import { REALTIME_SNAPSHOT_MAX_AGE_SECONDS } from '@openanalytics/contracts'
import { createRecordingMetrics } from '@openanalytics/observability'
import type { PresenceSnapshot } from '@openanalytics/redis'
import { createCapturedLogger } from '@openanalytics/testkit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HubManager, SiteHub, type HubClient } from '../../apps/realtime/src/hub.ts'

/**
 * The hub's two liveness properties (ADR-0035, D5).
 *
 * Both are about what a *quiet* site looks like, which is why neither had a test
 * before: the hub recomputed only on a pubsub touch, so nothing published meant
 * `active_visitors` froze at its last value forever, and `sendInitial` had two
 * paths that ended in silence. A five-minute presence window makes a frozen
 * count indistinguishable from a real one, so these stopped being cosmetic.
 */

const EMPTY: PresenceSnapshot = {
  activeVisitors: 0,
  truncated: false,
  pages: [],
  countries: [],
  devices: [],
  browsers: [],
  operatingSystems: [],
  cities: [],
  events: [],
  present: [],
}

function snapshotWith(activeVisitors: number): PresenceSnapshot {
  return { ...EMPTY, activeVisitors }
}

interface Recorded {
  readonly client: HubClient
  readonly snapshots: { seq: number; presence: PresenceSnapshot; generatedAt: string }[]
  readonly controls: { action: string; reason: string }[]
  readonly closed: () => boolean
}

function recordingClient(): Recorded {
  const snapshots: { seq: number; presence: PresenceSnapshot; generatedAt: string }[] = []
  const controls: { action: string; reason: string }[] = []
  let closed = false
  const client: HubClient = {
    scope: 'private',
    subject: 'user-1',
    epoch: 0,
    siteEpoch: 0,
    sendSnapshot: (seq, presence, generatedAt) =>
      snapshots.push({ seq, presence, generatedAt: generatedAt.toISOString() }),
    sendControl: (_seq, action, reason) => controls.push({ action, reason }),
    requestClose: () => {
      closed = true
    },
  }
  return { client, snapshots, controls, closed: () => closed }
}

describe('SiteHub', () => {
  let clockMs = 1_000_000

  beforeEach(() => {
    vi.useFakeTimers()
    clockMs = 1_000_000
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const hubWith = (
    readPresenceSnapshot: () => Promise<PresenceSnapshot>,
    overrides: { cacheSeconds?: number; refreshSeconds?: number } = {},
  ) =>
    new SiteHub({
      siteId: 'site-1',
      cache: { readPresenceSnapshot },
      maxVisitors: 100,
      cacheSeconds: overrides.cacheSeconds ?? 2,
      refreshSeconds: overrides.refreshSeconds ?? 10,
      metrics: createRecordingMetrics(),
      logger: createCapturedLogger().logger,
      clock: () => clockMs,
    })

  it('recomputes on its own timer while a client is attached', async () => {
    let count = 0
    const hub = hubWith(async () => snapshotWith(++count))
    const a = recordingClient()

    hub.add(a.client)
    await hub.sendInitial(a.client, null)
    expect(a.snapshots).toHaveLength(1)
    expect(a.snapshots[0]?.presence.activeVisitors).toBe(1)

    // Nothing publishes on a quiet site. Without the timer this count is the
    // last one the board will ever see.
    clockMs += 10_000
    await vi.advanceTimersByTimeAsync(10_000)
    expect(a.snapshots).toHaveLength(2)
    expect(a.snapshots[1]?.presence.activeVisitors).toBe(2)

    clockMs += 10_000
    await vi.advanceTimersByTimeAsync(10_000)
    expect(a.snapshots).toHaveLength(3)

    hub.dispose()
  })

  it('stops recomputing once disposed', async () => {
    let count = 0
    const hub = hubWith(async () => snapshotWith(++count))
    const a = recordingClient()
    hub.add(a.client)
    await hub.sendInitial(a.client, null)

    hub.dispose()
    clockMs += 60_000
    await vi.advanceTimersByTimeAsync(60_000)

    expect(a.snapshots).toHaveLength(1)
  })

  it('never recomputes faster than the cache window allows', async () => {
    let reads = 0
    const hub = hubWith(
      async () => {
        reads += 1
        return snapshotWith(reads)
      },
      // A refresh cadence equal to the cache window is the tightest the policy
      // invariant permits; a touch landing inside the window must not add a read.
      { cacheSeconds: 2, refreshSeconds: 2 },
    )
    const a = recordingClient()
    hub.add(a.client)
    await hub.sendInitial(a.client, null)
    expect(reads).toBe(1)

    // A pubsub touch immediately after the initial compute is inside the window,
    // so it schedules a trailing recompute rather than running one.
    hub.onUpdate()
    expect(reads).toBe(1)

    clockMs += 2_000
    await vi.advanceTimersByTimeAsync(2_000)
    // One recompute for the window that elapsed — not one per waking mechanism.
    expect(reads).toBe(2)

    hub.dispose()
  })

  it('does not resend a snapshot the clients already hold', async () => {
    // The timer exists so a quiet site's count cannot freeze, not so that an
    // idle dashboard receives the same bytes every ten seconds. A site that has
    // just emptied still carries its 15-minute feed, so the unchanged frame is
    // ~12 KB — the one case where this is not free.
    const hub = hubWith(async () => snapshotWith(4))
    const a = recordingClient()
    hub.add(a.client)
    await hub.sendInitial(a.client, null)

    // The first tick after a hub's first `sendInitial` still sends: `sendInitial`
    // is per-client and deliberately does not seed the fan-out bookkeeping, or a
    // steady trickle of joiners would keep resetting the floor and starve the
    // clients already connected. One redundant frame per hub lifetime.
    clockMs += 10_000
    await vi.advanceTimersByTimeAsync(10_000)
    expect(a.snapshots).toHaveLength(2)

    // From here the payload is unchanged and the clients hold it.
    clockMs += 10_000
    await vi.advanceTimersByTimeAsync(10_000)
    expect(a.snapshots).toHaveLength(2)

    hub.dispose()
  })

  it('resends an unchanged snapshot once the resend floor passes', async () => {
    // Suppression may never outlast the client's staleness rule: `generated_at`
    // moving is the only thing that tells a browser the stream is alive, and a
    // snapshot older than REALTIME_SNAPSHOT_MAX_AGE_SECONDS means "dead", not
    // "quiet". The floor is half that, so the worst gap is two ticks.
    const hub = hubWith(async () => snapshotWith(4))
    const a = recordingClient()
    hub.add(a.client)
    await hub.sendInitial(a.client, null)

    clockMs += 10_000
    await vi.advanceTimersByTimeAsync(10_000) // seeds the fan-out bookkeeping
    expect(a.snapshots).toHaveLength(2)

    clockMs += 10_000
    await vi.advanceTimersByTimeAsync(10_000) // 10s < floor -> suppressed
    expect(a.snapshots).toHaveLength(2)

    clockMs += 10_000
    await vi.advanceTimersByTimeAsync(10_000) // 20s >= floor -> resent
    expect(a.snapshots).toHaveLength(3)

    // The worst gap the suppression can produce is two ticks, and it must stay
    // inside the window a client calls a dead stream.
    const gapS =
      (Date.parse(a.snapshots[2]!.generatedAt) - Date.parse(a.snapshots[1]!.generatedAt)) / 1000
    expect(gapS).toBe(20)
    expect(gapS).toBeLessThan(REALTIME_SNAPSHOT_MAX_AGE_SECONDS)

    hub.dispose()
  })

  it('sends a changed snapshot at once, without waiting for the floor', async () => {
    let count = 0
    const hub = hubWith(async () => snapshotWith(++count))
    const a = recordingClient()
    hub.add(a.client)
    await hub.sendInitial(a.client, null)

    clockMs += 10_000
    await vi.advanceTimersByTimeAsync(10_000)

    expect(a.snapshots).toHaveLength(2)
    expect(a.snapshots[1]?.presence.activeVisitors).toBe(2)

    hub.dispose()
  })

  it('always sends a snapshot after recovering, even an unchanged one', async () => {
    // The contract promises "a fresh snapshot follows" a `recovered` control. If
    // the site was idle through the outage the payload is identical, and
    // suppressing it would leave the client holding a recovered banner and no
    // data behind it.
    let fail = false
    const hub = hubWith(async () => {
      if (fail) throw new Error('presence scan failed')
      return snapshotWith(4)
    })
    const a = recordingClient()
    hub.add(a.client)
    await hub.sendInitial(a.client, null)
    const before = a.snapshots.length

    fail = true
    clockMs += 10_000
    await vi.advanceTimersByTimeAsync(10_000)
    expect(a.controls.at(-1)).toEqual({ action: 'degraded', reason: 'snapshot_unavailable' })

    fail = false
    clockMs += 10_000
    await vi.advanceTimersByTimeAsync(10_000)

    expect(a.controls.at(-1)).toEqual({ action: 'recovered', reason: 'ok' })
    expect(a.snapshots.length).toBe(before + 1)

    hub.dispose()
  })

  it('gives a newly joined client the current snapshot even while suppressed', async () => {
    // Suppression is about clients that already hold the state. Someone opening
    // a second tab holds nothing.
    const hub = hubWith(async () => snapshotWith(4))
    const a = recordingClient()
    hub.add(a.client)
    await hub.sendInitial(a.client, null)

    clockMs += 10_000
    await vi.advanceTimersByTimeAsync(10_000)
    clockMs += 10_000
    await vi.advanceTimersByTimeAsync(10_000)
    expect(a.snapshots).toHaveLength(2)

    const b = recordingClient()
    hub.add(b.client)
    await hub.sendInitial(b.client, null)
    expect(b.snapshots).toHaveLength(1)
    expect(b.snapshots[0]?.presence.activeVisitors).toBe(4)

    hub.dispose()
  })

  it('answers an initial subscribe with a snapshot even when the client is current', async () => {
    const hub = hubWith(async () => snapshotWith(7))
    const first = recordingClient()
    hub.add(first.client)
    await hub.sendInitial(first.client, null)
    const seq = first.snapshots[0]!.seq

    // A reconnecting client holding the current id used to get silence, which is
    // indistinguishable from a broken stream. It gets the state it already holds.
    const second = recordingClient()
    hub.add(second.client)
    await hub.sendInitial(second.client, seq)

    expect(second.snapshots).toHaveLength(1)
    expect(second.snapshots[0]?.seq).toBe(seq)
    expect(second.controls).toHaveLength(0)

    hub.dispose()
  })

  it('answers an initial subscribe with a degraded control when the first compute fails', async () => {
    const hub = hubWith(async () => {
      throw new Error('valkey unreachable')
    })
    const a = recordingClient()
    hub.add(a.client)

    await hub.sendInitial(a.client, null)

    expect(a.snapshots).toHaveLength(0)
    expect(a.controls).toEqual([{ action: 'degraded', reason: 'snapshot_unavailable' }])

    hub.dispose()
  })
})

describe('HubManager', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('leaves no timer running behind the last client on a site', async () => {
    let reads = 0
    const subscribed = new Set<string>()
    const manager = new HubManager({
      subscriber: {
        onMessage: () => undefined,
        subscribe: async (channel: string) => {
          subscribed.add(channel)
        },
        unsubscribe: async (channel: string) => {
          subscribed.delete(channel)
        },
        close: async () => undefined,
      },
      cache: {
        readPresenceSnapshot: async () => {
          reads += 1
          return EMPTY
        },
      },
      maxVisitors: 100,
      cacheSeconds: 2,
      refreshSeconds: 10,
      metrics: createRecordingMetrics(),
      logger: createCapturedLogger().logger,
      clock: () => Date.now(),
    })

    const a = recordingClient()
    const hub = await manager.addClient('site-1', a.client)
    await hub.sendInitial(a.client, null)
    const afterInitial = reads

    await manager.removeClient('site-1', a.client)
    expect(subscribed.size).toBe(0)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(reads).toBe(afterInitial)
  })
})
