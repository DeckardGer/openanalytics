import {
  deleteManifestsCompletedBefore,
  sweepAssistantUsageLedger,
  sweepIdempotencyKeys,
  sweepExpiredDeviceCodes,
  sweepReadCostLedger,
} from '@openanalytics/postgres'
import type { IngestDeps } from './deps.ts'
import { WORKER_METRICS } from './metrics.ts'

/**
 * Retention trimmer (plan Milestone 6 item 9; docs snapshot 05, D-216).
 *
 * ACKed payloads are kept for `ACKED_QUEUE_RETENTION_DAYS` so a ClickHouse
 * restore can be repaired from the queue rather than from nothing. That is why
 * an ACK does not delete the stream entry and why the site queue index is not
 * cleared on ACK either — deletion removes a site's entries early and
 * deliberately (D-210), but ordinary completion does not.
 *
 * Two things expire on their own and are deliberately not touched here: the
 * dedup records and the site queue index both carry TTLs set when they were
 * written, and `policySchema` already enforces that the index outlives the
 * payload retention. A trimmer that also deleted them would be a second, racing
 * opinion about the same horizon.
 *
 * The manifest is trimmed on the same horizon, and never sooner: it is what
 * bounds a disaster replay, so it has to outlive the entries it describes.
 *
 * The inbound idempotency ledger is swept here too, on its own pair of horizons
 * (ADR-0019 known gap 4, closed by the amendment dated 2026-08-06). It shares
 * nothing with the queue but the schedule, and this is the home ADR-0019 named
 * for it: a table whose rows expire on wall-clock age, in the one process that
 * already wakes up hourly to retire things. Its horizons are hours where these
 * are days, which is why it takes its own two policy values rather than
 * borrowing `ACKED_QUEUE_RETENTION_DAYS`.
 */

export interface TrimResult {
  readonly streamTrimmed: number
  readonly manifestsRemoved: number
  readonly idempotencyKeysSwept: number
  readonly readCostBucketsSwept: number
  readonly assistantUsageBucketsSwept: number
  readonly deviceCodesSwept: number
  readonly minId: string
}

export async function runRetentionTrim(
  deps: IngestDeps,
  options: { readonly manifestLimit?: number; readonly idempotencyLimit?: number } = {},
): Promise<TrimResult> {
  const retentionMs = deps.policy.ACKED_QUEUE_RETENTION_DAYS * 24 * 60 * 60 * 1000
  const before = new Date(deps.now().getTime() - retentionMs)

  const { trimmed, minId } = await deps.maintenance.trimAcked({ before })
  if (trimmed > 0) deps.metrics.increment(WORKER_METRICS.queueTrimmed, {}, trimmed)

  // Strictly after the stream trim. A manifest removed while its entries were
  // still replayable would leave payloads that D-216's selection cannot classify
  // — and an unclassifiable payload is one a replay either skips or duplicates.
  const manifestsRemoved = await deleteManifestsCompletedBefore(deps.db, {
    before,
    limit: options.manifestLimit ?? 500,
  })

  // Independent of the queue horizon above, and deliberately not inside the
  // `trimmed > 0` guard: the ledger fills from the management API, which is
  // busy on days the event queue is idle and idle on days it is busy.
  const now = deps.now().getTime()
  const hour = 60 * 60 * 1000
  const idempotencyKeysSwept = await sweepIdempotencyKeys(deps.db, {
    completedBefore: new Date(now - deps.policy.IDEMPOTENCY_KEY_RETENTION_HOURS * hour),
    claimedBefore: new Date(now - deps.policy.IDEMPOTENCY_CLAIM_MAX_AGE_HOURS * hour),
    limit: options.idempotencyLimit ?? 500,
  })

  // The read-cost ledger's hourly buckets (ADR-0043 D7), on the same schedule
  // and for the same reason the idempotency ledger is here: a table whose rows
  // expire on wall-clock age, swept by the one process that already wakes hourly
  // to retire things. Its horizon is fixed at 48 hours inside the statement
  // rather than being a policy value — the rolling window is 24 hours and is not
  // configurable, so a second number here could only ever disagree with it.
  const readCostBucketsSwept = await sweepReadCostLedger(deps.db)

  // The assistant's question ledger (ADR-0046 D5), beside its twin and on the
  // same fixed 48-hour horizon: the rolling window is a day and is not
  // configurable, so a policy value here could only ever disagree with it.
  const assistantUsageBucketsSwept = await sweepAssistantUsageLedger(deps.db)

  // Abandoned device authorizations (ADR-0043 D13). The token exchange deletes a
  // code whenever it is polled, so this only ever finds the flows that never
  // ended — a CLI killed mid-login, a link nobody opened. Without it those rows
  // are unreachable and permanent.
  const deviceCodesSwept = await sweepExpiredDeviceCodes(deps.db)

  if (
    trimmed > 0 ||
    manifestsRemoved > 0 ||
    idempotencyKeysSwept > 0 ||
    readCostBucketsSwept > 0 ||
    assistantUsageBucketsSwept > 0 ||
    deviceCodesSwept > 0
  ) {
    deps.logger.info('ingest_retention_trimmed', {
      stream_trimmed: trimmed,
      manifests_removed: manifestsRemoved,
      idempotency_keys_swept: idempotencyKeysSwept,
      read_cost_buckets_swept: readCostBucketsSwept,
      assistant_usage_buckets_swept: assistantUsageBucketsSwept,
      device_codes_swept: deviceCodesSwept,
      min_id: minId,
      retention_days: deps.policy.ACKED_QUEUE_RETENTION_DAYS,
      idempotency_retention_hours: deps.policy.IDEMPOTENCY_KEY_RETENTION_HOURS,
      idempotency_claim_max_age_hours: deps.policy.IDEMPOTENCY_CLAIM_MAX_AGE_HOURS,
    })
  }

  return {
    streamTrimmed: trimmed,
    manifestsRemoved,
    idempotencyKeysSwept,
    readCostBucketsSwept,
    assistantUsageBucketsSwept,
    deviceCodesSwept,
    minId,
  }
}

export interface TrimmerHandle {
  stop(): Promise<void>
}

/**
 * Runs the trim on an interval.
 *
 * Hourly by default rather than continuously: retention is measured in days, so
 * a trim that ran every second would spend its time proving there is nothing to
 * do. The interval is unref'd so it never keeps the process alive on its own.
 */
export function startRetentionTrimmer(
  deps: IngestDeps,
  options: { readonly intervalMs?: number } = {},
): TrimmerHandle {
  const intervalMs = options.intervalMs ?? 60 * 60 * 1000
  let stopped = false

  const timer = setInterval(() => {
    if (stopped) return
    void runRetentionTrim(deps).catch((err: unknown) => {
      deps.logger.error('ingest_retention_trim_failed', { err, retryable: true })
    })
  }, intervalMs)
  timer.unref?.()

  return {
    async stop(): Promise<void> {
      stopped = true
      clearInterval(timer)
    },
  }
}
