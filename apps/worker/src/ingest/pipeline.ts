import { persistedEventSchema, type PersistedEvent } from '@openanalytics/contracts'
import {
  ClickHouseInsertError,
  toEventsRawRow,
  type EventsRawRow,
} from '@openanalytics/clickhouse'
import { recoveryActionFor, retryDelayMs, type IngestBatchState } from '@openanalytics/domain'
import {
  applyBatchUsage,
  markAttemptFailed,
  markBatchSitesWritten,
  markCompleted,
  markDeadLettered,
  markInserted,
  markInserting,
  markUsageRecorded,
  registerBatchSites,
  type Manifest,
} from '@openanalytics/postgres'
import type { StreamMessage } from '@openanalytics/redis'
import type { IngestDeps } from './deps.ts'
import { createFirstEventFill } from './first-event.ts'
import { WORKER_METRICS } from './metrics.ts'
import { afterUsageApplied, computeUsageAttribution } from './usage.ts'

/**
 * The manifest pipeline: ClickHouse, then the usage ledger, then the ACK
 * (docs snapshot 02 §7.5; 05 D-209 steps 4-6).
 *
 * The order is the guarantee, and it is never rearranged for convenience. The
 * ACK is last because an ACK is the queue forgetting an event: acknowledging
 * before the row and the usage row are durable is precisely the legacy defect
 * this milestone exists to make impossible — answering for data that was not
 * stored (docs snapshot 01 §4.3).
 *
 * Recovery re-enters at whatever step the manifest says was not finished, and
 * every step is idempotent by its own mechanism rather than by a flag this code
 * keeps: the ClickHouse token for the insert, the ledger's unique constraint for
 * usage, and XACK's own semantics for the acknowledgement.
 */

/**
 * The install-verified signal's already-filled cache (ADR-0027).
 *
 * Module scope, which is per process — the same lifetime as the ingest loop that
 * drives this file, and the honest scope for a cache whose only job is to stop a
 * long-lived worker re-asking a question it has already had answered. It holds
 * no correctness: the `first_event_at IS NULL` guard inside the statement does.
 */
const firstEventFill = createFirstEventFill()

export type BatchOutcome =
  | { readonly kind: 'completed'; readonly rows: number; readonly billable: number }
  | { readonly kind: 'retry'; readonly errorCode: string; readonly ambiguous: boolean }
  | { readonly kind: 'dead_lettered'; readonly errorCode: string }

interface LoadedBatch {
  /** In manifest order, which is the insert's row order. */
  readonly events: readonly PersistedEvent[]
  readonly messages: readonly StreamMessage[]
  /** Manifest message ids with no stream entry left (D-210 deletion). */
  readonly missingIds: readonly string[]
  /** Message ids whose payload no longer parses as an envelope. */
  readonly invalidIds: readonly string[]
}

/**
 * Fetch a manifest's payloads back from the stream, in manifest order.
 *
 * Manifest order, not stream order: the ClickHouse deduplication token only
 * recognises a retry that re-issues the same rows in the same order, and the
 * manifest is the only record of what that order was (02 §7.5).
 *
 * Two kinds of gap are tolerated and audited rather than being allowed to stall
 * the batch forever:
 *
 * - a **missing** entry, which is the deletion case: `XDEL` removes a site's
 *   entries without waiting for retention, so a pending id can legitimately
 *   resolve to nothing (plan Milestone 6 item 13);
 * - an **invalid** payload, which cannot become a row no matter how many times
 *   it is retried. Blocking the batch on it would stop every other event behind
 *   it, so it is dropped with a metric and the rest of the batch proceeds.
 */
async function loadBatch(deps: IngestDeps, manifest: Manifest): Promise<LoadedBatch> {
  const orderedIds = manifest.items.map((item) => item.messageId)
  const { messages, missingIds } = await deps.consumer.fetchByIds(orderedIds)
  const byId = new Map(messages.map((message) => [message.id, message]))

  const events: PersistedEvent[] = []
  const ordered: StreamMessage[] = []
  const invalidIds: string[] = []

  for (const id of orderedIds) {
    const message = byId.get(id)
    if (!message) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(message.payload)
    } catch {
      invalidIds.push(id)
      continue
    }

    const result = persistedEventSchema.safeParse(parsed)
    if (!result.success) {
      invalidIds.push(id)
      continue
    }

    events.push(result.data)
    ordered.push(message)
  }

  if (missingIds.length > 0) {
    deps.metrics.increment(WORKER_METRICS.messageMissing, {}, missingIds.length)
    deps.logger.warn('ingest_message_missing', {
      batch_id: manifest.batchId,
      count: missingIds.length,
      // The ids themselves, not the payloads: this is the audit trail D-210 asks
      // for, and it must not become a place event data leaks into logs.
      message_ids: missingIds,
    })
  }

  if (invalidIds.length > 0) {
    deps.metrics.increment(WORKER_METRICS.payloadInvalid, {}, invalidIds.length)
    deps.logger.error('ingest_payload_invalid', {
      batch_id: manifest.batchId,
      count: invalidIds.length,
      message_ids: invalidIds,
      retryable: false,
    })
  }

  return { events, messages: ordered, missingIds, invalidIds }
}

/** Distinct (site, generation) pairs a batch would write, with their row counts. */
function fenceRegistrationsFor(
  events: readonly PersistedEvent[],
): { siteId: string; ingestGeneration: number; rowCount: number }[] {
  const counts = new Map<string, { siteId: string; ingestGeneration: number; rowCount: number }>()

  for (const event of events) {
    // Keyed by both, so a batch spanning a generation bump registers each half
    // separately and the stale half can be dropped while the fresh half lands.
    const key = `${event.site_id}:${event.ingest_generation}`
    const existing = counts.get(key)
    if (existing) counts.set(key, { ...existing, rowCount: existing.rowCount + 1 })
    else
      counts.set(key, {
        siteId: event.site_id,
        ingestGeneration: event.ingest_generation,
        rowCount: 1,
      })
  }

  return [...counts.values()]
}

/**
 * Apply the D-210 fence and return the events that may be written.
 *
 * A dropped site's events are not written and never will be. The record of that
 * decision is the `ingest_batch_sites` row plus this metric — the audit trail
 * the plan requires — and the messages are still ACKed, because leaving them
 * pending forever would stall the queue behind a site that no longer exists.
 */
async function applyFence(
  deps: IngestDeps,
  manifest: Manifest,
  events: readonly PersistedEvent[],
): Promise<PersistedEvent[]> {
  const registrations = fenceRegistrationsFor(events)
  if (registrations.length === 0) return []

  const decisions = await registerBatchSites(deps.db, {
    batchId: manifest.batchId,
    registrations,
  })

  const dropped = new Set<string>()
  for (const decision of decisions) {
    if (decision.admitted) continue
    dropped.add(decision.siteId)
    deps.metrics.increment(WORKER_METRICS.fenceDropped, {
      reason: decision.dropReason ?? 'unknown',
    })
    deps.metrics.increment(
      WORKER_METRICS.fenceDroppedRows,
      { reason: decision.dropReason ?? 'unknown' },
      decision.rowCount,
    )
    deps.logger.warn('ingest_fence_dropped', {
      batch_id: manifest.batchId,
      site_id: decision.siteId,
      reason: decision.dropReason,
      observed_generation: decision.observedGeneration,
      observed_status: decision.observedStatus,
      rows: decision.rowCount,
    })
  }

  return events.filter((event) => !dropped.has(event.site_id))
}

function recordFreshness(deps: IngestDeps, events: readonly PersistedEvent[]): void {
  if (events.length === 0) return
  const now = deps.now().getTime()
  let total = 0
  for (const event of events) total += Math.max(0, now - new Date(event.accepted_at).getTime())

  deps.metrics.increment(WORKER_METRICS.freshnessMs, {}, total)
  deps.metrics.increment(WORKER_METRICS.freshnessTotal, {}, events.length)
}

/**
 * Run a manifest from whatever state it is in to a decided outcome.
 *
 * `recoveryActionFor` decides where to start, from the manifest and nothing
 * else. That is what makes crash recovery a resumption rather than a guess: a
 * worker that finds `inserted` knows the rows are durable and that the usage
 * transaction is what did not happen, regardless of which process wrote them or
 * how long ago.
 */
export async function runManifest(deps: IngestDeps, manifest: Manifest): Promise<BatchOutcome> {
  const action = recoveryActionFor(manifest.state)

  if (action === 'none') {
    // Already terminal. The messages may still be pending if the crash landed
    // between the state write and the ACK, so acknowledging again is both safe
    // and the only thing left to do.
    await deps.consumer.ack(manifest.items.map((item) => item.messageId))
    return { kind: 'completed', rows: 0, billable: 0 }
  }

  let state: IngestBatchState = manifest.state

  try {
    const batch = await loadBatch(deps, manifest)
    // The fence decisions are durable, so re-registering on a retry is a no-op
    // that returns the same answers. Computed once here and reused below rather
    // than recomputed per step, because a second fetch of the same payloads on
    // the happy path is pure latency in the freshness budget.
    const writable = await applyFence(deps, manifest, batch.events)

    if (action === 'insert') {
      const rows: EventsRawRow[] = writable.map((event) =>
        toEventsRawRow(event, { batchId: manifest.batchId }),
      )

      await markInserting(deps.db, manifest.batchId)
      state = 'inserting'

      if (rows.length > 0) {
        const started = Date.now()
        try {
          const result = await deps.clickhouse.insertEvents(rows, { token: manifest.batchId })
          deps.metrics.increment(WORKER_METRICS.insertTotal)
          deps.metrics.increment(WORKER_METRICS.insertMs, {}, result.durationMs)
          deps.metrics.increment(WORKER_METRICS.insertRows, {}, result.rows)
        } catch (error) {
          const ambiguous = error instanceof ClickHouseInsertError ? error.ambiguous : true
          deps.metrics.increment(WORKER_METRICS.insertError, { ambiguous: String(ambiguous) })
          deps.metrics.increment(WORKER_METRICS.insertMs, {}, Date.now() - started)
          throw error
        }
      }

      await markInserted(deps.db, manifest.batchId)
      state = 'inserted'
      recordFreshness(deps, writable)
    }

    if (state === 'inserted') {
      // Settled here rather than beside `markInserted`, so the *recovery* entry
      // point reaches it too. `recoveryActionFor('inserted')` is `record_usage`:
      // a worker that crashed between the insert and the settle resumes at this
      // block and skips the one above it, and settling only there left the
      // batch's fence rows `registered` for good — which is precisely what the
      // M10 deletion drain blocks on.
      await markBatchSitesWritten(deps.db, manifest.batchId)

      const attribution = await computeUsageAttribution(deps, writable)
      const applied = await applyBatchUsage(deps.db, {
        batchId: manifest.batchId,
        deltas: attribution.deltas,
      })

      for (const entry of applied) {
        deps.metrics.increment(
          entry.applied ? WORKER_METRICS.usageApplied : WORKER_METRICS.usageAlreadyApplied,
          {},
          entry.applied ? entry.delta.delta : 1,
        )
      }

      await markUsageRecorded(deps.db, manifest.batchId)
      state = 'usage_recorded'

      // The counter reconciliation and the rapid-burn notice, when a surface
      // keeps windows to reconcile against (`./usage.ts`). Both were called here
      // directly until the open-core split; both are best-effort by contract,
      // which is what lets them run after the state is already settled.
      await afterUsageApplied(deps, { applied, attribution, events: writable })

      // The install-verified signal (ADR-0027), in the same block and for the
      // same reasons as the two calls above it: this is the point where the
      // batch's rows are durable, so "an event reached the pipeline" is true
      // rather than hoped for, and recovery re-enters here too. It rides the
      // batch's per-site knowledge — one folded statement, guarded by
      // `first_event_at IS NULL`, skipped entirely for sites already filled —
      // and it is best-effort: a failure warns, exactly like the queue-age
      // gauge, because an onboarding checkmark must never be able to retry an
      // insert that already succeeded.
      await firstEventFill.record(deps, writable)
    }

    // Only now. Docs snapshot 05, D-209 step 6: the queue is not told to forget
    // an event until both the row and the usage unit are durable.
    const acked = await deps.consumer.ack(manifest.items.map((item) => item.messageId))
    deps.metrics.increment(WORKER_METRICS.acked, {}, acked)

    await markCompleted(deps.db, manifest.batchId)
    deps.metrics.increment(WORKER_METRICS.batchCompleted)

    const billable = batch.events.filter((event) => event.billable).length
    return { kind: 'completed', rows: batch.events.length, billable }
  } catch (error) {
    return await handleFailure(deps, manifest, error)
  }
}

async function handleFailure(
  deps: IngestDeps,
  manifest: Manifest,
  error: unknown,
): Promise<BatchOutcome> {
  const ambiguous = error instanceof ClickHouseInsertError ? error.ambiguous : true
  const errorCode = error instanceof ClickHouseInsertError ? error.code : 'unknown'
  const attempts = manifest.attempts + 1

  deps.logger.error('ingest_batch_failed', {
    batch_id: manifest.batchId,
    attempts,
    error_code: errorCode,
    ambiguous,
    err: error,
    retryable: attempts < deps.policy.WORKER_BATCH_MAX_ATTEMPTS,
  })

  if (attempts >= deps.policy.WORKER_BATCH_MAX_ATTEMPTS) {
    const { messages } = await deps.consumer.fetchByIds(
      manifest.items.map((item) => item.messageId),
    )
    await deps.maintenance.publishDeadLetter({
      batchId: manifest.batchId,
      reason: errorCode,
      messages,
    })
    await markDeadLettered(deps.db, { batchId: manifest.batchId, errorCode })
    // ACKed only after the payloads are in the dead-letter stream. The order is
    // the same rule as the happy path: nothing is forgotten by the queue until
    // it exists somewhere else.
    await deps.consumer.ack(manifest.items.map((item) => item.messageId))
    deps.metrics.increment(WORKER_METRICS.batchDeadLettered, { error_code: errorCode })
    return { kind: 'dead_lettered', errorCode }
  }

  await markAttemptFailed(deps.db, {
    batchId: manifest.batchId,
    errorCode,
    retryDelayMs: retryDelayMs(attempts, deps.policy),
    ambiguous,
  })
  deps.metrics.increment(WORKER_METRICS.batchRetried, { ambiguous: String(ambiguous) })
  return { kind: 'retry', errorCode, ambiguous }
}
