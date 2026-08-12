import { gunzipSync } from 'node:zlib'
import { ExportReadError, type ExportReader } from '@openanalytics/clickhouse'
import {
  EXPORT_MANIFEST_NOTES,
  IMPORTED_REPORTS,
  exportObjectKeysOf,
  exportObjectPrefix,
  exportRunStatusFor,
  type ExportChunkRecord,
  type ExportManifest,
} from '@openanalytics/domain'
import { ObjectStorageError, type ObjectStorage } from '@openanalytics/integrations'
import type { ClaimedJob, Database, ExportRunRow } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { createCapturedLogger } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobExecutorContext, JobOutcome } from '../../apps/worker/src/jobs/runner.ts'

/**
 * The `export_run` executor (ADR-0032, D8), with a fake bucket and a fake
 * ClickHouse.
 *
 * What this suite exists to hold — every item is something no integration test
 * would notice until a customer's export was already wrong:
 *
 * - **the chunk plan**: one object per calendar month, one per imported report,
 *   one for funnels, and the manifest **last**, because its presence in the
 *   bucket is what says the export is complete;
 * - **an empty unit is still written.** "This report was empty" and "this report
 *   was not exported" are different statements, and a manifest missing a report
 *   is indistinguishable from one written by a build that forgot it;
 * - **the cap splits a month into parts** and the split names them `-p2`, `-p3`
 *   while part one keeps the plain name;
 * - **resume skips verified chunks and regenerates unverified ones.** The
 *   verification is a real `head()`, because the bucket's seven-day rule can
 *   legitimately have reaped a chunk a recorded row still names — and a manifest
 *   naming objects that do not exist is the one failure a manifest exists to
 *   prevent;
 * - **infrastructure failures are counting retries**, never a failed export: a
 *   customer told their data could not be exported because storage blinked is a
 *   wrong answer, and a *non*-counting retry would be an immortal job holding
 *   the site's only export slot forever;
 * - the pins are read off the run and bound into every query, never re-read.
 */

const SITE = '2b8c1d40-1111-4000-8000-000000000001'
const EXPORT = '9d3f0a55-2222-4000-8000-000000000002'
const IMPORT_RUN = '4e1b2c66-3333-4000-8000-000000000003'
const PREFIX = exportObjectPrefix(SITE, EXPORT)
const CUTOFF = new Date('2026-07-29T10:00:00.000Z')

interface StoredObject {
  readonly body: Buffer
  readonly contentType: string
}

/** What the repository, the bucket and ClickHouse answer, per test. */
const world = {
  run: null as ExportRunRow | null,
  months: [] as string[],
  events: new Map<string, Record<string, unknown>[]>(),
  imported: new Map<string, Record<string, unknown>[]>(),
  funnels: [] as Record<string, unknown>[],
  /** Which call throws, and what. */
  storageFails: null as null | 'put' | 'head',
  readFails: false,
  leaseHeld: true,
  maxChunkBytes: 64 * 1024 * 1024,
  leaseTtlMs: 60_000,
  resources: 'all' as 'all' | 'no_storage' | 'no_reader',
}

const calls = {
  puts: [] as string[],
  heads: [] as string[],
  recorded: [] as ExportChunkRecord[],
  started: [] as string[],
  completed: [] as { exportRunId: string; manifest: ExportManifest }[],
  failed: [] as { exportRunId: string; errorCode: string }[],
  phases: [] as string[],
  retracted: [] as string[],
  renewals: 0,
}

const objects = new Map<string, StoredObject>()

function run(overrides: Partial<ExportRunRow> = {}): ExportRunRow {
  return {
    id: EXPORT,
    siteId: SITE,
    requestedBy: 'u-1',
    state: 'queued',
    cutoff: CUTOFF,
    pinnedImportRunId: IMPORT_RUN,
    manifest: null,
    progress: null,
    objectPrefix: PREFIX,
    errorCode: null,
    createdAt: CUTOFF,
    startedAt: null,
    finishedAt: null,
    sweptAt: null,
    ...overrides,
  }
}

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    readExportRun: async () => world.run,
    startExportRun: async (_db: unknown, input: { exportRunId: string }) => {
      calls.started.push(input.exportRunId)
      return true
    },
    recordExportChunk: async (_db: unknown, input: { chunk: ExportChunkRecord }) => {
      calls.recorded.push(input.chunk)
    },
    retractExportChunks: async (_db: unknown, input: { keys: readonly string[] }) => {
      calls.retracted.push(...input.keys)
    },
    completeExportRun: async (
      _db: unknown,
      input: { exportRunId: string; manifest: ExportManifest },
    ) => {
      calls.completed.push(input)
      return true
    },
    failExportRun: async (_db: unknown, input: { exportRunId: string; errorCode: string }) => {
      calls.failed.push(input)
      return true
    },
    listFunnels: async () =>
      world.funnels.map((funnel) => ({
        id: funnel['id'],
        siteId: SITE,
        name: funnel['name'],
        steps: ['/a', '/b'],
        scope: 'session',
        windowMs: 1_000,
        createdByUserId: null,
        createdAt: CUTOFF,
        updatedAt: CUTOFF,
        archivedAt: null,
      })),
  }
})

const { EXPORT_RUN_REGISTRATION, executeExportRun } =
  await import('../../apps/worker/src/jobs/export-run.ts')

const storage = {
  async put(input: { key: string; body: Uint8Array | string; contentType: string }) {
    await Promise.resolve()
    if (world.storageFails === 'put') {
      throw new ObjectStorageError('unavailable', 'storage did not answer')
    }
    calls.puts.push(input.key)
    const body = typeof input.body === 'string' ? Buffer.from(input.body) : Buffer.from(input.body)
    objects.set(input.key, { body, contentType: input.contentType })
    return { key: input.key, etag: '"x"', size: body.byteLength }
  },
  async head(ref: { key: string }) {
    await Promise.resolve()
    if (world.storageFails === 'head') {
      throw new ObjectStorageError('unavailable', 'storage did not answer')
    }
    calls.heads.push(ref.key)
    const stored = objects.get(ref.key)
    if (!stored) return null
    return {
      key: ref.key,
      size: stored.body.byteLength,
      contentType: stored.contentType,
      lastModified: CUTOFF,
      etag: '"x"',
    }
  },
} as unknown as ObjectStorage

/** The default event stream. Held separately so the heartbeat suite can swap in
 * a slow one and put this back afterwards. */
const streamEventsOf = (input: { month: string }): AsyncIterable<Record<string, unknown>> =>
  (async function* () {
    await Promise.resolve()
    if (world.readFails) throw new ExportReadError('ClickHouse is unreachable', null)
    for (const row of world.events.get(input.month) ?? []) yield row
  })()

const reader: ExportReader = {
  async eventMonths() {
    await Promise.resolve()
    if (world.readFails) throw new ExportReadError('ClickHouse is unreachable', null)
    return world.months
  },
  streamEvents: (input) => streamEventsOf(input),
  streamImported(input) {
    return (async function* () {
      await Promise.resolve()
      for (const row of world.imported.get(input.report) ?? []) yield row
    })()
  },
  async ping() {
    return await Promise.resolve(true)
  },
  async close() {
    await Promise.resolve()
  },
}

const { logger, lines } = createCapturedLogger()

const db = {} as unknown as Database

function job(payload: Record<string, unknown> = { export_run_id: EXPORT }): ClaimedJob {
  return {
    id: 'job-1',
    type: 'export_run',
    subjectId: SITE,
    payload,
    attempts: 1,
  } as unknown as ClaimedJob
}

function context(overrides: Partial<JobExecutorContext> = {}): JobExecutorContext {
  return {
    job: job(),
    db,
    logger,
    metrics: { increment: () => undefined, gauge: () => undefined } as never,
    resources: {
      ...(world.resources === 'no_storage' ? {} : { objectStorage: storage }),
      ...(world.resources === 'no_reader' ? {} : { exportReader: reader }),
      exportPolicy: {
        maxChunkBytes: world.maxChunkBytes,
        objectTtlDays: 7,
        leaseTtlMs: world.leaseTtlMs,
      },
    },
    extendLease: async () => {
      calls.renewals += 1
      return await Promise.resolve(world.leaseHeld)
    },
    updatePhase: async (phase: string) => {
      calls.phases.push(phase)
      return await Promise.resolve(world.leaseHeld)
    },
    ...overrides,
  } as JobExecutorContext
}

const linesOf = (key: string): Record<string, unknown>[] => {
  const stored = objects.get(key)
  if (!stored) throw new Error(`no object at ${key}`)
  return gunzipSync(stored.body)
    .toString('utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

const manifestOf = (): ExportManifest =>
  JSON.parse(objects.get(`${PREFIX}manifest.json`)?.body.toString('utf8') ?? '{}') as ExportManifest

beforeEach(() => {
  world.run = run()
  world.months = []
  world.events = new Map()
  world.imported = new Map()
  world.funnels = []
  world.storageFails = null
  world.readFails = false
  world.leaseHeld = true
  world.maxChunkBytes = 64 * 1024 * 1024
  world.leaseTtlMs = 60_000
  world.resources = 'all'
  calls.puts = []
  calls.heads = []
  calls.recorded = []
  calls.started = []
  calls.completed = []
  calls.failed = []
  calls.phases = []
  calls.retracted = []
  calls.renewals = 0
  objects.clear()
  lines.length = 0
})

describe('the export chunk plan', () => {
  it('writes one object per month, per report and for funnels — manifest last', async () => {
    world.months = ['2026-06', '2026-07']
    world.events.set('2026-06', [{ event_id: 'a', occurred_at: '2026-06-01T00:00:00.000Z' }])
    world.events.set('2026-07', [{ event_id: 'b', occurred_at: '2026-07-01T00:00:00.000Z' }])
    world.imported.set('metrics', [{ date: '2026-01-01', visitors: 5 }])
    world.funnels = [{ id: 'f-1', name: 'Signup' }]

    const outcome = await executeExportRun(context())
    expect(outcome).toBe('succeeded')

    expect(calls.puts).toEqual([
      `${PREFIX}events-2026-06.ndjson.gz`,
      `${PREFIX}events-2026-07.ndjson.gz`,
      ...IMPORTED_REPORTS.map((report) => `${PREFIX}imported-${report}.ndjson.gz`),
      `${PREFIX}funnels.ndjson.gz`,
      // **Last.** Its presence is the completeness signal, so anything written
      // after it would make that signal a lie.
      `${PREFIX}manifest.json`,
    ])

    const manifest = manifestOf()
    // The manifest never lists itself: it is the index, not an entry.
    expect(manifest.chunks.map((chunk) => chunk.key)).not.toContain(`${PREFIX}manifest.json`)
    expect(manifest.totals.chunks).toBe(calls.puts.length - 1)
    expect(manifest.cutoff).toBe(CUTOFF.toISOString())
    expect(manifest.pinned_import_run_id).toBe(IMPORT_RUN)
    // The caveats ship inside the artefact, not only in documentation: the
    // manifest is the part of an export that outlives the download window.
    expect(manifest.number_encoding).toBe('json_number')
    expect(manifest.notes).toEqual(EXPORT_MANIFEST_NOTES)

    expect(calls.completed).toHaveLength(1)
    expect(calls.completed[0]?.manifest.totals.rows).toBe(manifest.totals.rows)
  })

  it('writes an honest empty chunk for a report with no rows', async () => {
    // Including the case the pinned run was cleaned up mid-export: rows are
    // keyed by run id and cleanup deletes exactly those, so a later read is
    // empty and must say so rather than vanish.
    const outcome = await executeExportRun(context())
    expect(outcome).toBe('succeeded')

    for (const report of IMPORTED_REPORTS) {
      expect(linesOf(`${PREFIX}imported-${report}.ndjson.gz`)).toEqual([])
    }
    const manifest = manifestOf()
    expect(manifest.chunks.filter((chunk) => chunk.kind === 'imported')).toHaveLength(
      IMPORTED_REPORTS.length,
    )
    expect(manifest.totals.rows).toBe(0)
  })

  it('exports nothing imported when the site published no import', async () => {
    world.run = run({ pinnedImportRunId: null })
    world.imported.set('metrics', [{ date: '2026-01-01', visitors: 5 }])

    await executeExportRun(context())
    // The pin, not the reader, is what decides: a null pointer is a site with no
    // imported history, and reading whatever is staged would export a run
    // nobody published.
    expect(linesOf(`${PREFIX}imported-metrics.ndjson.gz`)).toEqual([])
    expect(manifestOf().pinned_import_run_id).toBeNull()
  })

  it('records rows, gzipped bytes and a sha256 for every chunk', async () => {
    world.months = ['2026-07']
    world.events.set('2026-07', [{ event_id: 'a' }, { event_id: 'b' }])

    await executeExportRun(context())

    const chunk = manifestOf().chunks.find((entry) => entry.kind === 'events')
    expect(chunk).toBeDefined()
    expect(chunk?.rows).toBe(2)
    // The digest and the size describe the *stored* object, so a downloader can
    // verify what arrived without inflating it.
    expect(chunk?.bytes).toBe(objects.get(chunk?.key ?? '')?.body.byteLength)
    expect(chunk?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(linesOf(chunk?.key ?? '')).toEqual([{ event_id: 'a' }, { event_id: 'b' }])
  })

  it('serializes counts as JSON numbers, not strings', async () => {
    // The decision the manifest declares: one integer encoding across the whole
    // export. The reader asks ClickHouse for unquoted 64-bit integers precisely
    // so the imported counts do not arrive as strings while the event columns
    // arrive as numbers — a consumer should never have to branch per file.
    world.imported.set('metrics', [{ date: '2026-01-01', visitors: 12_345, pageviews: 67_890 }])

    await executeExportRun(context())

    const raw = gunzipSync(
      objects.get(`${PREFIX}imported-metrics.ndjson.gz`)?.body ?? Buffer.alloc(0),
    )
      .toString('utf8')
      .trim()
    expect(raw).toContain('"visitors":12345')
    expect(raw).not.toContain('"visitors":"12345"')
    expect(typeof (linesOf(`${PREFIX}imported-metrics.ndjson.gz`)[0]?.['visitors'] ?? null)).toBe(
      'number',
    )
  })
})

describe('the chunk size cap', () => {
  it('splits a month over the cap into -p2, -p3 parts', async () => {
    world.maxChunkBytes = 200
    world.months = ['2026-07']
    // Each line is ~60 bytes, so three lines cross a 200-byte cap twice.
    world.events.set(
      '2026-07',
      Array.from({ length: 6 }, (_, index) => ({
        event_id: `id-${String(index)}`,
        pad: 'x'.repeat(40),
      })),
    )

    await executeExportRun(context())

    const keys = calls.puts.filter((key) => key.includes('events-2026-07'))
    expect(keys.length).toBeGreaterThan(1)
    // Part one keeps the plain name; only the overflow is suffixed, so a month
    // that later grows does not rename the file that was already there.
    expect(keys[0]).toBe(`${PREFIX}events-2026-07.ndjson.gz`)
    expect(keys[1]).toBe(`${PREFIX}events-2026-07-p2.ndjson.gz`)

    // Nothing is lost or repeated across the split.
    const all = keys.flatMap((key) => linesOf(key))
    expect(all).toHaveLength(6)
    expect(new Set(all.map((row) => row['event_id'])).size).toBe(6)
  })
})

describe('resume', () => {
  it('skips a unit whose objects are all still in the bucket', async () => {
    world.months = ['2026-07']
    world.events.set('2026-07', [{ event_id: 'a' }])

    // First attempt writes everything.
    await executeExportRun(context())
    const firstPuts = [...calls.puts]
    const eventsChunk = calls.recorded.find((chunk) => chunk.kind === 'events')
    expect(eventsChunk).toBeDefined()

    // Second attempt resumes with the recorded progress.
    calls.puts = []
    calls.heads = []
    world.run = run({ state: 'running', progress: { chunks: calls.recorded } })
    calls.recorded = []

    const outcome = await executeExportRun(context())
    expect(outcome).toBe('succeeded')

    // Every chunk was verified present and reused; only the manifest is rewritten.
    expect(calls.heads).toContain(eventsChunk?.key)
    expect(calls.puts).toEqual([`${PREFIX}manifest.json`])
    // ...and the manifest still names the full set.
    expect(manifestOf().totals.chunks).toBe(firstPuts.length - 1)
  })

  it('regenerates a unit whose object the bucket no longer has', async () => {
    world.months = ['2026-07']
    world.events.set('2026-07', [{ event_id: 'a' }])
    await executeExportRun(context())

    const recorded = [...calls.recorded]
    const eventsKey = `${PREFIX}events-2026-07.ndjson.gz`
    // The bucket's seven-day rule reaped it while the run waited. Trusting the
    // recorded row here would produce a manifest naming an object that is gone.
    objects.delete(eventsKey)

    calls.puts = []
    world.run = run({ state: 'running', progress: { chunks: recorded } })
    await executeExportRun(context())

    expect(calls.puts).toContain(eventsKey)
    expect(objects.has(eventsKey)).toBe(true)
  })

  it('regenerates a unit whose recorded size no longer matches the object', async () => {
    world.months = ['2026-07']
    world.events.set('2026-07', [{ event_id: 'a' }])
    await executeExportRun(context())

    const recorded = [...calls.recorded]
    const eventsKey = `${PREFIX}events-2026-07.ndjson.gz`
    // Present but not the object the record describes — a truncated upload, a
    // key reused by a differently-sized part, a provider that returned a stale
    // `head`. Adopting it would put a digest in the manifest that does not match
    // the bytes a customer downloads, which is worse than re-uploading.
    const stored = objects.get(eventsKey)
    if (!stored) throw new Error('setup failed')
    objects.set(eventsKey, {
      body: Buffer.concat([stored.body, Buffer.from('x')]),
      contentType: stored.contentType,
    })

    calls.puts = []
    world.run = run({ state: 'running', progress: { chunks: recorded } })
    await executeExportRun(context())

    expect(calls.puts).toContain(eventsKey)
    expect(objects.get(eventsKey)?.body.byteLength).toBe(stored.body.byteLength)
    expect(
      lines.some(
        (line) =>
          line['msg'] === 'export_run_chunk_regenerating' && line['reason'] === 'size_mismatch',
      ),
    ).toBe(true)
  })

  it('retracts a stale higher part so a later resume cannot adopt it', async () => {
    // Attempt one splits the month into four parts; attempt two — fewer rows,
    // same cap — splits it into three. Without retraction the NEXT resume walks
    // p1..p4, finds a record and a live object for each, and adopts a four-part
    // generation whose last chunk came from a different stream.
    world.maxChunkBytes = 120
    world.months = ['2026-07']
    const wide = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `id-${String(index)}`,
        pad: 'x'.repeat(80),
      }))

    world.events.set('2026-07', wide(4))
    await executeExportRun(context())
    expect(calls.puts.filter((key) => key.includes('events-2026-07'))).toHaveLength(4)

    // Attempt two: the same month, one row shorter, and the first part deleted
    // so the unit regenerates rather than being reused.
    const afterFirst = [...calls.recorded]
    objects.delete(`${PREFIX}events-2026-07.ndjson.gz`)
    world.events.set('2026-07', wide(3))
    world.run = run({ state: 'running', progress: { chunks: afterFirst } })
    calls.puts = []
    calls.recorded = []
    await executeExportRun(context())

    expect(calls.puts.filter((key) => key.includes('events-2026-07'))).toHaveLength(3)
    // p4's record is retracted; its object is deliberately left in the bucket.
    const stalePart = `${PREFIX}events-2026-07-p4.ndjson.gz`
    expect(calls.retracted).toEqual([stalePart])
    expect(objects.has(stalePart)).toBe(true)
    // ...and the manifest names exactly the three that were written.
    expect(manifestOf().chunks.filter((chunk) => chunk.kind === 'events')).toHaveLength(3)

    // The third attempt is the one the retraction exists for: with the stale
    // record gone from `chunks`, the resume enumerates three parts, not four.
    // The progress it resumes from is what the row would really hold — every
    // record ever written for the run, minus the retracted one — so reused units
    // (which record nothing new) are still in it.
    const live = new Map(
      [...afterFirst, ...calls.recorded].map((chunk) => [chunk.key, chunk] as const),
    )
    live.delete(stalePart)
    const afterSecond = [...live.values()]
    world.run = run({ state: 'running', progress: { chunks: afterSecond } })
    calls.puts = []
    await executeExportRun(context())
    expect(calls.puts).toEqual([`${PREFIX}manifest.json`])
    expect(manifestOf().chunks.filter((chunk) => chunk.kind === 'events')).toHaveLength(3)
  })

  it('keeps a retracted key reachable for the deletion enumeration', () => {
    // The retraction must not make the orphan unreachable: the port has no
    // `list`, so a key dropped from `chunks` and recorded nowhere else would
    // survive the customer's deletion until the bucket rule happened to reap it.
    const stalePart = `${PREFIX}events-2026-07-p4.ndjson.gz`
    expect(
      exportObjectKeysOf({
        objectPrefix: PREFIX,
        progress: {
          chunks: [
            {
              key: `${PREFIX}events-2026-07.ndjson.gz`,
              kind: 'events',
              rows: 1,
              bytes: 2,
              sha256: 'a',
            },
          ],
          orphaned_keys: [stalePart],
        },
        manifest: null,
      }),
    ).toEqual([`${PREFIX}manifest.json`, `${PREFIX}events-2026-07.ndjson.gz`, stalePart])
  })
})

describe('the lease heartbeat', () => {
  it('renews on elapsed time inside a single long stream', async () => {
    // A month that streams for longer than `WORKER_LEASE_TTL_MS` while producing
    // ONE chunk touches nothing that would renew at a chunk boundary. Without a
    // wall-clock heartbeat the job is stolen mid-stream and the next worker does
    // exactly the same thing — a unit that can never finish, forever.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-07-29T10:00:00.000Z'))
      world.leaseTtlMs = 30_000
      world.months = ['2026-07']

      // Six rows, ten seconds of wall clock each: a minute of streaming inside
      // one chunk, against a 30 s TTL whose heartbeat fires every 10 s.
      reader.streamEvents = () =>
        (async function* () {
          for (let index = 0; index < 6; index += 1) {
            vi.advanceTimersByTime(10_000)
            await Promise.resolve()
            yield { event_id: `id-${String(index)}` }
          }
        })()

      const before = calls.renewals
      expect(await executeExportRun(context())).toBe('succeeded')

      // One chunk was written, so chunk-boundary renewals alone would be a
      // handful; the heartbeat is what accounts for the rest.
      expect(calls.puts.filter((key) => key.includes('events-2026-07'))).toHaveLength(1)
      expect(calls.renewals - before).toBeGreaterThanOrEqual(6)
    } finally {
      vi.useRealTimers()
      reader.streamEvents = streamEventsOf
    }
  })

  it('renews immediately after the month plan, before the first chunk', async () => {
    // `eventMonths` is a DISTINCT over the site's whole history and it is the
    // first thing the job does; the lease it inherited was stamped at claim time
    // and spent on the page's earlier jobs. Beginning the first chunk on an
    // expired lease means two workers writing the same objects.
    world.leaseHeld = false
    world.months = ['2026-07']
    world.events.set('2026-07', [{ event_id: 'a' }])

    expect(await executeExportRun(context())).toMatchObject({ retry: { counts: true } })
    // Refused before a single object was written.
    expect(calls.puts).toHaveLength(0)
  })
})

describe('failure handling', () => {
  it('asks for a counting retry when storage is unavailable', async () => {
    world.months = ['2026-07']
    world.events.set('2026-07', [{ event_id: 'a' }])
    world.storageFails = 'put'

    const outcome = (await executeExportRun(context())) as Exclude<JobOutcome, string>
    expect(outcome).toMatchObject({ retry: { counts: true } })
    // The run is left exactly where it is: an outage is not a customer's export
    // being impossible.
    expect(calls.failed).toHaveLength(0)
  })

  it('asks for a counting retry when ClickHouse is unreachable', async () => {
    world.readFails = true
    const outcome = (await executeExportRun(context())) as Exclude<JobOutcome, string>
    expect(outcome).toMatchObject({ retry: { counts: true } })
    expect(calls.failed).toHaveLength(0)
  })

  it('asks for a counting retry when the bucket or the reader is not configured', async () => {
    world.resources = 'no_storage'
    expect(await executeExportRun(context())).toMatchObject({ retry: { counts: true } })
    world.resources = 'no_reader'
    expect(await executeExportRun(context())).toMatchObject({ retry: { counts: true } })
    // Counting is what makes a missing credential reach `failed_terminal` and
    // release the site's export slot, rather than polling forever.
  })

  it('stops when the lease has been stolen', async () => {
    world.months = ['2026-07']
    world.events.set('2026-07', [{ event_id: 'a' }])
    world.leaseHeld = false

    const outcome = await executeExportRun(context())
    expect(outcome).toMatchObject({ retry: { counts: true } })
    expect(calls.completed).toHaveLength(0)
  })

  it('is a no-op for a settled or absent run', async () => {
    world.run = run({ state: 'succeeded' })
    expect(await executeExportRun(context())).toBe('succeeded')
    expect(calls.puts).toHaveLength(0)

    world.run = null
    expect(await executeExportRun(context())).toBe('succeeded')
    expect(calls.puts).toHaveLength(0)
  })

  it('is terminal for a payload nothing can act on', async () => {
    const outcome = await executeExportRun(context({ job: job({}) }))
    expect(outcome).toMatchObject({ terminal: {} })
  })

  it('fails the run from onTerminal so the site can export again', async () => {
    // Without this, a job that exhausted its attempts leaves the run `running` —
    // and while an `export_run` job is live for the site, no second export can
    // be enqueued. The customer would be locked out with nothing polling.
    await EXPORT_RUN_REGISTRATION.onTerminal?.(job(), 'attempts exhausted', {
      db,
      logger,
      metrics: { increment: () => undefined, gauge: () => undefined } as never,
    })
    expect(calls.failed).toEqual([{ exportRunId: EXPORT, errorCode: 'export_abandoned' }])
  })
})

describe('the export vocabulary', () => {
  it('enumerates every key a deletion must reach, finished or not', async () => {
    // The port has no `list`: a key this misses is a key nothing can address
    // again. The manifest key is *derived* rather than recorded, so it is
    // covered even for an export that crashed before writing one.
    const chunks: ExportChunkRecord[] = [
      { key: `${PREFIX}events-2026-07.ndjson.gz`, kind: 'events', rows: 1, bytes: 2, sha256: 'a' },
    ]
    expect(
      exportObjectKeysOf({ objectPrefix: PREFIX, progress: { chunks }, manifest: null }),
    ).toEqual([`${PREFIX}manifest.json`, `${PREFIX}events-2026-07.ndjson.gz`])

    // An export that never started still names its manifest key, which a delete
    // treats as a no-op and the phase's `head() === null` verifies trivially.
    expect(exportObjectKeysOf({ objectPrefix: PREFIX, progress: null, manifest: null })).toEqual([
      `${PREFIX}manifest.json`,
    ])
    await Promise.resolve()
  })

  it('maps expired to a succeeded operation', () => {
    expect(exportRunStatusFor('queued')).toBe('queued')
    expect(exportRunStatusFor('running', 'failed_retryable')).toBe('failed_retryable')
    expect(exportRunStatusFor('succeeded')).toBe('succeeded')
    expect(exportRunStatusFor('failed')).toBe('failed_terminal')
    // The work succeeded; the artefact's life ran out. `phase` carries that.
    expect(exportRunStatusFor('expired')).toBe('succeeded')
  })
})
