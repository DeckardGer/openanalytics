import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  EXPORT_RUN_LIVE_STATES,
  exportObjectKeysOf,
  exportObjectPrefix,
  type ExportChunkRecord,
  type ExportManifest,
  type ExportProgress,
  type ExportRunState,
} from '@openanalytics/domain'
import type { Database, Executor } from '../client.ts'
import { newId } from '../ids.ts'
import { exportRuns } from '../schema/exports.ts'
import { sites, type SiteStatus } from '../schema/sites.ts'
import { writeAudit } from './audit.ts'
import { enqueueJob } from './jobs.ts'

/**
 * The export run repository (ADR-0032, D8/D9; migration 0032).
 *
 * Three ideas run through it, and each one is a property the application layer
 * cannot recover if this file gets it wrong:
 *
 * 1. **The cutoff and the pin are one snapshot.** They are taken inside a single
 *    transaction that holds the site row, so a publish or a rollback landing
 *    mid-export cannot make the early chunks disagree with the late ones. The
 *    cutoff is the DATABASE clock (`now()` in SQL), never a `Date` from a
 *    service whose clock may run ahead of the one that stamped `accepted_at`.
 * 2. **Every uploaded key is recorded before it is anybody's job to find it.**
 *    The storage port has no `list` (D9), so a chunk whose key was never written
 *    to `progress` is a chunk nothing can enumerate — not a deletion, not a
 *    sweep, not an operator. `recordExportChunk` is therefore called after each
 *    upload rather than once at the end.
 * 3. **The deadlines are computed in SQL.** The seven-day download window is
 *    `finished_at < now() - make_interval(...)`, the M10 rule: an api whose
 *    clock sits minutes ahead would otherwise expire an export that is still
 *    inside its window, and there is no way back — the bytes are gone from the
 *    customer's side of the conversation the moment we say they are.
 */

/** The export job's type. Named here rather than at either end because the api
 * enqueues it and the worker's registry executes it, and a literal in two places
 * is a registry entry that silently never fires. */
export const EXPORT_RUN_JOB_TYPE = 'export_run'

/** The job's idempotency key, derived from the run. Shared so the api's enqueue
 * and the api's status lookup cannot drift apart. */
export function exportRunJobKey(exportRunId: string): string {
  return `${EXPORT_RUN_JOB_TYPE}:${exportRunId}`
}

export interface ExportRunRow {
  readonly id: string
  readonly siteId: string
  readonly requestedBy: string | null
  readonly state: ExportRunState
  readonly cutoff: Date
  readonly pinnedImportRunId: string | null
  readonly manifest: ExportManifest | null
  readonly progress: ExportProgress | null
  readonly objectPrefix: string
  readonly errorCode: string | null
  readonly createdAt: Date
  readonly startedAt: Date | null
  readonly finishedAt: Date | null
  readonly sweptAt: Date | null
}

const runColumns = {
  id: exportRuns.id,
  siteId: exportRuns.siteId,
  requestedBy: exportRuns.requestedBy,
  state: exportRuns.state,
  cutoff: exportRuns.cutoff,
  pinnedImportRunId: exportRuns.pinnedImportRunId,
  manifest: exportRuns.manifest,
  progress: exportRuns.progress,
  objectPrefix: exportRuns.objectPrefix,
  errorCode: exportRuns.errorCode,
  createdAt: exportRuns.createdAt,
  startedAt: exportRuns.startedAt,
  finishedAt: exportRuns.finishedAt,
  sweptAt: exportRuns.sweptAt,
}

export type CreateExportRunResult =
  | { readonly ok: true; readonly run: ExportRunRow; readonly jobId: string | null }
  /** A live export already holds this site's export slot. `exportRunId` is that
   * run, so the caller can point the customer at it rather than at a failure
   * with nothing to act on. */
  | { readonly ok: false; readonly conflict: 'live_export'; readonly exportRunId: string | null }
  /** The site is gone or on its way out. Its own outcome rather than an
   * exception, because the route's answer is `404 SITE_NOT_FOUND` — a torn-down
   * site must not be distinguishable from one that never existed. */
  | { readonly ok: false; readonly conflict: 'site_unavailable' }

/** Rolls the create transaction back when the runner's liveness index refuses
 * the job. Thrown rather than returned because a returned value commits — and
 * an `export_runs` row with no job to work it would sit `queued` forever while
 * the site's real export ran beside it. */
class ExportEnqueueRefused extends Error {
  readonly existingJobId: string | null
  constructor(existingJobId: string | null) {
    super('an export job is already live for this site')
    this.name = 'ExportEnqueueRefused'
    this.existingJobId = existingJobId
  }
}

export interface CreateExportRunInput {
  readonly siteId: string
  /** The member who asked. Nullable so a future system-initiated export (a DSAR
   * pipeline, say) needs no schema change; the audit row's actor type follows. */
  readonly requestedByUserId?: string | null
  readonly requestId?: string | null
}

/**
 * Create the run, pin its consistency, enqueue its job and audit the request —
 * in one transaction.
 *
 * **The site row is locked first**, the same `SELECT … FOR UPDATE` that
 * `createImportRun` and `startSiteDeletion` take, and it is doing three jobs at
 * once here:
 *
 * - it serializes against a deletion, so either this transaction wins and the
 *   deletion's object snapshot enumerates the prefix it just recorded, or the
 *   deletion wins and this reads `deleting` and refuses. A run created in the
 *   window between the snapshot and the purge would leave chunks in the bucket
 *   that nothing could ever address again;
 * - it serializes against a publish or a rollback, which take the same lock, so
 *   `published_import_run_id` read under it is a pointer that cannot move while
 *   this transaction is deciding what to pin;
 * - it serializes two concurrent create requests for the same site, which is
 *   what makes the live-run pre-check below meaningful rather than a race.
 *
 * The **enqueue is the authority** on "one live export per site" regardless
 * (D8): the pre-check reads this table, and the jobs table's own
 * `(type, subject_id)` liveness index is what the ADR names. If it refuses, the
 * whole transaction is rolled back rather than leaving an orphan row.
 */
export async function createExportRun(
  db: Database,
  input: CreateExportRunInput,
): Promise<CreateExportRunResult> {
  const exportRunId = newId()

  try {
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

      const live = await findLiveExportRunId(tx, input.siteId)
      if (live !== null) {
        return { ok: false, conflict: 'live_export', exportRunId: live } as const
      }

      const [row] = await tx
        .insert(exportRuns)
        .values({
          id: exportRunId,
          siteId: input.siteId,
          state: 'queued',
          // The database clock, in the same statement as the pinned pointer.
          // A JS `Date` here would be the api's clock deciding which of the
          // worker's rows are inside the export.
          cutoff: sql`now()`,
          objectPrefix: exportObjectPrefix(input.siteId, exportRunId),
          ...(input.requestedByUserId === undefined || input.requestedByUserId === null
            ? {}
            : { requestedBy: input.requestedByUserId }),
          ...(site.published_import_run_id === null
            ? {}
            : { pinnedImportRunId: site.published_import_run_id }),
        })
        .returning(runColumns)
      if (!row) throw new Error('export run insert returned no row')

      const enqueued = await enqueueJob(tx, {
        type: EXPORT_RUN_JOB_TYPE,
        subjectId: input.siteId,
        idempotencyKey: exportRunJobKey(exportRunId),
        payload: { export_run_id: exportRunId },
      })
      if (!enqueued.enqueued) throw new ExportEnqueueRefused(enqueued.id)

      // In the same transaction as the row it describes, which is this ledger's
      // rule (02 §6): an export request that was recorded but never created, or
      // created but never recorded, would be a gap in exactly the trail 02 §25
      // requires exports to leave.
      await writeAudit(tx, {
        action: 'site.export.requested',
        actorUserId: input.requestedByUserId ?? null,
        actorType: input.requestedByUserId ? 'user' : 'system',
        siteId: input.siteId,
        targetType: 'export_run',
        targetId: exportRunId,
        // Safe, categorized detail: what was pinned, never what was exported.
        metadata: {
          cutoff: row.cutoff.toISOString(),
          pinned_import_run_id: row.pinnedImportRunId,
        },
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      })

      return { ok: true, run: row, jobId: enqueued.id } as const
    })
  } catch (error) {
    if (!(error instanceof ExportEnqueueRefused)) throw error
    // The liveness index refused: another export of this site is live. The row
    // this transaction wrote is rolled back with it, so nothing is orphaned.
    return {
      ok: false,
      conflict: 'live_export',
      exportRunId: await findLiveExportRunId(db, input.siteId),
    }
  }
}

/** The site's live export, if it has one. */
export async function findLiveExportRunId(db: Executor, siteId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: exportRuns.id })
    .from(exportRuns)
    .where(
      and(eq(exportRuns.siteId, siteId), inArray(exportRuns.state, [...EXPORT_RUN_LIVE_STATES])),
    )
    .orderBy(desc(exportRuns.createdAt))
    .limit(1)
  return row?.id ?? null
}

/** One run, scoped by site: an export id from another site reads as absent,
 * which is the same answer a non-member would get anyway. */
export async function readExportRun(
  db: Executor,
  input: { siteId: string; exportRunId: string },
): Promise<ExportRunRow | null> {
  const [row] = await db
    .select(runColumns)
    .from(exportRuns)
    .where(and(eq(exportRuns.id, input.exportRunId), eq(exportRuns.siteId, input.siteId)))
  return row ?? null
}

export async function listExportRuns(
  db: Executor,
  input: { siteId: string; limit?: number },
): Promise<ExportRunRow[]> {
  return await db
    .select(runColumns)
    .from(exportRuns)
    .where(eq(exportRuns.siteId, input.siteId))
    .orderBy(desc(exportRuns.createdAt))
    .limit(input.limit ?? 50)
}

/**
 * Move the run to `running` and stamp `started_at`.
 *
 * Guarded on `queued` in the `WHERE`, the transition idiom the import
 * repository uses: a run somebody else already started does not match, and the
 * caller is told `false` rather than overwriting a state machine another worker
 * advanced. A resumed job finds the run already `running` and continues — which
 * is why the executor treats `false` as "check the state" rather than as a
 * failure.
 */
export async function startExportRun(
  db: Executor,
  input: { exportRunId: string; now?: Date },
): Promise<boolean> {
  const rows = await db
    .update(exportRuns)
    .set({ state: 'running', startedAt: input.now ?? new Date() })
    .where(and(eq(exportRuns.id, input.exportRunId), eq(exportRuns.state, 'queued')))
    .returning({ id: exportRuns.id })
  return rows.length > 0
}

/**
 * Record one uploaded object.
 *
 * Called **after** the upload returns, never before, for the reason
 * `recordStagingProgress` gives on the import side: recorded first, a crash in
 * between would claim an object that is not there and a resume would skip it
 * forever. Recorded after, the worst case is an object in the bucket that no row
 * names — which is why the executor verifies presence with `head()` on resume
 * and re-uploads what it cannot find.
 *
 * Appended in SQL (`||` over the existing array) rather than read-modify-write:
 * one statement per chunk, and nothing to lose if two writers somehow overlapped
 * (they cannot — the job lease is the serializer). `jsonb_set` on the `chunks`
 * path leaves `orphaned_keys` alone, which is what keeps a retraction's
 * tombstones from being erased by the next chunk.
 *
 * **Cost note.** Postgres rewrites the whole `progress` value on every append,
 * so recording N chunks is O(N²) bytes over the run. At the shipped
 * `EXPORT_MAX_CHUNK_BYTES` a chunk is 64 MiB of source data and a record is
 * ~200 bytes, so a thousand-chunk export — 64 GiB of NDJSON — rewrites about
 * 100 MB in total across its lifetime, which is noise beside the bytes it is
 * uploading. It is left as one jsonb column deliberately: the whole value is
 * read and written by one writer holding the job lease, and a row-per-chunk
 * table would be a join and a cascading delete for data with no independent
 * lifetime. The escape hatch, should part counts ever grow past that — a much
 * smaller cap, or event-level exports — is an `export_run_chunks` table keyed
 * `(export_run_id, key)`; nothing outside this file and `exportObjectKeysOf`
 * reads the shape, so the change is local.
 */
export async function recordExportChunk(
  db: Executor,
  input: { exportRunId: string; chunk: ExportChunkRecord },
): Promise<void> {
  await db.execute(sql`
    UPDATE ${exportRuns}
       SET progress = jsonb_set(
             COALESCE(progress, '{}'::jsonb),
             ARRAY['chunks'],
             COALESCE(progress -> 'chunks', '[]'::jsonb) || ${JSON.stringify([input.chunk])}::jsonb,
             true
           )
     WHERE id = ${input.exportRunId}::uuid
  `)
}

/**
 * Retract chunk records a regeneration made stale, keeping their keys reachable.
 *
 * The case: a first attempt split a month into four parts; a retry — different
 * row count, a retuned cap, a provider that answered slightly differently —
 * splits it into three. Parts one to three are overwritten by key, and `p4` is
 * left in the bucket with a record still pointing at it. Nothing yet is wrong.
 * The *next* resume is what breaks: it walks `p1, p2, p3, p4`, finds a record
 * for each, `head()`s all four successfully (the stale one really is there) and
 * adopts a four-part generation whose last part came from a different stream —
 * a manifest that names a chunk no attempt of this export ever produced together
 * with the ones beside it.
 *
 * So the record has to go. But deleting it alone would be a worse bug than the
 * one it fixes: the storage port has no `list`, so the object would become
 * unaddressable and survive a customer's deletion until the bucket lifecycle
 * rule happened to reap it. The key therefore **moves** — out of `chunks`, which
 * the resume path reads, into `orphaned_keys`, which only `exportObjectKeysOf`
 * reads. The bytes stay reachable for the purge and invisible to the resume,
 * which is exactly the split the problem needs.
 *
 * One statement, rebuilding both arrays, so a crash cannot leave a key in
 * neither.
 */
export async function retractExportChunks(
  db: Executor,
  input: { exportRunId: string; keys: readonly string[] },
): Promise<void> {
  if (input.keys.length === 0) return
  const keysJson = JSON.stringify(input.keys)
  await db.execute(sql`
    UPDATE ${exportRuns}
       SET progress = jsonb_build_object(
             'chunks',
             COALESCE(
               (
                 SELECT jsonb_agg(chunk)
                   FROM jsonb_array_elements(COALESCE(progress -> 'chunks', '[]'::jsonb)) AS chunk
                  WHERE chunk ->> 'key' NOT IN (
                    SELECT jsonb_array_elements_text(${keysJson}::jsonb)
                  )
               ),
               '[]'::jsonb
             ),
             'orphaned_keys',
             COALESCE(progress -> 'orphaned_keys', '[]'::jsonb) || ${keysJson}::jsonb
           )
     WHERE id = ${input.exportRunId}::uuid
  `)
}

/**
 * Finish the export: the manifest lands on the row and the state becomes
 * `succeeded`.
 *
 * Guarded on `running`, and the manifest is written in the same statement as the
 * state for the reason the import transitions give: a manifest attached to a run
 * that then failed to leave `running` would describe an export the state machine
 * says did not finish.
 */
export async function completeExportRun(
  db: Executor,
  input: { exportRunId: string; manifest: ExportManifest; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date()
  const rows = await db
    .update(exportRuns)
    .set({ state: 'succeeded', manifest: input.manifest, finishedAt: now, errorCode: null })
    .where(and(eq(exportRuns.id, input.exportRunId), eq(exportRuns.state, 'running')))
    .returning({ id: exportRuns.id })
  return rows.length > 0
}

/**
 * Fail the export with a safe category.
 *
 * The already-uploaded objects are deliberately **not** deleted here. They are
 * recorded in `progress`, so a site deletion still enumerates them, and the
 * bucket's `exports/` lifecycle rule reaps them within seven days either way.
 * Issuing deletes from the failure path would add a second thing that can fail
 * while recording the customer-visible answer, in exchange for a week of storage.
 */
export async function failExportRun(
  db: Executor,
  input: { exportRunId: string; errorCode: string; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date()
  const rows = await db
    .update(exportRuns)
    .set({ state: 'failed', errorCode: input.errorCode, finishedAt: now })
    .where(
      and(eq(exportRuns.id, input.exportRunId), inArray(exportRuns.state, ['queued', 'running'])),
    )
    .returning({ id: exportRuns.id })
  return rows.length > 0
}

export type ExportDownloadResult =
  | {
      readonly ok: true
      readonly manifest: ExportManifest
      readonly objectPrefix: string
    }
  /** The objects are past `EXPORT_OBJECT_TTL_DAYS`; the row has just been
   * flipped to `expired` and the answer is `410`. */
  | { readonly ok: false; readonly reason: 'expired' }
  /** Anything else: still running, failed, already expired, or no manifest.
   * `state` is what the route reports back so the client can see why. */
  | { readonly ok: false; readonly reason: 'not_downloadable'; readonly state: ExportRunState }
  | { readonly ok: false; readonly reason: 'not_found' }

export interface ClaimExportDownloadInput {
  readonly siteId: string
  readonly exportRunId: string
  /** `EXPORT_OBJECT_TTL_DAYS`. The deadline is applied in SQL against the
   * database-stamped `finished_at`. */
  readonly ttlDays: number
  readonly actorUserId?: string | null
  readonly requestId?: string | null
}

/**
 * Decide whether an export may still be downloaded, expire it if not, and audit
 * the download — in one transaction (ADR-0032, D8).
 *
 * Everything about this is one transaction on purpose:
 *
 * - **the expiry is lazy and its deadline is SQL.** Nothing sweeps `succeeded`
 *   exports; the bucket's lifecycle rule deletes the bytes and this is what
 *   makes the row agree with the bucket, at the only moment the difference
 *   matters. The comparison is `finished_at < now() - make_interval(…)` so an
 *   api clock running fast cannot retire a download that is still live.
 * - **exactly one audit row per download request** (D8), which is the property
 *   that keeps a polling frontend from generating audit noise: the status read
 *   is a different endpoint and writes nothing, and this row is written under
 *   the same row lock that decided the export was downloadable, so two
 *   concurrent `POST`s produce two audited downloads and never one audited and
 *   one silent.
 *
 * The signed URLs themselves are minted by the caller, outside this
 * transaction — the port is not a database and has no business inside one.
 */
export async function claimExportDownload(
  db: Database,
  input: ClaimExportDownloadInput,
): Promise<ExportDownloadResult> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        state: exportRuns.state,
        manifest: exportRuns.manifest,
        objectPrefix: exportRuns.objectPrefix,
      })
      .from(exportRuns)
      .where(and(eq(exportRuns.id, input.exportRunId), eq(exportRuns.siteId, input.siteId)))
      .for('update')
    if (!row) return { ok: false, reason: 'not_found' } as const

    if (row.state === 'expired') return { ok: false, reason: 'expired' } as const
    if (row.state !== 'succeeded' || row.manifest === null) {
      return { ok: false, reason: 'not_downloadable', state: row.state } as const
    }

    const expired = await tx.execute(sql`
      UPDATE ${exportRuns}
         SET state = 'expired'
       WHERE id = ${input.exportRunId}::uuid
         AND state = 'succeeded'
         AND finished_at < now() - make_interval(days => ${input.ttlDays})
       RETURNING id
    `)
    if ((expired as unknown as { rows: unknown[] }).rows.length > 0) {
      return { ok: false, reason: 'expired' } as const
    }

    await writeAudit(tx, {
      action: 'site.export.downloaded',
      actorUserId: input.actorUserId ?? null,
      actorType: input.actorUserId ? 'user' : 'system',
      siteId: input.siteId,
      targetType: 'export_run',
      targetId: input.exportRunId,
      // What was handed out, never a URL: a signed URL is a bearer credential
      // and the audit trail is read by more people than the download was.
      metadata: {
        chunks: row.manifest.chunks.length,
        rows: row.manifest.totals.rows,
        bytes: row.manifest.totals.bytes,
      },
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    })

    // `finished_at` is deliberately not returned: the download response's own
    // `expires_at` is the *URL's* fifteen minutes, and the object's seven-day
    // life is answered by `GET …/exports/{id}` (`expires_at` on the run). One
    // field named `expires_at` meaning two different deadlines in two responses
    // would be read wrong by somebody eventually.
    return { ok: true, manifest: row.manifest, objectPrefix: row.objectPrefix } as const
  })
}

/**
 * The object keys a site's exports have written — what the deletion snapshot
 * records before `postgres_purge` deletes the rows that carry them (D9).
 *
 * The enumeration itself is the pure `exportObjectKeysOf`, shared with the
 * tests, because a key this misses is a key the port can never address again.
 * The read is deliberately over *every* export of the site rather than only the
 * unexpired ones: an `expired` row's bytes are usually gone, but "usually" is
 * not a deletion guarantee, and deleting an absent key is a no-op the phase's
 * `head() === null` verification passes trivially.
 */
export async function listSiteExportObjectKeys(db: Executor, siteId: string): Promise<string[]> {
  const rows = await db
    .select({
      objectPrefix: exportRuns.objectPrefix,
      progress: exportRuns.progress,
      manifest: exportRuns.manifest,
    })
    .from(exportRuns)
    .where(eq(exportRuns.siteId, siteId))
  return rows.flatMap((row) => exportObjectKeysOf(row))
}
