import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createClient } from '@clickhouse/client'
import {
  EXPORT_EVENT_COLUMNS,
  createExportReader,
  createImportedAggregatesWriter,
  migrateClickHouse,
  toStoredImportedRow,
  type ExportReader,
  type ImportedAggregatesWriter,
} from '@openanalytics/clickhouse'
import type { ImportedReport, ImportedRow } from '@openanalytics/domain'
import { createCapturedLogger } from '@openanalytics/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The export read path against a live ClickHouse (ADR-0032, D8).
 *
 * This is where plan-04's M11 acceptance criterion **"export returns no other
 * site's data"** is proven, and it can only be proven here: a unit test can show
 * that `site_id` is a bound parameter, and only a real server can show that the
 * statement carrying it returns nothing of the site beside it. The suite stages
 * two sites' events *and* two runs' imported rows on purpose — the fixture is
 * built so that a missing filter anywhere produces a visible extra row rather
 * than a subtly wrong count.
 *
 * Three more things are provable only against a real server:
 *
 * 1. **The cutoff excludes what it should.** `accepted_at` is the axis, not
 *    `occurred_at`: an event that *happened* inside the exported month but was
 *    *accepted* after the export was requested must not appear, which is what
 *    makes every chunk of one export cover the same event set.
 * 2. **The month plan is the partition expression.** `toYYYYMM(occurred_at)`
 *    decides both the file names and the pruning, and ClickHouse is the authority
 *    on what it returns.
 * 3. **The NDJSON number and instant encodings.** `output_format_json_quote_64bit_integers = 0`
 *    and `date_time_output_format = 'iso'` are settings whose effect exists only
 *    on the wire — a fake reader would happily "pass" either way, and they decide
 *    the format of every file a customer receives.
 *
 * Skipped without TEST_CLICKHOUSE_URL; CI always provides one.
 */

const URL_ = process.env['TEST_CLICKHOUSE_URL']
const USERNAME = process.env['TEST_CLICKHOUSE_USER'] ?? 'default'
const PASSWORD = process.env['TEST_CLICKHOUSE_PASSWORD'] ?? ''

const describeIfClickHouse = URL_ ? describe : describe.skip

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../packages/clickhouse/migrations/', import.meta.url),
)

/** The export's pin. Everything accepted after it is outside the export. */
const CUTOFF = new Date('2026-07-20T12:00:00.000Z')

describeIfClickHouse('the export read path', () => {
  const url = URL_ as string
  const database = `m11exp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  const siteA = randomUUID()
  const siteB = randomUUID()
  const runA = randomUUID()
  const runB = randomUUID()
  let client: ReturnType<typeof createClient>
  let writer: ImportedAggregatesWriter
  let reader: ExportReader

  /**
   * A live page view in the shape `events_raw` declares.
   *
   * The same helper `query-gateway-rollups.test.ts` uses, defaults and all.
   * **`event_id` and `site_id` are `UUID` columns**, and a non-UUID value there
   * does not fail as a type error: ClickHouse's UUID reader consumes 36
   * characters of whatever follows and then complains about the byte it stopped
   * on, so a past CI failure over a literal `'e-0'` read like corrupted JSON
   * framing and sent somebody looking for a serialization bug that was not there.
   */
  const insertRaw = async (
    token: string,
    rows: readonly {
      site_id: string
      occurred_at: string
      accepted_at: string
      page_path?: string
    }[],
  ): Promise<void> => {
    await client.insert({
      table: 'events_raw',
      values: rows.map((row) => ({
        schema_version: 1,
        event_id: randomUUID(),
        batch_id: 'b-1',
        type: 'page_view',
        name: '',
        origin: 'live',
        received_at: row.accepted_at,
        clock_skewed: 0,
        ingest_generation: 3,
        billing_user_id: randomUUID(),
        billing_assignment_version: 1,
        usage_window_start: '2026-07-01 00:00:00.000',
        billing_grace: 0,
        billable: 1,
        anonymous_id: 'v-1',
        session_id: 's-1',
        user_id: '',
        page_url: 'https://shop.example.com/pricing',
        page_path: '/pricing',
        page_title: 'Pricing',
        referrer_domain: '',
        referrer_path: '',
        utm_source: '',
        utm_medium: '',
        utm_campaign: '',
        utm_content: '',
        utm_term: '',
        properties: '{"plan":"pro"}',
        sdk: 'web',
        sdk_version: '1.0.0',
        device_type: 'desktop',
        browser: 'chrome',
        os: 'windows',
        country: 'DE',
        city: 'Berlin',
        ...row,
      })),
      format: 'JSONEachRow',
      clickhouse_settings: { insert_deduplication_token: token },
    })
  }

  const stage = async (
    report: ImportedReport,
    siteId: string,
    importRunId: string,
    rows: readonly ImportedRow[],
  ): Promise<void> => {
    await writer.insertRows({
      report,
      rows: rows.map((row) =>
        toStoredImportedRow(report, { site_id: siteId, import_run_id: importRunId }, row),
      ),
      insertDeduplicationToken: `${importRunId}:${report}:0`,
    })
  }

  const collect = async (iterable: AsyncIterable<Record<string, unknown>>) => {
    const rows: Record<string, unknown>[] = []
    for await (const row of iterable) rows.push(row)
    return rows
  }

  beforeAll(async () => {
    const { logger } = createCapturedLogger()
    await migrateClickHouse({
      url,
      username: USERNAME,
      password: PASSWORD,
      database,
      directory: MIGRATIONS_DIR,
      logger,
    })
    client = createClient({ url, username: USERNAME, password: PASSWORD, database })
    writer = createImportedAggregatesWriter({
      url,
      username: USERNAME,
      password: PASSWORD,
      database,
    })
    reader = createExportReader({ url, username: USERNAME, password: PASSWORD, database })

    await insertRaw('export-a', [
      // Two months, so the month plan has something to split on.
      {
        site_id: siteA,
        occurred_at: '2026-06-15 10:00:00.000',
        accepted_at: '2026-06-15 10:00:01.000',
        page_path: '/a-june',
      },
      {
        site_id: siteA,
        occurred_at: '2026-07-10 10:00:00.000',
        accepted_at: '2026-07-10 10:00:01.000',
        page_path: '/a-july',
      },
      // Accepted AFTER the cutoff while occurring inside an exported month —
      // the row the pin exists to exclude.
      {
        site_id: siteA,
        occurred_at: '2026-07-11 10:00:00.000',
        accepted_at: '2026-07-25 09:00:00.000',
        page_path: '/a-late',
      },
    ])
    await insertRaw('export-b', [
      // Site B, in the same months and inside the same cutoff. If any statement
      // loses its site filter, these appear.
      {
        site_id: siteB,
        occurred_at: '2026-06-15 11:00:00.000',
        accepted_at: '2026-06-15 11:00:01.000',
        page_path: '/b-june',
      },
      {
        site_id: siteB,
        occurred_at: '2026-07-10 11:00:00.000',
        accepted_at: '2026-07-10 11:00:01.000',
        page_path: '/b-july',
      },
    ])

    await stage('metrics', siteA, runA, [
      {
        date: '2026-01-10',
        visitors: 10,
        visits: 12,
        pageviews: 25,
        bounces: 4,
        visitDuration: 600,
      },
    ])
    // A second run of the SAME site: the pin is a generation, so an export that
    // bound only the site would pull an unpublished import into the customer's
    // files.
    await stage('metrics', siteA, runB, [
      {
        date: '2026-02-10',
        visitors: 999,
        visits: 999,
        pageviews: 999,
        bounces: 99,
        visitDuration: 999,
      },
    ])
    // ...and the same run id against a different site, which cannot happen in
    // production and is staged here precisely so the site filter is load-bearing
    // in the assertion below rather than incidentally satisfied by the run.
    await stage('metrics', siteB, runA, [
      {
        date: '2026-01-10',
        visitors: 5,
        visits: 5,
        pageviews: 5,
        bounces: 1,
        visitDuration: 100,
      },
    ])
    await stage('pages', siteA, runA, [
      {
        date: '2026-01-10',
        hostname: 'shop.example.com',
        page: '/pricing',
        visitors: 6,
        visits: 7,
        pageviews: 12,
      },
    ])
  }, 180_000)

  afterAll(async () => {
    await reader?.close()
    await writer?.close()
    await client?.command({ query: `DROP DATABASE IF EXISTS ${database}` })
    await client?.close()
  })

  it('export returns no other site data', async () => {
    // **The plan-04 M11 acceptance criterion.** Every statement the export
    // issues is run here against a fixture where site B has rows in the same
    // months, inside the same cutoff, under the same import run id — so a
    // missing filter anywhere shows up as an extra row rather than as a subtly
    // different number.
    const months = await reader.eventMonths({ siteId: siteA, cutoff: CUTOFF })
    expect(months).toEqual(['2026-06', '2026-07'])

    const events = [
      ...(await collect(reader.streamEvents({ siteId: siteA, cutoff: CUTOFF, month: '2026-06' }))),
      ...(await collect(reader.streamEvents({ siteId: siteA, cutoff: CUTOFF, month: '2026-07' }))),
    ]
    expect(events.map((row) => row['page_path'])).toEqual(['/a-june', '/a-july'])
    // Stated as an invariant rather than only as an expected list: what must
    // never appear is *any* row of another site.
    expect(events.every((row) => row['site_id'] === siteA)).toBe(true)
    expect(events.some((row) => row['site_id'] === siteB)).toBe(false)

    const imported = await collect(
      reader.streamImported({ siteId: siteA, importRunId: runA, report: 'metrics' }),
    )
    expect(imported).toHaveLength(1)
    expect(imported[0]).toMatchObject({ site_id: siteA, import_run_id: runA, visitors: 10 })
    // Neither the other site's rows under the same run, nor the same site's
    // rows under an unpublished run.
    expect(imported.some((row) => row['site_id'] === siteB)).toBe(false)
    expect(imported.some((row) => row['import_run_id'] === runB)).toBe(false)
  })

  it('excludes an event accepted after the cutoff', async () => {
    // `/a-late` occurred on 2026-07-11 — inside an exported month — and was
    // accepted five days after the export was requested. Without the pin it
    // would appear in a chunk regenerated on a retry and be absent from the one
    // written on the first attempt.
    const july = await collect(
      reader.streamEvents({ siteId: siteA, cutoff: CUTOFF, month: '2026-07' }),
    )
    expect(july.map((row) => row['page_path'])).toEqual(['/a-july'])

    // Move the cutoff past it and it is there, which is what shows the exclusion
    // was the cutoff rather than a missing row.
    const later = await collect(
      reader.streamEvents({
        siteId: siteA,
        cutoff: new Date('2026-07-26T00:00:00.000Z'),
        month: '2026-07',
      }),
    )
    expect(later.map((row) => row['page_path'])).toEqual(['/a-july', '/a-late'])
    // The month plan moves with it too — the plan and the chunks are bound by
    // the same instant.
    expect(
      await reader.eventMonths({ siteId: siteA, cutoff: new Date('2026-06-30T00:00:00.000Z') }),
    ).toEqual(['2026-06'])
  })

  it('carries the contract columns and none of the pipeline internals', async () => {
    const [row] = await collect(
      reader.streamEvents({ siteId: siteA, cutoff: CUTOFF, month: '2026-06' }),
    )
    expect(Object.keys(row ?? {}).sort()).toEqual([...EXPORT_EVENT_COLUMNS].sort())
    for (const internal of [
      'batch_id',
      'ingest_generation',
      'billing_user_id',
      'billing_assignment_version',
      'usage_window_start',
      'billing_grace',
      'billable',
    ]) {
      expect(row).not.toHaveProperty(internal)
    }
    // The stored properties JSON, exported verbatim as text rather than
    // re-parsed: the bytes are what the pipeline accepted.
    expect(row?.['properties']).toBe('{"plan":"pro"}')
  })

  it('serializes counts as JSON numbers and instants as ISO-8601 UTC', async () => {
    // The decision the manifest declares, asserted where it actually happens.
    // `visitors` is `UInt64`, which ClickHouse quotes as a *string* by default —
    // the export would then have string counts in the imported files and number
    // counts nowhere else, and a consumer would have to branch per file.
    const [imported] = await collect(
      reader.streamImported({ siteId: siteA, importRunId: runA, report: 'metrics' }),
    )
    expect(typeof imported?.['visitors']).toBe('number')
    expect(imported?.['visitors']).toBe(10)
    expect(typeof imported?.['pageviews']).toBe('number')
    // A calendar day stays a calendar day.
    expect(imported?.['date']).toBe('2026-01-10')

    const [event] = await collect(
      reader.streamEvents({ siteId: siteA, cutoff: CUTOFF, month: '2026-06' }),
    )
    // Zone-stated rather than zone-documented: the default format is a bare
    // `2026-06-15 10:00:00.000` that somebody will parse in their own zone.
    expect(event?.['occurred_at']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
    expect(new Date(String(event?.['occurred_at'])).toISOString()).toBe('2026-06-15T10:00:00.000Z')
    // `schema_version` is UInt16 and was always a number; asserted so a future
    // change of the quoting setting cannot pass unnoticed.
    expect(typeof event?.['schema_version']).toBe('number')
  })

  it('answers an empty stream for a report the run never staged', async () => {
    // The honest-empty-chunk case, at the source: an export writes the file
    // anyway, because "this report was empty" and "this report was not exported"
    // are different statements.
    expect(
      await collect(
        reader.streamImported({ siteId: siteA, importRunId: runA, report: 'browsers' }),
      ),
    ).toEqual([])
    expect(
      await collect(
        reader.streamImported({ siteId: siteA, importRunId: randomUUID(), report: 'metrics' }),
      ),
    ).toEqual([])
  })

  it('carries every imported dimension, including the ones the read path drops', async () => {
    // The export is lossless where the dashboard is not: `hostname` has no live
    // counterpart the breakdown can merge with, so the read path never shows it —
    // and a customer migrating away should still get it back.
    const [page] = await collect(
      reader.streamImported({ siteId: siteA, importRunId: runA, report: 'pages' }),
    )
    expect(page).toMatchObject({ hostname: 'shop.example.com', page: '/pricing', visitors: 6 })
  })
})
