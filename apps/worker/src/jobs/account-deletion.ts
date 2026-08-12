import {
  ACCOUNT_DELETION_PHASES,
  isAccountDeletionPhase,
  type AccountDeletionPhase,
} from '@openanalytics/domain'
import {
  ACCOUNT_DELETION_JOB_TYPE,
  AccountDeletionBlockedError,
  finalizeAccountDeletion,
  listBilledSiteStates,
  listDeletionTargets,
  markAccountDeletionFailed,
  markAccountDeletionRunning,
  purgeAccountPostgres,
  readAccountDeletionContext,
  updateDeletionTarget,
  type DeletionTargetRow,
  type PurgeAccountPostgresResult,
} from '@openanalytics/postgres'
import { WORKER_METRICS } from '../ingest/metrics.ts'
import type { JobExecutor, JobExecutorContext, JobOutcome, JobRegistration } from './runner.ts'

/**
 * The account-deletion executor (ADR-0030, decision 8).
 *
 * Four phases, run in order, each idempotent and each resumable from the durable
 * state `jobs.phase` and `deletion_targets` hold — the same contract the
 * site-deletion executor works under, because a worker that dies half-way
 * through erasing somebody's account has to be recoverable by another worker
 * stealing the lease and re-entering the phase.
 *
 * The phase order is the correctness argument:
 *
 * - `await_site_deletions` is first because the account's own sites are being
 *   erased by *their* jobs, and those jobs still read rows this teardown
 *   removes: `redis_purge` enumerates a site's realtime epoch keys from its
 *   `site_members` rows, and a membership deleted from under it would strand one
 *   key per member with no way to find it short of a keyspace `SCAN`.
 * - `stripe_cancel` precedes `postgres_teardown` because the teardown deletes
 *   the `subscriptions` row that names the subscription. Reversed, a crash
 *   between the phases would leave a live Stripe subscription with nothing in
 *   our database pointing at it — a card still being charged for an account that
 *   no longer exists, discoverable only from Stripe's side.
 * - `verify_finalize` is last and re-reads every target rather than trusting the
 *   phases that ran: the tombstone is a statement to a person that their account
 *   is gone, and it is made only against observed verification.
 *
 * **Waiting is not failing.** Every "not yet" is a returned `retry`, which the
 * runner records without counting an attempt. Only an unexpected error throws,
 * and those attempts are what `JOB_MAX_ATTEMPTS` bounds — so a deletion may wait
 * days for a site's ClickHouse mutation and still have its full retry budget for
 * the Stripe call that follows.
 */

/** How long to wait on a condition that changes on its own — another job's
 * progress, or Stripe finishing what it accepted. */
const WAIT_RETRY_MS = 30_000

export interface PhaseContext {
  readonly job: JobExecutorContext
  readonly deletionRequestId: string
  readonly userId: string
}

export type PhaseOutcome = 'advance' | JobOutcome

/**
 * A phase a registered surface owns, and which store's targets it settles.
 *
 * One registration carries all three facts because they are one decision: the
 * phase name (spliced into `ACCOUNT_DELETION_PHASES` by the same surface's
 * deletion-dictionary entry), the store whose target rows it completes — which is
 * what `phaseForStore` needs to rewind correctly — and how to run it.
 */
export interface AccountDeletionPhaseHandler {
  readonly phase: string
  readonly store: string
  readonly run: (context: PhaseContext) => Promise<PhaseOutcome>
}

const phaseHandlers: AccountDeletionPhaseHandler[] = []

/** Idempotent by phase name; a second handler for one phase is refused, because
 * which of the two ran would otherwise depend on import order. */
export function registerAccountDeletionPhase(handler: AccountDeletionPhaseHandler): void {
  const existing = phaseHandlers.find((candidate) => candidate.phase === handler.phase)
  if (existing === handler) return
  if (existing) throw new Error(`an account-deletion phase "${handler.phase}" is registered`)
  phaseHandlers.push(handler)
}

const executeAccountDeletion: JobExecutor = async (context) => {
  const deletionRequestId = context.job.payload['deletion_request_id']
  if (typeof deletionRequestId !== 'string' || deletionRequestId.length === 0) {
    // Nothing will ever add the field, so waiting cannot help. Terminal with a
    // reason, and loud: it means a producer wrote a bad row.
    return { terminal: { reason: 'account_deletion payload has no deletion_request_id' } }
  }

  const state = await readAccountDeletionContext(context.db, deletionRequestId)
  if (!state) {
    return {
      terminal: { reason: `deletion request ${deletionRequestId} is not an account request` },
    }
  }
  if (state.requestStatus === 'completed') {
    // Already finished — a lease stolen after the final transaction committed,
    // or a replayed job. Succeeding is correct and is what makes the whole
    // executor safe to re-run.
    return 'succeeded'
  }
  if (state.requestStatus === 'failed') {
    return { terminal: { reason: `deletion request ${deletionRequestId} was marked failed` } }
  }

  const phaseContext: PhaseContext = {
    job: context,
    deletionRequestId,
    userId: state.userId,
  }

  const startIndex = isAccountDeletionPhase(context.job.phase)
    ? ACCOUNT_DELETION_PHASES.indexOf(context.job.phase)
    : 0

  for (let index = startIndex; index < ACCOUNT_DELETION_PHASES.length; index += 1) {
    const phase = ACCOUNT_DELETION_PHASES[index] as AccountDeletionPhase

    // The phase marker is durable before the phase runs, and the write is
    // lease-guarded, so a worker whose lease was stolen learns it before doing
    // any store work.
    if (!(await context.updatePhase(phase))) return lost(context, phase)
    context.metrics.increment(WORKER_METRICS.deletionPhase, { phase })

    const outcome = await runPhase(phase, phaseContext)
    if (outcome !== 'advance') return outcome

    if (!(await context.extendLease())) return lost(context, phase)
  }

  return 'succeeded'
}

/** A stolen lease is not an error and not a retry this executor chose; see the
 * site-deletion executor's `lost` for why the settlement is `lost` rather than a
 * counted failure. */
function lost(context: JobExecutorContext, phase: string): JobOutcome {
  context.logger.warn('account_deletion_lease_lost', {
    job_id: context.job.id,
    user_id: context.job.subjectId,
    phase,
    retryable: true,
  })
  return { retry: { delayMs: WAIT_RETRY_MS } }
}

async function runPhase(phase: AccountDeletionPhase, context: PhaseContext): Promise<PhaseOutcome> {
  switch (phase) {
    case 'await_site_deletions':
      return await awaitSiteDeletions(context)
    case 'postgres_teardown':
      return await postgresTeardown(context)
    case 'verify_finalize':
      return await verifyFinalize(context)
  }
  // A phase a registered surface spliced into the sequence (`stripe_cancel` is
  // the one that was a `case` here until the open-core split). An unknown phase
  // is a *durable marker naming work this build cannot do* — a job written by a
  // deployment with a surface this one does not mount — so it must not be
  // silently skipped: skipping would advance past a target nothing settled and
  // let `verify_finalize` declare an erasure complete that never happened.
  const handler = phaseHandlers.find((candidate) => candidate.phase === phase)
  if (!handler) {
    throw new Error(`no handler is registered for account-deletion phase "${phase}"`)
  }
  return await handler.run(context)
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function completeTarget(
  context: PhaseContext,
  target: DeletionTargetRow,
  verification: Record<string, unknown>,
): Promise<void> {
  await updateDeletionTarget(context.job.db, {
    targetId: target.id,
    phase: 'completed',
    verified: true,
    verification,
    lastError: null,
    countAttempt: true,
  })
}

/**
 * Wait until every site this account pays for is `deleted`
 * (ADR-0030, D8 `await_site_deletions`).
 *
 * `deleted`, not merely `deleting`: a site's own job is what enumerates its
 * members and purges its stores, and this teardown deletes those very
 * memberships. Advancing while a site deletion was still mid-flight would race
 * two erasures over one set of rows.
 *
 * A site that is *neither* deleting nor deleted is a different matter entirely.
 * The gate in `startAccountDeletion` guaranteed there was none, under a locking
 * read, so finding one here means something re-billed this account after the
 * request was made — a transfer offer accepted in the seconds before the job ran
 * is the realistic path. Waiting for it would be waiting for something nobody
 * has asked to happen, forever. It settles terminally instead, and marks the
 * request `failed` so the account is not left with a live request that makes
 * every future `DELETE /v1/me` report a deletion that will never run.
 */
async function awaitSiteDeletions(context: PhaseContext): Promise<PhaseOutcome> {
  const sites = await listBilledSiteStates(context.job.db, context.userId)

  const unresolved = sites.filter((site) => site.status !== 'deleting' && site.status !== 'deleted')
  if (unresolved.length > 0) {
    const reason = `account was billing owner of ${String(unresolved.length)} live site(s) after the gate: ${unresolved
      .map((site) => `${site.slug}=${site.status}`)
      .join(', ')}`
    context.job.logger.error('account_deletion_site_reacquired', {
      job_id: context.job.job.id,
      user_id: context.userId,
      sites: unresolved.map((site) => site.siteId),
      retryable: false,
    })
    await markAccountDeletionFailed(context.job.db, {
      deletionRequestId: context.deletionRequestId,
      userId: context.userId,
      reason,
    })
    return { terminal: { reason } }
  }

  const pending = sites.filter((site) => site.status === 'deleting')
  if (pending.length > 0) {
    context.job.logger.info('account_deletion_awaiting_sites', {
      job_id: context.job.job.id,
      user_id: context.userId,
      pending_sites: pending.length,
    })
    return { retry: { delayMs: WAIT_RETRY_MS } }
  }

  // The first phase that proves work has begun; the request leaves `pending`.
  await markAccountDeletionRunning(context.job.db, context.deletionRequestId)
  return 'advance'
}

/**
 * Tear down the account's Postgres rows (ADR-0030, D8 `postgres_teardown`).
 *
 * One transaction over every Postgres target, so one failure belongs to all of them —
 * recorded on each, metered once, and rethrown so the runner counts the attempt.
 *
 * The outstanding check comes first and returns without touching anything when
 * there is nothing left to do. That is not an optimisation: re-entering this
 * phase after a successful teardown (a stolen lease, a crash between the last
 * target write and the phase advance) would re-run a transaction whose steps are
 * individually idempotent but whose *counts* are not — every target would be
 * rewritten to say zero rows were affected, erasing the record of what the
 * erasure actually removed.
 *
 * **A blocked purge is terminal, not a retry.** `purgeAccountPostgres` re-runs
 * both gate checks inside its own transaction, under the `users` lock, and
 * throws `AccountDeletionBlockedError` when the account has acquired a live site
 * since the request was made. Nothing about that fixes itself: the site is
 * somebody's live property and no phase here can hand it over, so retrying would
 * poll a payment-bearing account forever. The request is marked `failed` and the
 * job settles terminally, which is what lets the customer resolve the site and
 * ask again.
 *
 * That second request starts from a *slightly* used state, and the residue is
 * accepted deliberately: `stripe_cancel` runs before this phase, so a
 * late-acquired site can be refused here after the subscription was already
 * cancelled. It is an edge the account holder created — acquiring a billed site
 * during their own account's erasure — the cancellation is of their own
 * subscription, and a re-requested deletion re-derives everything from the live
 * tables. The alternative, ordering the teardown before Stripe, would leave a
 * live subscription with nothing in our database naming it, which is a customer
 * still being charged for an account that no longer exists.
 */
async function postgresTeardown(context: PhaseContext): Promise<PhaseOutcome> {
  const targets = await listDeletionTargets(context.job.db, {
    deletionRequestId: context.deletionRequestId,
    store: 'postgres',
  })
  const outstanding = targets.filter((target) => target.phase !== 'completed')
  if (outstanding.length === 0) return 'advance'

  let result: PurgeAccountPostgresResult
  try {
    result = await purgeAccountPostgres(context.job.db, { userId: context.userId })
  } catch (err) {
    const message = errorMessage(err)
    for (const target of outstanding) {
      await updateDeletionTarget(context.job.db, { targetId: target.id, lastError: message })
    }
    context.job.metrics.increment(WORKER_METRICS.deletionTargetFailed, { store: 'postgres' })

    if (err instanceof AccountDeletionBlockedError) {
      const reason = `account acquired ${String(err.blockingSites.length)} live site(s) after the gate: ${err.blockingSites
        .map((site) => `${site.slug}=${site.reason}`)
        .join(', ')}`
      context.job.logger.error('account_deletion_site_reacquired', {
        job_id: context.job.job.id,
        user_id: context.userId,
        sites: err.blockingSites.map((site) => site.siteId),
        phase: 'postgres_teardown',
        retryable: false,
      })
      await markAccountDeletionFailed(context.job.db, {
        deletionRequestId: context.deletionRequestId,
        userId: context.userId,
        reason,
      })
      return { terminal: { reason } }
    }

    throw err
  }

  // Written after the purge's own transaction has committed, in a loop of
  // single-row updates. A crash midway leaves some targets recorded and some
  // not, which is safe rather than tidy: the purge is idempotent, so a re-run
  // re-derives the same counts and the loop converges — and the alternative,
  // threading ten target ids into the repository so the writes join the purge's
  // transaction, would put the deletion's bookkeeping inside the statement whose
  // commit the ownership triggers judge.
  for (const target of outstanding) {
    // A zero is a legitimate answer — an account with no invitations, a trial
    // never claimed — so verification here is "the count was observed", not
    // "the count was positive", exactly as the site purge's is.
    await completeTarget(context, target, {
      affected: result.affected[target.target] ?? 0,
      verified_at: new Date().toISOString(),
    })
  }

  return 'advance'
}

/**
 * Verify every target and close the request (ADR-0030, D8 `verify`/`finalize`).
 *
 * A re-read of `deletion_targets` rather than a variable carried through the
 * phases: they may have run in different processes across restarts, and the
 * table is the only thing that knows what all of them observed.
 *
 * An unfinished target rewinds `jobs.phase` to the phase that owns it, and the
 * rewind is the point. `jobs.phase` is where the next claim resumes, so a retry
 * returned from here without moving it would re-enter `verify_finalize`, find
 * the same unfinished target and return the same retry — polling until an
 * operator noticed, with nothing in between ever doing the work.
 */
async function verifyFinalize(context: PhaseContext): Promise<PhaseOutcome> {
  const targets = await listDeletionTargets(context.job.db, {
    deletionRequestId: context.deletionRequestId,
  })
  const unfinished = targets.filter((target) => target.phase !== 'completed' || !target.verified)

  if (unfinished.length > 0) {
    const resumeAt = earliestPhase(unfinished)
    context.job.logger.warn('account_deletion_targets_unfinished', {
      job_id: context.job.job.id,
      user_id: context.userId,
      unfinished: unfinished.length,
      stores: [...new Set(unfinished.map((target) => target.store))],
      resume_phase: resumeAt,
      retryable: true,
    })
    // A refused rewind means the lease is somebody else's; the retry below is
    // then refused by the runner too and settles as `lost`. Saying so is what
    // stops an operator reading the phase marker as this run's decision.
    if (!(await context.job.updatePhase(resumeAt))) {
      context.job.logger.warn('account_deletion_rewind_refused', {
        job_id: context.job.job.id,
        user_id: context.userId,
        resume_phase: resumeAt,
        retryable: true,
      })
    }
    return { retry: { delayMs: WAIT_RETRY_MS } }
  }

  await finalizeAccountDeletion(context.job.db, {
    deletionRequestId: context.deletionRequestId,
    userId: context.userId,
  })

  context.job.logger.info('account_deletion_completed', {
    job_id: context.job.job.id,
    user_id: context.userId,
    deletion_request_id: context.deletionRequestId,
    targets: targets.length,
  })

  return 'advance'
}

/** Which phase owns a store's targets. An unknown store — a snapshot written by
 * a newer build, or by one with a surface this build does not mount — maps to the
 * first phase, so a rewind is never *later* than the work it has to redo. */
function phaseForStore(store: string): AccountDeletionPhase {
  if (store === 'postgres') return 'postgres_teardown'
  const registered = phaseHandlers.find((candidate) => candidate.store === store)
  return registered?.phase ?? (ACCOUNT_DELETION_PHASES[0] as AccountDeletionPhase)
}

function earliestPhase(unfinished: readonly DeletionTargetRow[]): AccountDeletionPhase {
  let earliest = ACCOUNT_DELETION_PHASES.length - 1
  for (const target of unfinished) {
    const index = ACCOUNT_DELETION_PHASES.indexOf(phaseForStore(target.store))
    if (index < earliest) earliest = index
  }
  return ACCOUNT_DELETION_PHASES[earliest] as AccountDeletionPhase
}

export const ACCOUNT_DELETION_REGISTRATION: JobRegistration = {
  type: ACCOUNT_DELETION_JOB_TYPE,
  execute: executeAccountDeletion,
  /**
   * A dead job leaves a request nobody is performing, and `startAccountDeletion`
   * decides what to do by finding exactly that row: a `pending` request behind a
   * `failed_terminal` job would make every later `DELETE /v1/me` return its id —
   * an account permanently unable to be deleted, reporting success each time.
   * Marking it `failed` is what lets the next call start a real one.
   */
  onTerminal: async (job, reason, context) => {
    const requestId = job.payload['deletion_request_id']
    // A payload with no request id is the one terminal that has nothing to
    // settle: no request was ever named, so none can be marked failed. The
    // runner's ERROR log is the whole record of it.
    if (typeof requestId !== 'string' || requestId.length === 0) return
    if (job.subjectId === null) return
    await markAccountDeletionFailed(context.db, {
      deletionRequestId: requestId,
      userId: job.subjectId,
      reason,
    })
  },
  // `limit` contributes this type's share of the runner's single global claim
  // `LIMIT`; it does not make anything concurrent, since one tick executes the
  // claimed page serially. One is what keeps a tick from holding ten accounts'
  // Stripe round trips and ten multi-table teardowns back-to-back behind each
  // other, and it keeps the page's remaining slots available to other types.
  limit: 1,
}

export { executeAccountDeletion }
