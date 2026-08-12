import { decideDailyCeiling } from '@openanalytics/domain'
import { listCompletedBatchLedgerTotals, listRecentlyIngestedSites } from '@openanalytics/postgres'
import type { IngestDeps } from './deps.ts'
import { WORKER_METRICS } from './metrics.ts'

/**
 * The operational jobs the worker owns (plan Milestone 6 item 11 and an ADR-0009
 * carry-forward).
 *
 * They share a shape: each one exists because a rule was decided in an earlier
 * milestone and left without anything to enforce it. Usage reconciliation is the
 * measurement that would catch every correctness bug this milestone claims to
 * have prevented; the ceiling-days alert is a G-005 rule whose predicate shipped
 * in M5 with nothing to evaluate it.
 *
 * There were three until the open-core split: the rapid-burn notice compares a
 * day's traffic against a *plan's* monthly limit, so it left with the plans
 * (`../cloud/usage.ts`). The ceiling alert stayed, because
 * `SITE_DAILY_EVENT_CEILING` is an abuse throttle every deployment has.
 */

// ---------------------------------------------------------------------------
// Usage reconciliation (plan Milestone 6 item 11)
// ---------------------------------------------------------------------------

export interface ReconciliationReport {
  readonly batchesChecked: number
  /** Batches where ClickHouse and the ledger disagree. */
  readonly drifting: readonly { batchId: string; clickhouse: number; ledger: number }[]
  readonly totalDrift: number
}

/**
 * Compare billable rows in ClickHouse against the Postgres usage ledger.
 *
 * This is the measurement that would catch every correctness failure M6 claims
 * to prevent, from the outside: a duplicated insert, a lost usage delta, a
 * double-applied batch. Both sides are keyed on `batch_id` — which is why the
 * column is on `events_raw` at all — so a disagreement names the batch rather
 * than a day.
 *
 * Only `completed` batches are compared. A batch mid-pipeline is *expected* to
 * disagree: rows land in ClickHouse before the usage transaction commits, and
 * counting that window as drift would make the metric alarm on the system
 * working correctly.
 *
 * Zero drift is published as well as non-zero. A drift gauge that only appears
 * when something is wrong is indistinguishable from a job that stopped running.
 */
export async function runUsageReconciliation(
  deps: IngestDeps,
  options: { readonly sinceMs?: number; readonly limit?: number } = {},
): Promise<ReconciliationReport> {
  const sinceMs = options.sinceMs ?? 60 * 60 * 1000
  const limit = options.limit ?? 500
  const since = new Date(deps.now().getTime() - sinceMs)

  const rows = await listCompletedBatchLedgerTotals(deps.db, { since, limit })

  if (rows.length === 0) {
    deps.metrics.gauge(WORKER_METRICS.reconciliationDrift, 0)
    return { batchesChecked: 0, drifting: [], totalDrift: 0 }
  }

  const batchIds = rows.map((row) => row.batchId)
  const clickhouse = await deps.clickhouse.countBillableByBatch(batchIds)

  const drifting: { batchId: string; clickhouse: number; ledger: number }[] = []
  let totalDrift = 0

  for (const row of rows) {
    const inClickHouse = clickhouse.get(row.batchId) ?? 0
    if (inClickHouse === row.ledger) continue

    totalDrift += Math.abs(inClickHouse - row.ledger)
    drifting.push({ batchId: row.batchId, clickhouse: inClickHouse, ledger: row.ledger })
  }

  deps.metrics.gauge(WORKER_METRICS.reconciliationDrift, totalDrift)
  deps.metrics.gauge(WORKER_METRICS.reconciliationBatches, rows.length)

  for (const entry of drifting) {
    deps.logger.error('usage_reconciliation_drift', {
      batch_id: entry.batchId,
      clickhouse_billable: entry.clickhouse,
      ledger_delta: entry.ledger,
      retryable: false,
    })
  }

  return { batchesChecked: rows.length, drifting, totalDrift }
}

// ---------------------------------------------------------------------------
// The G-005 consecutive-ceiling-days internal alert (ADR-0009 carry-forward)
// ---------------------------------------------------------------------------

export interface CeilingAlert {
  readonly siteId: string
  readonly consecutiveDays: number
}

/**
 * Count consecutive days a site has hit its daily safety ceiling, and raise the
 * internal alert on the third (G-005).
 *
 * `decideDailyCeiling` has taken `consecutiveCeilingDays` since M5 and nothing
 * has ever supplied it — the collector sees one day at a time and may not write
 * Postgres on the ingest path, so the count needed a component with a longer
 * memory. The daily counters the collector already maintains are that memory;
 * they only had to outlive their own day, which is why the ceiling counter's TTL
 * now spans the alert window (see `createRealtimeCache`).
 *
 * Sites are taken from what the worker has recently ingested rather than from a
 * full site list: a site at its daily ceiling is by definition sending traffic,
 * so the set that could possibly qualify is exactly the set that has been busy.
 * That bounds the job without a limit that could silently truncate it.
 *
 * The output is an alert and nothing else. G-005 is explicit that a persistently
 * pathological site is the operator's decision, never an automatic block.
 */
export async function runCeilingDayCheck(
  deps: IngestDeps,
  options: { readonly activeSinceMs?: number } = {},
): Promise<CeilingAlert[]> {
  const cache = deps.cache
  if (!cache) return []

  const activeSince = new Date(
    deps.now().getTime() - (options.activeSinceMs ?? 24 * 60 * 60 * 1000),
  )
  const days = deps.policy.SITE_CEILING_ALERT_CONSECUTIVE_DAYS

  const siteIds = await listRecentlyIngestedSites(deps.db, { since: activeSince })
  if (siteIds.length === 0) return []

  const alerts: CeilingAlert[] = []

  for (const siteId of siteIds) {
    // Yesterday backwards. Today is deliberately excluded: a day still in
    // progress has not hit its ceiling until it has, and counting a partial day
    // would make the alert fire a day early roughly half the time.
    const counts = await cache.readDailyCeilingCounts({
      siteId,
      endingBefore: deps.now(),
      days,
    })

    let consecutive = 0
    for (const count of counts) {
      if (count < deps.policy.SITE_DAILY_EVENT_CEILING) break
      consecutive += 1
    }

    const decision = decideDailyCeiling({
      dailyCount: 0,
      cost: 0,
      now: deps.now(),
      policy: deps.policy,
      consecutiveCeilingDays: consecutive,
    })

    if (!decision.alertOperator) continue

    alerts.push({ siteId, consecutiveDays: consecutive })
    deps.metrics.increment(WORKER_METRICS.ceilingDaysAlert, { site_id: siteId })
    deps.logger.warn('site_daily_ceiling_streak', {
      site_id: siteId,
      consecutive_days: consecutive,
      ceiling: deps.policy.SITE_DAILY_EVENT_CEILING,
      // G-005: the system throttles and reports. What happens next is a human
      // decision, so this is a warning and not an automated action.
      retryable: false,
    })
  }

  return alerts
}
