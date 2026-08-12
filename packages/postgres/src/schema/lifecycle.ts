import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { createdAt, idColumn, instant, primaryId, updatedAt } from './_shared.ts'

/**
 * Lifecycle tables.
 *
 * The two deletion tables are no longer the 0005 skeleton: migration 0021 gave
 * `deletion_targets` its phase vocabulary, its `(request, store, target)`
 * uniqueness and the ClickHouse mutation bookkeeping the resumable purge needs
 * (ADR-0030, decisions 3 and 4). `jobs` is not either: migration 0020 dropped
 * and recreated it as the leased, idempotent, subject-keyed table the job
 * runner actually claims from (ADR-0030, decision 3), and the mirror below is
 * that table.
 */

export type JobStatus =
  'queued' | 'running' | 'succeeded' | 'failed_retryable' | 'failed_terminal' | 'cancelled'
export type DeletionSubjectType = 'site' | 'account'
export type DeletionStatus = 'pending' | 'running' | 'completed' | 'failed'

export const jobs = pgTable(
  'jobs',
  {
    id: primaryId(),
    type: text('type').notNull(),
    /** The row the job acts on. Null for a job with no single subject. */
    subjectId: uuid('subject_id'),
    status: text('status').$type<JobStatus>().notNull().default('queued'),
    /** The executor's progress marker; its vocabulary belongs to the job type. */
    phase: text('phase'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    attempts: integer('attempts').notNull().default(0),
    availableAt: instant('available_at').notNull().defaultNow(),
    claimedBy: text('claimed_by'),
    leaseExpiresAt: instant('lease_expires_at'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    startedAt: instant('started_at'),
    finishedAt: instant('finished_at'),
  },
  (t) => [
    // One live job per (type, subject): the structural half of idempotency,
    // which the key alone cannot give when two producers mint different keys.
    uniqueIndex('jobs_live_subject_key')
      .on(t.type, t.subjectId)
      .where(sql`status IN ('queued', 'running', 'failed_retryable')`),
    index('jobs_due_idx').on(t.status, t.availableAt),
  ],
)

export const deletionRequests = pgTable(
  'deletion_requests',
  {
    id: primaryId(),
    subjectType: text('subject_type').$type<DeletionSubjectType>().notNull(),
    subjectId: uuid('subject_id').notNull(),
    status: text('status').$type<DeletionStatus>().notNull().default('pending'),
    requestedByUserId: uuid('requested_by_user_id'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: instant('completed_at'),
  },
  (t) => [index('deletion_requests_status_idx').on(t.status)],
)

/** The vocabulary migration 0028's CHECK pins. No `failed`: a target that failed
 * is `running` with `last_error` set, because failure in a purge phase is
 * transient by construction and the job retries it (ADR-0030, D4). */
export type DeletionTargetPhase = 'pending' | 'running' | 'completed'

/** The stores a target can name (ADR-0030, decision 7). `stripe` is account
 * deletion's (CP4) and `object` is reserved — no object store exists before M11. */
/**
 * The store column's type is the *vocabulary's*, which is open: a surface that
 * deletes from a store of its own registers it (`registerDeletionExtension`),
 * and this column records whatever the snapshot named. The closed list lives in
 * `@openanalytics/domain` where the targets are declared.
 */
export type DeletionTargetStore = string

export const deletionTargets = pgTable(
  'deletion_targets',
  {
    id: primaryId(),
    deletionRequestId: idColumn('deletion_request_id')
      .notNull()
      .references(() => deletionRequests.id, { onDelete: 'cascade' }),
    store: text('store').$type<DeletionTargetStore>().notNull(),
    target: text('target').notNull(),
    phase: text('phase').$type<DeletionTargetPhase>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    verified: boolean('verified').notNull().default(false),
    verification: jsonb('verification').$type<Record<string, unknown>>(),
    /** The ClickHouse mutation this target is waiting on (migration 0028). Null
     * for every non-ClickHouse store, and for a ClickHouse target whose
     * `ALTER … DELETE` has not been submitted yet — which is exactly the
     * distinction a resumed job needs to make. */
    mutationId: text('mutation_id'),
    /** The last transient failure recorded for this target — a ClickHouse
     * `latest_fail_reason`, a Redis error — so the table alone explains a stuck
     * purge without log correlation. */
    lastError: text('last_error'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('deletion_targets_request_idx').on(t.deletionRequestId),
    // The snapshot is a set: a re-executed start transaction must not be able to
    // double it, or "every target completed" passes on a half-purged site.
    unique('deletion_targets_request_store_target_key').on(t.deletionRequestId, t.store, t.target),
    check('deletion_targets_phase_check', sql`${t.phase} IN ('pending', 'running', 'completed')`),
  ],
)
