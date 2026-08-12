import { createImportAdapterRegistry, plausibleImportAdapter } from '@openanalytics/domain'
import type { ObjectStorage } from '@openanalytics/integrations'
import { createRecordingMetrics } from '@openanalytics/observability'
import type { Database, ImportRunRow, ImportUploadRow } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { createCapturedLogger } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPlausibleZip } from '../support/import-fixtures.ts'

/**
 * A real Plausible archive through the real pipeline (ADR-0032, CP3).
 *
 * The adapter suite proves the parser and the executor suite proves the
 * pipeline; neither proves that the two meet. This one does: a genuine ZIP of
 * the provider's ten CSVs — quoted commas, a GeoNames city, entry/exit files —
 * goes in at `uploaded`, and what comes out is the review payload a customer
 * would be shown before publishing.
 *
 * What it is asserting is the *summary*, because that is the artefact the human
 * decision is made on. Eight staged reports and not ten; the two dropped ones
 * named as notes rather than as failures; the dropped city counted; a date range
 * and a proposed cutover computed from the rows rather than from the filename.
 */

const SITE = '11111111-1111-4111-8111-111111111111'
const RUN = '22222222-2222-4222-8222-222222222222'
const KEY = `imports/${SITE}/${RUN}/archive.zip`
const ETAG = '"plausible-fixture"'

const world = {
  run: null as ImportRunRow | null,
  upload: null as ImportUploadRow | null,
  firstEventAt: null as Date | null,
  archive: Buffer.alloc(0) as Buffer,
}

const calls = {
  transitions: [] as { to: string; summary?: Record<string, unknown> }[],
  inserts: [] as { report: string; rows: readonly Record<string, unknown>[]; token: string }[],
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
    recordStagingChunkBytes: async (_db: unknown, input: { proposedBytes: number }) =>
      input.proposedBytes,
    recordStagingProgress: async () => undefined,
    clearStagingProgress: async () => undefined,
    claimImportRunForCleanup: async () => true,
    releaseImportRunCleanupClaim: async () => undefined,
    transitionImportRun: async (
      _db: unknown,
      input: { to: string; summary?: Record<string, unknown> },
    ) => {
      calls.transitions.push(input)
      if (world.run) world.run = { ...world.run, state: input.to as ImportRunRow['state'] }
      return true
    },
  }
})

const { executeImportPrepare } = await import('../../apps/worker/src/jobs/import-prepare.ts')

const storage = {
  async getStream() {
    await Promise.resolve()
    return {
      key: KEY,
      size: world.archive.length,
      contentType: 'application/zip',
      etag: ETAG,
      body: (async function* () {
        yield new Uint8Array(world.archive)
      })(),
    }
  },
} as unknown as ObjectStorage

const writer = {
  async insertRows(input: {
    report: string
    rows: readonly Record<string, unknown>[]
    insertDeduplicationToken: string
  }) {
    await Promise.resolve()
    calls.inserts.push({
      report: input.report,
      rows: input.rows,
      token: input.insertDeduplicationToken,
    })
    return { rows: input.rows.length, durationMs: 1 }
  },
}

function context() {
  const { logger } = createCapturedLogger()
  return {
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
    metrics: createRecordingMetrics(),
    resources: {
      objectStorage: storage,
      importedAggregatesWriter: writer,
      importedAggregatesMaintenance: { deleteImportRunRows: async () => ({ tables: 8 }) },
      importAdapters: createImportAdapterRegistry([plausibleImportAdapter]),
      importPolicy: {
        maxArchiveBytes: 1_000_000,
        maxEntries: 32,
        maxEntryBytes: 1_000_000,
        maxTotalUncompressedBytes: 2_000_000,
        maxRowBytes: 1_024,
        stagingChunkBytes: 1_000_000,
        uploadTtlDays: 7,
      },
    },
    extendLease: async () => {
      await Promise.resolve()
      return true
    },
    updatePhase: async () => {
      await Promise.resolve()
      return true
    },
  } as unknown as Parameters<typeof executeImportPrepare>[0]
}

beforeEach(() => {
  world.run = {
    id: RUN,
    siteId: SITE,
    provider: 'plausible',
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
  }
  world.upload = {
    id: 'up-1',
    importRunId: RUN,
    objectKey: KEY,
    declaredBytes: 4_096,
    contentType: 'application/zip',
    etag: ETAG,
    createdAt: new Date('2026-07-29T00:00:00.000Z'),
    completedAt: new Date('2026-07-29T00:00:00.000Z'),
  }
  world.firstEventAt = null
  world.archive = buildPlausibleZip()
  calls.transitions = []
  calls.inserts = []
})

function summary(): Record<string, unknown> {
  const recorded = calls.transitions.find((transition) => transition.summary !== undefined)
  return recorded?.summary as Record<string, unknown>
}

describe('a real Plausible export, uploaded to ready_for_review', () => {
  it('walks the run forward and terminates the job succeeded at review', async () => {
    // `ready_for_review` and not `published`: a human review that can take days
    // must not hold a job lease or the site's single live-run slot (D7).
    expect(await executeImportPrepare(context())).toBe('succeeded')
    expect(calls.transitions.map((transition) => transition.to)).toEqual([
      'validating',
      'processing',
      'ready_for_review',
    ])
  })

  it('stages exactly the eight reports, never the ten files', async () => {
    await executeImportPrepare(context())
    expect(Object.keys(summary()['reports'] as object).sort()).toEqual([
      'browsers',
      'custom_events',
      'devices',
      'geography',
      'metrics',
      'os',
      'pages',
      'sources',
    ])
    // One insert per report, each under the deterministic retry token.
    expect(calls.inserts.map((insert) => insert.token).sort()).toEqual(
      [
        'browsers',
        'custom_events',
        'devices',
        'geography',
        'metrics',
        'os',
        'pages',
        'sources',
      ].map((report) => `${RUN}:${report}:0`),
    )
  })

  it('records entry and exit pages as notes naming the report, never the filename', async () => {
    await executeImportPrepare(context())
    const warnings = summary()['warnings'] as { code: string; detail?: { report?: string } }[]
    const dropped = warnings
      .filter((warning) => warning.code === 'report_not_staged')
      .map((warning) => warning.detail?.report)
      .sort()
    expect(dropped).toEqual(['entry_pages', 'exit_pages'])
    // The summary is rendered on the customer's review screen, and a filename is
    // provider text from inside an archive nothing has yet proven benign — the
    // one class of value the whole safe-category vocabulary keeps off a dashboard.
    expect(JSON.stringify(summary())).not.toContain('.csv')
  })

  it('reads a BOM-and-CRLF entry exactly as it reads a plain one', async () => {
    // What a spreadsheet round-trip produces, and both halves are invisible if
    // unhandled: the BOM becomes part of the first column's *name* (so `date` is
    // never found) and the trailing `\r` becomes part of the last cell's value
    // (so a count stops parsing and a dimension gains a control character).
    const plain = buildPlausibleZip()
    world.archive = buildPlausibleZip({ crlfBom: ['visitors', 'locations', 'pages'] })
    await executeImportPrepare(context())
    const withBom = summary()

    calls.transitions = []
    calls.inserts = []
    world.run = { ...(world.run as ImportRunRow), state: 'uploaded' }
    world.archive = plain
    await executeImportPrepare(context())

    expect(withBom['reports']).toEqual(summary()['reports'])
    expect(withBom['date_range']).toEqual(summary()['date_range'])
    expect(withBom['total_rows']).toEqual(summary()['total_rows'])
  })

  it('tells the reviewer the city column was dropped, and how much of it', async () => {
    await executeImportPrepare(context())
    const warnings = summary()['warnings'] as { code: string; count: number }[]
    const city = warnings.find((warning) => warning.code === 'city_dropped')
    expect(city).toBeDefined()
    // One of the fixture's two location rows carries a GeoNames id.
    expect(city?.count).toBe(1)
  })

  it('reports the range the rows cover and the cutover it proposes', async () => {
    await executeImportPrepare(context())
    expect(summary()['date_range']).toEqual({ from: '2024-01-01', to: '2024-01-03' })
    // No live events yet — the primary migration case — so there is no clamp and
    // the whole import is visible: the day after the last imported day.
    expect(summary()['proposed_cutover_date']).toBe('2024-01-04')
    expect(summary()['total_rows']).toBe(19)
  })

  it('warns about rows the chosen cutover would not show', async () => {
    // A site whose tracker was installed mid-export: the default cutover clamps
    // to the first live day, and the rows at or after it are counted so the
    // reviewer sees what a publish would leave unread.
    world.firstEventAt = new Date('2024-01-02T09:00:00.000Z')
    await executeImportPrepare(context())
    expect(summary()['proposed_cutover_date']).toBe('2024-01-02')
    const warnings = summary()['warnings'] as { code: string; count: number }[]
    expect(warnings.find((warning) => warning.code === 'rows_at_or_after_cutover')?.count).toBe(11)
  })

  it('stages the parsed values, quoted commas and all', async () => {
    await executeImportPrepare(context())
    const pages = calls.inserts.find((insert) => insert.report === 'pages')?.rows ?? []
    expect(pages.map((row) => row['page'])).toContain('/blog/hello,-world-"quoted"')
    // Every staged row carries the site and the run the pipeline stamped, never
    // anything the adapter could have named.
    for (const insert of calls.inserts) {
      for (const row of insert.rows) {
        expect(row['site_id']).toBe(SITE)
        expect(row['import_run_id']).toBe(RUN)
      }
    }
    // The geography rows reach ClickHouse with no city column at all.
    const geography = calls.inserts.find((insert) => insert.report === 'geography')?.rows ?? []
    expect(Object.keys(geography[0] as object)).not.toContain('city')
  })

  it('fails the run, not the job, when a file is another provider’s', async () => {
    // The likeliest real failure: a customer uploading the wrong export. The job
    // did its work and the answer was no, so retrying would ask the same question
    // of the same bytes.
    world.archive = buildPlausibleZip({
      override: { visitors: 'date,sessions\n2024-01-01,5' },
    })
    expect(await executeImportPrepare(context())).toBe('succeeded')
    expect(calls.transitions.at(-1)).toMatchObject({ to: 'failed' })
  })
})
