import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  IMPORT_RUN_CLEANABLE_STATES,
  IMPORT_RUN_LIVE_STATES,
  importArchiveObjectKey,
  type ImportRunState,
} from '@openanalytics/domain'
import type { Database, Executor } from '../client.ts'
import { newId } from '../ids.ts'
import { importRuns, importUploads } from '../schema/imports.ts'
import { sites, type SiteStatus } from '../schema/sites.ts'

/**
 * The import run repository (ADR-0032, D3/D6; migration 0030).
 *
 * Two ideas run through every function here:
 *
 * 1. **The live-run unique is the serialization mechanism, and it is a database
 *    fact.** `createImportRun` does not read "is there a live run?" and then
 *    insert — two requests that both read "no" would both insert. It inserts and
 *    lets `import_runs_live_site_key` refuse the second, then reports the
 *    existing run. The jobs table's own `(type, subject_id)` unique cannot stand
 *    in for this: `import_prepare` and `import_publish` are different types.
 *
 * 2. **Every transition names the states it is allowed to leave.** The guards
 *    are in the `WHERE`, not in a preceding `SELECT`, so a run that moved under
 *    a concurrent worker simply does not match and the caller is told `false`
 *    rather than overwriting a state machine somebody else advanced. This is the
 *    lease-guard idiom the job repository uses, applied to a state instead of a
 *    holder.
 *
 * The publish/rollback pointer swap is deliberately **not** here yet: it is one
 * transaction over `sites.published_import_run_id` plus two run rows, and it
 * belongs with the executor that performs it (CP2).
 */

/** The prepare job's type. Named here rather than at either end because the api
 * enqueues it and the worker's registry will execute it, and a literal in two
 * places is a registry entry that silently never fires. */
export const IMPORT_PREPARE_JOB_TYPE = 'import_prepare'

/** The publish job's type. Reserved by the same argument; its executor is CP2's. */
export const IMPORT_PUBLISH_JOB_TYPE = 'import_publish'

export interface ImportRunRow {
  readonly id: string
  readonly siteId: string
  readonly provider: string
  readonly state: ImportRunState
  readonly summary: Record<string, unknown> | null
  /** A calendar date (`YYYY-MM-DD`), not an instant — it partitions day keys. */
  readonly cutoverDate: string | null
  readonly stagingChunkBytes: number | null
  /** Per-report next chunk number; null before staging starts (migration 0031). */
  readonly stagingProgress: Record<string, number> | null
  /** The run this one superseded when it was published — the single rollback
   * generation (D3, migration 0031). */
  readonly supersededRunId: string | null
  readonly sweptAt: Date | null
  readonly errorCode: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly finishedAt: Date | null
}

export interface ImportUploadRow {
  readonly id: string
  readonly importRunId: string
  readonly objectKey: string
  readonly declaredBytes: number
  readonly contentType: string
  readonly etag: string | null
  readonly createdAt: Date
  readonly completedAt: Date | null
}

const runColumns = {
  id: importRuns.id,
  siteId: importRuns.siteId,
  provider: importRuns.provider,
  state: importRuns.state,
  summary: importRuns.summary,
  cutoverDate: importRuns.cutoverDate,
  stagingChunkBytes: importRuns.stagingChunkBytes,
  stagingProgress: importRuns.stagingProgress,
  supersededRunId: importRuns.supersededRunId,
  sweptAt: importRuns.sweptAt,
  errorCode: importRuns.errorCode,
  createdAt: importRuns.createdAt,
  updatedAt: importRuns.updatedAt,
  finishedAt: importRuns.finishedAt,
}

export interface CreateImportRunInput {
  readonly siteId: string
  readonly provider: string
  /** What the client says it will upload; the signed URL binds exactly this. */
  readonly declaredBytes: number
  readonly contentType: string
}

export type CreateImportRunResult =
  | { readonly ok: true; readonly run: ImportRunRow; readonly upload: ImportUploadRow }
  /** A non-terminal run already holds this site's import slot (D3). `runId` is
   * that run, so the caller can point the customer at it rather than at a
   * failure with nothing to act on. */
  | { readonly ok: false; readonly conflict: 'live_run'; readonly runId: string | null }
  /** The site is gone or on its way out. Reported as its own outcome rather
   * than thrown because the route's answer is `404 SITE_NOT_FOUND`, which is
   * what `requireAnalyticsAccess` already answers for a `deleting` site — a
   * torn-down site must not be distinguishable from one that never existed. */
  | { readonly ok: false; readonly conflict: 'site_unavailable' }

/** Postgres' unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505'

/**
 * Whether this error is the live-run unique refusing a second import.
 *
 * The cause chain is walked rather than the top-level error inspected, and that
 * is not defensive padding: drizzle wraps a driver failure in its own
 * `DrizzleQueryError` ("Failed query: insert into …") and hangs the `pg` error —
 * the only thing carrying `code` and `constraint` — off `cause`. Reading the
 * outer object alone matched nothing, so every conflict escaped as a 500 instead
 * of the `409` the frontend branches on. The live-Postgres suite is what caught
 * it; no fake could have, because the wrapping is drizzle's behaviour rather
 * than ours.
 *
 * The **constraint name** is checked, not just the SQLSTATE. This function runs
 * over a transaction that also inserts `import_uploads`, and a unique violation
 * from anywhere else in it must not be reported to the customer as "an import is
 * already in progress" — that would be a wrong answer wearing a correct one's
 * clothes.
 */
function isLiveRunConflict(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; current !== null && current !== undefined && depth < 5; depth += 1) {
    const candidate = current as { code?: string; constraint?: string; cause?: unknown }
    if (
      candidate.code === UNIQUE_VIOLATION &&
      candidate.constraint === 'import_runs_live_site_key'
    ) {
      return true
    }
    current = candidate.cause
  }
  return false
}

/**
 * Create a run and its upload row, or report what refuses it.
 *
 * One transaction: a run with no upload row would be a run whose object key
 * nothing knows, which the deletion registry enumerates *from* (D9) — so the
 * pair has to commit together or not at all.
 *
 * **The site row is locked first, and the lock is the whole point.** It is the
 * same `SELECT … FOR UPDATE` that `startSiteDeletion` takes before it snapshots
 * the deletion targets, which is what makes the two serialize instead of
 * interleaving: either this transaction wins and the deletion's snapshot
 * enumerates the object key it just wrote, or the deletion wins and this
 * transaction reads `deleting` and refuses. Without it a run — and an object
 * key — could be created in the window between the snapshot and the purge, and
 * nothing would ever delete those bytes: the port has no `list`, so a key that
 * missed the snapshot is a key nobody can find again.
 *
 * The live-run conflict is caught rather than pre-checked, and the catch is why
 * this takes a `Database` instead of an `Executor`: a raised `23505` aborts the
 * whole enclosing transaction, so recovering from it needs a transaction of its
 * own to abort. `enqueueJob` avoids the same problem by using a targetless
 * `ON CONFLICT DO NOTHING`; that is unavailable here because the second
 * statement (the upload row) depends on the first having inserted.
 */
export async function createImportRun(
  db: Database,
  input: CreateImportRunInput,
): Promise<CreateImportRunResult> {
  const runId = newId()

  try {
    return await db.transaction(async (tx) => {
      const locked = await tx.execute(sql`
        SELECT status FROM ${sites} WHERE id = ${input.siteId}::uuid FOR UPDATE
      `)
      const status = (locked as unknown as { rows: { status: SiteStatus }[] }).rows[0]?.status
      if (status === undefined || status === 'deleting' || status === 'deleted') {
        return { ok: false, conflict: 'site_unavailable' } as const
      }

      const [run] = await tx
        .insert(importRuns)
        .values({
          id: runId,
          siteId: input.siteId,
          provider: input.provider,
          state: 'uploading',
        })
        .returning(runColumns)

      const [upload] = await tx
        .insert(importUploads)
        .values({
          id: newId(),
          importRunId: runId,
          objectKey: importArchiveObjectKey(input.siteId, runId),
          declaredBytes: input.declaredBytes,
          contentType: input.contentType,
        })
        .returning()

      // Neither can be undefined — both are unconditional inserts with
      // RETURNING — but the types admit it and a non-null assertion would be a
      // worse way to say so.
      if (!run || !upload) throw new Error('import run insert returned no row')
      return { ok: true, run: toRunRow(run), upload: toUploadRow(upload) } as const
    })
  } catch (error) {
    if (!isLiveRunConflict(error)) throw error
    return { ok: false, conflict: 'live_run', runId: await findLiveImportRunId(db, input.siteId) }
  }
}

/** The site's one non-terminal run, if it has one. */
export async function findLiveImportRunId(db: Executor, siteId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: importRuns.id })
    .from(importRuns)
    .where(
      and(eq(importRuns.siteId, siteId), inArray(importRuns.state, [...IMPORT_RUN_LIVE_STATES])),
    )
  return row?.id ?? null
}

/** One run, scoped by site: a run id from another site reads as absent, which is
 * the same answer a caller who is not a member of that site would get anyway. */
export async function readImportRun(
  db: Executor,
  input: { siteId: string; importRunId: string },
): Promise<ImportRunRow | null> {
  const [row] = await db
    .select(runColumns)
    .from(importRuns)
    .where(and(eq(importRuns.id, input.importRunId), eq(importRuns.siteId, input.siteId)))
  return row ? toRunRow(row) : null
}

/** A run's upload row — *the* row, since `import_uploads_run_key` admits one per
 * run (migration 0030). Null for a run whose upload row is gone, which only a
 * purge produces, since the pair is created in one transaction. */
export async function readImportUpload(
  db: Executor,
  importRunId: string,
): Promise<ImportUploadRow | null> {
  const [row] = await db
    .select()
    .from(importUploads)
    .where(eq(importUploads.importRunId, importRunId))
  return row ? toUploadRow(row) : null
}

export async function listImportRuns(
  db: Executor,
  input: { siteId: string; limit?: number },
): Promise<ImportRunRow[]> {
  const rows = await db
    .select(runColumns)
    .from(importRuns)
    .where(eq(importRuns.siteId, input.siteId))
    .orderBy(desc(importRuns.createdAt))
    .limit(input.limit ?? 50)
  return rows.map(toRunRow)
}

export interface TransitionImportRunInput {
  readonly importRunId: string
  /** The states this move is allowed to leave. Empty is never valid — a
   * transition with no guard is an unconditional overwrite. */
  readonly from: readonly ImportRunState[]
  readonly to: ImportRunState
  /** Set on the failure path; explicit null clears a previous category. */
  readonly errorCode?: string | null
  /** Stamp `finished_at`. True for every terminal move. */
  readonly finished?: boolean
  /**
   * Written in the same statement as the state, never before it.
   *
   * Both belong to a transition rather than to the row: a summary attached to a
   * run that then failed to leave `processing` would describe work the state
   * machine says did not finish, and a `cutover_date` written outside the
   * `ready_for_review → publishing` move would be a partition boundary on a run
   * nobody published.
   */
  readonly summary?: Record<string, unknown>
  readonly cutoverDate?: string
  readonly now?: Date
}

/**
 * Move a run between states, guarded on where it is now.
 *
 * Reports `false` when nothing matched — the run is gone, or somebody else
 * already moved it. Callers turn that into a conflict rather than retrying: a
 * state machine that lost a race has an answer (the current state), not a
 * transient error.
 */
export async function transitionImportRun(
  db: Executor,
  input: TransitionImportRunInput,
): Promise<boolean> {
  const now = input.now ?? new Date()
  const rows = await db
    .update(importRuns)
    .set({
      state: input.to,
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      ...(input.finished === true ? { finishedAt: now } : {}),
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      ...(input.cutoverDate === undefined ? {} : { cutoverDate: input.cutoverDate }),
      updatedAt: now,
    })
    .where(and(eq(importRuns.id, input.importRunId), inArray(importRuns.state, [...input.from])))
    .returning({ id: importRuns.id })
  return rows.length > 0
}

/**
 * Record the ETag the `complete` call observed on the object.
 *
 * The worker verifies it before parsing, which is what stops a client from
 * re-PUTting different bytes through the still-valid signed URL after the size
 * check passed (D6 step 2). Pinned in the same call that stamps `completed_at`,
 * so an upload row can never claim to be complete without the fingerprint the
 * verification needs.
 */
export async function pinUploadEtag(
  db: Executor,
  input: { importRunId: string; etag: string; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date()
  const rows = await db
    .update(importUploads)
    .set({ etag: input.etag, completedAt: now })
    .where(eq(importUploads.importRunId, input.importRunId))
    .returning({ id: importUploads.id })
  return rows.length > 0
}

/** The object keys a site has staged — what the deletion snapshot records before
 * `postgres_purge` deletes the rows that carry them (ADR-0032, D9). */
export async function listSiteImportObjectKeys(db: Executor, siteId: string): Promise<string[]> {
  const rows = await db
    .select({ objectKey: importUploads.objectKey })
    .from(importUploads)
    .innerJoin(importRuns, eq(importRuns.id, importUploads.importRunId))
    .where(eq(importRuns.siteId, siteId))
  return rows.map((row) => row.objectKey)
}

export interface ExpiredImportUpload {
  readonly importRunId: string
  readonly siteId: string
  /** Null when the run somehow has no upload row; the sweep still fails the run. */
  readonly objectKey: string | null
}

/**
 * Runs whose upload never completed within the TTL (ADR-0032, D7).
 *
 * The deadline is computed **in SQL against `now()`**, not against a JS `Date`
 * the worker passes in. `created_at` is stamped by the database, and a worker
 * whose clock sits minutes ahead would otherwise sweep runs that are not
 * actually expired — the M10 rule, and the reason `claimDueJobs` compares the
 * same way.
 *
 * **`FOR UPDATE OF r SKIP LOCKED`**, the shape `listSitesPastRetentionDeadline`
 * uses: only the run rows are locked — the upload join is a read, and a
 * `LEFT JOIN`'s nullable side cannot be locked at all — and a run another
 * sweeper is already holding is skipped rather than waited for. Like every
 * discovery query in the sweeper this is an efficiency, not the correctness
 * argument: the lock is released when this transaction commits, long before the
 * per-item work runs, so two sweepers can still serve the same run. What makes
 * that safe is the guarded transition each item performs.
 */
export async function listExpiredImportUploads(
  db: Database,
  input: { ttlDays: number; limit: number },
): Promise<ExpiredImportUpload[]> {
  return await db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      SELECT r.id AS import_run_id,
             r.site_id,
             u.object_key
        FROM ${importRuns} r
        LEFT JOIN ${importUploads} u ON u.import_run_id = r.id
       WHERE r.state IN ('uploading', 'uploaded')
         AND r.created_at < now() - make_interval(days => ${input.ttlDays})
       ORDER BY r.created_at
       LIMIT ${input.limit}
       FOR UPDATE OF r SKIP LOCKED
    `)

    const rows = (
      result as unknown as {
        rows: { import_run_id: string; site_id: string; object_key: string | null }[]
      }
    ).rows

    return rows.map((row) => ({
      importRunId: row.import_run_id,
      siteId: row.site_id,
      objectKey: row.object_key,
    }))
  })
}

// --- Staging progress (ADR-0032, D7) -----------------------------------------

/**
 * Fix the chunk size staging will use, and report the value that is now binding.
 *
 * `COALESCE` rather than an unconditional write, and it is the whole point of
 * the column: the ClickHouse insert dedup token is `{run}:{report}:{chunk_no}`,
 * so if a deploy retuned the policy default between a first attempt and a retry,
 * the same token would name a *different* set of rows and the retry would
 * duplicate rather than deduplicate. The first attempt records what it used and
 * every later one reuses it, however the default has since moved.
 *
 * Returns the effective value, which is the recorded one for a resumed run and
 * the proposed one for a fresh one.
 */
export async function recordStagingChunkBytes(
  db: Executor,
  input: { importRunId: string; proposedBytes: number; now?: Date },
): Promise<number | null> {
  const now = input.now ?? new Date()
  const rows = await db
    .update(importRuns)
    .set({
      stagingChunkBytes: sql`COALESCE(${importRuns.stagingChunkBytes}, ${input.proposedBytes})`,
      updatedAt: now,
    })
    .where(eq(importRuns.id, input.importRunId))
    .returning({ stagingChunkBytes: importRuns.stagingChunkBytes })
  const value = rows[0]?.stagingChunkBytes
  return value === undefined || value === null ? null : Number(value)
}

/**
 * Record that a report's chunks are durable up to (but not including) `nextChunk`.
 *
 * Written **after** the insert returns, never before. A crash between the two
 * costs one chunk re-inserted under a token ClickHouse has already seen — a
 * no-op under the table's dedup window. Written first, a crash in between would
 * skip that chunk permanently, and the run would publish with a hole nothing
 * could detect afterwards.
 *
 * `jsonb_set` with `create_missing` on the whole object, so the first report to
 * finish a chunk creates the object and the rest add to it — one statement per
 * chunk, no read-modify-write, and therefore nothing to lose if two writers
 * somehow overlapped (they cannot: the job lease is the serializer).
 */
export async function recordStagingProgress(
  db: Executor,
  input: { importRunId: string; report: string; nextChunk: number; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date()
  await db.execute(sql`
    UPDATE ${importRuns}
       SET staging_progress = jsonb_set(
             COALESCE(staging_progress, '{}'::jsonb),
             ARRAY[${input.report}],
             to_jsonb(${input.nextChunk}::int),
             true
           ),
           updated_at = ${now}
     WHERE id = ${input.importRunId}::uuid
  `)
}

/** Clear the staging bookkeeping a failed run leaves behind, so a *later* run of
 * the same site is never resumed from a dead one's progress. The run id is the
 * dedup token's prefix, so this is bookkeeping hygiene rather than correctness —
 * but a stale progress object on a row an operator is reading is a lie. */
export async function clearStagingProgress(
  db: Executor,
  input: { importRunId: string; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date()
  await db
    .update(importRuns)
    .set({ stagingProgress: null, updatedAt: now })
    .where(eq(importRuns.id, input.importRunId))
}

// --- Publish and rollback (ADR-0032, D3) --------------------------------------

export interface SiteImportContext {
  /** ADR-0027's install-verified signal; the cutover clamp's only input (D4). */
  readonly firstEventAt: Date | null
  /** The pointer. Null for a site showing no imported history. */
  readonly publishedImportRunId: string | null
  readonly status: SiteStatus
}

/** The two site facts publish and rollback decide on, read together so a route
 * does not make two round trips for one decision. */
export async function readSiteImportContext(
  db: Executor,
  siteId: string,
): Promise<SiteImportContext | null> {
  const result = await db.execute(sql`
    SELECT first_event_at, published_import_run_id, status
      FROM ${sites}
     WHERE id = ${siteId}::uuid
  `)
  const row = (
    result as unknown as {
      rows: {
        first_event_at: string | Date | null
        published_import_run_id: string | null
        status: SiteStatus
      }[]
    }
  ).rows[0]
  if (!row) return null
  return {
    firstEventAt: row.first_event_at === null ? null : new Date(row.first_event_at),
    publishedImportRunId: row.published_import_run_id,
    status: row.status,
  }
}

export type PublishImportRunResult =
  | {
      readonly ok: true
      /** True when this call performed the swap; false when it found the run
       * already `published` and did nothing. Both are successes — the second is
       * what makes the publish job safe to re-run after its lease was stolen
       * between the commit and the settlement. */
      readonly swapped: boolean
      /** The run this publish superseded, or null for a site's first import.
       * The rollback generation, and the run cleanup must NOT touch. */
      readonly predecessorRunId: string | null
    }
  | { readonly ok: false; readonly conflict: 'state' | 'site_unavailable' }

/**
 * The publish swap (D3): one transaction, three rows.
 *
 * `sites` is taken `FOR UPDATE` first and everything else follows from that
 * lock. It serializes this against `createImportRun` and `startSiteDeletion`,
 * which take the same lock, so a publish can neither land on a site being torn
 * down nor slip a pointer past a deletion's target snapshot.
 *
 * The order inside is: run → `published`, predecessor → `superseded`, pointer →
 * run. All three commit together, so there is no instant at which the pointer
 * names a run that is not `published`, and none at which two runs claim to be.
 *
 * `superseded_run_id` is written here and nowhere else. It is what makes
 * rollback a lookup instead of "the most recent superseded run", which is the
 * same answer only until a cleanup fails or two runs settle in one millisecond.
 *
 * **Idempotent by state, not by key.** A re-run finds the run already
 * `published` and returns `swapped: false` with the recorded predecessor, so the
 * publish job can go straight to its cleanup. Guarding on `publishing` in the
 * `WHERE` is what makes that distinction a database fact rather than a read
 * followed by a hope.
 */
export async function publishImportRun(
  db: Database,
  input: { siteId: string; importRunId: string; now?: Date },
): Promise<PublishImportRunResult> {
  const now = input.now ?? new Date()

  return await db.transaction(async (tx) => {
    const locked = await tx.execute(sql`
      SELECT status, published_import_run_id
        FROM ${sites}
       WHERE id = ${input.siteId}::uuid
       FOR UPDATE
    `)
    const site = (
      locked as unknown as {
        rows: { status: SiteStatus; published_import_run_id: string | null }[]
      }
    ).rows[0]
    if (!site || site.status === 'deleting' || site.status === 'deleted') {
      return { ok: false, conflict: 'site_unavailable' } as const
    }

    const current = await tx
      .select({ state: importRuns.state, supersededRunId: importRuns.supersededRunId })
      .from(importRuns)
      .where(and(eq(importRuns.id, input.importRunId), eq(importRuns.siteId, input.siteId)))
    const run = current[0]
    if (!run) return { ok: false, conflict: 'state' } as const

    if (run.state === 'published') {
      // Already done — a stolen lease, a replayed job, a lost response. The
      // recorded predecessor is returned so the caller's cleanup knows which
      // superseded run is the live rollback generation.
      return { ok: true, swapped: false, predecessorRunId: run.supersededRunId } as const
    }
    if (run.state !== 'publishing') return { ok: false, conflict: 'state' } as const

    const predecessorRunId =
      site.published_import_run_id === input.importRunId ? null : site.published_import_run_id

    const promoted = await tx
      .update(importRuns)
      .set({
        state: 'published',
        supersededRunId: predecessorRunId,
        finishedAt: now,
        errorCode: null,
        updatedAt: now,
      })
      .where(and(eq(importRuns.id, input.importRunId), eq(importRuns.state, 'publishing')))
      .returning({ id: importRuns.id })
    if (promoted.length === 0) return { ok: false, conflict: 'state' } as const

    if (predecessorRunId !== null) {
      await tx
        .update(importRuns)
        .set({ state: 'superseded', updatedAt: now })
        .where(and(eq(importRuns.id, predecessorRunId), eq(importRuns.state, 'published')))
    }

    await tx.execute(sql`
      UPDATE ${sites}
         SET published_import_run_id = ${input.importRunId}::uuid
       WHERE id = ${input.siteId}::uuid
    `)

    return { ok: true, swapped: true, predecessorRunId } as const
  })
}

export type RollbackImportRunResult =
  | {
      readonly ok: true
      /** The run the pointer now names, or null when the rolled-back run was the
       * site's first import and there is nothing behind it. */
      readonly restoredRunId: string | null
    }
  | {
      readonly ok: false
      readonly conflict:
        | 'not_published'
        | 'site_unavailable'
        /**
         * The run names a predecessor that can no longer be restored — already
         * swept, already moved, or gone.
         *
         * Its own outcome rather than "restore nothing and null the pointer",
         * which is what this code used to do and is the worst possible answer:
         * the customer asks to undo an import and silently loses the *previous*
         * one too, with the site reading as though it had never imported
         * anything. Refusing leaves the published run exactly where it is.
         */
        | 'generation_erased'
    }

/**
 * Undo the last publish (D3): one transaction, pure Postgres, no ClickHouse.
 *
 * That it touches no analytics store at all is the point of the whole staging
 * design. The predecessor's rows were never deleted — cleanup keeps exactly one
 * rollback generation — so restoring them is moving a pointer, and the operation
 * is as fast and as atomic as any other single-row update.
 *
 * The run must be the one the pointer currently names. Rolling back an *older*
 * published run is not a coherent request: its successor is what the site is
 * showing, and "undo the thing before the thing you are looking at" would leave
 * the dashboard exactly as it was while telling the customer something happened.
 *
 * A run with no predecessor is a valid rollback, not an error: the pointer goes
 * to NULL and the site reads as having no imported history, which is precisely
 * where it was before the import. The guard is on the *pointer*, never on the
 * existence of something to restore.
 */
export async function rollbackImportRun(
  db: Database,
  input: { siteId: string; importRunId: string; now?: Date },
): Promise<RollbackImportRunResult> {
  const now = input.now ?? new Date()

  return await db.transaction(async (tx) => {
    const locked = await tx.execute(sql`
      SELECT status, published_import_run_id
        FROM ${sites}
       WHERE id = ${input.siteId}::uuid
       FOR UPDATE
    `)
    const site = (
      locked as unknown as {
        rows: { status: SiteStatus; published_import_run_id: string | null }[]
      }
    ).rows[0]
    if (!site || site.status === 'deleting' || site.status === 'deleted') {
      return { ok: false, conflict: 'site_unavailable' } as const
    }
    if (site.published_import_run_id !== input.importRunId) {
      return { ok: false, conflict: 'not_published' } as const
    }

    // **Every check before every write.** The predecessor's restorability is
    // decided first, so a refusal returns from a transaction that has changed
    // nothing — no `tx.rollback()`, no half-applied rollback, and the published
    // run is provably still published when the caller sees the conflict.
    const current = await tx
      .select({ state: importRuns.state, supersededRunId: importRuns.supersededRunId })
      .from(importRuns)
      .where(and(eq(importRuns.id, input.importRunId), eq(importRuns.siteId, input.siteId)))
      .for('update')
    const run = current[0]
    if (!run || run.state !== 'published') {
      return { ok: false, conflict: 'not_published' } as const
    }

    let restoredRunId: string | null = null
    if (run.supersededRunId !== null) {
      // A run that names a predecessor must be able to restore it, or the whole
      // operation is refused. Three ways it cannot:
      //
      //   * `swept_at` is set — the cleanup backstop already erased its staged
      //     ClickHouse rows, so "restoring" it would repoint the site at a
      //     generation with no data and render an empty dashboard;
      //   * it is not `superseded` any more — an operator or a later publish
      //     moved it, and resurrecting it into `published` would put two runs in
      //     that state;
      //   * the row is gone entirely.
      //
      // The old behaviour was to restore nothing and null the pointer, which
      // turned "undo this import" into "lose this import AND the one before it".
      const predecessor = await tx
        .select({ state: importRuns.state, sweptAt: importRuns.sweptAt })
        .from(importRuns)
        .where(eq(importRuns.id, run.supersededRunId))
        .for('update')
      const previous = predecessor[0]
      if (!previous || previous.state !== 'superseded' || previous.sweptAt !== null) {
        return { ok: false, conflict: 'generation_erased' } as const
      }
      restoredRunId = run.supersededRunId
    }

    const rolled = await tx
      .update(importRuns)
      .set({ state: 'rolled_back', finishedAt: now, updatedAt: now })
      .where(and(eq(importRuns.id, input.importRunId), eq(importRuns.state, 'published')))
      .returning({ id: importRuns.id })
    if (rolled.length === 0) return { ok: false, conflict: 'not_published' } as const

    if (restoredRunId !== null) {
      // Still guarded on `superseded` even though it was just checked under a row
      // lock: the guard costs nothing and is what the state machine is written
      // in everywhere else.
      await tx
        .update(importRuns)
        .set({ state: 'published', finishedAt: now, updatedAt: now })
        .where(and(eq(importRuns.id, restoredRunId), eq(importRuns.state, 'superseded')))
    }

    await tx.execute(sql`
      UPDATE ${sites}
         SET published_import_run_id = ${restoredRunId}::uuid
       WHERE id = ${input.siteId}::uuid
    `)

    return { ok: true, restoredRunId } as const
  })
}

// --- Cleanup selection (ADR-0032, D3/D7) --------------------------------------

export interface CleanableImportRun {
  readonly importRunId: string
  readonly siteId: string
  /** Null when the run has no upload row — a purge removed it, or the run
   * predates the pairing. The staged ClickHouse rows are still cleaned. */
  readonly objectKey: string | null
}

/**
 * What a publish of this site may erase (D3).
 *
 * Two sets, in one query because they are cleaned identically:
 *
 * 1. **The grandparents** — everything of this site in `superseded` *except* the
 *    run the just-published one names as its predecessor. That exception is the
 *    entire "exactly one rollback generation" rule, and expressing it as an id
 *    comparison rather than as "the newest superseded run" is what makes it
 *    survive a failed cleanup: a grandparent that was not erased last time is
 *    still not the predecessor and is picked up again here, while the real
 *    rollback generation is never at risk.
 * 2. **Long-dead terminal runs** — `failed`, `discarded` and `rolled_back` past
 *    `IMPORT_UPLOAD_TTL_DAYS`. Their own job should have cleaned them, and a
 *    publish is a cheap, natural moment to notice that it did not. The sweeper
 *    covers the sites that never publish again.
 *
 * The age comparison is `now()` **in SQL** against a database-stamped
 * `updated_at`, the M10 rule: a worker whose clock runs ahead would otherwise
 * erase a run that is still inside its window.
 *
 * Already-swept runs are excluded so a repeated publish does not re-issue eight
 * mutations per run for work that is done.
 */
export async function listCleanableSiteImportRuns(
  db: Executor,
  input: {
    siteId: string
    predecessorRunId: string | null
    ttlDays: number
    limit?: number
  },
): Promise<CleanableImportRun[]> {
  const result = await db.execute(sql`
    SELECT r.id AS import_run_id, r.site_id, u.object_key
      FROM ${importRuns} r
      LEFT JOIN ${importUploads} u ON u.import_run_id = r.id
     WHERE r.site_id = ${input.siteId}::uuid
       AND r.swept_at IS NULL
       AND (
         (
           r.state = 'superseded'
           AND (${input.predecessorRunId}::uuid IS NULL OR r.id <> ${input.predecessorRunId}::uuid)
         )
         OR (
           r.state IN ('failed', 'discarded', 'rolled_back')
           AND r.updated_at < now() - make_interval(days => ${input.ttlDays})
         )
       )
     ORDER BY r.updated_at
     LIMIT ${input.limit ?? 20}
  `)
  return toCleanable(result)
}

/**
 * The sweeper's backstop set (D7).
 *
 * Runs whose staged rows and object nothing is going to clean on its own:
 * terminal by their own transition (`failed`, `discarded`, `rolled_back`), or
 * `superseded` and **no longer any run's `superseded_run_id`** — which is
 * exactly the grandparent condition, re-derived here because the publish that
 * should have done it may have died between the swap and the cleanup.
 *
 * The deadline is `now()` **in SQL**, against a database-stamped `updated_at`.
 * A worker whose clock runs ahead would otherwise erase the staged rows of a run
 * that is still inside its retention window — including, for a `superseded` run,
 * the data a customer's rollback is about to need.
 *
 * `FOR UPDATE OF r SKIP LOCKED`, like every other discovery query in the
 * sweeper: an efficiency, not the correctness argument. Correctness comes from
 * `markImportRunSwept` being idempotent and from the cleanup itself being safe
 * to run twice.
 */
export async function listCleanableImportRuns(
  db: Database,
  input: { ttlDays: number; limit: number },
): Promise<CleanableImportRun[]> {
  return await db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      SELECT r.id AS import_run_id, r.site_id, u.object_key
        FROM ${importRuns} r
        LEFT JOIN ${importUploads} u ON u.import_run_id = r.id
       WHERE r.swept_at IS NULL
         AND r.updated_at < now() - make_interval(days => ${input.ttlDays})
         AND (
           r.state IN ('failed', 'discarded', 'rolled_back')
           OR (
             r.state = 'superseded'
             AND NOT EXISTS (
               SELECT 1 FROM ${importRuns} successor
                WHERE successor.superseded_run_id = r.id
                  AND successor.state = 'published'
             )
           )
         )
       ORDER BY r.updated_at
       LIMIT ${input.limit}
       FOR UPDATE OF r SKIP LOCKED
    `)
    return toCleanable(result)
  })
}

function toCleanable(result: unknown): CleanableImportRun[] {
  const rows = (
    result as { rows: { import_run_id: string; site_id: string; object_key: string | null }[] }
  ).rows
  return rows.map((row) => ({
    importRunId: row.import_run_id,
    siteId: row.site_id,
    objectKey: row.object_key,
  }))
}

/**
 * Take exclusive ownership of a run's cleanup, or report that it is not
 * available.
 *
 * **A claim, not a receipt, and it runs before the deletes rather than after.**
 * The candidate list is read outside any transaction and the cleanup that
 * follows issues eight ClickHouse mutations per run — a window of seconds — and
 * in that window a concurrent rollback can restore a `superseded` candidate to
 * `published`. Erasing its rows then would empty a dashboard the customer had
 * just asked to see again. The guarded `UPDATE … RETURNING` closes it in the
 * only way a cross-store operation can be closed: `swept_at` is set *first*,
 * atomically, and only a caller that won the row proceeds.
 *
 * It composes with `rollbackImportRun`, which refuses to restore a predecessor
 * whose `swept_at` is set. Between them there is no interleaving in which one
 * side believes the rows are live and the other is deleting them: whoever writes
 * first wins, and the loser is told.
 *
 * `false` means "not yours" — already claimed, or no longer in a cleanable state
 * (the state guard is what a republished run trips). Callers skip such a run
 * rather than treating it as an error.
 */
export async function claimImportRunForCleanup(
  db: Executor,
  input: { importRunId: string; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date()
  const rows = await db
    .update(importRuns)
    .set({ sweptAt: now, stagingProgress: null })
    .where(
      and(
        eq(importRuns.id, input.importRunId),
        isNull(importRuns.sweptAt),
        inArray(importRuns.state, [...IMPORT_RUN_CLEANABLE_STATES]),
      ),
    )
    .returning({ id: importRuns.id })
  return rows.length > 0
}

/**
 * Hand a claim back, for a cleanup that could not finish.
 *
 * Only the ClickHouse half calls it. A run left marked with its staged rows
 * still present is a leak nothing would ever look at again — `swept_at` is
 * exactly what removes it from the backstop's candidate set — so a failed delete
 * has to undo the claim rather than keep it. The object half deliberately does
 * *not*: the bucket's `imports/` lifecycle rule reaps that on its own schedule,
 * and re-examining the run forever to chase it would re-issue eight mutations a
 * tick for work already done.
 */
export async function releaseImportRunCleanupClaim(
  db: Executor,
  input: { importRunId: string },
): Promise<void> {
  await db.update(importRuns).set({ sweptAt: null }).where(eq(importRuns.id, input.importRunId))
}

type RawRun = {
  id: string
  siteId: string
  provider: string
  state: ImportRunState
  summary: Record<string, unknown> | null
  cutoverDate: string | null
  stagingChunkBytes: number | null
  stagingProgress: Record<string, number> | null
  supersededRunId: string | null
  sweptAt: Date | null
  errorCode: string | null
  createdAt: Date
  updatedAt: Date
  finishedAt: Date | null
}

function toRunRow(row: RawRun): ImportRunRow {
  return {
    ...row,
    stagingChunkBytes: row.stagingChunkBytes === null ? null : Number(row.stagingChunkBytes),
  }
}

type RawUpload = {
  id: string
  importRunId: string
  objectKey: string
  declaredBytes: number
  contentType: string
  etag: string | null
  createdAt: Date
  completedAt: Date | null
}

function toUploadRow(row: RawUpload): ImportUploadRow {
  return { ...row, declaredBytes: Number(row.declaredBytes) }
}
