import type { IngestDeps } from './deps.ts'
import { runCeilingDayCheck, runUsageReconciliation } from './operations.ts'

/**
 * The periodic half of the operational jobs.
 *
 * Rapid burn is not here: it runs on the batch that observes the crossing,
 * because the value of "you are burning your month in a day" decays quickly. The
 * two below are the opposite — a reconciliation drift and a three-day ceiling
 * streak are both slow facts, and running them on the ingest path would put a
 * ClickHouse aggregate in front of every batch.
 *
 * Failures are logged and swallowed. These jobs *observe* the system, and an
 * observer that can stop ingest has the relationship backwards.
 */

export interface OperationsJobHandle {
  /** Runs one pass immediately. Exposed so a test does not wait for a timer. */
  runOnce(): Promise<void>
  stop(): Promise<void>
}

export const DEFAULT_RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000
export const DEFAULT_CEILING_CHECK_INTERVAL_MS = 60 * 60 * 1000

export function startOperationsJobs(
  deps: IngestDeps,
  options: {
    readonly reconciliationIntervalMs?: number
    readonly ceilingIntervalMs?: number
  } = {},
): OperationsJobHandle {
  const reconciliationIntervalMs =
    options.reconciliationIntervalMs ?? DEFAULT_RECONCILIATION_INTERVAL_MS
  const ceilingIntervalMs = options.ceilingIntervalMs ?? DEFAULT_CEILING_CHECK_INTERVAL_MS
  let stopped = false

  const guarded = async (name: string, run: () => Promise<unknown>): Promise<void> => {
    if (stopped) return
    try {
      await run()
    } catch (err) {
      deps.logger.error('operations_job_failed', { job: name, err, retryable: true })
    }
  }

  const reconciliationTimer = setInterval(() => {
    void guarded('usage_reconciliation', () => runUsageReconciliation(deps))
  }, reconciliationIntervalMs)
  reconciliationTimer.unref?.()

  const ceilingTimer = setInterval(() => {
    void guarded('ceiling_day_check', () => runCeilingDayCheck(deps))
  }, ceilingIntervalMs)
  ceilingTimer.unref?.()

  return {
    async runOnce(): Promise<void> {
      await guarded('usage_reconciliation', () => runUsageReconciliation(deps))
      await guarded('ceiling_day_check', () => runCeilingDayCheck(deps))
    },
    async stop(): Promise<void> {
      stopped = true
      clearInterval(reconciliationTimer)
      clearInterval(ceilingTimer)
    },
  }
}
