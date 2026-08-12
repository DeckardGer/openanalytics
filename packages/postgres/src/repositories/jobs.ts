import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Executor } from '../client.ts'
import { newId } from '../ids.ts'
import { jobs, type JobStatus } from '../schema/lifecycle.ts'

/**
 * The job repository (ADR-0030, decision 3; migration 0027).
 *
 * Two ideas, both borrowed rather than invented, because the codebase already
 * runs each of them in production:
 *
 * 1. **Claiming is the manifest/finalizer idiom.** One `UPDATE … WHERE id IN
 *    (SELECT … FOR UPDATE SKIP LOCKED)` moves a bounded page of due rows to
 *    `running` and stamps a lease. `SKIP LOCKED` is what makes N workers take
 *    disjoint work instead of blocking on each other, and the lease is what makes
 *    a worker that dies mid-job recoverable: once `lease_expires_at` passes, the
 *    row is due again and another worker steals it.
 *
 * 2. **Every state-changing statement is guarded by `claimed_by`**, exactly as
 *    `advanceFinalizerWatermark` is (0017). A worker whose lease was stolen —
 *    because its phase outran the TTL — must not be able to complete, fail or
 *    re-phase the job the new holder is now working. The guard turns that from a
 *    corruption into a `false` return the caller can log and abandon on. This is
 *    the whole reason these functions report booleans rather than void.
 *
 * Idempotency has two layers, and they answer different questions.
 * `idempotency_key` is the *producer's* handle: the same producer retrying makes
 * the same key and finds its own job. The partial unique on `(type, subject_id)`
 * is the *subject's* protection: two different producers, with two legitimately
 * different keys, still cannot put two live jobs on one site. `enqueueJob`
 * reports both as "found an existing job" rather than as an error, because to
 * every caller they mean the same thing — the work is already queued.
 *
 * Every function here takes an `Executor` rather than a `Database`, so any of
 * them can be composed into a caller's transaction. `enqueueJob` is the one that
 * needs it: the deletion-start transaction (ADR-0030, D4 step 2) writes the
 * deletion request, flips the site to `deleting` and enqueues the job as one
 * unit, and a crash between those statements would otherwise leave a site marked
 * for deletion with no job to do it.
 */

/**
 * The fenced site-deletion job (ADR-0030, decision 4). Named here rather than at
 * either end because the sweeper enqueues it and the worker's registry executes
 * it, and a literal in two places is a registry entry that silently never fires.
 */
export const SITE_DELETION_JOB_TYPE = 'site_deletion'

/**
 * The account-deletion job (ADR-0030, decision 8). Named here for the same
 * reason as its sibling: the api enqueues it and the worker's registry executes
 * it, and the two ends must agree on one literal.
 *
 * Its subject is a **user** id rather than a site id, which the `jobs` table
 * admits without change — `subject_id` is an untyped uuid precisely so a second
 * job type could name a different kind of row. The partial unique on
 * `(type, subject_id)` therefore still means what it should: one live account
 * deletion per user, and no collision with a site deletion that happens to have
 * been given the same uuid, because the type differs.
 */
export const ACCOUNT_DELETION_JOB_TYPE = 'account_deletion'

/**
 * Statuses a job can still be worked from — the predicate of the partial unique
 * `jobs_live_subject_key` (migration 0027), restated here so the repository's
 * "find the live job" read and the index agree by construction.
 */
const LIVE_JOB_STATUSES = ['queued', 'running', 'failed_retryable'] as const

export interface EnqueueJobInput {
  readonly type: string
  /** The row this job acts on. Omitted for a job with no single subject. */
  readonly subjectId?: string | null
  readonly payload?: Record<string, unknown>
  readonly idempotencyKey: string
  /** Defaults to immediately due. */
  readonly availableAt?: Date
}

export interface EnqueueJobResult {
  /** False when an equivalent job already existed — the id is that job's. */
  readonly enqueued: boolean
  readonly id: string | null
}

/**
 * Enqueue a job, or find the one that is already doing this work.
 *
 * **Never throws on either uniqueness rule, and never by catching one.** The
 * insert uses a *targetless* `ON CONFLICT DO NOTHING`, which is what makes it
 * safe to compose into a caller's transaction: Postgres allows only one conflict
 * target per statement, so a targeted form would let the second rule — the
 * `(type, subject_id)` liveness index — raise `23505`, and a raised error aborts
 * the *whole* enclosing transaction. Every statement after it, including the
 * lookup that would have recovered the existing job's id, then fails with
 * `25P02`. The deletion-start transactions compose this call precisely so the
 * job and the request commit together, so that abort would surface as a 500 on
 * a request that had a perfectly good answer available.
 *
 * Which rule fired decides where the answer is, and both are asked in order:
 * the idempotency key first (the *producer's* handle — the same producer
 * retrying finds its own job, finished or not), then the live job for the
 * subject (the *subject's* protection — a different producer with a legitimately
 * different key still finds the one live job). A caller that wants "the job for
 * this work" gets it either way.
 */
export async function enqueueJob(db: Executor, input: EnqueueJobInput): Promise<EnqueueJobResult> {
  const subjectId = input.subjectId ?? null

  const inserted = await db
    .insert(jobs)
    .values({
      id: newId(),
      type: input.type,
      subjectId,
      payload: input.payload ?? {},
      idempotencyKey: input.idempotencyKey,
      ...(input.availableAt === undefined ? {} : { availableAt: input.availableAt }),
    })
    .onConflictDoNothing()
    .returning({ id: jobs.id })

  const row = inserted[0]
  if (row) return { enqueued: true, id: row.id }

  // The key may be taken. The row it belongs to may since have finished, which
  // is still "not enqueued": the key is spent, and a caller that wants a fresh
  // run has to mint a fresh key.
  const [existing] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.idempotencyKey, input.idempotencyKey))
  if (existing) return { enqueued: false, id: existing.id }

  // Otherwise the liveness index refused it: somebody else's key, same subject.
  return { enqueued: false, id: await findLiveJob(db, input.type, subjectId) }
}

async function findLiveJob(
  db: Executor,
  type: string,
  subjectId: string | null,
): Promise<string | null> {
  if (subjectId === null) return null
  const [row] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, type),
        eq(jobs.subjectId, subjectId),
        inArray(jobs.status, [...LIVE_JOB_STATUSES]),
      ),
    )
  return row?.id ?? null
}

/**
 * The status of a job, found by the producer's key.
 *
 * Added for the import surface's derived status (ADR-0032, D7): a run sitting in
 * `processing` reports `running` from its state alone, but a run whose prepare
 * job is between retries should report `failed_retryable` — the difference
 * between "this is working" and "this keeps failing and will be tried again",
 * which is exactly what a support conversation turns on.
 *
 * Keyed on `idempotency_key` rather than on `(type, subject_id)` because the
 * import keys are run-scoped (`import_prepare:{run_id}`) while the subject is
 * the *site*: a site with two historical runs has two jobs of the same type, and
 * a subject lookup would answer with whichever is live rather than with the one
 * belonging to the run being read.
 *
 * Null for a key no job carries — the normal state before `complete` enqueues
 * anything, and after a build that predates a job type.
 */
export async function readJobStatusByIdempotencyKey(
  db: Executor,
  idempotencyKey: string,
): Promise<JobStatus | null> {
  const [row] = await db
    .select({ status: jobs.status })
    .from(jobs)
    .where(eq(jobs.idempotencyKey, idempotencyKey))
  return row?.status ?? null
}

export interface ClaimedJob {
  readonly id: string
  readonly type: string
  readonly subjectId: string | null
  readonly payload: Record<string, unknown>
  readonly phase: string | null
  /** Includes the attempt this claim just started. */
  readonly attempts: number
  readonly claimedBy: string
  readonly leaseExpiresAt: Date
  readonly createdAt: Date
}

export interface ClaimDueJobsInput {
  readonly types: readonly string[]
  readonly claimedBy: string
  readonly leaseTtlMs: number
  readonly limit: number
  readonly now?: Date
}

/**
 * Take up to `limit` runnable jobs of the given types.
 *
 * Runnable is two disjoint things. A `queued`/`failed_retryable` row whose
 * `available_at` has arrived is work nobody has started (or work waiting out a
 * backoff). A `running` row whose lease has expired is work somebody started and
 * did not finish — a crashed worker, or one whose phase outran its TTL. Both are
 * claimed by the same statement, which is what makes recovery automatic rather
 * than a separate reaper loop.
 *
 * `attempts` is incremented at claim time, so it always counts the attempt now in
 * flight and a lease steal is counted as the retry it is. It therefore counts
 * *claims*, which is why `failJobRetryable` can zero it: a claim the executor
 * ended by asking to be called back later is not an attempt at anything.
 * `started_at` is set only once (`COALESCE`), so it keeps meaning "when this job
 * first began".
 */
export async function claimDueJobs(db: Executor, input: ClaimDueJobsInput): Promise<ClaimedJob[]> {
  if (input.types.length === 0) return []
  // The due comparison uses the DATABASE clock unless a test supplies its own
  // instant. `available_at` is stamped by `now()` on insert, and a worker whose
  // JS clock sits even a few milliseconds behind the server would read a
  // freshly-enqueued row as "not yet due" — an intermittent empty claim that
  // surfaced as CI flakes before it surfaced anywhere worse. One clock decides.
  const now = input.now === undefined ? sql`now()` : sql`${input.now}::timestamptz`
  const leaseInterval = sql`make_interval(secs => ${input.leaseTtlMs / 1000})`
  const types = sql.join(
    input.types.map((type) => sql`${type}`),
    sql`, `,
  )

  const result = await db.execute(sql`
    UPDATE ${jobs} AS j
       SET status = 'running',
           claimed_by = ${input.claimedBy},
           lease_expires_at = ${now} + ${leaseInterval},
           attempts = j.attempts + 1,
           started_at = COALESCE(j.started_at, ${now}),
           updated_at = ${now}
     WHERE j.id IN (
       SELECT id FROM ${jobs}
        WHERE type IN (${types})
          AND (
            (status IN ('queued', 'failed_retryable') AND available_at <= ${now})
            OR (status = 'running' AND lease_expires_at < ${now})
          )
        ORDER BY available_at
        LIMIT ${input.limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING j.id, j.type, j.subject_id, j.payload, j.phase, j.attempts,
              j.claimed_by, j.lease_expires_at, j.created_at
  `)

  const rows = (
    result as unknown as {
      rows: {
        id: string
        type: string
        subject_id: string | null
        payload: Record<string, unknown>
        phase: string | null
        attempts: number
        claimed_by: string
        lease_expires_at: string | Date
        created_at: string | Date
      }[]
    }
  ).rows

  // Raw `execute` bypasses drizzle's column mapping: timestamptz arrives as the
  // wire string. Convert here so the declared `Date` type is actually true.
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    subjectId: row.subject_id,
    payload: row.payload,
    phase: row.phase,
    attempts: Number(row.attempts),
    claimedBy: row.claimed_by,
    leaseExpiresAt: new Date(row.lease_expires_at),
    createdAt: new Date(row.created_at),
  }))
}

/**
 * Push the lease out, for an executor still working.
 *
 * Returns false when the lease is no longer this worker's — the signal to stop
 * doing the work rather than to keep going and write over the new holder.
 */
export async function extendJobLease(
  db: Executor,
  input: { jobId: string; claimedBy: string; leaseTtlMs: number; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date()
  const rows = await db
    .update(jobs)
    .set({ leaseExpiresAt: new Date(now.getTime() + input.leaseTtlMs), updatedAt: now })
    .where(and(eq(jobs.id, input.jobId), eq(jobs.claimedBy, input.claimedBy)))
    .returning({ id: jobs.id })
  return rows.length > 0
}

/** Record which phase the executor has reached. Lease-guarded like every other write. */
export async function updateJobPhase(
  db: Executor,
  input: { jobId: string; claimedBy: string; phase: string; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date()
  const rows = await db
    .update(jobs)
    .set({ phase: input.phase, updatedAt: now })
    .where(and(eq(jobs.id, input.jobId), eq(jobs.claimedBy, input.claimedBy)))
    .returning({ id: jobs.id })
  return rows.length > 0
}

/** The three terminal states. A job in any of them leaves the liveness index,
 * so a later job for the same subject becomes possible. */
export type TerminalJobStatus = Extract<JobStatus, 'succeeded' | 'failed_terminal' | 'cancelled'>

/**
 * Settle a job terminally and release its lease.
 *
 * The lease is cleared in the same statement that writes the status, because the
 * `jobs_lease_check` constraint forbids the half-state either order would pass
 * through if they were two statements.
 */
export async function completeJob(
  db: Executor,
  input: {
    jobId: string
    claimedBy: string
    status: TerminalJobStatus
    error?: string | undefined
    now?: Date
  },
): Promise<boolean> {
  const now = input.now ?? new Date()
  const rows = await db
    .update(jobs)
    .set({
      status: input.status,
      claimedBy: null,
      leaseExpiresAt: null,
      finishedAt: now,
      lastError: input.error ?? null,
      updatedAt: now,
    })
    .where(and(eq(jobs.id, input.jobId), eq(jobs.claimedBy, input.claimedBy)))
    .returning({ id: jobs.id })
  return rows.length > 0
}

/**
 * Hand the job back for a later attempt.
 *
 * `failed_retryable` stays inside the liveness index on purpose: the job is
 * waiting out a backoff, not finished, and a second job enqueued for the same
 * subject beside it would double-execute the phases this one is part-way through.
 *
 * `resetAttempts` exists because `attempts` is incremented at *claim* time and
 * therefore counts claims, not failures. When the executor itself asked to be
 * called back later, no attempt failed — nothing went wrong — and letting that
 * claim count would let a job that is merely waiting (a stub polling for CP3, an
 * executor deferring on a fence) burn through `JOB_MAX_ATTEMPTS` and reach
 * `failed_terminal` without a single error ever having occurred. The reset is in
 * the same UPDATE as the status so there is no window where the row is retryable
 * with a stale count.
 */
export async function failJobRetryable(
  db: Executor,
  input: {
    jobId: string
    claimedBy: string
    error: string
    retryDelayMs: number
    /** Zero the attempt counter: this retry was requested, not failed. */
    resetAttempts?: boolean
    now?: Date
  },
): Promise<boolean> {
  const now = input.now ?? new Date()
  const rows = await db
    .update(jobs)
    .set({
      status: 'failed_retryable',
      availableAt: new Date(now.getTime() + input.retryDelayMs),
      claimedBy: null,
      leaseExpiresAt: null,
      lastError: input.error,
      ...(input.resetAttempts === true ? { attempts: 0 } : {}),
      updatedAt: now,
    })
    .where(and(eq(jobs.id, input.jobId), eq(jobs.claimedBy, input.claimedBy)))
    .returning({ id: jobs.id })
  return rows.length > 0
}

export interface JobsBacklogRow {
  readonly type: string
  readonly status: JobStatus
  readonly count: number
  /** Age of the oldest row in the group, by `created_at`. */
  readonly oldestAgeMs: number
}

/**
 * The unfinished backlog, per type and status.
 *
 * `created_at` rather than `available_at`, for the reason `readOutboxBacklog`
 * gives: the question is "how long has this work been owed", and a row in its
 * fifth backoff has an `available_at` in the future that would report ~0.
 */
export async function readJobsBacklog(db: Executor): Promise<JobsBacklogRow[]> {
  const result = await db.execute(sql`
    SELECT type,
           status,
           count(*)::int AS count,
           (extract(epoch FROM (now() - min(created_at))) * 1000)::bigint AS oldest_age_ms
      FROM ${jobs}
     WHERE status IN ('queued', 'running', 'failed_retryable')
     GROUP BY type, status
  `)

  const rows = (
    result as unknown as {
      rows: { type: string; status: string; count: number; oldest_age_ms: string }[]
    }
  ).rows

  return rows.map((row) => ({
    type: row.type,
    status: row.status as JobStatus,
    count: Number(row.count),
    oldestAgeMs: Number(row.oldest_age_ms),
  }))
}
