import type { Logger, Metrics } from '@openanalytics/observability'
import {
  REALTIME_CONTROL_CHANNEL_PREFIX,
  REALTIME_SITE_EPOCH_SUBJECT,
  REALTIME_UPDATES_CHANNEL_PREFIX,
  type PresenceSnapshot,
  realtimeControlChannel,
  realtimeUpdatesChannel,
} from '@openanalytics/redis'
import {
  REALTIME_SNAPSHOT_MAX_AGE_SECONDS,
  type RealtimeControlAction,
  type RealtimeControlReason,
} from '@openanalytics/contracts'
import type { RealtimeTokenScope } from '@openanalytics/auth'
import { REALTIME_METRICS } from './metrics.ts'
import type { RealtimeSubscriber } from './subscriber.ts'

/**
 * Shared-snapshot hubs and their process-wide manager (docs snapshot 02 §17).
 *
 * The invariant the section states outright — "never one scan per client" — is
 * the whole reason a `SiteHub` exists: one `readPresenceSnapshot` per site per
 * cache window feeds every subscribed client, private and public alike. The hub
 * owns the snapshot cache, the per-site monotonic sequence, the debounced
 * recompute and the degraded/recovered transition; the manager owns the single
 * subscriber connection and the site→hub routing.
 */

/**
 * How long an unchanged snapshot may be withheld before it is resent anyway.
 *
 * **Derived, not chosen.** A client calls a stream dead when its snapshot is
 * older than `REALTIME_SNAPSHOT_MAX_AGE_SECONDS`, and `generated_at` only moves
 * when the gateway sends — so any suppression window has to sit safely inside
 * that. Half of it means the steady gap is `ceil(floor / refresh) * refresh`,
 * two ticks at the default cadence (20 s).
 *
 * The margin that matters is not the steady gap but **the gap after one failed
 * or slow recompute**, which costs a whole tick: 30 s. That is why the threshold
 * on the contract side is 40 s rather than 30 — at 30 the very first slow Redis
 * read would have shown a "live paused" flicker on a perfectly healthy stream.
 *
 * `tests/unit/policy.test.ts` pins that arithmetic and
 * `tests/unit/realtime-hub.test.ts` pins the behaviour; the two values live in
 * different packages and share no import, the same way `PRESENCE_FEED_MAX` and
 * `REALTIME_FEED_MAX_EVENTS` do.
 */
const SNAPSHOT_RESEND_FLOOR_MS = (REALTIME_SNAPSHOT_MAX_AGE_SECONDS / 2) * 1000

/** What a hub needs from a connected stream. Implemented by the SSE client. */
export interface HubClient {
  readonly scope: RealtimeTokenScope
  /** User id, or the literal `public`. Matched against a control message. */
  readonly subject: string
  /** Access epoch this connection snapshotted; a control bump past it revokes. */
  readonly epoch: number
  /** The site-level epoch this connection snapshotted (ADR-0030, decision 5).
   * A control message on the reserved `site` subject closes every client behind
   * it, which is how a block or a deletion start cuts a whole site at once. */
  readonly siteEpoch: number
  /** Deliver a snapshot; the client formats it for its own scope. */
  sendSnapshot(seq: number, presence: PresenceSnapshot, generatedAt: Date): void
  /** Deliver a control message. */
  sendControl(seq: number, action: RealtimeControlAction, reason: RealtimeControlReason): void
  /** Ask the stream to close after its queued writes flush. */
  requestClose(): void
}

/** Read-only presence source the hub recomputes from. */
export interface PresenceReader {
  readPresenceSnapshot(input: {
    siteId: string
    at: Date
    maxVisitors: number
  }): Promise<PresenceSnapshot>
}

export interface SiteHubOptions {
  readonly siteId: string
  readonly cache: PresenceReader
  readonly maxVisitors: number
  readonly cacheSeconds: number
  /**
   * How often this hub recomputes on its own, from
   * `REALTIME_SNAPSHOT_REFRESH_SECONDS`. Never a literal here (AGENTS.md), and
   * never faster than `cacheSeconds` — the policy schema refuses that pairing.
   */
  readonly refreshSeconds: number
  readonly metrics: Metrics
  readonly logger: Logger
  readonly clock: () => number
}

export class SiteHub {
  private readonly clients = new Set<HubClient>()

  private cachedPresence: PresenceSnapshot | null = null
  private cachedGeneratedAt: Date | null = null
  private hasComputed = false
  private lastComputeMs = 0
  private lastComputeSucceeded = false
  private computing: Promise<void> | null = null

  /**
   * Monotonic per-site event sequence, seeded from a ms timestamp so ids keep
   * increasing even across hub destruction/recreation: a later incarnation
   * starts from a strictly larger clock reading than any id the previous one
   * emitted, so a reconnecting client's `Last-Event-ID` never collides with a
   * fresh, unrelated snapshot.
   */
  private seq: number
  private currentSequence: number
  private lastBroadcastSeq = 0

  private degraded = false
  private trailingTimer: ReturnType<typeof setTimeout> | null = null
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  /** Serialized presence of the last frame actually sent, for the unchanged
   * check. Deliberately not the wire payload: `generated_at` moves on every
   * compute and would make every snapshot look different from every other. */
  private lastBroadcastPayload: string | null = null
  private lastBroadcastAtMs = 0

  private readonly options: SiteHubOptions

  constructor(options: SiteHubOptions) {
    this.options = options
    this.seq = Math.floor(options.clock())
    this.currentSequence = this.seq
  }

  get siteId(): string {
    return this.options.siteId
  }

  currentSeq(): number {
    return this.currentSequence
  }

  size(): number {
    return this.clients.size
  }

  isEmpty(): boolean {
    return this.clients.size === 0
  }

  add(client: HubClient): void {
    this.clients.add(client)
    this.options.metrics.increment(REALTIME_METRICS.connectionOpened, { scope: client.scope })
    this.startRefresh()
  }

  remove(client: HubClient): void {
    if (this.clients.delete(client)) {
      this.options.metrics.increment(REALTIME_METRICS.connectionClosed, { scope: client.scope })
    }
    // The manager tears an empty hub down anyway; stopping here as well means a
    // hub held by anything else cannot keep scanning Redis for nobody.
    if (this.clients.size === 0) this.stopRefresh()
  }

  dispose(): void {
    if (this.trailingTimer !== null) {
      clearTimeout(this.trailingTimer)
      this.trailingTimer = null
    }
    this.stopRefresh()
  }

  /**
   * Recompute on a cadence for as long as anyone is watching (ADR-0035, D5).
   *
   * `onUpdate` alone made the snapshot a function of *traffic*, so a site with
   * none never recomputed and `active_visitors` froze at whatever it last was —
   * for as long as the tab stayed open. At a 60-second presence window a frozen
   * count was obviously stale within a minute; at five minutes it is
   * indistinguishable from a real one, which is why this ships with the window
   * rather than after it.
   *
   * Started by the first client and stopped by the last, so the process only
   * ever scans sites somebody is looking at — the same rule the manager applies
   * to its subscriptions.
   */
  private startRefresh(): void {
    if (this.refreshTimer !== null) return
    this.refreshTimer = setInterval(() => {
      if (this.clients.size === 0) return
      // A coalesced burst has already scheduled the recompute this tick would
      // ask for. Without this the two timers can land on the same millisecond
      // and pay for the scan twice.
      if (this.trailingTimer !== null) return
      // The cache window is the floor on real work: a touch that recomputed a
      // moment ago has already answered this tick's question.
      if (this.options.clock() - this.lastComputeMs < this.options.cacheSeconds * 1000) return
      void this.computeAndBroadcast()
    }, this.options.refreshSeconds * 1000)
  }

  private stopRefresh(): void {
    if (this.refreshTimer === null) return
    clearInterval(this.refreshTimer)
    this.refreshTimer = null
  }

  /**
   * Sends the connecting client its first frame. **Always exactly one frame**
   * (ADR-0035, D5): a snapshot, or a `degraded` control when there is no
   * snapshot to send.
   *
   * It used to be able to end in silence twice over — a client holding an id at
   * or beyond the current sequence got nothing, and so did a client whose hub's
   * first compute had thrown. Both are indistinguishable from a stream that
   * opened and broke, and the second one is exactly the case where the client
   * most needs to be told something.
   *
   * `Last-Event-ID` keeps its meaning and loses its silence. A client already at
   * the current sequence holds the state that sequence names, so nothing is
   * *recomputed* for it — but the snapshot it already has is re-sent, which is
   * free (it is a formatted copy of the cache) and re-anchors its `generated_at`
   * against the staleness rule. That remains the whole of the bounded replay for
   * a snapshot-typed stream: a snapshot supersedes every delta that could have
   * been missed, so there has never been anything to replay.
   */
  async sendInitial(client: HubClient, lastEventId: number | null): Promise<void> {
    const current = this.hasComputed && lastEventId !== null && lastEventId >= this.currentSequence
    if (!current) {
      const windowMs = this.options.cacheSeconds * 1000
      const fresh = this.hasComputed && this.options.clock() - this.lastComputeMs < windowMs
      if (!fresh) {
        await this.runCompute()
      }
    }

    if (this.hasComputed && this.cachedPresence !== null && this.cachedGeneratedAt !== null) {
      client.sendSnapshot(this.currentSequence, this.cachedPresence, this.cachedGeneratedAt)
      return
    }

    // No snapshot has ever succeeded on this hub. The connection's auth held —
    // it got this far — so this is the data-only degradation the control
    // vocabulary already has a word for, and the client keeps the stream.
    client.sendControl(this.currentSequence, 'degraded', 'snapshot_unavailable')
    this.degraded = true
  }

  /** A `rt_updates` message: recompute at most once per cache window, then fan out. */
  onUpdate(): void {
    const windowMs = this.options.cacheSeconds * 1000
    const elapsed = this.options.clock() - this.lastComputeMs
    if (elapsed >= windowMs) {
      void this.computeAndBroadcast()
    } else if (this.trailingTimer === null) {
      // Trailing edge: coalesce a burst of updates into one recompute at the end
      // of the window rather than one per message (docs snapshot 02 §17).
      this.trailingTimer = setTimeout(() => {
        this.trailingTimer = null
        void this.computeAndBroadcast()
      }, windowMs - elapsed)
    }
  }

  /**
   * A `rt_control` message `{subject, epoch}`: close, at once, every client of
   * this site whose subject matches and whose snapshotted epoch predates the
   * bump — not waiting for the next keepalive check. `subject` may be the literal
   * `public`, which closes the public-scope clients.
   *
   * The reserved subject `site` is the one that does not match a client's own
   * subject (ADR-0030, decision 5): it closes *every* client on this site whose
   * snapshotted `site_epoch` predates the bump, which is what a billing block
   * and a deletion start need and what nothing before M10 could do. The reason
   * stays `access_revoked` — no new control vocabulary, because the client's
   * behaviour is identical: stop, re-mint, and find out why from the API.
   */
  onControl(subject: string, epoch: number): void {
    this.options.metrics.increment(REALTIME_METRICS.controlHandled)
    if (subject === REALTIME_SITE_EPOCH_SUBJECT) {
      for (const client of [...this.clients]) {
        if (client.siteEpoch < epoch) {
          client.sendControl(this.currentSequence, 'disconnect', 'access_revoked')
          this.options.metrics.increment(REALTIME_METRICS.disconnect, { reason: 'access_revoked' })
          client.requestClose()
        }
      }
      return
    }
    for (const client of [...this.clients]) {
      if (client.subject === subject && client.epoch < epoch) {
        client.sendControl(this.currentSequence, 'disconnect', 'access_revoked')
        this.options.metrics.increment(REALTIME_METRICS.disconnect, { reason: 'access_revoked' })
        client.requestClose()
      }
    }
  }

  /** Closes every client with a control disconnect (graceful shutdown). */
  closeAll(reason: RealtimeControlReason): void {
    for (const client of [...this.clients]) {
      client.sendControl(this.currentSequence, 'disconnect', reason)
      this.options.metrics.increment(REALTIME_METRICS.disconnect, { reason })
      client.requestClose()
    }
  }

  private async computeAndBroadcast(): Promise<void> {
    await this.runCompute()
    if (this.lastComputeSucceeded) {
      let recovered = false
      if (this.degraded) {
        // Auth is fine (revoked clients close on their own timer); a recompute
        // succeeding is the recovery from a data-only degradation.
        this.degraded = false
        this.broadcastControl('recovered', 'ok')
        recovered = true
      }
      // A recovery always carries its snapshot, even an unchanged one: the
      // contract says one follows, and the client has been told to keep showing
      // a "live paused" hint until it arrives.
      this.broadcastCurrent(recovered)
    } else if (!this.degraded) {
      // Data failing while the stream's auth still holds: announce once, keep
      // the stream, and stay quiet until a recompute recovers.
      this.degraded = true
      this.broadcastControl('degraded', 'snapshot_unavailable')
    }
  }

  /** Coalesces concurrent recompute requests onto one in-flight `readPresenceSnapshot`. */
  private runCompute(): Promise<void> {
    if (this.computing !== null) return this.computing
    const pending = this.compute().finally(() => {
      if (this.computing === pending) this.computing = null
    })
    this.computing = pending
    return pending
  }

  private async compute(): Promise<void> {
    // Window is measured from the attempt, so a storm of updates cannot force
    // more than one scan per window even if the scan itself is slow.
    this.lastComputeMs = this.options.clock()
    try {
      const presence = await this.options.cache.readPresenceSnapshot({
        siteId: this.options.siteId,
        at: new Date(this.options.clock()),
        maxVisitors: this.options.maxVisitors,
      })
      this.cachedPresence = presence
      this.cachedGeneratedAt = new Date(this.options.clock())
      this.hasComputed = true
      this.seq += 1
      this.currentSequence = this.seq
      this.lastComputeSucceeded = true
      this.options.metrics.increment(REALTIME_METRICS.snapshotComputed)
    } catch (error) {
      this.lastComputeSucceeded = false
      this.options.metrics.increment(REALTIME_METRICS.snapshotFailed)
      this.options.logger.warn('realtime_snapshot_failed', {
        site_id: this.options.siteId,
        err: error,
        retryable: true,
      })
    }
  }

  /**
   * Fan the current snapshot out — unless every client already holds exactly it.
   *
   * The timer (D5) exists so a quiet site's count cannot freeze, not so that an
   * idle dashboard receives the same bytes every ten seconds. The case that
   * makes this worth doing is not the empty one (194 B) but the site that has
   * *just* emptied: its `events` feed lives on for fifteen minutes, so the
   * unchanged frame is ~12 KB and an open dashboard would take ~1 MiB of it
   * while nobody is there.
   *
   * Suppression is bounded, and the bound is the client's own rule rather than a
   * taste: a browser calls a stream dead when its snapshot is older than
   * `REALTIME_SNAPSHOT_MAX_AGE_SECONDS`, and `generated_at` only moves when we
   * send. So an unchanged snapshot is resent once `SNAPSHOT_RESEND_FLOOR_MS` has
   * passed — half the staleness threshold, which at the default cadence makes
   * the worst gap two ticks (20 s) against a 30 s threshold, leaving a whole
   * tick of margin.
   *
   * `force` is for the one case where an unchanged payload still has to go out:
   * the snapshot the contract promises after a `recovered` control. Suppressing
   * it would leave a client holding a recovery banner and no data behind it.
   *
   * `sendInitial` deliberately does **not** update this bookkeeping, even though
   * it hands one client the same bytes. The floor is "how long since everyone
   * last got a frame", and a per-client send is not that: a steady trickle of
   * joiners would keep resetting it and starve the clients already connected.
   * The cost is one redundant frame on the first tick after a hub's first
   * subscribe — once per hub, not once per tick.
   */
  private broadcastCurrent(force = false): void {
    if (
      !this.hasComputed ||
      this.cachedPresence === null ||
      this.cachedGeneratedAt === null ||
      this.currentSequence === this.lastBroadcastSeq
    ) {
      return
    }

    const payload = JSON.stringify(this.cachedPresence)
    if (
      !force &&
      payload === this.lastBroadcastPayload &&
      this.options.clock() - this.lastBroadcastAtMs < SNAPSHOT_RESEND_FLOOR_MS
    ) {
      // The sequence still advanced, so a reconnecting client with an older
      // `Last-Event-ID` is served the current state on connect — the redundancy
      // lands on the one client that does not have it, not on all of them.
      return
    }

    this.lastBroadcastSeq = this.currentSequence
    this.lastBroadcastPayload = payload
    this.lastBroadcastAtMs = this.options.clock()
    for (const client of this.clients) {
      client.sendSnapshot(this.currentSequence, this.cachedPresence, this.cachedGeneratedAt)
    }
  }

  private broadcastControl(action: RealtimeControlAction, reason: RealtimeControlReason): void {
    for (const client of this.clients) {
      client.sendControl(this.currentSequence, action, reason)
    }
  }
}

export interface HubManagerOptions {
  readonly subscriber: RealtimeSubscriber
  readonly cache: PresenceReader
  readonly maxVisitors: number
  readonly cacheSeconds: number
  readonly refreshSeconds: number
  readonly metrics: Metrics
  readonly logger: Logger
  readonly clock: () => number
}

/**
 * Owns the site hubs and the single subscriber connection. A hub is created on
 * its first client (subscribing to that site's two channels) and torn down on
 * its last (unsubscribing), so the process only ever listens to sites that have
 * a live viewer.
 */
export class HubManager {
  private readonly hubs = new Map<string, SiteHub>()

  private readonly options: HubManagerOptions

  constructor(options: HubManagerOptions) {
    this.options = options
    this.options.subscriber.onMessage((channel, message) => this.dispatch(channel, message))
  }

  async addClient(siteId: string, client: HubClient): Promise<SiteHub> {
    let hub = this.hubs.get(siteId)
    if (hub === undefined) {
      hub = new SiteHub({
        siteId,
        cache: this.options.cache,
        maxVisitors: this.options.maxVisitors,
        cacheSeconds: this.options.cacheSeconds,
        refreshSeconds: this.options.refreshSeconds,
        metrics: this.options.metrics,
        logger: this.options.logger,
        clock: this.options.clock,
      })
      this.hubs.set(siteId, hub)
      await this.options.subscriber.subscribe(realtimeUpdatesChannel(siteId))
      await this.options.subscriber.subscribe(realtimeControlChannel(siteId))
    }
    hub.add(client)
    return hub
  }

  async removeClient(siteId: string, client: HubClient): Promise<void> {
    const hub = this.hubs.get(siteId)
    if (hub === undefined) return
    hub.remove(client)
    if (hub.isEmpty()) {
      this.hubs.delete(siteId)
      hub.dispose()
      await this.options.subscriber.unsubscribe(realtimeUpdatesChannel(siteId))
      await this.options.subscriber.unsubscribe(realtimeControlChannel(siteId))
    }
  }

  /** Ends every open stream with a reconnect-inviting disconnect. */
  shutdown(reason: RealtimeControlReason = 'token_expired_reconnect'): void {
    for (const hub of this.hubs.values()) {
      hub.closeAll(reason)
      hub.dispose()
    }
    this.hubs.clear()
  }

  private dispatch(channel: string, message: string): void {
    const updatesPrefix = `${REALTIME_UPDATES_CHANNEL_PREFIX}:`
    const controlPrefix = `${REALTIME_CONTROL_CHANNEL_PREFIX}:`

    if (channel.startsWith(updatesPrefix)) {
      const hub = this.hubs.get(channel.slice(updatesPrefix.length))
      hub?.onUpdate()
      return
    }
    if (channel.startsWith(controlPrefix)) {
      const hub = this.hubs.get(channel.slice(controlPrefix.length))
      if (hub === undefined) return
      let parsed: { subject?: unknown; epoch?: unknown }
      try {
        parsed = JSON.parse(message) as { subject?: unknown; epoch?: unknown }
      } catch {
        this.options.logger.warn('realtime_control_unparsable', { channel })
        return
      }
      if (typeof parsed.subject === 'string' && typeof parsed.epoch === 'number') {
        hub.onControl(parsed.subject, parsed.epoch)
      }
    }
  }
}
