import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ImportedInsertError,
  toStoredImportedRow,
  type ImportedAggregatesMaintenance,
  type ImportedAggregatesWriter,
  type StoredImportedRow,
} from '@openanalytics/clickhouse'
import {
  ImportRunFailure,
  defaultCutoverDate,
  importDateOf,
  type ImportAdapter,
  type ImportFailureCategory,
  type ImportReportSummary,
  type ImportRunSummary,
  type ImportSummaryWarning,
} from '@openanalytics/domain'
import { ObjectStorageError, type ObjectStorage } from '@openanalytics/integrations'
import {
  IMPORT_PREPARE_JOB_TYPE,
  clearStagingProgress,
  readImportRun,
  readImportUpload,
  readSiteImportContext,
  recordStagingChunkBytes,
  recordStagingProgress,
  transitionImportRun,
  type ImportRunRow,
} from '@openanalytics/postgres'
import { openZipArchive, writeStreamToFile, type ArchiveEntry } from '../imports/archive.ts'
import { cleanImportRun } from '../imports/cleanup.ts'
import type { ImportPolicy } from './resources.ts'
import type { JobExecutor, JobExecutorContext, JobOutcome, JobRegistration } from './runner.ts'

/**
 * The `import_prepare` executor (ADR-0032, D6/D7).
 *
 * Download, validate, stage — and then **terminate succeeded at
 * `ready_for_review`**. The human review that follows can take days, and a job
 * that held its lease across it would occupy the site's live-job slot and be
 * repeatedly stolen and re-run by lease expiry. The run is the state machine;
 * this job is one push along it.
 *
 * ## Which failures end the run and which end the attempt
 *
 * This is the distinction the whole executor is organised around, because
 * getting it backwards produces one of two bad outcomes: a customer told their
 * archive is broken because ClickHouse was down, or a job retrying a customer's
 * malformed CSV a hundred times.
 *
 * - **`ImportRunFailure`** — the archive, or the run, is not something this
 *   system will import. The *run* is failed with a safe category, its staged
 *   rows are best-effort deleted, and the **job returns `succeeded`**: it did
 *   its work and the answer was no. Retrying would ask the same question of the
 *   same bytes.
 * - **Infrastructure** — storage unavailable, ClickHouse unreachable or refusing
 *   the insert, a resource the worker was not configured with. The job returns
 *   `retry` and the run is left exactly where it is, so the import resumes when
 *   the outage ends and nothing customer-visible changes.
 *
 * ## Resume
 *
 * A reclaimed lease re-enters here and re-parses from the beginning of the
 * archive. That is deliberate, and it is what makes the chunk tokens correct:
 * parsing is deterministic and the chunk size is the one **recorded on the run**
 * (never the current policy default), so chunk N of report R contains the same
 * rows on every attempt. Chunks below the recorded progress are re-parsed and
 * *not* re-inserted; the summary is recomputed from the full parse, so a resumed
 * run and a first-pass run produce the same summary. Re-parsing costs CPU over a
 * local file and buys a resume path whose entire durable state is one integer
 * per report.
 */

/** Long, because the resource being waited on is a redeploy or an outage. */
const RESOURCE_RETRY_MS = 30_000
/** Short: a stolen lease means another worker is already doing this. */
const LEASE_LOST_RETRY_MS = 5_000

/**
 * **Every retry this executor returns counts against `JOB_MAX_ATTEMPTS`.**
 *
 * Unlike a deletion draining an ingest fence, nothing this job waits on ends by
 * itself: a missing ClickHouse grant, a bucket credential a deployment never
 * added, an endpoint that stays down. A non-counting retry over one of those is
 * an immortal job — and an immortal `import_prepare` is worse than a wasted
 * tick, because the run it is working stays in `validating`/`processing`, which
 * are inside the live-run unique's predicate (D3). The site can then start no
 * other import, ever, and no error is ever reported to the customer.
 *
 * Counting makes the guard fire, which settles the job `failed_terminal` and
 * runs `onTerminal` — the hook that fails the run and releases the slot.
 *
 * The lease-lost path is marked the same way and the marking is moot there: the
 * runner's write is guarded on `claimed_by`, so a worker whose lease was stolen
 * changes nothing at all. It is uniform on purpose, so that no later edit has to
 * re-derive which of these four returns was the safe one.
 */
const COUNTING_RETRY = true

/**
 * How many already-durable chunks a resume may re-parse between lease renewals.
 *
 * The bound that matters is *work per renewal*, not chunks: eight chunks is
 * eight times `staging_chunk_bytes` of CSV re-parsed and discarded — 64 MiB at
 * the shipped default — which is a second or two of CPU against a 60 s
 * `WORKER_LEASE_TTL_MS`. That leaves the renewal interval more than an order of
 * magnitude inside the TTL even on a loaded host, while costing one cheap
 * `UPDATE` per eight chunks rather than one per chunk.
 */
const SKIP_RENEW_EVERY = 8

/** The three states this job may work from. Anything else is somebody else's
 * business and is answered with a logged no-op. */
const WORKABLE_STATES = ['uploaded', 'validating', 'processing'] as const

/** What every path needs, including the ones that fail before an adapter or a
 * bucket has been resolved. */
interface RunContext {
  readonly job: JobExecutorContext
  readonly siteId: string
  readonly runId: string
  readonly maintenance: ImportedAggregatesMaintenance | undefined
  /** Optional here and required in `PrepareContext`: the failure path can be
   * reached before the bucket was resolved, and a cleanup that skips the object
   * is still a cleanup. */
  readonly storage: ObjectStorage | undefined
}

interface PrepareContext extends RunContext {
  readonly policy: ImportPolicy
  readonly adapter: ImportAdapter
  readonly storage: ObjectStorage
  readonly writer: ImportedAggregatesWriter
}

const executeImportPrepare: JobExecutor = async (context) => {
  const runId = context.job.payload['import_run_id']
  if (typeof runId !== 'string' || runId.length === 0) {
    // Nothing will ever add the field, so waiting cannot help. Loud, because it
    // means a producer wrote a bad row.
    return { terminal: { reason: 'import_prepare payload has no import_run_id' } }
  }
  const siteId = context.job.subjectId
  if (siteId === null) {
    return { terminal: { reason: 'import_prepare job has no subject site' } }
  }

  const run = await readImportRun(context.db, { siteId, importRunId: runId })
  if (!run) {
    // Discarded and purged, or the site was deleted under it. Succeeding is
    // correct: there is no work, and no state to record having done none.
    context.logger.info('import_prepare_run_absent', { site_id: siteId, import_run_id: runId })
    return 'succeeded'
  }
  if (!(WORKABLE_STATES as readonly string[]).includes(run.state)) {
    // Discarded while queued, already reviewed, already published, failed by the
    // sweeper. All settled answers, none of them this job's to change.
    context.logger.info('import_prepare_noop', {
      site_id: siteId,
      import_run_id: runId,
      phase: run.state,
    })
    return 'succeeded'
  }

  const base: RunContext = {
    job: context,
    siteId,
    runId,
    maintenance: context.resources?.importedAggregatesMaintenance,
    storage: context.resources?.objectStorage,
  }

  const policy = context.resources?.importPolicy
  const storage = context.resources?.objectStorage
  const writer = context.resources?.importedAggregatesWriter
  if (!policy || !storage || !writer) {
    context.logger.error('import_prepare_resources_missing', {
      site_id: siteId,
      import_run_id: runId,
      policy_configured: policy !== undefined,
      storage_configured: storage !== undefined,
      clickhouse_configured: writer !== undefined,
      retryable: true,
    })
    return { retry: { delayMs: RESOURCE_RETRY_MS, counts: COUNTING_RETRY } }
  }

  const adapter = context.resources?.importAdapters?.get(run.provider)
  if (!adapter) {
    // **Not a retry.** The provider is recorded on the run and this build has no
    // parser for it. A redeploy could add one, but the honest answer to the
    // customer now is that the import cannot proceed, and a job silently
    // retrying for days would leave the run's phase saying "validating" forever.
    return await failRun(base, 'adapter_unavailable', { provider: run.provider })
  }

  return await runPrepare({ ...base, policy, storage, writer, adapter }, run)
}

async function runPrepare(context: PrepareContext, run: ImportRunRow): Promise<JobOutcome> {
  const { job } = context

  const upload = await readImportUpload(job.db, context.runId)
  if (!upload) {
    return await failRun(context, 'upload_unverifiable', { reason: 'no upload row' })
  }
  if (upload.etag === null || upload.etag.length === 0) {
    // CP1 pins whatever `head()` reported, including an empty string, and leaves
    // the decision here — where the bytes are — rather than refusing at the api.
    // An archive whose fingerprint the provider never supplied cannot be shown
    // to be the archive that was checked, and importing it would make the pin
    // theatre.
    return await failRun(context, 'upload_unverifiable', { reason: 'no pinned etag' })
  }

  if (run.state === 'uploaded') {
    const moved = await transitionImportRun(job.db, {
      importRunId: context.runId,
      from: ['uploaded'],
      to: 'validating',
    })
    if (!moved) return lostRace(context)
  }
  if (!(await job.updatePhase('validating'))) return lost(context, 'validating')

  const directory = await mkdtemp(join(tmpdir(), 'oa-import-'))
  const archivePath = join(directory, 'archive.zip')

  try {
    // The download and the fingerprint check are one call, so there is no window
    // between "this is the object we checked" and "these are the bytes we read"
    // — which is precisely the window a client re-PUTting through a still-valid
    // signed URL would use.
    const stream = await context.storage.getStream({ key: upload.objectKey })
    if (!etagMatches(stream.etag, upload.etag)) {
      job.logger.warn('import_prepare_etag_mismatch', {
        site_id: context.siteId,
        import_run_id: context.runId,
        retryable: false,
      })
      return await failRun(context, 'upload_changed', {})
    }
    await writeStreamToFile(stream.body, archivePath, context.policy.maxArchiveBytes)

    const archive = await openZipArchive({
      path: archivePath,
      budgets: {
        maxEntries: context.policy.maxEntries,
        maxEntryBytes: context.policy.maxEntryBytes,
        maxTotalUncompressedBytes: context.policy.maxTotalUncompressedBytes,
        maxRowBytes: context.policy.maxRowBytes,
      },
    })

    // The download is the longest step before any chunk work, and on a slow
    // bucket a 256 MiB archive can eat most of `WORKER_LEASE_TTL_MS` on its own.
    // Renewing here means staging starts with a full TTL rather than whatever
    // the transfer left, which matters most on the resume path: that pass does a
    // lot of parsing before its first *new* insert renews anything.
    if (!(await job.extendLease())) return lost(context, 'processing')

    try {
      const plan = planEntries(context.adapter, archive.entries)

      if (run.state !== 'processing') {
        const moved = await transitionImportRun(job.db, {
          importRunId: context.runId,
          from: ['validating'],
          to: 'processing',
        })
        if (!moved) return lostRace(context)
      }
      if (!(await job.updatePhase('processing'))) return lost(context, 'processing')

      const chunkBytes = await recordStagingChunkBytes(job.db, {
        importRunId: context.runId,
        proposedBytes: context.policy.stagingChunkBytes,
      })
      if (chunkBytes === null) {
        // The row vanished between the read at the top and this write: a purge.
        job.logger.info('import_prepare_run_absent', {
          site_id: context.siteId,
          import_run_id: context.runId,
        })
        return 'succeeded'
      }

      const site = await readSiteImportContext(job.db, context.siteId)
      const firstEventAt = site?.firstEventAt ?? null

      const staged = await stageReports(context, {
        archive,
        plan,
        chunkBytes,
        progress: run.stagingProgress ?? {},
        firstLiveDay: firstEventAt === null ? null : importDateOf(firstEventAt),
      })
      if (staged.lost) return lost(context, 'processing')

      const summary = buildSummary(staged, firstEventAt)

      const moved = await transitionImportRun(job.db, {
        importRunId: context.runId,
        from: ['processing'],
        to: 'ready_for_review',
        summary: summary as unknown as Record<string, unknown>,
        errorCode: null,
      })
      if (!moved) return lostRace(context)

      job.logger.info('import_prepare_ready', {
        site_id: context.siteId,
        import_run_id: context.runId,
        rows: summary.total_rows,
        reports: Object.keys(summary.reports).length,
        warnings: summary.warnings.length,
      })
      return 'succeeded'
    } finally {
      await archive.close()
    }
  } catch (error) {
    return await classifyFailure(context, error)
  } finally {
    // The temp file is a copy of a customer's upload sitting on a shared host.
    // Removed on every path, including the ones that threw.
    await rm(directory, { recursive: true, force: true })
  }
}

/**
 * Turn a thrown error into the right kind of ending.
 *
 * Anything not recognised here is re-thrown, which the runner counts as a failed
 * attempt against `JOB_MAX_ATTEMPTS`. That is the correct default for a bug: it
 * retries a handful of times, is logged at WARN each time and eventually reaches
 * `failed_terminal`, where `onTerminal` fails the run so the site's import slot
 * is released.
 */
async function classifyFailure(context: PrepareContext, error: unknown): Promise<JobOutcome> {
  if (error instanceof ImportRunFailure) {
    return await failRun(context, error.category, { ...error.detail, message: error.message })
  }
  if (error instanceof ObjectStorageError) {
    if (error.reason === 'not_found') {
      // The archive is gone. The bucket's `imports/` lifecycle rule expires the
      // prefix on the same schedule the sweeper uses, so the overwhelmingly
      // likely cause is a run that sat unworked past its TTL — a failed run with
      // a category, not an outage to wait on.
      return await failRun(context, 'upload_expired', {})
    }
    context.job.logger.error('import_prepare_storage_unavailable', {
      site_id: context.siteId,
      import_run_id: context.runId,
      reason: error.reason,
      retryable: true,
    })
    return { retry: { delayMs: RESOURCE_RETRY_MS, counts: COUNTING_RETRY } }
  }
  if (error instanceof ImportedInsertError) {
    // Every insert failure is infrastructure, including `ACCESS_DENIED`: the
    // grant is ours to fix, and telling a customer their archive is broken
    // because `oa_ingest` cannot write `imported_pages_1d` would be a wrong
    // answer wearing a correct one's clothes. The run stays where it is and the
    // chunk is re-attempted under the same token.
    context.job.logger.error('import_prepare_clickhouse_failed', {
      site_id: context.siteId,
      import_run_id: context.runId,
      code: error.code,
      ambiguous: error.ambiguous,
      retryable: true,
    })
    return { retry: { delayMs: RESOURCE_RETRY_MS, counts: COUNTING_RETRY } }
  }
  throw error
}

/** Normalise an ETag before comparing. Providers quote it, some proxies do not,
 * and a comparison that failed on a pair of quotes would fail every import for a
 * reason no log line would explain. */
function etagMatches(observed: string, pinned: string): boolean {
  const strip = (value: string) => value.trim().replace(/^W\//, '').replace(/^"|"$/g, '')
  const left = strip(observed)
  return left.length > 0 && left === strip(pinned)
}

function lost(context: RunContext, phase: string): JobOutcome {
  context.job.logger.warn('import_prepare_lease_lost', {
    site_id: context.siteId,
    import_run_id: context.runId,
    phase,
    retryable: true,
  })
  return { retry: { delayMs: LEASE_LOST_RETRY_MS, counts: COUNTING_RETRY } }
}

/** A guarded transition that matched nothing: somebody else moved the run —
 * a discard, the sweeper, or another worker that stole the lease and got
 * further. Succeeding is right; the run has an owner and it is not this call. */
function lostRace(context: RunContext): JobOutcome {
  context.job.logger.info('import_prepare_lost_transition', {
    site_id: context.siteId,
    import_run_id: context.runId,
  })
  return 'succeeded'
}

/**
 * Fail the run, clean up after it, and report the *job* as done.
 *
 * State first, cleanup second, exactly as the abandoned-upload sweep orders its
 * two steps: the customer-visible answer is recorded whether or not ClickHouse
 * answers this second, and the sweeper's backstop catches a cleanup that did not
 * happen. Reversed, a cleanup failure would leave a run saying `processing` with
 * no job working it.
 */
async function failRun(
  context: RunContext,
  category: ImportFailureCategory,
  detail: Record<string, unknown>,
): Promise<JobOutcome> {
  const moved = await transitionImportRun(context.job.db, {
    importRunId: context.runId,
    from: [...WORKABLE_STATES],
    to: 'failed',
    errorCode: category,
    finished: true,
  })

  context.job.logger.error('import_prepare_failed', {
    site_id: context.siteId,
    import_run_id: context.runId,
    error_code: category,
    recorded: moved,
    ...detail,
    retryable: false,
  })

  await clearStagingProgress(context.job.db, { importRunId: context.runId })
  await cleanupStagedRows(context)

  // The run is the state machine. A failed run is not a failed job: retrying
  // would ask the same question of the same bytes.
  return 'succeeded'
}

/**
 * Erase what this run staged, through the same helper the publish job and the
 * sweeper use.
 *
 * Shared rather than a local delete for one reason beyond tidiness: the helper
 * marks the run **swept** on success, which takes it out of the sweeper's
 * candidate set. Without that, every failed run would be picked up again at
 * `IMPORT_UPLOAD_TTL_DAYS` and pay for eight more ClickHouse mutations over part
 * sets this call already emptied. Marking is safe here precisely because the
 * helper marks *last* and only after the delete returned — a failure leaves the
 * run unswept and the backstop still owns it.
 *
 * Best-effort by design: the rows are invisible either way, since nothing
 * publishes a failed run.
 */
async function cleanupStagedRows(context: RunContext): Promise<void> {
  if (!context.maintenance) return
  // The upload row carries the archive's key, and the port has no `list` — so
  // this read is the only way the object is addressable at all. A run whose
  // upload row is gone still has its ClickHouse rows cleaned.
  const upload = await readImportUpload(context.job.db, context.runId)
  await cleanImportRun(
    {
      db: context.job.db,
      logger: context.job.logger,
      maintenance: context.maintenance,
      ...(context.storage ? { objectStorage: context.storage } : {}),
    },
    {
      importRunId: context.runId,
      siteId: context.siteId,
      objectKey: upload?.objectKey ?? null,
    },
  )
}

// --- Entry planning ----------------------------------------------------------

interface EntryPlan {
  /** Report → the one entry that fills it. */
  readonly staged: Map<string, ArchiveEntry>
  /**
   * Entries the adapter recognises and deliberately does not stage (D2), as the
   * adapter's own **tokens** rather than as filenames.
   *
   * The distinction is the boundary this list exists to hold. The token lands in
   * a summary warning that is rendered on the customer's review screen, and a
   * filename is provider text from inside an archive nothing has yet proven
   * benign — the same class of value the whole safe-category vocabulary exists to
   * keep off a dashboard. An adapter with no token for an entry it drops
   * contributes `other`, which is a worse message and still not a payload.
   */
  readonly dropped: string[]
}

/** What a dropped entry is called in the summary when its adapter names none. */
const UNNAMED_DROPPED_REPORT = 'other'

/**
 * Decide what every entry in the archive is, before any of it is parsed.
 *
 * An entry the adapter does not claim ends the run. That looks strict and it is
 * the point: the overwhelmingly likely cause is a customer uploading the wrong
 * provider's export, and importing "the parts we recognised" would give them a
 * dashboard silently missing whatever was skipped.
 *
 * Two entries claiming one report also ends the run. A provider ships one file
 * per report, and staging both would double every number in it — the kind of
 * error that stays invisible until somebody compares a total against their old
 * dashboard.
 */
function planEntries(adapter: ImportAdapter, entries: readonly ArchiveEntry[]): EntryPlan {
  const staged = new Map<string, ArchiveEntry>()
  const dropped: string[] = []
  const droppedPattern = adapter.droppedEntryPattern()

  for (const entry of entries) {
    const report = adapter.reportForEntry(entry.name)
    if (report !== null) {
      if (!adapter.expectedEntryPattern(report).test(entry.name)) {
        throw new ImportRunFailure('unexpected_entry', 'entry name does not match its report', {
          entry: entry.name,
        })
      }
      if (staged.has(report)) {
        throw new ImportRunFailure('unexpected_entry', 'two entries claim the same report', {
          report,
        })
      }
      staged.set(report, entry)
      continue
    }
    if (droppedPattern !== null && droppedPattern.test(entry.name)) {
      dropped.push(adapter.droppedEntryToken?.(entry.name) ?? UNNAMED_DROPPED_REPORT)
      continue
    }
    throw new ImportRunFailure('unexpected_entry', 'archive contains an unrecognised entry', {
      entry: entry.name,
    })
  }

  if (staged.size === 0) {
    throw new ImportRunFailure('empty_archive', 'archive contains no report this build stages')
  }
  return { staged, dropped }
}

// --- Staging -----------------------------------------------------------------

interface StagedResult {
  readonly reports: Record<string, ImportReportSummary>
  readonly warnings: Map<string, ImportSummaryWarning>
  readonly minDate: string | null
  readonly maxDate: string | null
  readonly totalRows: number
  /** True when the lease was stolen mid-staging and the caller must stop. */
  readonly lost: boolean
}

interface StageInput {
  readonly archive: { readLines(entry: ArchiveEntry): AsyncIterable<string> }
  readonly plan: EntryPlan
  readonly chunkBytes: number
  readonly progress: Record<string, number>
  /** The UTC day of `first_event_at`, or null for a site with no live data. */
  readonly firstLiveDay: string | null
}

/**
 * Parse every planned report and insert its rows in recorded-size chunks.
 *
 * **Nothing is dropped by date here** — see `buildSummary` for why, and for what
 * is recorded instead.
 */
async function stageReports(context: PrepareContext, input: StageInput): Promise<StagedResult> {
  const reports: Record<string, ImportReportSummary> = {}
  const warnings = new Map<string, ImportSummaryWarning>()
  const key = { site_id: context.siteId, import_run_id: context.runId }

  let minDate: string | null = null
  let maxDate: string | null = null
  let totalRows = 0
  let overlapRows = 0

  for (const report of context.adapter.reports()) {
    const entry = input.plan.staged.get(report)
    if (!entry) continue

    const nextChunk = input.progress[report] ?? 0
    let chunkNo = 0
    let rows = 0
    let skipped = 0
    let buffer: StoredImportedRow[] = []
    let bufferBytes = 0

    const flush = async (): Promise<boolean> => {
      const current = chunkNo
      chunkNo += 1
      const pending = buffer
      buffer = []
      bufferBytes = 0

      // Re-parsed but already durable. Skipped rather than re-inserted: the
      // insert would deduplicate under the same token anyway, and skipping keeps
      // a resume cheap over a long report.
      //
      // **The skip still has to renew the lease**, every `SKIP_RENEW_EVERY`
      // chunks. It is the one path through this loop that does real work — a
      // full re-parse of everything already staged — while touching nothing that
      // would otherwise extend the lease. A resume of a large archive would
      // therefore run past `WORKER_LEASE_TTL_MS` and lose the job to another
      // worker *before reaching its first new chunk*, which the next worker
      // would then repeat: a resume that can never make progress, forever.
      if (current < nextChunk) {
        skipped += 1
        if (skipped % SKIP_RENEW_EVERY !== 0) return true
        return await context.job.extendLease()
      }

      await context.writer.insertRows({
        report,
        rows: pending,
        insertDeduplicationToken: `${context.runId}:${report}:${String(current)}`,
      })
      // **After** the insert returned. A crash between the two costs one chunk
      // re-inserted under a token ClickHouse has seen — a no-op. Before it, a
      // crash would skip the chunk forever and the run would publish with a hole
      // nothing could detect afterwards.
      await recordStagingProgress(context.job.db, {
        importRunId: context.runId,
        report,
        nextChunk: current + 1,
      })
      // Between chunks, not inside one: an insert that outran the lease is
      // already durable, and what must not happen is the *next* one running for
      // a job somebody else now owns.
      return await context.job.extendLease()
    }

    for await (const batch of context.adapter.parseEntry({
      report,
      entryName: entry.name,
      lines: input.archive.readLines(entry),
    })) {
      for (const row of batch.rows) {
        rows += 1
        totalRows += 1
        if (minDate === null || row.date < minDate) minDate = row.date
        if (maxDate === null || row.date > maxDate) maxDate = row.date
        if (input.firstLiveDay !== null && row.date >= input.firstLiveDay) overlapRows += 1

        const stored = toStoredImportedRow(report, key, row)
        buffer.push(stored)
        bufferBytes += estimateRowBytes(stored)
        if (bufferBytes >= input.chunkBytes && !(await flush())) {
          return { reports, warnings, minDate, maxDate, totalRows, lost: true }
        }
      }
      for (const warning of batch.warnings ?? []) addWarning(warnings, warning)
    }

    if (buffer.length > 0 && !(await flush())) {
      return { reports, warnings, minDate, maxDate, totalRows, lost: true }
    }

    reports[report] = { rows, chunks: chunkNo }
  }

  for (const token of input.plan.dropped) {
    addWarning(warnings, { code: 'report_not_staged', count: 0, detail: { report: token } })
  }
  if (overlapRows > 0) {
    addWarning(warnings, { code: 'rows_at_or_after_cutover', count: overlapRows })
  }

  return { reports, warnings, minDate, maxDate, totalRows, lost: false }
}

/**
 * Chunk sizing measures the JSON the insert actually sends.
 *
 * `JSON.stringify().length` rather than a per-row constant, because rows differ
 * by an order of magnitude between reports — a metrics row is six small numbers
 * and a pages row carries a URL path. A constant would make the chunk size mean
 * "8 MiB" for one report and "80 MiB" for another, and the whole point of a
 * byte-bounded chunk is a bounded insert body.
 *
 * `.length` counts UTF-16 code units rather than bytes, so the estimate is low
 * for non-ASCII dimension values. That is the safe direction for a cap expressed
 * against the heap, and the error is bounded by the dimension scrubber's
 * 512-character cap per value.
 */
function estimateRowBytes(row: unknown): number {
  return JSON.stringify(row).length
}

function addWarning(into: Map<string, ImportSummaryWarning>, warning: ImportSummaryWarning): void {
  const key =
    warning.detail === undefined
      ? warning.code
      : `${warning.code}:${JSON.stringify(warning.detail)}`
  const existing = into.get(key)
  into.set(key, existing ? { ...existing, count: existing.count + warning.count } : warning)
}

/**
 * The review payload — and the D4 interpretation this checkpoint implements.
 *
 * ADR-0032 D4 says rows at or after the cutover are "dropped at staging with a
 * summary warning". Taken literally that is not implementable in the order the
 * rest of the ADR requires: the cutover is **chosen at review time** (D4's own
 * first sentence) and its default depends on `max imported date`, which is not
 * known until staging has finished. Staging cannot drop rows against a boundary
 * that staging is what computes.
 *
 * What this implements instead, and it is the closest correct thing:
 *
 * - staging drops **nothing** by date, and stages every row the adapter emits;
 * - the summary records `proposed_cutover_date` (D4's default,
 *   `min(first live day, max imported date + 1)`) and a
 *   `rows_at_or_after_cutover` warning counting the rows that fall at or past
 *   it — which is exactly the warning D4 asks the reviewer to see;
 * - the **read path** is where the partition is enforced: the imported branch
 *   binds `date < cutover_date` (D4's own read rule), so an overlapping row is
 *   dead weight in ClickHouse and cannot reach a dashboard.
 *
 * The guarantee D4 actually wants — "the imported side cannot overlap live even
 * if a later query uses a different timezone" — is therefore held by the read
 * filter rather than by the absence of the rows, which is strictly stronger: it
 * survives a customer publishing with an *earlier* cutover than the default,
 * which dropping-at-staging would not. The cost is storage for rows nobody
 * reads, bounded by the overlap the warning counts and reclaimed with the run.
 *
 * ADR-0032 D4 carries this amendment (2026-07-29), so the decision record and
 * this function now say the same thing.
 */
function buildSummary(staged: StagedResult, firstEventAt: Date | null): ImportRunSummary {
  return {
    reports: staged.reports,
    date_range:
      staged.minDate === null || staged.maxDate === null
        ? null
        : { from: staged.minDate, to: staged.maxDate },
    warnings: [...staged.warnings.values()],
    proposed_cutover_date: defaultCutoverDate({
      maxImportedDate: staged.maxDate,
      firstEventAt,
    }),
    total_rows: staged.totalRows,
  }
}

export const IMPORT_PREPARE_REGISTRATION: JobRegistration = {
  type: IMPORT_PREPARE_JOB_TYPE,
  execute: executeImportPrepare,
  /**
   * The run is the state machine, so a job that ran out of attempts must not
   * leave it mid-flight. `validating` and `processing` are inside the live-run
   * unique's predicate (D3): a run stuck in one holds the site's only import
   * slot forever while nothing is working it, and every later import of that
   * site answers `409 IMPORT_IN_PROGRESS`.
   *
   * This is the hook that makes a *counting* infrastructure retry safe. Without
   * it, marking those retries as counting would only trade an immortal job for a
   * dead job and a permanently pinned run — the lockout would survive, with
   * nothing even polling it any more.
   *
   * The staged rows go too. A run abandoned half-way through `processing` has
   * chunks in ClickHouse that nothing will ever publish, and leaving them to the
   * TTL sweep means a week of a customer's storage for data that is already
   * unreachable.
   */
  onTerminal: async (job, reason, context) => {
    const runId = job.payload['import_run_id']
    if (typeof runId !== 'string' || runId.length === 0) return
    const siteId = job.subjectId

    await transitionImportRun(context.db, {
      importRunId: runId,
      from: [...WORKABLE_STATES],
      to: 'failed',
      // A category, never the raw reason: it is rendered to the customer. The
      // reason is on the job row and in the ERROR line the runner already wrote.
      errorCode: 'prepare_abandoned',
      finished: true,
    })
    await clearStagingProgress(context.db, { importRunId: runId })

    context.logger.error('import_prepare_abandoned', {
      import_run_id: runId,
      site_id: siteId,
      reason,
      retryable: false,
    })

    // Best-effort, and after the state change for the same reason `failRun`
    // orders them that way: the customer-visible answer is recorded whether or
    // not ClickHouse answers, and the sweeper's backstop catches what this
    // misses. A job with no subject site cannot address the rows at all.
    const maintenance = context.resources?.importedAggregatesMaintenance
    if (siteId === null || !maintenance) return
    const upload = await readImportUpload(context.db, runId)
    await cleanImportRun(
      {
        db: context.db,
        logger: context.logger,
        maintenance,
        ...(context.resources?.objectStorage
          ? { objectStorage: context.resources.objectStorage }
          : {}),
      },
      { importRunId: runId, siteId, objectKey: upload?.objectKey ?? null },
    )
  },
  /** One at a time: a prepare holds a temp file, an inflate stream and a
   * ClickHouse insert path, and claiming ten per tick would run ten of those in
   * one process while the page executes serially anyway. */
  limit: 1,
}

export { executeImportPrepare }
