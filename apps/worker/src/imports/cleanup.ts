import type { ImportedAggregatesMaintenance } from '@openanalytics/clickhouse'
import type { ObjectStorage } from '@openanalytics/integrations'
import type { Logger } from '@openanalytics/observability'
import {
  claimImportRunForCleanup,
  releaseImportRunCleanupClaim,
  type CleanableImportRun,
  type Executor,
} from '@openanalytics/postgres'

/**
 * Erase one import run's staged rows and uploaded archive (ADR-0032, D3/D7).
 *
 * Three callers reach it — the publish job's grandparent cleanup, the lifecycle
 * sweeper's backstop, and the prepare job's failure path — and they must all do
 * exactly the same thing in exactly the same order, which is why it is one
 * function rather than three similar loops.
 *
 * ## Order: claim, ClickHouse, object
 *
 * **The claim is first, and it has to be.** The candidate list is read outside
 * any transaction and the deletes below take seconds; in that window a
 * concurrent rollback can restore a `superseded` candidate to `published`, and
 * erasing its rows afterwards would empty a dashboard the customer had just
 * asked to see again. `claimImportRunForCleanup` is a guarded
 * `UPDATE … RETURNING` that both excludes a second cleaner and refuses a run
 * whose state has moved, and `rollbackImportRun` refuses to restore a
 * predecessor whose claim is set — so whichever writes first wins and the loser
 * is told. Ordering the marker last, which is the intuitive choice, is precisely
 * what leaves that race open.
 *
 * The cost of claiming first is that a failed ClickHouse delete would leave the
 * run marked with its rows still present — a leak nothing revisits, since the
 * marker is what removes it from the backstop's candidate set. So that one
 * failure **releases the claim** and reports false.
 *
 * The **object delete does not release it**, and the asymmetry is deliberate:
 * the bucket's `imports/` lifecycle rule expires the prefix on its own schedule
 * (D1), so storage has a backstop of its own, while ClickHouse rows have none
 * but this. Re-examining the run forever to chase one object would re-issue
 * eight mutations a tick for work already done.
 *
 * Returns false when nothing was done and the run should be looked at again.
 */

export interface ImportCleanupDeps {
  readonly db: Executor
  readonly logger: Logger
  /** The `oa_maintenance` ClickHouse client. Absent, the cleanup is deferred
   * rather than skipped: a run marked swept without its rows deleted is a leak
   * with a note saying it was handled. */
  readonly maintenance?: ImportedAggregatesMaintenance | undefined
  readonly objectStorage?: ObjectStorage | undefined
}

export async function cleanImportRun(
  deps: ImportCleanupDeps,
  run: CleanableImportRun,
): Promise<boolean> {
  if (!deps.maintenance) {
    deps.logger.warn('import_cleanup_deferred', {
      site_id: run.siteId,
      import_run_id: run.importRunId,
      reason: 'clickhouse maintenance credential not configured',
      retryable: true,
    })
    return false
  }

  // Atomic, and before any store work. A run somebody else claimed, or one that
  // is no longer in a cleanable state because a rollback republished it, is
  // simply not this caller's.
  if (!(await claimImportRunForCleanup(deps.db, { importRunId: run.importRunId }))) {
    deps.logger.info('import_cleanup_not_claimed', {
      site_id: run.siteId,
      import_run_id: run.importRunId,
    })
    return false
  }

  try {
    await deps.maintenance.deleteImportRunRows({
      siteId: run.siteId,
      importRunId: run.importRunId,
    })
  } catch (err) {
    // Hand the claim back: a run left marked with its rows still there is a leak
    // the backstop would never look at again.
    await releaseImportRunCleanupClaim(deps.db, { importRunId: run.importRunId })
    deps.logger.warn('import_cleanup_clickhouse_failed', {
      site_id: run.siteId,
      import_run_id: run.importRunId,
      err,
      retryable: true,
    })
    return false
  }

  if (run.objectKey !== null && deps.objectStorage) {
    try {
      await deps.objectStorage.delete([{ key: run.objectKey }])
    } catch (err) {
      // Not a reason to leave the run unswept: the lifecycle rule reaps the
      // prefix, and re-examining the run forever would re-issue eight ClickHouse
      // mutations per pass to chase one object storage already expires.
      deps.logger.warn('import_cleanup_object_delete_failed', {
        site_id: run.siteId,
        import_run_id: run.importRunId,
        err,
        retryable: true,
      })
    }
  }

  deps.logger.info('import_cleanup_done', {
    site_id: run.siteId,
    import_run_id: run.importRunId,
  })
  return true
}
