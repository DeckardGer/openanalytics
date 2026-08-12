import type { ImportedAggregatesMaintenance } from '@openanalytics/clickhouse'
import type { ObjectStorage } from '@openanalytics/integrations'
import type { Logger, Metrics } from '@openanalytics/observability'
import {
  listCleanableImportRuns,
  listExpiredImportUploads,
  transitionImportRun,
  type Database,
} from '@openanalytics/postgres'
import { cleanImportRun } from '../imports/cleanup.ts'
import { WORKER_METRICS } from '../ingest/metrics.ts'

/**
 * The lifecycle sweeper (ADR-0030, decision 2).
 *
 * Duties of one kind: a deadline has passed and no event is coming to say so.
 *
 * Two are the product's, and a registered surface may add more
 * (`registerLifecycleDuty`) — which is where the two this file used to open with
 * went. **Entitlement expiry** and **retention deletion** both start from a
 * commercial deadline: a cancelled subscription's paid period running out, and a
 * suspended site reaching the deletion date it was promised. A deployment that
 * sells nothing has neither, and an OSS sweeper that deleted sites on a retention
 * countdown nothing sets would be the most dangerous kind of dead code.
 *
 * 1. **Abandoned import uploads** (ADR-0032, D7). A signed upload URL is handed
 *    to a browser and nothing guarantees the browser comes back — the tab is
 *    closed, the network drops, the customer changes their mind. The run then
 *    sits in `uploading` forever, and because a site may hold only one
 *    non-terminal run (D3), it blocks every later import of that site. Past
 *    `IMPORT_UPLOAD_TTL_DAYS` the run is failed with `upload_expired` and its
 *    object deleted. The bucket's own lifecycle rule expires the same prefix on
 *    the same schedule; that is the backstop for objects our bookkeeping lost
 *    track of, and this is the mechanism of record.
 * 2. **Terminal import-run cleanup** (ADR-0032, D7), the backstop described at
 *    `sweepCleanableImportRuns`.
 *
 * **Replica safety.** Every duty pages with `FOR UPDATE SKIP LOCKED`, which
 * keeps two sweepers from queueing behind each other on the same rows *at the
 * instant of the SELECT*. It is not a guarantee that their pages stay disjoint:
 * the locks are released when the discovery transaction commits, long before the
 * per-item work runs, so a sweeper that starts a moment later can and will
 * re-serve rows the first one is still processing. The skip is therefore an
 * efficiency, and correctness comes entirely from each item being idempotent on
 * its own. An expiry re-derives under its own row lock and keys its outbox row on
 * the stored deadline and provider snapshot; a retention start takes the site row
 * `FOR UPDATE` and returns the existing request for a site that is already
 * `deleting`; an import expiry's transition names the states it may leave, so the
 * second sweeper to reach a run simply does not match. All three are database
 * facts rather than timing arguments. Two sweepers that do see the same row
 * produce one effect between them, and a registered duty is held to the same
 * standard — it is called on every tick of every replica.
 *
 * Failures are per item. A single subscription that throws must not stop the
 * other expiries or the retention half of the same tick — the next tick retries
 * it five minutes later, which is exactly the right cadence for work whose
 * deadline is measured in days.
 */

const DEFAULT_INTERVAL_MS = 300_000
const DEFAULT_PAGE_SIZE = 100

export interface LifecycleSweeperDeps {
  readonly db: Database
  readonly logger: Logger
  readonly metrics: Metrics
  /** `LIFECYCLE_SWEEP_PAGE_SIZE`. Rows taken per duty per tick. */
  readonly pageSize?: number
  /** `LIFECYCLE_SWEEP_INTERVAL_MS`. */
  readonly intervalMs?: number
  /**
   * `IMPORT_UPLOAD_TTL_DAYS`. Absent, the import sweep does not run at all —
   * the optional-until-used rule applied to a duty rather than a credential, so
   * a deployment that predates M11 keeps exactly its previous behaviour.
   */
  readonly importUploadTtlDays?: number
  /** The bucket, when configured. The sweep still fails an expired run without
   * it; only the object deletion is skipped, and the bucket's own lifecycle rule
   * is what reaps the bytes in that case. */
  readonly objectStorage?: ObjectStorage
  /**
   * The `oa_maintenance` ClickHouse client, for the terminal-run cleanup
   * backstop (ADR-0032, D7).
   *
   * Absent, that duty **defers rather than skips**: a run is left unswept and
   * looked at again next tick, because marking it clean without deleting its
   * rows would be a leak with a note saying it was handled. Every other duty is
   * unaffected — the sweeper's whole shape is that one missing resource cannot
   * stop the others.
   */
  readonly importedAggregatesMaintenance?: ImportedAggregatesMaintenance
  /** Test seam: the instant both deadlines are compared against. */
  readonly now?: Date
}

export interface LifecycleSweepResult {
  /** Import runs failed as `upload_expired` this tick. */
  readonly importUploadsExpired: number
  /** Terminal import runs whose staged rows and archive were cleaned this tick. */
  readonly importRunsCleaned: number
  /**
   * What the registered duties counted, merged by their own key names.
   *
   * A bag rather than named fields, because the product cannot name a counter for
   * a duty it does not have: the four the hosted sweep reports —
   * `candidates`, `expired`, `retentionDue`, `deletionsEnqueued` — were fields on
   * this interface until the open-core split, and they are the same numbers under
   * the same names in the same log line.
   */
  readonly extra: Readonly<Record<string, number>>
  readonly failures: number
}

/**
 * A deadline duty a registered surface adds.
 *
 * The contract is the one the product's own duties keep and the header's
 * replica-safety paragraph explains: it is called on every tick of every replica,
 * it must be idempotent per item, and a throw inside it must not stop the other
 * duties — which is why it reports failures rather than raising them.
 */
export interface LifecycleDuty {
  readonly name: string
  readonly sweep: (deps: SweepDeps) => Promise<{
    readonly counts: Readonly<Record<string, number>>
    readonly failures: number
  }>
}

const duties: LifecycleDuty[] = []

/** Idempotent by name, so importing the surface twice registers once. */
export function registerLifecycleDuty(duty: LifecycleDuty): void {
  if (duties.some((registered) => registered.name === duty.name)) return
  duties.push(duty)
}

export type SweepDeps = Pick<
  LifecycleSweeperDeps,
  | 'db'
  | 'logger'
  | 'metrics'
  | 'pageSize'
  | 'now'
  | 'importUploadTtlDays'
  | 'objectStorage'
  | 'importedAggregatesMaintenance'
>

/**
 * Fail every import run whose upload never arrived (ADR-0032, D7).
 *
 * **The deadline is decided in SQL, against `now()`.** `import_runs.created_at`
 * is stamped by the database, and a worker whose clock runs even minutes ahead
 * would otherwise expire runs that are not expired — deleting an object a
 * customer's browser is at that moment still uploading to. The comparison lives
 * in `listExpiredImportUploads`, which is the M10 rule (`claimDueJobs` compares
 * the same way and for the same reason) and the reason `deps.now` is deliberately
 * not threaded into this duty the way it is into the other two.
 *
 * The order inside each item is state first, object second. The transition is
 * guarded on `('uploading','uploaded')`, so a run that a `complete` call moved
 * between the page read and this write simply does not match and its object is
 * left alone — whereas deleting first would have destroyed the archive of a run
 * that had just legitimately become someone's live import. The object delete is
 * best-effort for the same reason it is second: the run is already terminal, the
 * bucket lifecycle rule reaps the prefix anyway, and a storage outage must not
 * hold the site's import slot open.
 */
async function sweepExpiredImportUploads(
  deps: SweepDeps,
): Promise<{ expired: number; failures: number }> {
  const ttlDays = deps.importUploadTtlDays
  if (ttlDays === undefined) return { expired: 0, failures: 0 }

  const limit = deps.pageSize ?? DEFAULT_PAGE_SIZE
  const candidates = await listExpiredImportUploads(deps.db, { ttlDays, limit })

  let expired = 0
  let failures = 0

  for (const candidate of candidates) {
    try {
      const moved = await transitionImportRun(deps.db, {
        importRunId: candidate.importRunId,
        from: ['uploading', 'uploaded'],
        to: 'failed',
        errorCode: 'upload_expired',
        finished: true,
      })
      // The candidate list is a hint, never the decision: a `complete` call
      // between the page read and this write is a normal outcome, not a failure.
      if (!moved) continue
      expired += 1
      deps.metrics.increment(WORKER_METRICS.lifecycleImportUploadsExpired)
      deps.logger.info('lifecycle_import_upload_expired', {
        site_id: candidate.siteId,
        import_run_id: candidate.importRunId,
        ttl_days: ttlDays,
      })

      if (candidate.objectKey !== null && deps.objectStorage) {
        try {
          await deps.objectStorage.delete([{ key: candidate.objectKey }])
        } catch (err) {
          // Not a sweep failure: the run is already terminal and the bucket's
          // `imports/` expiry rule is the backstop for exactly this orphan.
          deps.logger.warn('lifecycle_import_object_delete_failed', {
            site_id: candidate.siteId,
            import_run_id: candidate.importRunId,
            err,
            retryable: true,
          })
        }
      }
    } catch (err) {
      failures += 1
      deps.logger.error('lifecycle_import_expiry_failed', {
        site_id: candidate.siteId,
        import_run_id: candidate.importRunId,
        err,
        retryable: true,
      })
    }
  }

  return { expired, failures }
}

/**
 * Erase the staged rows and archives of runs nothing else will (ADR-0032, D7).
 *
 * The backstop, not the mechanism of record. A run's staged rows are deleted by
 * the job that failed it or by the publish that made it a grandparent; this duty
 * exists because a worker can die between the state change and the cleanup, and
 * because a site that never imports again would leave its last grandparent
 * behind forever.
 *
 * Which runs it covers is the interesting part, and it is the D3 rollback rule
 * expressed as a predicate: `failed`, `discarded` and `rolled_back` are cleanable
 * once they are past the TTL, and `superseded` is cleanable only when it is **no
 * longer any run's `superseded_run_id`**. That last clause is what keeps the one
 * rollback generation alive — a superseded run that some published run still
 * points at is the thing a rollback would restore, and erasing its ClickHouse
 * rows would make that rollback silently produce an empty dashboard.
 *
 * The deadline is computed in SQL against `now()` (the M10 rule), so a worker
 * whose clock runs ahead cannot erase a run that is still inside its window.
 * `deps.now` is deliberately not threaded in, for the same reason the
 * abandoned-upload duty does not thread it.
 *
 * A run whose cleanup fails is simply not marked, so the next tick tries again.
 * That is the whole recovery mechanism, and it is why `swept_at` is written last.
 */
async function sweepCleanableImportRuns(
  deps: SweepDeps,
): Promise<{ cleaned: number; failures: number }> {
  const ttlDays = deps.importUploadTtlDays
  if (ttlDays === undefined) return { cleaned: 0, failures: 0 }

  const limit = deps.pageSize ?? DEFAULT_PAGE_SIZE
  const candidates = await listCleanableImportRuns(deps.db, { ttlDays, limit })

  let cleaned = 0
  let failures = 0

  for (const candidate of candidates) {
    try {
      const done = await cleanImportRun(
        {
          db: deps.db,
          logger: deps.logger,
          ...(deps.importedAggregatesMaintenance
            ? { maintenance: deps.importedAggregatesMaintenance }
            : {}),
          ...(deps.objectStorage ? { objectStorage: deps.objectStorage } : {}),
        },
        candidate,
      )
      if (!done) continue
      cleaned += 1
      deps.metrics.increment(WORKER_METRICS.lifecycleImportRunsCleaned)
    } catch (err) {
      failures += 1
      deps.logger.error('lifecycle_import_cleanup_failed', {
        site_id: candidate.siteId,
        import_run_id: candidate.importRunId,
        err,
        retryable: true,
      })
    }
  }

  return { cleaned, failures }
}

/** One tick: every duty, in order, none able to stop the others. */
export async function sweepLifecycleOnce(deps: SweepDeps): Promise<LifecycleSweepResult> {
  const imports = await sweepExpiredImportUploads(deps)
  const cleanup = await sweepCleanableImportRuns(deps)

  // Registered duties run first in the *log line* and last in execution order,
  // for the reason the product's own duties are ordered as they are: none of them
  // depends on another, and a new duty must not be able to delay an existing one
  // by throwing. A duty that throws outright — rather than reporting failures —
  // is counted as one failure and the rest still run.
  const extra: Record<string, number> = {}
  let extraFailures = 0
  for (const duty of duties) {
    try {
      const result = await duty.sweep(deps)
      for (const [key, value] of Object.entries(result.counts)) {
        extra[key] = (extra[key] ?? 0) + value
      }
      extraFailures += result.failures
    } catch (err) {
      extraFailures += 1
      deps.logger.error('lifecycle_duty_failed', { duty: duty.name, err, retryable: true })
    }
  }

  return {
    importUploadsExpired: imports.expired,
    importRunsCleaned: cleanup.cleaned,
    extra,
    failures: imports.failures + cleanup.failures + extraFailures,
  }
}

export interface LifecycleSweeper {
  stop(): Promise<void>
}

export function startLifecycleSweeper(deps: LifecycleSweeperDeps): LifecycleSweeper {
  let running = false
  let stopped = false

  const tick = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      const { extra, ...counts } = await sweepLifecycleOnce(deps)
      // Flattened, so a registered duty's counters read in the log line exactly
      // as they did when they were fields on the result.
      const result = { ...counts, ...extra }
      if (Object.values(result).some((value) => value > 0)) {
        deps.logger.info('lifecycle_swept', result)
      }
    } catch (err) {
      deps.logger.error('lifecycle_sweep_failed', { err, retryable: true })
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => void tick(), deps.intervalMs ?? DEFAULT_INTERVAL_MS)
  // The sweeper must not by itself keep the process alive.
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
