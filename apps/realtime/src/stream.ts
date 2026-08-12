import type { ServiceEnv } from '@openanalytics/domain'
import type { Logger, Metrics } from '@openanalytics/observability'
import {
  REALTIME_SITE_EPOCH_SUBJECT,
  type PresenceSnapshot,
  type RealtimeCache,
} from '@openanalytics/redis'
import type { RealtimeControlAction, RealtimeControlReason } from '@openanalytics/contracts'
import type { RealtimeTokenClaims } from '@openanalytics/auth'
import { Hono } from 'hono'
import { streamSSE, type SSEStreamingApi } from 'hono/streaming'
import { authenticateConnection } from './auth.ts'
import type { HubClient, HubManager } from './hub.ts'
import { REALTIME_METRICS } from './metrics.ts'
import { controlMessage, toPrivateSnapshot, toPublicSnapshot } from './snapshot.ts'
import type { KeyObject } from 'node:crypto'

/**
 * The `GET /v1/realtime/stream` handler (docs snapshot 02 §17, 05 D-213).
 *
 * Auth runs to completion before the stream opens, so a rejection is a 401 JSON
 * envelope, not a half-open `text/event-stream`. Once open, the connection is a
 * `SiteHub` client: it receives the shared snapshot fan-out, re-checks its own
 * access epoch on a timer (fail-closed), and is closed by a control message the
 * instant its subject is revoked.
 */

/**
 * SSE reconnect backoff hint, milliseconds. This is the one bare literal the
 * design allows: it is a client-side backoff suggestion, not a server policy
 * value — the epoch cadence, cache TTL and max-visitors all come from typed env.
 */
const SSE_RETRY_HINT_MS = 3000

export interface StreamRouteDeps {
  readonly hubs: HubManager
  readonly cache: Pick<RealtimeCache, 'getEpoch'>
  readonly verifyKey: KeyObject
  readonly env: ServiceEnv<'realtime'>
  readonly metrics: Metrics
  readonly logger: Logger
  readonly now: () => Date
}

/**
 * One connected stream. Serializes every write behind a promise chain — SSE
 * frames must not interleave — and exposes a `closed` promise the route awaits
 * so the `streamSSE` callback (and thus the HTTP response) stays open exactly as
 * long as the connection should.
 */
class StreamClient implements HubClient {
  readonly scope: RealtimeTokenClaims['scope']
  readonly subject: string
  readonly epoch: number
  readonly siteEpoch: number

  private writeChain: Promise<void> = Promise.resolve()
  private isClosed = false
  private resolveClosed!: () => void
  readonly closed: Promise<void>

  private readonly stream: SSEStreamingApi
  private readonly onWriteError: (error: unknown) => void

  constructor(
    stream: SSEStreamingApi,
    claims: RealtimeTokenClaims,
    onWriteError: (error: unknown) => void,
  ) {
    this.stream = stream
    this.onWriteError = onWriteError
    this.scope = claims.scope
    this.subject = claims.subject
    this.epoch = claims.epoch
    this.siteEpoch = claims.site_epoch
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve
    })
  }

  private enqueue(write: () => Promise<void>): void {
    this.writeChain = this.writeChain.then(async () => {
      if (this.isClosed) return
      try {
        await write()
      } catch (error) {
        this.onWriteError(error)
        this.markClosed()
      }
    })
  }

  sendSnapshot(seq: number, presence: PresenceSnapshot, generatedAt: Date): void {
    const payload =
      this.scope === 'public'
        ? toPublicSnapshot(presence, generatedAt)
        : toPrivateSnapshot(presence, generatedAt)
    this.enqueue(() =>
      this.stream.writeSSE({
        event: 'snapshot',
        id: String(seq),
        data: JSON.stringify(payload),
        retry: SSE_RETRY_HINT_MS,
      }),
    )
  }

  sendControl(seq: number, action: RealtimeControlAction, reason: RealtimeControlReason): void {
    this.enqueue(() =>
      this.stream.writeSSE({
        event: 'control',
        id: String(seq),
        data: JSON.stringify(controlMessage(action, reason)),
      }),
    )
  }

  /** SSE comment line, so an idle proxy does not close the connection. */
  keepalive(): void {
    this.enqueue(async () => {
      await this.stream.write(': keepalive\n\n')
    })
  }

  /** Close after the queued writes flush, so a final control message is sent. */
  requestClose(): void {
    this.writeChain = this.writeChain.then(
      () => this.markClosed(),
      () => this.markClosed(),
    )
  }

  /** Immediate close, for a client that already went away (abort). */
  markClosed(): void {
    if (this.isClosed) return
    this.isClosed = true
    this.resolveClosed()
  }
}

/** Parses a `Last-Event-ID` header into a sequence number, or null. */
function parseLastEventId(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const value = Number(raw)
  return Number.isInteger(value) ? value : null
}

export function createStreamRoute(deps: StreamRouteDeps): Hono {
  const app = new Hono()

  app.get('/realtime/stream', async (c) => {
    // Fully authenticate before opening the stream; a failure is a JSON 401.
    const claims = await authenticateConnection(c, {
      verifyKey: deps.verifyKey,
      maxTtlSeconds: deps.env.REALTIME_TOKEN_TTL_SECONDS,
      cache: deps.cache,
      now: deps.now,
    })

    const lastEventId = parseLastEventId(c.req.header('Last-Event-ID'))

    return streamSSE(c, async (stream) => {
      const client = new StreamClient(stream, claims, (error) =>
        deps.logger.warn('realtime_write_failed', { jti: claims.jti, err: error, retryable: true }),
      )

      // A gone client (proxy/browser closed) cancels the readable, which aborts
      // the stream: close fail-closed and let the finally block clean up.
      stream.onAbort(() => client.markClosed())

      const hub = await deps.hubs.addClient(claims.site_id, client)
      await hub.sendInitial(client, lastEventId)

      const intervalMs = deps.env.REALTIME_EPOCH_CHECK_SECONDS * 1000

      // One tick per epoch-check cadence carries both concerns: it keeps the
      // connection warm (keepalive comment) and re-checks that the member is
      // still entitled. Either question failing closes the stream fail-closed.
      const tick = async (): Promise<void> => {
        client.keepalive()

        let current: number | null
        try {
          current = await deps.cache.getEpoch({ siteId: claims.site_id, subject: claims.subject })
        } catch (error) {
          deps.metrics.increment(REALTIME_METRICS.epochCheckFailed)
          deps.logger.warn('realtime_epoch_unreachable', {
            jti: claims.jti,
            err: error,
            retryable: false,
          })
          client.sendControl(hub.currentSeq(), 'disconnect', 'auth_unreachable')
          deps.metrics.increment(REALTIME_METRICS.disconnect, { reason: 'auth_unreachable' })
          client.requestClose()
          return
        }

        if (current === null) {
          deps.metrics.increment(REALTIME_METRICS.epochCheckFailed)
          client.sendControl(hub.currentSeq(), 'disconnect', 'auth_unreachable')
          deps.metrics.increment(REALTIME_METRICS.disconnect, { reason: 'auth_unreachable' })
          client.requestClose()
          return
        }
        if (current !== claims.epoch) {
          client.sendControl(hub.currentSeq(), 'disconnect', 'access_revoked')
          deps.metrics.increment(REALTIME_METRICS.disconnect, { reason: 'access_revoked' })
          client.requestClose()
          return
        }

        // The site-level anchor (ADR-0030, decision 5). Checked on the same tick
        // as the subject's, so a block or a deletion start cuts the stream within
        // REALTIME_EPOCH_CHECK_SECONDS even if the control publish was missed.
        // Null reads as 0 for the reason `auth.ts` records: the site key means
        // "never bumped" when absent, and the subject check above is what fails
        // closed on an unreachable cache.
        let currentSite: number | null
        try {
          currentSite = await deps.cache.getEpoch({
            siteId: claims.site_id,
            subject: REALTIME_SITE_EPOCH_SUBJECT,
          })
        } catch (error) {
          deps.metrics.increment(REALTIME_METRICS.epochCheckFailed)
          deps.logger.warn('realtime_epoch_unreachable', {
            jti: claims.jti,
            err: error,
            retryable: false,
          })
          client.sendControl(hub.currentSeq(), 'disconnect', 'auth_unreachable')
          deps.metrics.increment(REALTIME_METRICS.disconnect, { reason: 'auth_unreachable' })
          client.requestClose()
          return
        }

        if ((currentSite ?? 0) > claims.site_epoch) {
          client.sendControl(hub.currentSeq(), 'disconnect', 'access_revoked')
          deps.metrics.increment(REALTIME_METRICS.disconnect, { reason: 'access_revoked' })
          client.requestClose()
        }
      }

      const timer = setInterval(() => void tick(), intervalMs)

      try {
        await client.closed
      } finally {
        clearInterval(timer)
        await deps.hubs.removeClient(claims.site_id, client)
      }
    })
  })

  return app
}
