import { ImportedInsertError } from '@openanalytics/clickhouse'
import { createImportAdapterRegistry } from '@openanalytics/domain'
import { ObjectStorageError, type ObjectStorage } from '@openanalytics/integrations'
import { createRecordingMetrics } from '@openanalytics/observability'
import type { Database, ImportRunRow, ImportUploadRow } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { createCapturedLogger } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildZip,
  fixtureCsv,
  fixtureEntryName,
  testFixtureAdapter,
  TEST_FIXTURE_PROVIDER,
} from '../support/import-fixtures.ts'

/**
 * The `import_prepare` executor (ADR-0032, D6/D7).
 *
 * The whole suite is organised around one distinction, because getting it
 * backwards produces one of two bad outcomes — a customer told their archive is
 * broken because ClickHouse was down, or a job retrying a malformed CSV a
 * hundred times:
 *
 * - a bad **archive** fails the RUN with a safe category and the JOB reports
 *   `succeeded` (it did its work and the answer was no);
 * - a bad **dependency** returns a retry and leaves the run untouched.
 *
 * The resume test is the other load-bearing one. It proves the D7 guarantee in
 * its exact form: the chunk size comes from the **run row**, not from the
 * current policy default, and a reclaimed lease skips the chunks whose progress
 * is recorded rather than re-inserting them. If the recorded size were ignored,
 * a retuned default would make the token `{run}:{report}:{chunk}` name a
 * different set of rows and the retry would duplicate a customer's history.
 */

const SITE = '11111111-1111-4111-8111-111111111111'
const RUN = '22222222-2222-4222-8222-222222222222'
const KEY = `imports/${SITE}/${RUN}/archive.zip`
const ETAG = '"deadbeef"'

interface World {
  run: ImportRunRow | null
  upload: ImportUploadRow | null
  firstEventAt: Date | null
  transitions: boolean
  chunkBytes: number | null
  archive: Buffer
  streamEtag: string
  storageError: ObjectStorageError | null
  insertError: unknown
  /** How many `extendLease()` calls succeed before the lease reads as stolen. */
  leaseHoldsFor: number
  phaseHeld: boolean
}

const world: World = {
  run: null,
  upload: null,
  firstEventAt: null,
  transitions: true,
  chunkBytes: null,
  archive: Buffer.alloc(0),
  streamEtag: ETAG,
  storageError: null,
  insertError: null,
  leaseHoldsFor: Number.POSITIVE_INFINITY,
  phaseHeld: true,
}

const calls = {
  transitions: [] as { from: readonly string[]; to: string; errorCode?: string | null }[],
  phases: [] as string[],
  progress: [] as { report: string; nextChunk: number }[],
  inserts: [] as { report: string; rows: number; token: string }[],
  cleaned: [] as string[],
  chunkProposals: [] as number[],
  summaries: [] as Record<string, unknown>[],
  leaseExtensions: 0,
}

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    readImportRun: async () => world.run,
    readImportUpload: async () => world.upload,
    readSiteImportContext: async () => ({
      firstEventAt: world.firstEventAt,
      publishedImportRunId: null,
      status: 'active',
    }),
    recordStagingChunkBytes: async (
      _db: unknown,
      input: { importRunId: string; proposedBytes: number },
    ) => {
      calls.chunkProposals.push(input.proposedBytes)
      return world.chunkBytes ?? input.proposedBytes
    },
    recordStagingProgress: async (_db: unknown, input: { report: string; nextChunk: number }) => {
      calls.progress.push({ report: input.report, nextChunk: input.nextChunk })
    },
    clearStagingProgress: async () => undefined,
    // The cleanup helper claims before it deletes (ADR-0032, D3): a run another
    // cleaner holds, or one a rollback republished, is never touched.
    claimImportRunForCleanup: async () => true,
    releaseImportRunCleanupClaim: async () => undefined,
    transitionImportRun: async (
      _db: unknown,
      input: {
        from: readonly string[]
        to: string
        errorCode?: string | null
        summary?: Record<string, unknown>
      },
    ) => {
      calls.transitions.push(input)
      if (input.summary !== undefined) calls.summaries.push(input.summary)
      if (!world.transitions) return false
      if (world.run) world.run = { ...world.run, state: input.to as ImportRunRow['state'] }
      return true
    },
  }
})

const { executeImportPrepare, IMPORT_PREPARE_REGISTRATION } =
  await import('../../apps/worker/src/jobs/import-prepare.ts')

function runRow(overrides: Partial<ImportRunRow> = {}): ImportRunRow {
  return {
    id: RUN,
    siteId: SITE,
    provider: TEST_FIXTURE_PROVIDER,
    state: 'uploaded',
    summary: null,
    cutoverDate: null,
    stagingChunkBytes: null,
    stagingProgress: null,
    supersededRunId: null,
    sweptAt: null,
    errorCode: null,
    createdAt: new Date('2026-07-29T00:00:00.000Z'),
    updatedAt: new Date('2026-07-29T00:00:00.000Z'),
    finishedAt: null,
    ...overrides,
  }
}

function uploadRow(overrides: Partial<ImportUploadRow> = {}): ImportUploadRow {
  return {
    id: 'up-1',
    importRunId: RUN,
    objectKey: KEY,
    declaredBytes: 1_024,
    contentType: 'application/zip',
    etag: ETAG,
    createdAt: new Date('2026-07-29T00:00:00.000Z'),
    completedAt: new Date('2026-07-29T00:00:00.000Z'),
    ...overrides,
  }
}

const storage = {
  async getStream() {
    await Promise.resolve()
    if (world.storageError) throw world.storageError
    const bytes = world.archive
    return {
      key: KEY,
      size: bytes.length,
      contentType: 'application/zip',
      etag: world.streamEtag,
      body: (async function* () {
        yield new Uint8Array(bytes)
      })(),
    }
  },
} as unknown as ObjectStorage

const writer = {
  async insertRows(input: {
    report: string
    rows: readonly unknown[]
    insertDeduplicationToken: string
  }) {
    await Promise.resolve()
    if (world.insertError) throw world.insertError
    calls.inserts.push({
      report: input.report,
      rows: input.rows.length,
      token: input.insertDeduplicationToken,
    })
    return { rows: input.rows.length, durationMs: 1 }
  },
}

const maintenance = {
  async deleteImportRunRows(key: { importRunId: string }) {
    await Promise.resolve()
    calls.cleaned.push(key.importRunId)
    return { tables: 8 }
  },
}

const POLICY = {
  maxArchiveBytes: 1_000_000,
  maxEntries: 32,
  maxEntryBytes: 1_000_000,
  maxTotalUncompressedBytes: 2_000_000,
  maxRowBytes: 1_024,
  stagingChunkBytes: 1_000_000,
  uploadTtlDays: 7,
}

function context(overrides: Record<string, unknown> = {}) {
  const { logger, find } = createCapturedLogger()
  const metrics = createRecordingMetrics()
  return {
    find,
    input: {
      job: {
        id: 'job-1',
        type: 'import_prepare',
        subjectId: SITE,
        payload: { import_run_id: RUN },
        phase: null,
        attempts: 1,
        claimedBy: 'w-1',
        leaseExpiresAt: new Date(),
        createdAt: new Date(),
      },
      db: {} as Database,
      logger,
      metrics,
      resources: {
        objectStorage: storage,
        importedAggregatesWriter: writer,
        importedAggregatesMaintenance: maintenance,
        importAdapters: createImportAdapterRegistry([testFixtureAdapter]),
        importPolicy: POLICY,
      },
      extendLease: async () => {
        await Promise.resolve()
        calls.leaseExtensions += 1
        return calls.leaseExtensions <= world.leaseHoldsFor
      },
      updatePhase: async (phase: string) => {
        await Promise.resolve()
        calls.phases.push(phase)
        return world.phaseHeld
      },
      ...overrides,
    } as unknown as Parameters<typeof executeImportPrepare>[0],
  }
}

/** Three days of metrics and two pages: enough that chunking is observable. */
function goodArchive(): Buffer {
  return buildZip([
    {
      name: fixtureEntryName('metrics'),
      content: fixtureCsv('metrics', [
        '2024-01-01,10,12,30,4,600',
        '2024-01-02,11,13,31,5,610',
        '2024-01-03,12,14,32,6,620',
      ]),
    },
    {
      name: fixtureEntryName('pages'),
      content: fixtureCsv('pages', [
        '2024-01-01,shop.example.com,/,5,6,9',
        '2024-01-02,shop.example.com,/pricing,4,4,7',
      ]),
    },
    { name: 'fixture_dropped.csv', content: 'anything\n' },
  ])
}

beforeEach(() => {
  world.run = runRow()
  world.upload = uploadRow()
  world.firstEventAt = null
  world.transitions = true
  world.chunkBytes = null
  world.archive = goodArchive()
  world.streamEtag = ETAG
  world.storageError = null
  world.insertError = null
  world.leaseHoldsFor = Number.POSITIVE_INFINITY
  world.phaseHeld = true
  calls.transitions = []
  calls.phases = []
  calls.progress = []
  calls.inserts = []
  calls.cleaned = []
  calls.chunkProposals = []
  calls.summaries = []
  calls.leaseExtensions = 0
})

describe('import_prepare — the happy path', () => {
  it('validates, stages and reaches ready_for_review with a summary', async () => {
    const c = context()
    expect(await executeImportPrepare(c.input)).toBe('succeeded')

    // The phases are the run states, in order, and each is durable before the
    // work it names so a crash resumes there rather than one phase back.
    expect(calls.phases).toEqual(['validating', 'processing'])
    expect(calls.transitions.map((t) => t.to)).toEqual([
      'validating',
      'processing',
      'ready_for_review',
    ])

    // One insert per report, each under the deterministic token D7 names.
    expect(calls.inserts).toEqual([
      { report: 'metrics', rows: 3, token: `${RUN}:metrics:0` },
      { report: 'pages', rows: 2, token: `${RUN}:pages:0` },
    ])
    // Progress is recorded AFTER each durable insert.
    expect(calls.progress).toEqual([
      { report: 'metrics', nextChunk: 1 },
      { report: 'pages', nextChunk: 1 },
    ])

    const summary = calls.summaries[0]
    expect(summary).toMatchObject({
      reports: {
        metrics: { rows: 3, chunks: 1 },
        pages: { rows: 2, chunks: 1 },
      },
      date_range: { from: '2024-01-01', to: '2024-01-03' },
      total_rows: 5,
      // No live events, so no clamp: the whole import is visible and live data
      // starts winning the moment the tracker arrives (D4).
      proposed_cutover_date: '2024-01-04',
    })
  })

  it('records the report the adapter recognises and does not stage', async () => {
    // D2's entry/exit-pages decision in its general form: a recognised report
    // this build does not read is a summary note, not a failure.
    const c = context()
    await executeImportPrepare(c.input)
    const summary = calls.summaries[0] as { warnings: { code: string }[] }
    expect(summary.warnings.map((w) => w.code)).toContain('report_not_staged')
  })

  it('clamps the proposed cutover to the first live day and warns about the overlap', async () => {
    // The D4 interpretation this checkpoint implements: staging drops NOTHING by
    // date. It proposes the clamped cutover and counts the rows that fall at or
    // past it, and the read path's `date < cutover` filter is what keeps them off
    // the dashboard.
    world.firstEventAt = new Date('2024-01-02T09:00:00.000Z')
    const c = context()
    await executeImportPrepare(c.input)

    const summary = calls.summaries[0] as {
      proposed_cutover_date: string
      warnings: { code: string; count: number }[]
      reports: Record<string, { rows: number }>
    }
    expect(summary.proposed_cutover_date).toBe('2024-01-02')
    // Every row is still staged — 3 metrics + 2 pages.
    expect(summary.reports['metrics']?.rows).toBe(3)
    const overlap = summary.warnings.find((w) => w.code === 'rows_at_or_after_cutover')
    // 2024-01-02 and 2024-01-03 metrics, plus the 2024-01-02 page.
    expect(overlap?.count).toBe(3)
  })

  it('chunks by the recorded byte size, not by row count', async () => {
    // A tiny chunk size makes every row its own chunk, which is what proves the
    // boundary is bytes rather than an arbitrary batch size.
    world.chunkBytes = 1
    const c = context()
    await executeImportPrepare(c.input)

    expect(calls.inserts.map((i) => i.token)).toEqual([
      `${RUN}:metrics:0`,
      `${RUN}:metrics:1`,
      `${RUN}:metrics:2`,
      `${RUN}:pages:0`,
      `${RUN}:pages:1`,
    ])
  })
})

describe('import_prepare — resume', () => {
  it('reuses the recorded chunk size and skips chunks already durable', async () => {
    // The D7 guarantee. The policy default is 1 MB, the run recorded 1 byte, and
    // the resumed pass must use the RECORDED value — otherwise chunk 0 of a
    // retry would contain three rows where the first attempt's chunk 0 contained
    // one, and the same token would name different rows.
    world.chunkBytes = 1
    world.run = runRow({ state: 'processing', stagingProgress: { metrics: 2 } })
    const c = context()

    expect(await executeImportPrepare(c.input)).toBe('succeeded')

    // The proposal is still made (the repository's COALESCE decides), and the
    // recorded value is what chunking used.
    expect(calls.chunkProposals).toEqual([POLICY.stagingChunkBytes])
    // Chunks 0 and 1 of metrics were already durable: re-parsed, not re-inserted.
    expect(calls.inserts.map((i) => i.token)).toEqual([
      `${RUN}:metrics:2`,
      `${RUN}:pages:0`,
      `${RUN}:pages:1`,
    ])
    // The summary is recomputed from the full parse, so a resumed run and a
    // first-pass run describe the same import.
    expect(calls.summaries[0]).toMatchObject({
      reports: { metrics: { rows: 3, chunks: 3 }, pages: { rows: 2, chunks: 2 } },
      total_rows: 5,
    })
    // Already-`processing`: no second transition into it.
    expect(calls.transitions.map((t) => t.to)).toEqual(['ready_for_review'])
  })

  it('stops when the lease is stolen between chunks', async () => {
    world.chunkBytes = 1
    // The first extension is the post-download renewal; the second is the one
    // after chunk 0, and that is where the row becomes somebody else's.
    world.leaseHoldsFor = 1
    const c = context()
    const outcome = await executeImportPrepare(c.input)

    expect(outcome).toMatchObject({ retry: expect.anything() })
    // One insert, then the extend said the row belongs to somebody else.
    expect(calls.inserts).toHaveLength(1)
    // The run is NOT failed: another worker owns it.
    expect(calls.transitions.some((t) => t.to === 'failed')).toBe(false)
  })

  it('renews the lease after the download, before any chunk work', async () => {
    // A 256 MiB archive over a slow bucket can eat most of the TTL before
    // staging starts. Renewing here means the first chunk begins with a full
    // lease rather than whatever the transfer left.
    world.leaseHoldsFor = 0
    const c = context()

    expect(await executeImportPrepare(c.input)).toMatchObject({ retry: expect.anything() })
    expect(calls.inserts).toEqual([])
    expect(c.find('import_prepare_lease_lost')).toHaveLength(1)
  })

  it('renews the lease while re-parsing chunks it is going to skip', async () => {
    // The resume path's one real hazard: re-parsing everything already staged is
    // minutes of work that touches nothing which would otherwise extend the
    // lease. Without a renewal on the skip path a large archive loses the job
    // before reaching its first new chunk — and the next worker repeats it,
    // forever.
    //
    // Twenty rows at one byte per chunk with progress at 18 means eighteen
    // skipped chunks, so the every-eighth renewal has to fire twice before any
    // insert happens.
    world.chunkBytes = 1
    world.archive = buildZip([
      {
        name: fixtureEntryName('metrics'),
        content: fixtureCsv(
          'metrics',
          Array.from(
            { length: 20 },
            (_unused, index) => `2024-02-${String(index + 1).padStart(2, '0')},1,1,1,0,1`,
          ),
        ),
      },
    ])
    world.run = runRow({ state: 'processing', stagingProgress: { metrics: 18 } })
    const c = context()

    expect(await executeImportPrepare(c.input)).toBe('succeeded')
    // 18 skips renew at 8 and 16, plus the post-download renewal, plus one per
    // inserted chunk (18 and 19).
    expect(calls.leaseExtensions).toBe(5)
    expect(calls.inserts.map((i) => i.token)).toEqual([`${RUN}:metrics:18`, `${RUN}:metrics:19`])
  })

  it('stops cleanly when a skip-path renewal finds the lease stolen', async () => {
    world.chunkBytes = 1
    world.archive = buildZip([
      {
        name: fixtureEntryName('metrics'),
        content: fixtureCsv(
          'metrics',
          Array.from(
            { length: 20 },
            (_unused, index) => `2024-02-${String(index + 1).padStart(2, '0')},1,1,1,0,1`,
          ),
        ),
      },
    ])
    world.run = runRow({ state: 'processing', stagingProgress: { metrics: 18 } })
    // Only the post-download renewal succeeds; the first skip renewal does not.
    world.leaseHoldsFor = 1
    const c = context()

    expect(await executeImportPrepare(c.input)).toMatchObject({ retry: expect.anything() })
    expect(calls.inserts).toEqual([])
    expect(calls.transitions.some((t) => t.to === 'failed')).toBe(false)
  })
})

describe('import_prepare — run failures (job succeeds)', () => {
  it('fails the run `adapter_unavailable` when no adapter is registered', async () => {
    const c = context({
      resources: {
        objectStorage: storage,
        importedAggregatesWriter: writer,
        importedAggregatesMaintenance: maintenance,
        importAdapters: createImportAdapterRegistry([]),
        importPolicy: POLICY,
      },
    })

    expect(await executeImportPrepare(c.input)).toBe('succeeded')
    expect(calls.transitions).toMatchObject([
      {
        from: ['uploaded', 'validating', 'processing'],
        to: 'failed',
        errorCode: 'adapter_unavailable',
        finished: true,
      },
    ])
    // Nothing was downloaded, so there is nothing staged — but the cleanup runs
    // anyway, because a resumed run could have staged before the adapter went.
    expect(calls.cleaned).toEqual([RUN])
  })

  it('fails the run `upload_changed` when the pinned ETag does not match', async () => {
    world.streamEtag = '"somethingelse"'
    const c = context()

    expect(await executeImportPrepare(c.input)).toBe('succeeded')
    expect(calls.transitions.at(-1)).toMatchObject({ to: 'failed', errorCode: 'upload_changed' })
    expect(calls.inserts).toEqual([])
  })

  it('tolerates a quoted/unquoted ETag difference rather than failing every import', async () => {
    world.streamEtag = 'deadbeef'
    const c = context()
    expect(await executeImportPrepare(c.input)).toBe('succeeded')
    expect(calls.transitions.at(-1)).toMatchObject({ to: 'ready_for_review' })
  })

  it('fails the run `upload_unverifiable` when no ETag was ever pinned', async () => {
    world.upload = uploadRow({ etag: '' })
    const c = context()

    expect(await executeImportPrepare(c.input)).toBe('succeeded')
    expect(calls.transitions).toMatchObject([{ to: 'failed', errorCode: 'upload_unverifiable' }])
  })

  it('fails the run and cleans up when a budget is breached', async () => {
    world.archive = buildZip([
      {
        name: fixtureEntryName('metrics'),
        content: fixtureCsv('metrics', ['2024-01-01,1,1,1,0,1']),
      },
      { name: 'inner.zip', content: 'PK' },
    ])
    const c = context()

    expect(await executeImportPrepare(c.input)).toBe('succeeded')
    expect(calls.transitions.at(-1)).toMatchObject({ to: 'failed', errorCode: 'nested_archive' })
    // Best-effort cleanup of anything a previous attempt staged.
    expect(calls.cleaned).toEqual([RUN])
    expect(c.find('import_prepare_failed')).toHaveLength(1)
  })

  it('fails the run `unexpected_entry` for an archive from another provider', async () => {
    world.archive = buildZip([{ name: 'visitors_20240101.csv', content: 'a,b\n1,2\n' }])
    const c = context()

    expect(await executeImportPrepare(c.input)).toBe('succeeded')
    expect(calls.transitions.at(-1)).toMatchObject({ to: 'failed', errorCode: 'unexpected_entry' })
  })

  it('fails the run `upload_expired` when the archive is no longer in storage', async () => {
    world.storageError = new ObjectStorageError('not_found', 'gone')
    const c = context()

    expect(await executeImportPrepare(c.input)).toBe('succeeded')
    expect(calls.transitions.at(-1)).toMatchObject({ to: 'failed', errorCode: 'upload_expired' })
  })
})

describe('import_prepare — infrastructure failures (run untouched)', () => {
  it('retries without failing the run when storage is unavailable', async () => {
    world.storageError = new ObjectStorageError('unavailable', 'bucket down')
    const c = context()

    expect(await executeImportPrepare(c.input)).toMatchObject({ retry: expect.anything() })
    expect(calls.transitions.some((t) => t.to === 'failed')).toBe(false)
    expect(c.find('import_prepare_storage_unavailable')).toHaveLength(1)
  })

  it('retries without failing the run when ClickHouse refuses the insert', async () => {
    // Including ACCESS_DENIED: the grant is ours to fix, and telling a customer
    // their archive is broken because `oa_ingest` cannot write would be a wrong
    // answer wearing a correct one's clothes.
    world.insertError = new ImportedInsertError('denied', { ambiguous: false, code: '497' })
    const c = context()

    expect(await executeImportPrepare(c.input)).toMatchObject({ retry: expect.anything() })
    expect(calls.transitions.some((t) => t.to === 'failed')).toBe(false)
  })

  it('retries when a resource the worker needs is not configured', async () => {
    const c = context({ resources: { importPolicy: POLICY } })
    expect(await executeImportPrepare(c.input)).toMatchObject({ retry: expect.anything() })
    expect(calls.transitions).toEqual([])
  })
})

describe('import_prepare — no-ops', () => {
  it('succeeds without touching anything when the run was discarded', async () => {
    world.run = runRow({ state: 'discarded' })
    const c = context()

    expect(await executeImportPrepare(c.input)).toBe('succeeded')
    expect(calls.transitions).toEqual([])
    expect(calls.phases).toEqual([])
    expect(c.find('import_prepare_noop')).toHaveLength(1)
  })

  it('succeeds when the run is gone entirely', async () => {
    world.run = null
    const c = context()

    expect(await executeImportPrepare(c.input)).toBe('succeeded')
    expect(c.find('import_prepare_run_absent')).toHaveLength(1)
  })

  it('is terminal for a payload that names no run', async () => {
    const c = context({ job: { id: 'job-1', subjectId: SITE, payload: {} } })
    expect(await executeImportPrepare(c.input)).toMatchObject({ terminal: expect.anything() })
  })
})

describe('import_prepare — abandonment', () => {
  it('frees the site import slot when the job is given up on', async () => {
    // `validating`/`processing` are inside the live-run unique's predicate (D3):
    // a run stuck in one would block every later import of that site forever.
    const { logger } = createCapturedLogger()
    const metrics = createRecordingMetrics()
    await IMPORT_PREPARE_REGISTRATION.onTerminal?.(
      {
        id: 'job-1',
        type: 'import_prepare',
        subjectId: SITE,
        payload: { import_run_id: RUN },
        phase: 'processing',
        attempts: 100,
        claimedBy: 'w-1',
        leaseExpiresAt: new Date(),
        createdAt: new Date(),
      },
      'attempts exhausted',
      { db: {} as Database, logger, metrics },
    )

    expect(calls.transitions).toMatchObject([
      { to: 'failed', errorCode: 'prepare_abandoned', finished: true },
    ])
  })
})
