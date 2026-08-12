import {
  REALTIME_ACCESS_REVOKED_TOPIC,
  parseRealtimeAccessRevokedPayload,
} from '@openanalytics/domain'
import type { Logger } from '@openanalytics/observability'
import {
  claimDueOutbox,
  markOutboxDelivered,
  markOutboxFailed,
  type Database,
} from '@openanalytics/postgres'
import type { RealtimeCache } from '@openanalytics/redis'

/**
 * The durable half of D-213 realtime revocation (docs snapshot 02 §17).
 *
 * The api bumps a removed subject's access epoch immediately, best-effort, right
 * after the membership change commits. That bump is lost if the realtime cache is
 * unreachable at that instant — so the same transaction also writes an outbox row
 * on `realtime.access_revoked`, and this loop drains it, replaying the epoch bump
 * until Redis acknowledges. A double bump only over-revokes, which is safe.
 *
 * Modelled on `email-drain.ts`: a thin interval over `claimDueOutbox` /
 * `markOutboxDelivered` / `markOutboxFailed`. A malformed payload is failed with a
 * clear reason rather than crashing the batch; a Redis error requeues the row with
 * backoff (markOutboxFailed's default retry/DLQ policy), so a transient cache
 * outage is retried and a persistently unreachable cache surfaces as a dead-letter
 * an operator sees rather than an infinite spin.
 */

const DEFAULT_INTERVAL_MS = 5_000
const DEFAULT_LIMIT = 20

export interface RealtimeRevocationDrainDeps {
  readonly db: Database
  /** The worker's realtime cache client; only the epoch bump is used here. */
  readonly cache: Pick<RealtimeCache, 'bumpEpochAndPublishDisconnect'>
  readonly logger: Logger
  readonly intervalMs?: number
  readonly limit?: number
}

export interface RealtimeRevocationDrainResult {
  readonly claimed: number
  readonly delivered: number
  readonly failed: number
}

export interface RealtimeRevocationDrain {
  stop(): Promise<void>
}

/**
 * Drains one batch of due revocation rows. Each row's epoch is bumped and the row
 * marked delivered; a malformed payload or a cache error marks that single row
 * failed and moves on, never throwing the batch away.
 */
export async function processRealtimeRevocationOutbox(
  deps: RealtimeRevocationDrainDeps,
): Promise<RealtimeRevocationDrainResult> {
  const rows = await claimDueOutbox(deps.db, {
    topic: REALTIME_ACCESS_REVOKED_TOPIC,
    limit: deps.limit ?? DEFAULT_LIMIT,
  })
  let delivered = 0
  let failed = 0

  for (const row of rows) {
    let payload: ReturnType<typeof parseRealtimeAccessRevokedPayload>
    try {
      payload = parseRealtimeAccessRevokedPayload(row.payload)
    } catch {
      await markOutboxFailed(deps.db, row.id, 'invalid_payload')
      failed += 1
      continue
    }

    try {
      // subject is the removed user id (or the literal `public` for a public
      // share); the epoch key is rt_epoch:{siteId}:{subject}.
      await deps.cache.bumpEpochAndPublishDisconnect({
        siteId: payload.site_id,
        subject: payload.user_id,
      })
      await markOutboxDelivered(deps.db, row.id)
      delivered += 1
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'bump_failed'
      deps.logger.warn('realtime_revocation_delivery_failed', {
        outboxId: row.id,
        site_id: payload.site_id,
        reason,
        retryable: true,
      })
      await markOutboxFailed(deps.db, row.id, reason)
      failed += 1
    }
  }

  return { claimed: rows.length, delivered, failed }
}

export function startRealtimeRevocationDrain(
  deps: RealtimeRevocationDrainDeps,
): RealtimeRevocationDrain {
  let running = false
  let stopped = false

  const tick = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      const result = await processRealtimeRevocationOutbox(deps)
      if (result.claimed > 0) {
        deps.logger.info('realtime_revocation_drained', { ...result })
      }
    } catch (err) {
      deps.logger.error('realtime_revocation_drain_failed', { err, retryable: true })
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => void tick(), deps.intervalMs ?? DEFAULT_INTERVAL_MS)
  // The drain must not by itself keep the process alive.
  timer.unref()

  return {
    async stop() {
      stopped = true
      clearInterval(timer)
      while (running) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    },
  }
}
