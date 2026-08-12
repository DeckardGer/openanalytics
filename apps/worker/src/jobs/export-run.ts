import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import { ExportReadError, type ExportReader, type ExportRow } from '@openanalytics/clickhouse'
import {
  EXPORT_MANIFEST_NOTES,
  EXPORT_NUMBER_ENCODING,
  EXPORT_SCHEMA_VERSION,
  IMPORTED_REPORTS,
  exportEventsChunkKey,
  exportFunnelsChunkKey,
  exportImportedChunkKey,
  exportManifestKey,
  type ExportChunkRecord,
  type ExportManifest,
  type ImportedReport,
} from '@openanalytics/domain'
import { ObjectStorageError, type ObjectStorage } from '@openanalytics/integrations'
import {
  EXPORT_RUN_JOB_TYPE,
  completeExportRun,
  failExportRun,
  listFunnels,
  readExportRun,
  recordExportChunk,
  retractExportChunks,
  startExportRun,
  type Database,
  type ExportRunRow,
} from '@openanalytics/postgres'
import type { ExportPolicy } from './resources.ts'
import type { JobExecutor, JobExecutorContext, JobOutcome, JobRegistration } from './runner.ts'

/**
 * The `export_run` executor (ADR-0032, D8).
 *
 * Read the site's history at a pinned instant, write it to object storage as
 * gzipped NDJSON, and finish with a manifest whose *presence* is what says the
 * export is complete.
 *
 * ## The two pins, and why nothing here re-reads them
 *
 * `cutoff` and `pinned_import_run_id` were taken by the api in one snapshot
 * under the site row's lock, and this job reads them off the run row and binds
 * them into every query. It never asks the site what its pointer is now: a
 * publish or a rollback landing in the middle of a ten-minute export would
 * otherwise make the imported chunks disagree with each other, and an event
 * accepted while the export ran would appear in a late month's file and not in
 * an early one's re-generation.
 *
 * A pinned run that gets *cleaned up* mid-export is handled by doing nothing
 * special: cleanup deletes rows by run id, and every imported query binds that
 * same run id, so the chunks already written stay internally consistent and a
 * later one simply reads empty. An empty chunk is still written — see
 * `writeUnit`.
 *
 * ## Failure, retry and resume
 *
 * The same split the import executor draws, for the same reason:
 *
 * - **infrastructure** — storage unavailable, ClickHouse unreachable, a resource
 *   this deployment does not have — returns a **counting** retry. Counting,
 *   because none of those resolve on their own, and an immortal export job holds
 *   the site's only export slot (the runner's `(type, subject_id)` liveness
 *   index) so no later export could ever start;
 * - **anything else** throws and reaches the runner's attempt guard, which
 *   settles the job `failed_terminal` and runs `onTerminal` — the hook that
 *   fails the *run* and releases the slot.
 *
 * Resume works at **unit** granularity — a month of events, a report, the
 * funnels file — rather than per object, and that is what makes it correct
 * without needing a total order on every table read. A unit whose recorded parts
 * are all still in the bucket (`head()`) is skipped and its records are reused;
 * a unit with any part missing is regenerated whole, overwriting its parts by
 * key. A regeneration that produces *fewer* parts than the last attempt retracts
 * the surplus records (`retractStaleParts`) so a later resume cannot adopt a
 * longer stale generation, and the orphaned objects are not a leak: their keys
 * move to `progress.orphaned_keys`, which the deletion enumeration still unions,
 * and the bucket's `exports/` rule reaps them within seven days.
 *
 * The lease is renewed on **elapsed time** rather than at chunk boundaries — see
 * `writeUnit` — because a single month can stream for longer than the TTL while
 * touching nothing that would otherwise renew.
 */

/**
 * Compression on the libuv threadpool, never `gzipSync`.
 *
 * A chunk is up to `EXPORT_MAX_CHUNK_BYTES` (64 MiB) of NDJSON, and gzipping
 * that synchronously blocks the event loop for a noticeable fraction of a
 * second — inside the *same process* that runs batch ingest, the outbox
 * dispatcher, the session finalizer and this worker's own health endpoint. One
 * customer's export would show up as latency on everybody's ingest. The async
 * form hands the work to the threadpool and yields, which costs nothing here
 * because the caller has to await the upload straight afterwards anyway.
 */
const gzipAsync = promisify(gzip)

/** Long, because the resource being waited on is a redeploy or an outage. */
const RESOURCE_RETRY_MS = 30_000
/** Short: a stolen lease means another worker is already doing this. */
const LEASE_LOST_RETRY_MS = 5_000

/**
 * **Every retry this executor returns counts against `JOB_MAX_ATTEMPTS`.**
 *
 * The import executor's argument applies unchanged: nothing this job waits on
 * ends by itself, and a non-counting retry over a missing credential is an
 * immortal job. Here the pinned subject is the site's export slot rather than
 * its import slot, and the consequence is the same — a customer who can never
 * export again, with no error ever reported.
 */
const COUNTING_RETRY = true

/** The two states this job may work from. Anything else is settled and is not
 * this job's to change. */
const WORKABLE_STATES = ['queued', 'running'] as const

/**
 * The safe error categories an export may end with. Rendered to the customer,
 * so never a raw message and never a provider string.
 *
 * One entry, and the type exists anyway: it is what makes the `onTerminal` hook
 * below a member of a declared vocabulary rather than a literal, so a second
 * failure path added later has to name itself here — where the "is this safe to
 * show a customer?" question is asked — instead of inventing a category at its
 * call site.
 */
type ExportFailureCode = 'export_abandoned'

interface ExportContext {
  readonly job: JobExecutorContext
  readonly db: Database
  readonly siteId: string
  readonly exportRunId: string
  readonly run: ExportRunRow
  readonly storage: ObjectStorage
  readonly reader: ExportReader
  readonly policy: ExportPolicy
  /** Chunk records from previous attempts, keyed by object key. */
  readonly recorded: Map<string, ExportChunkRecord>
  /** What this attempt will put in the manifest, in written order. */
  readonly written: ExportChunkRecord[]
}

/** Signals a stolen lease from inside a unit writer. Thrown rather than
 * returned because the write loops are generators-in-the-middle and a boolean
 * would have to be threaded through every one of them. */
class LeaseLost extends Error {
  constructor() {
    super('export lease lost')
    this.name = 'LeaseLost'
  }
}

const executeExportRun: JobExecutor = async (context) => {
  const exportRunId = context.job.payload['export_run_id']
  if (typeof exportRunId !== 'string' || exportRunId.length === 0) {
    // Nothing will ever add the field, so waiting cannot help. Loud, because it
    // means a producer wrote a bad row.
    return { terminal: { reason: 'export_run payload has no export_run_id' } }
  }
  const siteId = context.job.subjectId
  if (siteId === null) {
    return { terminal: { reason: 'export_run job has no subject site' } }
  }

  const run = await readExportRun(context.db, { siteId, exportRunId })
  if (!run) {
    // Purged with the site, or deleted under the job. There is no work and no
    // state to record having done none.
    context.logger.info('export_run_absent', { site_id: siteId, export_run_id: exportRunId })
    return 'succeeded'
  }
  if (!(WORKABLE_STATES as readonly string[]).includes(run.state)) {
    context.logger.info('export_run_noop', {
      site_id: siteId,
      export_run_id: exportRunId,
      phase: run.state,
    })
    return 'succeeded'
  }

  const storage = context.resources?.objectStorage
  const reader = context.resources?.exportReader
  const policy = context.resources?.exportPolicy
  if (!storage || !reader || !policy) {
    context.logger.error('export_run_resources_missing', {
      site_id: siteId,
      export_run_id: exportRunId,
      storage_configured: storage !== undefined,
      clickhouse_configured: reader !== undefined,
      policy_configured: policy !== undefined,
      retryable: true,
    })
    return { retry: { delayMs: RESOURCE_RETRY_MS, counts: COUNTING_RETRY } }
  }

  // Guarded on `queued`; a resumed run is already `running` and does not match,
  // which is not a failure — it is the resume path.
  if (run.state === 'queued') await startExportRun(context.db, { exportRunId })
  if (!(await context.updatePhase('running'))) return leaseLost(context, siteId, exportRunId)

  const exportContext: ExportContext = {
    job: context,
    db: context.db,
    siteId,
    exportRunId,
    run,
    storage,
    reader,
    policy,
    recorded: new Map((run.progress?.chunks ?? []).map((chunk) => [chunk.key, chunk])),
    written: [],
  }

  try {
    return await writeExport(exportContext)
  } catch (error) {
    return await classifyFailure(exportContext, error)
  }
}

async function writeExport(context: ExportContext): Promise<JobOutcome> {
  const { job, run } = context

  // The plan, taken once. `eventMonths` is stable across attempts because the
  // cutoff is: an event accepted since the export started is outside every
  // query this job issues.
  const months = await context.reader.eventMonths({
    siteId: context.siteId,
    cutoff: run.cutoff,
  })
  // **Renew immediately.** This is a `SELECT DISTINCT` over every part of a
  // site's whole `events_raw` history and it is the first thing the job does —
  // on a large site it can take a meaningful share of `WORKER_LEASE_TTL_MS` all
  // by itself, and the lease this job started with was already stamped at claim
  // time and then spent on the page's earlier jobs. Without this the first chunk
  // can begin on an expired lease, which means another worker has legitimately
  // stolen the export and two of them are writing its objects.
  if (!(await job.extendLease())) throw new LeaseLost()

  for (const month of months) {
    await writeUnit(context, {
      unit: `events:${month}`,
      keyFor: (part) => exportEventsChunkKey(run.objectPrefix, month, part),
      recordFor: (key, part, rows, bytes, sha256) => ({
        key,
        kind: 'events',
        month,
        part,
        rows,
        bytes,
        sha256,
      }),
      rows: () =>
        context.reader.streamEvents({ siteId: context.siteId, cutoff: run.cutoff, month }),
    })
  }

  for (const report of IMPORTED_REPORTS) {
    await writeUnit(context, {
      unit: `imported:${report}`,
      keyFor: (part) => exportImportedChunkKey(run.objectPrefix, report, part),
      recordFor: (key, part, rows, bytes, sha256) => ({
        key,
        kind: 'imported',
        report,
        part,
        rows,
        bytes,
        sha256,
      }),
      rows: () => importedRows(context, report),
    })
  }

  await writeUnit(context, {
    unit: 'funnels',
    keyFor: (part) => exportFunnelsChunkKey(run.objectPrefix, part),
    recordFor: (key, part, rows, bytes, sha256) => ({
      key,
      kind: 'funnels',
      part,
      rows,
      bytes,
      sha256,
    }),
    rows: () => funnelRows(context),
  })

  // **The manifest is last**, and that ordering is the completeness signal (D8):
  // an export whose manifest is in the bucket has every chunk the manifest
  // names, because each of them was uploaded before it. Written to storage
  // first and to the row second, so a crash between the two leaves a complete
  // artefact and a run that is retried — which re-verifies the chunks, rewrites
  // the same manifest and finishes. The reverse would leave a run claiming
  // success over a bucket with no manifest in it.
  const manifest = buildManifest(context)
  const body = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  // Deliberately **not** recorded in `progress`: its key is derived from the
  // prefix by `exportObjectKeysOf`, so a deletion finds it whether or not it was
  // ever written, and a progress record whose `kind` had to be invented would be
  // a lie in the one structure a purge reads.
  await context.storage.put({
    key: exportManifestKey(run.objectPrefix),
    body,
    contentType: 'application/json',
  })

  const completed = await completeExportRun(context.db, {
    exportRunId: context.exportRunId,
    manifest,
  })
  if (!completed) {
    // Somebody else moved the run — a sweep, an operator, another worker that
    // stole the lease and got further. It has an owner and it is not this call.
    job.logger.info('export_run_lost_transition', {
      site_id: context.siteId,
      export_run_id: context.exportRunId,
    })
    return 'succeeded'
  }

  job.logger.info('export_run_completed', {
    site_id: context.siteId,
    export_run_id: context.exportRunId,
    chunks: manifest.totals.chunks,
    rows: manifest.totals.rows,
    bytes: manifest.totals.bytes,
  })
  return 'succeeded'
}

interface UnitPlan {
  /** For logs only. */
  readonly unit: string
  readonly keyFor: (part: number) => string
  readonly recordFor: (
    key: string,
    part: number,
    rows: number,
    bytes: number,
    sha256: string,
  ) => ExportChunkRecord
  readonly rows: () => AsyncIterable<unknown>
}

/**
 * Write one unit — a month of events, one imported report, the funnels — as one
 * or more gzipped NDJSON objects.
 *
 * **A unit with no rows still produces an object**, containing zero lines. "This
 * report was empty" and "this report was not exported" are different statements,
 * and only the first is true for a site that imported nothing: the manifest
 * would otherwise be indistinguishable from one written by a build that had
 * forgotten a report. It is also what makes a pinned run cleaned up mid-export
 * degrade honestly rather than silently.
 *
 * Splitting is by **uncompressed** bytes against `EXPORT_MAX_CHUNK_BYTES`,
 * measured in real UTF-8 bytes as the NDJSON is built — `String.length` counts
 * UTF-16 code units and would undercount a Cyrillic or CJK page title by up to
 * three times, which is the difference between a 64 MiB cap and a 190 MiB one on
 * exactly the sites least able to afford it. Compressed size is unpredictable
 * and is not what bounds the worker's heap; this buffer is.
 *
 * The lines are kept as `Buffer[]` and joined with `Buffer.concat` at flush
 * rather than as strings joined with `''`: the string form would build one
 * enormous intermediate string and then re-encode it, doubling the peak for no
 * benefit when the destination is bytes either way.
 */
async function writeUnit(context: ExportContext, plan: UnitPlan): Promise<void> {
  const reused = await reuseUnit(context, plan)
  if (reused) return

  let part = 1
  let lines: Buffer[] = []
  let rows = 0
  let pendingBytes = 0

  /**
   * The wall-clock heartbeat.
   *
   * A chunk boundary is not a schedule: a single month of a quiet site is one
   * chunk, and streaming it can take longer than `WORKER_LEASE_TTL_MS` while
   * touching nothing that renews. The job would then be stolen mid-stream and
   * the next worker would do exactly the same thing — a unit that can never
   * finish, forever. Renewing on elapsed time instead makes the guarantee
   * independent of how the data happens to be shaped.
   *
   * A third of the TTL is the usual belt: two renewals may be missed (a slow
   * database, a paused event loop) before the lease is actually at risk.
   */
  const renewEveryMs = Math.max(1, Math.floor(context.policy.leaseTtlMs / 3))
  let renewedAt = Date.now()
  const renew = async (): Promise<void> => {
    if (!(await context.job.extendLease())) throw new LeaseLost()
    renewedAt = Date.now()
  }

  const flush = async (): Promise<void> => {
    const key = plan.keyFor(part)
    const body = await gzipAsync(Buffer.concat(lines))
    await context.storage.put({ key, body, contentType: 'application/gzip' })
    const record = plan.recordFor(key, part, rows, body.byteLength, sha256Of(body))
    // After the upload returned, never before: a record for an object that is
    // not there would make a resume skip a chunk that does not exist.
    await recordExportChunk(context.db, { exportRunId: context.exportRunId, chunk: record })
    context.recorded.set(key, record)
    context.written.push(record)
    part += 1
    lines = []
    rows = 0
    pendingBytes = 0
    // Between chunks, not inside one: an upload that outran the lease is already
    // durable, and what must not happen is the *next* one running for a job
    // somebody else now owns.
    await renew()
  }

  for await (const row of plan.rows()) {
    const line = Buffer.from(`${JSON.stringify(row)}\n`, 'utf8')
    // The split is checked *before* appending, so a chunk never exceeds the cap
    // by a whole row — and a single row larger than the cap still gets its own
    // chunk rather than being dropped.
    if (pendingBytes > 0 && pendingBytes + line.byteLength > context.policy.maxChunkBytes) {
      await flush()
    }
    lines.push(line)
    pendingBytes += line.byteLength
    rows += 1
    if (Date.now() - renewedAt > renewEveryMs) await renew()
  }

  // Unconditional: the empty unit is the case this line exists for.
  await flush()
  await retractStaleParts(context, plan, part)
}

/**
 * Drop the records of parts a previous, longer split left behind.
 *
 * The failure this prevents is subtle and would produce a *corrupt manifest*
 * rather than an error. Attempt one splits a month into four parts; attempt two
 * — a retuned cap, a slightly different row set — splits it into three, and
 * overwrites `p1`–`p3` by key. `p4` is still in the bucket with a record still
 * pointing at it. The next resume walks `p1, p2, p3, p4`, finds a record for
 * each, `head()`s all four successfully, and adopts a four-part generation whose
 * final chunk came from a different stream than the three before it.
 *
 * So the walk starts at the part *after* the last one written and continues
 * until the first gap, and every record it finds is retracted. The objects are
 * deliberately **not** deleted: their keys move into `progress.orphaned_keys`,
 * which `exportObjectKeysOf` still unions, so a site deletion reaches them and
 * the bucket's `exports/` rule reaps them meanwhile. Deleting here would add a
 * storage call that can fail on a path whose whole job is bookkeeping.
 *
 * **The residual window, stated rather than hidden:** a crash between the unit's
 * last flush and this retraction leaves the stale record in place for one more
 * attempt, which would then adopt it. It is one statement wide, it needs the
 * shorter regeneration to have happened in the first place, and the recovery is
 * the same one the whole resume path has — the next regeneration retracts it.
 * Closing it entirely would mean writing the last chunk's record and the
 * retraction in one transaction, which `flush` cannot do without knowing it is
 * the last, and that is a restructure this checkpoint does not need.
 */
async function retractStaleParts(
  context: ExportContext,
  plan: UnitPlan,
  nextPart: number,
): Promise<void> {
  const stale: string[] = []
  for (let part = nextPart; ; part += 1) {
    const key = plan.keyFor(part)
    if (!context.recorded.has(key)) break
    stale.push(key)
  }
  if (stale.length === 0) return

  await retractExportChunks(context.db, { exportRunId: context.exportRunId, keys: stale })
  for (const key of stale) context.recorded.delete(key)

  context.job.logger.info('export_run_chunk_retracted', {
    site_id: context.siteId,
    export_run_id: context.exportRunId,
    unit: plan.unit,
    keys: stale.length,
  })
}

/**
 * Skip a unit whose objects are all still in the bucket.
 *
 * The verification is `head()` rather than trust in the recorded row, because
 * the two can legitimately disagree: the bucket's seven-day `exports/` rule
 * expires objects, and a run reclaimed after a long outage could find its
 * earliest chunks already reaped. Trusting the record there would produce a
 * manifest naming objects that do not exist — the one failure mode a manifest
 * exists to prevent.
 *
 * All-or-nothing per unit: one missing part regenerates the whole unit, because
 * the parts of a unit are a *split of one stream* and re-deriving only the tail
 * would need the stream to be re-splittable at exactly the same boundary.
 */
async function reuseUnit(context: ExportContext, plan: UnitPlan): Promise<boolean> {
  const candidates: ExportChunkRecord[] = []
  for (let part = 1; ; part += 1) {
    const record = context.recorded.get(plan.keyFor(part))
    if (!record) break
    candidates.push(record)
  }
  if (candidates.length === 0) return false

  for (const record of candidates) {
    const head = await context.storage.head({ key: record.key })
    if (head === null || head.size !== record.bytes) {
      context.job.logger.info('export_run_chunk_regenerating', {
        site_id: context.siteId,
        export_run_id: context.exportRunId,
        unit: plan.unit,
        key: record.key,
        reason: head === null ? 'absent' : 'size_mismatch',
      })
      return false
    }
  }

  context.written.push(...candidates)
  context.job.logger.info('export_run_chunk_reused', {
    site_id: context.siteId,
    export_run_id: context.exportRunId,
    unit: plan.unit,
    parts: candidates.length,
  })
  if (!(await context.job.extendLease())) throw new LeaseLost()
  return true
}

/** The pinned run's rows, or nothing at all when the site has published no
 * import. Not an error: a site with no imported history exports zero imported
 * rows, and the chunk written for it says exactly that. */
async function* importedRows(
  context: ExportContext,
  report: ImportedReport,
): AsyncIterable<ExportRow> {
  const importRunId = context.run.pinnedImportRunId
  if (importRunId === null) return
  yield* context.reader.streamImported({ siteId: context.siteId, importRunId, report })
}

/**
 * The site's funnel definitions, from Postgres (D8's third content item).
 *
 * Archived ones included: an export is the customer's history, and a funnel they
 * retired last year is part of it. `archived_at` is on the row, so nothing is
 * ambiguous.
 */
async function* funnelRows(context: ExportContext): AsyncIterable<ExportRow> {
  const definitions = await listFunnels(context.db, context.siteId, { includeArchived: true })
  for (const definition of definitions) {
    yield {
      id: definition.id,
      site_id: definition.siteId,
      name: definition.name,
      steps: definition.steps,
      scope: definition.scope,
      window_ms: definition.windowMs,
      created_at: definition.createdAt.toISOString(),
      updated_at: definition.updatedAt.toISOString(),
      archived_at: definition.archivedAt?.toISOString() ?? null,
    }
  }
}

function buildManifest(context: ExportContext): ExportManifest {
  const chunks = context.written
  return {
    schema_version: EXPORT_SCHEMA_VERSION,
    export_id: context.exportRunId,
    site_id: context.siteId,
    cutoff: context.run.cutoff.toISOString(),
    pinned_import_run_id: context.run.pinnedImportRunId,
    // The only field of the manifest that is not stable across attempts: a
    // resume that reuses every chunk still stamps a new instant here. It is
    // provenance ("when were these bytes assembled"), not part of the content
    // hash of anything, and nothing compares two manifests for equality.
    generated_at: new Date().toISOString(),
    number_encoding: EXPORT_NUMBER_ENCODING,
    notes: EXPORT_MANIFEST_NOTES,
    chunks,
    totals: {
      chunks: chunks.length,
      rows: chunks.reduce((total, chunk) => total + chunk.rows, 0),
      bytes: chunks.reduce((total, chunk) => total + chunk.bytes, 0),
    },
  }
}

/** Over the **stored** bytes, so a downloader can verify what it received
 * without inflating it, and so a resume compares the same thing. */
function sha256Of(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex')
}

/**
 * Turn a thrown error into the right kind of ending.
 *
 * Anything unrecognised is re-thrown, which the runner counts as a failed
 * attempt. That is the correct default for a bug: it retries a handful of times,
 * is logged at WARN each time, and eventually reaches `failed_terminal` where
 * `onTerminal` fails the run so the site's export slot is released.
 */
async function classifyFailure(context: ExportContext, error: unknown): Promise<JobOutcome> {
  if (error instanceof LeaseLost) {
    return leaseLost(context.job, context.siteId, context.exportRunId)
  }
  if (error instanceof ObjectStorageError) {
    // Every reason, including `not_found`: unlike the import path there is no
    // customer-supplied object whose absence means "the upload expired". A
    // storage failure here is ours, and the export waits for it rather than
    // telling the customer their data could not be exported.
    context.job.logger.error('export_run_storage_unavailable', {
      site_id: context.siteId,
      export_run_id: context.exportRunId,
      reason: error.reason,
      retryable: true,
    })
    return { retry: { delayMs: RESOURCE_RETRY_MS, counts: COUNTING_RETRY } }
  }
  if (error instanceof ExportReadError) {
    context.job.logger.error('export_run_clickhouse_failed', {
      site_id: context.siteId,
      export_run_id: context.exportRunId,
      retryable: true,
    })
    return { retry: { delayMs: RESOURCE_RETRY_MS, counts: COUNTING_RETRY } }
  }
  throw error
}

function leaseLost(
  job: Pick<JobExecutorContext, 'logger'>,
  siteId: string,
  exportRunId: string,
): JobOutcome {
  job.logger.warn('export_run_lease_lost', {
    site_id: siteId,
    export_run_id: exportRunId,
    retryable: true,
  })
  return { retry: { delayMs: LEASE_LOST_RETRY_MS, counts: COUNTING_RETRY } }
}

export const EXPORT_RUN_REGISTRATION: JobRegistration = {
  type: EXPORT_RUN_JOB_TYPE,
  execute: executeExportRun,
  /**
   * A job that ran out of attempts must not leave the run mid-flight.
   *
   * `queued` and `running` are what the runner's `(type, subject_id)` liveness
   * index is derived from in practice — while a job of this type is live for the
   * site, no second export can be enqueued — so a dead job with a run stuck in
   * one of them is a customer who can never export again, with nothing even
   * polling it. This hook is what makes the *counting* infrastructure retry safe
   * above; without it, counting would only trade an immortal job for a permanent
   * lockout.
   *
   * The uploaded objects are deliberately left where they are: their keys are on
   * the run's `progress`, so a site deletion enumerates them, and the bucket's
   * `exports/` lifecycle rule reaps them within seven days. Issuing deletes from
   * a hook that runs after the settlement is durable would add a second thing
   * that can fail while recording the customer-visible answer.
   */
  onTerminal: async (job, reason, context) => {
    const exportRunId = job.payload['export_run_id']
    if (typeof exportRunId !== 'string' || exportRunId.length === 0) return

    const code: ExportFailureCode = 'export_abandoned'
    await failExportRun(context.db, { exportRunId, errorCode: code })

    context.logger.error('export_run_abandoned', {
      export_run_id: exportRunId,
      site_id: job.subjectId,
      error_code: code,
      reason,
      retryable: false,
    })
  },
  /** One at a time: an export holds a ClickHouse stream and a chunk buffer, and
   * claiming ten per tick would run ten of those in one process while the page
   * executes serially anyway. */
  limit: 1,
}

export { executeExportRun }
