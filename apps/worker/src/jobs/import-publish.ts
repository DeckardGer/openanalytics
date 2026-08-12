import {
  IMPORT_PUBLISH_JOB_TYPE,
  listCleanableSiteImportRuns,
  publishImportRun,
  readImportRun,
  transitionImportRun,
} from '@openanalytics/postgres'
import { cleanImportRun } from '../imports/cleanup.ts'
import type { JobExecutor, JobOutcome, JobRegistration } from './runner.ts'

/**
 * The `import_publish` executor (ADR-0032, D3/D7).
 *
 * Two steps with a hard boundary between them:
 *
 * 1. **The swap** — one Postgres transaction that takes the site row
 *    `FOR UPDATE`, moves the run to `published`, records the run it superseded,
 *    demotes that one, and moves the pointer. All of it commits together, so
 *    there is no instant at which the pointer names a run that is not published
 *    and none at which two runs claim to be.
 * 2. **The cleanup** — deleting the *grandparent's* staged rows and archive,
 *    strictly **outside** that transaction (D3: "it never runs inside the
 *    publish transaction"). ClickHouse mutations are not transactional and
 *    cannot be rolled back with a Postgres statement, so a cleanup inside the
 *    swap would be a delete that survived a rolled-back publish.
 *
 * **Retry-safe by state, not by key.** A lease stolen between the commit and the
 * settlement means this executor runs again over a run that is already
 * `published`; `publishImportRun` reports `swapped: false` with the recorded
 * predecessor and this job goes straight to the cleanup. That is the whole
 * reason the predecessor is a column rather than an inference — after the swap,
 * "which run did this one supersede" has no other answer.
 *
 * The customer's data is never at risk from this job failing: a publish that
 * never completes leaves the pointer where it was, and the old published run
 * stays live (the plan-04 acceptance criterion).
 */

const RESOURCE_RETRY_MS = 30_000
/** Cleanup is bounded per attempt so one publish cannot issue mutations for a
 * site's entire import history in a single lease. Whatever is left is picked up
 * by the next publish or by the sweeper's backstop. */
const CLEANUP_LIMIT = 20

const executeImportPublish: JobExecutor = async (context) => {
  const runId = context.job.payload['import_run_id']
  if (typeof runId !== 'string' || runId.length === 0) {
    return { terminal: { reason: 'import_publish payload has no import_run_id' } }
  }
  const siteId = context.job.subjectId
  if (siteId === null) {
    return { terminal: { reason: 'import_publish job has no subject site' } }
  }

  const run = await readImportRun(context.db, { siteId, importRunId: runId })
  if (!run) {
    context.logger.info('import_publish_run_absent', { site_id: siteId, import_run_id: runId })
    return 'succeeded'
  }
  if (run.state !== 'publishing' && run.state !== 'published') {
    // Rolled back, discarded or superseded before this job was claimed. All are
    // settled answers a later actor gave, and none of them is this job's to
    // overrule.
    context.logger.info('import_publish_noop', {
      site_id: siteId,
      import_run_id: runId,
      phase: run.state,
    })
    return 'succeeded'
  }

  if (!(await context.updatePhase('publishing'))) {
    context.logger.warn('import_publish_lease_lost', {
      site_id: siteId,
      import_run_id: runId,
      retryable: true,
    })
    return { retry: { delayMs: 5_000 } }
  }

  const result = await publishImportRun(context.db, { siteId, importRunId: runId })
  if (!result.ok) {
    if (result.conflict === 'site_unavailable') {
      // The site is being deleted. Its own deletion job purges the staged rows
      // and the pointer, so there is nothing here to do and nothing to wait for.
      context.logger.info('import_publish_site_unavailable', {
        site_id: siteId,
        import_run_id: runId,
      })
      return 'succeeded'
    }
    // The run moved under us between the read and the swap. Guarded in the
    // WHERE precisely so this is an answer rather than an overwrite.
    context.logger.info('import_publish_lost_transition', {
      site_id: siteId,
      import_run_id: runId,
    })
    return 'succeeded'
  }

  if (result.swapped) {
    context.logger.info('import_published', {
      site_id: siteId,
      import_run_id: runId,
      cutover_date: run.cutoverDate,
      superseded_run_id: result.predecessorRunId,
    })
  }

  return await cleanupAfterPublish(context, {
    siteId,
    predecessorRunId: result.predecessorRunId,
  })
}

/**
 * Erase the grandparent (D3), after the pointer has moved.
 *
 * A cleanup failure is **not** a publish failure. The swap is committed and the
 * customer's dashboard is already showing the new data; retrying the job to
 * chase a ClickHouse mutation would re-enter the swap path (which correctly
 * no-ops) purely to try the delete again, and the sweeper's backstop is the
 * mechanism that exists for exactly that. So this returns `succeeded` even when
 * it cleaned nothing — the one exception being a missing credential, which is a
 * deployment state a retry can actually resolve.
 */
async function cleanupAfterPublish(
  context: Parameters<JobExecutor>[0],
  input: { siteId: string; predecessorRunId: string | null },
): Promise<JobOutcome> {
  const ttlDays = context.resources?.importPolicy?.uploadTtlDays
  const maintenance = context.resources?.importedAggregatesMaintenance
  if (ttlDays === undefined || !maintenance) {
    context.logger.warn('import_publish_cleanup_deferred', {
      site_id: input.siteId,
      policy_configured: ttlDays !== undefined,
      clickhouse_configured: maintenance !== undefined,
      retryable: true,
    })
    return { retry: { delayMs: RESOURCE_RETRY_MS } }
  }

  const candidates = await listCleanableSiteImportRuns(context.db, {
    siteId: input.siteId,
    predecessorRunId: input.predecessorRunId,
    ttlDays,
    limit: CLEANUP_LIMIT,
  })

  for (const candidate of candidates) {
    await cleanImportRun(
      {
        db: context.db,
        logger: context.logger,
        maintenance,
        ...(context.resources?.objectStorage
          ? { objectStorage: context.resources.objectStorage }
          : {}),
      },
      candidate,
    )
    // Between runs: eight mutations each, and a publish of a site with a long
    // import history can outlast the lease. Losing it here is harmless — the
    // swap is committed — so the loop simply stops.
    if (!(await context.extendLease())) break
  }

  return 'succeeded'
}

export const IMPORT_PUBLISH_REGISTRATION: JobRegistration = {
  type: IMPORT_PUBLISH_JOB_TYPE,
  execute: executeImportPublish,
  /**
   * A publish that will never run leaves the run in `publishing` — inside the
   * live-run unique's predicate, so the site can start no other import — with
   * the pointer still on the old run. Sending it back to `ready_for_review` is
   * the truthful state: the staging is intact, nothing was published, and the
   * customer can publish again.
   */
  onTerminal: async (job, reason, context) => {
    const runId = job.payload['import_run_id']
    if (typeof runId !== 'string' || runId.length === 0) return
    await transitionImportRun(context.db, {
      importRunId: runId,
      from: ['publishing'],
      to: 'ready_for_review',
    })
    context.logger.error('import_publish_abandoned', {
      import_run_id: runId,
      site_id: job.subjectId,
      reason,
      retryable: false,
    })
  },
  /** One at a time: the swap takes a site row lock and the cleanup issues
   * ClickHouse mutations. */
  limit: 1,
}

export { executeImportPublish }
