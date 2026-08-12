import { retryDelayMs } from '@openanalytics/domain'
import type { Logger, Metrics } from '@openanalytics/observability'
import {
  claimDueJobs,
  completeJob,
  extendJobLease,
  failJobRetryable,
  readJobsBacklog,
  updateJobPhase,
  type ClaimedJob,
  type Database,
} from '@openanalytics/postgres'
import { WORKER_METRICS } from '../ingest/metrics.ts'
import { ACCOUNT_DELETION_REGISTRATION } from './account-deletion.ts'
import { EXPORT_RUN_REGISTRATION } from './export-run.ts'
import { IMPORT_PREPARE_REGISTRATION } from './import-prepare.ts'
import { IMPORT_PUBLISH_REGISTRATION } from './import-publish.ts'
import { REVENUE_BACKFILL_REGISTRATION } from './revenue-backfill.ts'
import { SITE_DELETION_REGISTRATION } from './site-deletion.ts'
import type { JobResources } from './resources.ts'

/**
 * The generic job runner (ADR-0030, decision 3).
 *
 * Shaped after `outbox-dispatcher.ts` on purpose — claim a bounded page, hand
 * each row to a registered handler, settle it, publish a zero-filled backlog —
 * because the two loops answer the same operational questions and an operator
 * should not have to learn two idioms. What differs is the durability model, and
 * it differs for one reason: an outbox row is a side effect that takes
 * milliseconds, while a job is a multi-phase state machine that can run for
 * minutes and must survive the worker dying half-way through it. That is why
 * jobs carry a lease rather than a `processing` status, why the executor can
 * re-extend it, and why every write back to the row is guarded by the holder.
 *
 * **Dispatch is a registry**, `type → executor`. The site-deletion executor CP3
 * writes plugs in here as one more entry; nothing in this file knows what a
 * deletion is.
 *
 * **Terminal failure is never implicit.** A throw is always a retry, and the
 * only automatic terminal is the max-attempts guard, which is set two orders of
 * magnitude above the batch pipeline's (`JOB_MAX_ATTEMPTS`, 100) precisely so a
 * deletion keeps trying through an hour-long ClickHouse outage. The counter it
 * reads is reset whenever an executor *asks* to be retried, so what the guard
 * bounds is consecutive failures rather than time spent waiting. An executor that
 * has decided the work is impossible says so by returning `terminal` — a
 * decision with a reason, not an exhausted counter. Either way a job that ends
 * `failed_terminal` is logged at ERROR, and the registration's `onTerminal` hook
 * is called on both of those paths: it is work somebody promised a customer that
 * will now never happen unless a human intervenes, and the row that *records* the
 * promise lives in another table this file knows nothing about.
 */

const DEFAULT_INTERVAL_MS = 15_000
const DEFAULT_LIMIT = 10

/** Statuses a job can still be worked from — what the backlog gauges cover. */
const LIVE_STATUSES = ['queued', 'running', 'failed_retryable'] as const

export interface JobRunnerPolicy {
  /** `WORKER_LEASE_TTL_MS`. How long a claim holds the row. */
  readonly leaseTtlMs: number
  /** `JOB_MAX_ATTEMPTS`. Attempts before a throwing job is given up on. */
  readonly maxAttempts: number
  /** `WORKER_RETRY_BASE_MS` / `WORKER_RETRY_MAX_MS`, the shared backoff schedule. */
  readonly retryBaseMs: number
  readonly retryMaxMs: number
}

/**
 * What an executor may do to the row it was handed, besides finishing.
 *
 * Both calls report `false` when the lease is no longer this worker's — which
 * happens when a phase outruns the TTL and another worker steals the job. An
 * executor that sees `false` should stop: the work is now somebody else's, and
 * continuing would mean two workers in the same phases.
 */
export interface JobExecutorContext {
  readonly job: ClaimedJob
  readonly db: Database
  readonly logger: Logger
  readonly metrics: Metrics
  /**
   * The non-Postgres stores an executor may reach.
   *
   * Optional as a whole and optional per member, and that is a deployment fact
   * rather than a convenience: the worker starts with only `DATABASE_URL`, and
   * the queue instance, the realtime cache and the `oa_maintenance` ClickHouse
   * credential are each configured separately. An executor that needs one it was
   * not given returns a retry and logs — the job stays live and runs the moment
   * the resource appears, which is exactly the behaviour a half-provisioned host
   * needs. The alternative (refusing to boot the worker) would take email
   * delivery, ingest and the sweeper down with it.
   */
  readonly resources?: JobResources | undefined
  extendLease(): Promise<boolean>
  updatePhase(phase: string): Promise<boolean>
}

export type JobOutcome =
  | 'succeeded'
  /**
   * Come back later. The executor chooses the delay; nothing is marked failed.
   *
   * **`counts` decides whether this retry can ever end.** A retry without it
   * zeroes the attempt counter (see the settlement below), which is right for a
   * wait whose end is not in this system's hands — a deletion draining an ingest
   * fence, an account deletion waiting for its sites — and would otherwise let a
   * job that is merely *waiting* exhaust `JOB_MAX_ATTEMPTS` without a single
   * error having occurred.
   *
   * It is exactly wrong for an **infrastructure** retry. A ClickHouse grant that
   * was never given, a bucket credential that will not be added, a resource a
   * deployment simply does not have: those never resolve on their own, and a
   * non-counting retry over one of them is an immortal job. That matters beyond
   * the wasted tick when the job's subject is pinned meanwhile — an import run
   * parked in `validating` holds its site's only import slot (ADR-0032, D3), so
   * an immortal `import_prepare` is a permanent import lockout for that customer.
   * A counting retry reaches `failed_terminal` like any other failure, and
   * `onTerminal` is what releases the subject.
   */
  | { readonly retry: { readonly delayMs: number; readonly counts?: boolean } }
  /** Give up, with a reason. The only path to `failed_terminal` besides the guard. */
  | { readonly terminal: { readonly reason: string } }

export type JobExecutor = (context: JobExecutorContext) => Promise<JobOutcome>

/**
 * What a terminal hook is handed. Deliberately not `JobExecutorContext`: the job
 * is settled, so the lease controls no longer mean anything — writing through
 * them would be writing against a row this worker has already released.
 */
export interface JobTerminalContext {
  readonly db: Database
  readonly logger: Logger
  readonly metrics: Metrics
  readonly resources?: JobResources | undefined
}

export type JobTerminalHook = (
  job: ClaimedJob,
  reason: string,
  context: JobTerminalContext,
) => Promise<void>

export interface JobRegistration {
  readonly type: string
  readonly execute: JobExecutor
  /**
   * Called once the job has been settled `failed_terminal`, on **both** paths
   * that reach it: an executor returning `terminal`, and the attempts guard
   * firing on a job that kept throwing.
   *
   * It exists because `jobs` and `deletion_requests` are two tables and only one
   * of them is the runner's. A job that dies leaves the request it was working
   * `pending` forever, and a `pending` request is what every "is a deletion
   * already under way?" read finds — so without this hook a dead job turns into
   * a subject that can never be deleted again while reporting success on every
   * attempt. The hook is the type's chance to say, in its own vocabulary, that
   * the work will not happen.
   *
   * Best-effort by construction: it runs *after* the settlement is durable, and
   * a throw from it is logged rather than propagated. The job is already
   * terminal, and re-settling it is not something a failed notification should
   * be able to undo.
   */
  readonly onTerminal?: JobTerminalHook
  /** Jobs of this type claimed per tick. Defaults to 10. */
  readonly limit?: number
}

/**
 * The job types this worker runs.
 *
 * Six entries, and the registry shape keeps earning its keep: neither this file
 * nor the claim statement knows what a deletion, an import, an export or a
 * revenue backfill is, so account deletion — whose subject is a *user* rather
 * than a site — the three M11 jobs, and M12's `revenue_backfill` — whose subject
 * is a **credential** — each plugged in as one more row.
 *
 * `import_prepare` and `import_publish` are deliberately **two types**, which is
 * also why the jobs table's `(type, subject_id)` unique is not what serializes
 * imports: it is per type and would happily admit a publish of one run beside a
 * prepare of another. The one-non-terminal-run-per-site index (ADR-0032, D3) is
 * what makes that impossible.
 *
 * `export_run` is the opposite case and the reason the distinction is worth
 * stating twice: it is **one** type, so the `(type, subject_id)` unique *is*
 * one live export per site (ADR-0032, D8), and the export surface deliberately
 * adds no second serializer of its own.
 *
 * `revenue_backfill` is the same shape at a *different grain*: its subject is a
 * credential id, so the unique means one live backfill per credential rather
 * than per site — which is what a site with two connected providers needs, and
 * what stops a reconnect from adopting the previous connection's cursors
 * (ADR-0033, D4).
 */
export const DEFAULT_JOB_REGISTRATIONS: readonly JobRegistration[] = [
  SITE_DELETION_REGISTRATION,
  ACCOUNT_DELETION_REGISTRATION,
  IMPORT_PREPARE_REGISTRATION,
  IMPORT_PUBLISH_REGISTRATION,
  EXPORT_RUN_REGISTRATION,
  REVENUE_BACKFILL_REGISTRATION,
]

export interface JobRunnerDeps {
  readonly db: Database
  readonly logger: Logger
  readonly metrics: Metrics
  readonly policy: JobRunnerPolicy
  /** This worker's identity — the value written into `claimed_by`. */
  readonly claimedBy: string
  /** Passed through to every executor; see `JobExecutorContext.resources`. */
  readonly resources?: JobResources | undefined
  readonly registrations?: readonly JobRegistration[]
  readonly intervalMs?: number
}

export interface JobRunResult {
  readonly claimed: number
  readonly succeeded: number
  readonly retried: number
  readonly failedTerminal: number
  /** Jobs abandoned mid-flight because the lease had been stolen. */
  readonly lost: number
}

type RunnerDeps = Pick<
  JobRunnerDeps,
  'db' | 'logger' | 'metrics' | 'policy' | 'claimedBy' | 'resources'
>

/**
 * Claim and execute one page of jobs.
 *
 * All registered types are claimed in a single statement rather than one call
 * per type: the claim is an `UPDATE … SKIP LOCKED` and doing it once keeps the
 * page globally ordered by `available_at`, so the oldest work runs first no
 * matter which type it belongs to.
 */
export async function runJobsOnce(
  deps: RunnerDeps,
  registrations: readonly JobRegistration[],
): Promise<JobRunResult> {
  const byType = new Map(registrations.map((registration) => [registration.type, registration]))
  if (byType.size === 0) {
    return { claimed: 0, succeeded: 0, retried: 0, failedTerminal: 0, lost: 0 }
  }

  const limit = registrations.reduce(
    (total, registration) => total + (registration.limit ?? DEFAULT_LIMIT),
    0,
  )

  const claimedJobs = await claimDueJobs(deps.db, {
    types: [...byType.keys()],
    claimedBy: deps.claimedBy,
    leaseTtlMs: deps.policy.leaseTtlMs,
    limit,
  })

  let succeeded = 0
  let retried = 0
  let failedTerminal = 0
  let lost = 0

  for (const job of claimedJobs) {
    // Cannot be undefined: the claim asked for exactly these types.
    const registration = byType.get(job.type)
    if (!registration) continue

    const settled = await executeOne(deps, registration, job)
    if (settled === 'succeeded') succeeded += 1
    else if (settled === 'retried') retried += 1
    else if (settled === 'failed_terminal') failedTerminal += 1
    else lost += 1
  }

  return { claimed: claimedJobs.length, succeeded, retried, failedTerminal, lost }
}

type Settlement = 'succeeded' | 'retried' | 'failed_terminal' | 'lost'

/**
 * Run one claimed job and settle it.
 *
 * The first thing this does is re-stamp the lease, and that is not belt and
 * braces. `claimDueJobs` stamps one `lease_expires_at` across the whole page, but
 * the page is executed serially: by the time a deletion at the tail of ten jobs
 * is reached, minutes of other work have been done against a lease that was
 * measured from the claim. Starting the executor on an already-expired lease
 * means another worker has legitimately stolen the job and both are now in its
 * phases. The extend both refuses that case — `false` means the row is somebody
 * else's, so the job is abandoned as `lost` without ever calling the executor and
 * without recording a failure — and gives the executor a full TTL to work in.
 */
async function executeOne(
  deps: RunnerDeps,
  registration: JobRegistration,
  job: ClaimedJob,
): Promise<Settlement> {
  const stillOurs = await extendJobLease(deps.db, {
    jobId: job.id,
    claimedBy: deps.claimedBy,
    leaseTtlMs: deps.policy.leaseTtlMs,
  })
  if (!stillOurs) return record(deps, job, 'lost')

  const context: JobExecutorContext = {
    job,
    db: deps.db,
    logger: deps.logger,
    metrics: deps.metrics,
    resources: deps.resources,
    extendLease: () =>
      extendJobLease(deps.db, {
        jobId: job.id,
        claimedBy: deps.claimedBy,
        leaseTtlMs: deps.policy.leaseTtlMs,
      }),
    updatePhase: (phase: string) =>
      updateJobPhase(deps.db, { jobId: job.id, claimedBy: deps.claimedBy, phase }),
  }

  let outcome: JobOutcome
  try {
    outcome = await registration.execute(context)
  } catch (err) {
    return await handleThrow(deps, registration, job, err)
  }

  if (outcome === 'succeeded') {
    const held = await completeJob(deps.db, {
      jobId: job.id,
      claimedBy: deps.claimedBy,
      status: 'succeeded',
    })
    return record(deps, job, held ? 'succeeded' : 'lost')
  }

  if ('terminal' in outcome) {
    const held = await completeJob(deps.db, {
      jobId: job.id,
      claimedBy: deps.claimedBy,
      status: 'failed_terminal',
      error: outcome.terminal.reason,
    })
    if (held) {
      deps.logger.error('job_failed_terminal', {
        job_id: job.id,
        type: job.type,
        subject_id: job.subjectId,
        reason: outcome.terminal.reason,
        retryable: false,
      })
      await notifyTerminal(deps, registration, job, outcome.terminal.reason)
    }
    return record(deps, job, held ? 'failed_terminal' : 'lost')
  }

  // A returned retry is normally a scheduling decision, not a failed attempt: the
  // executor looked at the work, decided now is not the time, and said so.
  // `attempts` is incremented at claim time, so leaving it alone would let a job
  // that is only *waiting* — an executor deferring on a fence, a deletion
  // draining — exhaust `JOB_MAX_ATTEMPTS` in a couple of hours and be marked
  // `failed_terminal` without one error ever occurring. The thrown-failure path
  // below deliberately does not reset: those attempts are the consecutive
  // failures the guard exists to bound.
  //
  // `counts: true` opts out of the reset, for the retries whose condition does
  // not resolve on its own (see `JobOutcome`). Those are bounded by the same
  // guard a throw is, including its terminal settlement and its `onTerminal`
  // hook — without which a job that can never succeed would poll forever while
  // its subject stayed pinned.
  const counts = outcome.retry.counts === true
  if (counts && job.attempts >= deps.policy.maxAttempts) {
    const exhausted = 'attempts exhausted: executor kept requesting an infrastructure retry'
    const settled = await completeJob(deps.db, {
      jobId: job.id,
      claimedBy: deps.claimedBy,
      status: 'failed_terminal',
      error: exhausted,
    })
    if (settled) {
      deps.logger.error('job_attempts_exhausted', {
        job_id: job.id,
        type: job.type,
        subject_id: job.subjectId,
        attempts: job.attempts,
        reason: exhausted,
        retryable: false,
      })
      await notifyTerminal(deps, registration, job, exhausted)
    }
    return record(deps, job, settled ? 'failed_terminal' : 'lost')
  }

  const held = await failJobRetryable(deps.db, {
    jobId: job.id,
    claimedBy: deps.claimedBy,
    error: 'executor requested a retry',
    retryDelayMs: outcome.retry.delayMs,
    resetAttempts: !counts,
  })
  return record(deps, job, held ? 'retried' : 'lost')
}

/**
 * A throw is a retry, until the guard.
 *
 * `attempts` was incremented at claim time, so it already counts the attempt
 * that just threw — comparing it against the maximum needs no adjustment. And
 * because a *requested* retry zeroes the counter, what is being compared is the
 * run of consecutive claims that ended in a throw, not the job's whole history.
 */
async function handleThrow(
  deps: RunnerDeps,
  registration: JobRegistration,
  job: ClaimedJob,
  err: unknown,
): Promise<Settlement> {
  const reason = err instanceof Error ? err.message : 'executor_failed'

  if (job.attempts >= deps.policy.maxAttempts) {
    const exhausted = `attempts exhausted: ${reason}`
    const held = await completeJob(deps.db, {
      jobId: job.id,
      claimedBy: deps.claimedBy,
      status: 'failed_terminal',
      error: exhausted,
    })
    if (held) {
      deps.logger.error('job_attempts_exhausted', {
        job_id: job.id,
        type: job.type,
        subject_id: job.subjectId,
        attempts: job.attempts,
        reason,
        retryable: false,
      })
      await notifyTerminal(deps, registration, job, exhausted)
    }
    return record(deps, job, held ? 'failed_terminal' : 'lost')
  }

  const delayMs = retryDelayMs(job.attempts, {
    WORKER_RETRY_BASE_MS: deps.policy.retryBaseMs,
    WORKER_RETRY_MAX_MS: deps.policy.retryMaxMs,
  })
  const held = await failJobRetryable(deps.db, {
    jobId: job.id,
    claimedBy: deps.claimedBy,
    error: reason,
    retryDelayMs: delayMs,
  })
  deps.logger.warn('job_failed', {
    job_id: job.id,
    type: job.type,
    subject_id: job.subjectId,
    attempts: job.attempts,
    retry_in_ms: delayMs,
    reason,
    retryable: true,
  })
  return record(deps, job, held ? 'retried' : 'lost')
}

/**
 * Tell the job's own type that it will never finish.
 *
 * Called only when the settlement was actually written (`held`), because a
 * refused write means another worker owns the row and is the one entitled to
 * decide what its failure means. The `try/catch` is not defensive padding: the
 * hook touches a *different* table from the one just settled, so it can fail on
 * its own, and a job that is already `failed_terminal` must not be affected by
 * that — the settlement is durable, and the hook failing is a second thing to
 * fix rather than a reason to lose the first.
 */
async function notifyTerminal(
  deps: RunnerDeps,
  registration: JobRegistration,
  job: ClaimedJob,
  reason: string,
): Promise<void> {
  if (!registration.onTerminal) return
  try {
    await registration.onTerminal(job, reason, {
      db: deps.db,
      logger: deps.logger,
      metrics: deps.metrics,
      resources: deps.resources,
    })
  } catch (err) {
    deps.logger.error('job_terminal_hook_failed', {
      job_id: job.id,
      type: job.type,
      subject_id: job.subjectId,
      reason,
      err,
      retryable: false,
    })
  }
}

function record(deps: RunnerDeps, job: ClaimedJob, settlement: Settlement): Settlement {
  if (settlement === 'lost') {
    // Not an error: the lease expired, another worker took the job and finished
    // or re-failed it. This run's writes were refused, which is the guard doing
    // exactly its job — but it is worth seeing, because a run that routinely
    // loses its lease means the TTL is too short for the phases.
    deps.logger.warn('job_lease_lost', {
      job_id: job.id,
      type: job.type,
      subject_id: job.subjectId,
      retryable: true,
    })
    deps.metrics.increment(WORKER_METRICS.jobCompleted, { type: job.type, status: 'lease_lost' })
    return settlement
  }
  deps.metrics.increment(WORKER_METRICS.jobCompleted, { type: job.type, status: settlement })
  return settlement
}

/**
 * Publish the unfinished backlog as gauges, zero-filled per registered type.
 *
 * The zero-fill is copied from `publishOutboxBacklog` and for the same reason: a
 * type whose last job just finished stops appearing in the `GROUP BY`, and left
 * alone its final non-zero gauge would be the newest value the backend ever saw.
 * The alert would stay lit on an empty queue — or, worse, a runner that stopped
 * running would look identical to one with nothing to do.
 */
export async function publishJobsBacklog(
  deps: Pick<JobRunnerDeps, 'db' | 'metrics'>,
  types: readonly string[],
): Promise<void> {
  const backlog = await readJobsBacklog(deps.db)
  const seen = new Set<string>()

  for (const row of backlog) {
    seen.add(`${row.type}:${row.status}`)
    deps.metrics.gauge(WORKER_METRICS.jobsBacklog, row.count, {
      type: row.type,
      status: row.status,
    })
    deps.metrics.gauge(WORKER_METRICS.jobsOldestAgeMs, row.oldestAgeMs, {
      type: row.type,
      status: row.status,
    })
  }

  for (const type of types) {
    for (const status of LIVE_STATUSES) {
      if (seen.has(`${type}:${status}`)) continue
      deps.metrics.gauge(WORKER_METRICS.jobsBacklog, 0, { type, status })
      deps.metrics.gauge(WORKER_METRICS.jobsOldestAgeMs, 0, { type, status })
    }
  }
}

export interface JobRunner {
  stop(): Promise<void>
}

export function startJobRunner(deps: JobRunnerDeps): JobRunner {
  const registrations = deps.registrations ?? DEFAULT_JOB_REGISTRATIONS
  let running = false
  let stopped = false

  const tick = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      const result = await runJobsOnce(deps, registrations)
      if (result.claimed > 0) deps.logger.info('jobs_run', { ...result })
      await publishJobsBacklog(
        deps,
        registrations.map((registration) => registration.type),
      )
    } catch (err) {
      deps.logger.error('job_run_failed', { err, retryable: true })
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => void tick(), deps.intervalMs ?? DEFAULT_INTERVAL_MS)
  // The runner must not by itself keep the process alive.
  timer.unref()

  return {
    async stop() {
      stopped = true
      clearInterval(timer)
      // Drain: a job mid-execution owns a lease and has to reach a settled state,
      // or it waits out the whole TTL before anyone can pick it up again.
      while (running) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    },
  }
}
