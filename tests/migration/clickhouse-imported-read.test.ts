import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createClient } from '@clickhouse/client'
import {
  createImportedAggregatesWriter,
  migrateClickHouse,
  toStoredImportedRow,
  type ImportedAggregatesWriter,
} from '@openanalytics/clickhouse'
import { type ImportPointer, type ImportedReport, type ImportedRow } from '@openanalytics/domain'
import { createCapturedLogger } from '@openanalytics/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { operationParamsFor } from '../../apps/api/src/analytics/resolve.ts'
import { createHttpClickHouseReader } from '../../apps/query-gateway/src/clickhouse-http.ts'
import { findOperation } from '../../apps/query-gateway/src/operations.ts'
import type { QueryParameterValue } from '../../apps/query-gateway/src/clickhouse.ts'

/**
 * The imported read path against a live ClickHouse (ADR-0032, D2b/D4).
 *
 * The golden suite pins the SQL text; only a real server can say whether that
 * text *runs* and what it answers. Four things are provable only here:
 *
 * 1. **The UNION type-checks and the two branches line up.** The live side reads
 *    a `uniqMerge` state and the imported side a plain `sum` of UInt64; ClickHouse
 *    is the authority on whether those meet in one column, and on whether the two
 *    bucket expressions produce the same label for the same day.
 * 2. **The cutover partitions rather than overlaps.** Live rows before the
 *    boundary and imported rows at or after it both exist in the fixture, and
 *    neither may appear.
 * 3. **The nil run really is empty.** The whole byte-identical claim for
 *    live-only sites rests on the imported branch matching nothing when the api
 *    binds `NIL_IMPORT_RUN_ID`, and this is what shows the two statements return
 *    the same rows.
 * 4. **`toDateTime(date, tz)` places a provider day where the test thinks it
 *    does.** The seam arithmetic is a ClickHouse semantic, not a TypeScript one.
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

/** The site's import stops here: everything before is the provider's. */
const CUTOVER = '2024-02-01'

describeIfClickHouse('the imported read path', () => {
  const url = URL_ as string
  const database = `m11read_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  const site = randomUUID()
  const run = randomUUID()
  const otherRun = randomUUID()
  let client: ReturnType<typeof createClient>
  let writer: ImportedAggregatesWriter

  const reader = createHttpClickHouseReader({
    url,
    database,
    username: USERNAME,
    password: PASSWORD,
  })

  /**
   * Runs an operation exactly as the route does: resolve its parameters from the
   * site's import pointer and the request zone, bind, then read.
   *
   * The parameters come from `operationParamsFor` — the api's own helper — rather
   * than from a per-call literal, and that is load-bearing rather than tidy.
   * Every operation's schema is a `strictObject`, and the set that takes a zone is
   * **not** the set that reads the import: the UTC-bucketed charts read a
   * published run and take no zone at all. A spread-in `timezone: 'UTC'` would be
   * rejected by `timeseries_day_utc` exactly as loudly as a missing cutover, and
   * a test that hand-rolled the pair would be asserting against a request shape
   * production never sends.
   */
  const run_ = async (
    operationId: string,
    input: Record<string, unknown>,
    scope: { pointer: ImportPointer | null; timezone: string },
  ): Promise<Record<string, unknown>[]> => {
    const operation = findOperation(operationId)
    if (!operation) throw new Error(`no such operation ${operationId}`)
    const parameters = {
      ...operationParamsFor(operationId, scope.pointer, scope.timezone),
      ...input,
    }
    const result = await reader.query({
      sql: operation.sql,
      parameters: operation.bindParams(parameters) as Record<string, QueryParameterValue>,
      signal: new AbortController().signal,
      queryId: randomUUID(),
      settings: { max_execution_time: 20, max_result_rows: 100_000, result_overflow_mode: 'throw' },
    })
    return [...result.rows]
  }

  /**
   * A live page view, in the shape `events_raw` actually declares.
   *
   * Deliberately the same helper `query-gateway-rollups.test.ts` uses, defaults
   * and all, rather than a second serializer written from memory. **`event_id`
   * and `site_id` are `UUID` columns**, and a non-UUID value there does not fail
   * as a type error: ClickHouse's UUID reader consumes 36 characters of whatever
   * follows and then complains about the byte it stopped on, so the error reads
   * like corrupted JSON framing (`expected '"' before: 'ge_view","name":…'`) and
   * sends you looking for a serialization bug that is not there.
   *
   * Every dimension is in the live classifier's own vocabulary (`desktop`,
   * `chrome`, `windows`), because the whole point of the merged reads is that the
   * two sides speak the same one.
   */
  const insertRaw = async (
    token: string,
    rows: readonly { occurred_at: string; anonymous_id: string }[],
  ): Promise<void> => {
    await client.insert({
      table: 'events_raw',
      values: rows.map((row) => ({
        schema_version: 1,
        site_id: site,
        event_id: randomUUID(),
        batch_id: 'b-1',
        type: 'page_view',
        name: '',
        billable: 1,
        user_id: '',
        page_path: '/live',
        referrer_domain: '',
        utm_source: '',
        utm_medium: '',
        utm_campaign: '',
        country: 'DE',
        city: 'Berlin',
        device_type: 'desktop',
        browser: 'chrome',
        os: 'windows',
        properties: '{}',
        ...row,
      })),
      format: 'JSONEachRow',
      clickhouse_settings: { insert_deduplication_token: token },
    })
  }

  const stage = async <R extends ImportedReport>(
    report: R,
    importRunId: string,
    rows: readonly ImportedRow<R>[],
  ): Promise<void> => {
    await writer.insertRows({
      report,
      rows: rows.map((row) =>
        toStoredImportedRow(report, { site_id: site, import_run_id: importRunId }, row),
      ),
      insertDeduplicationToken: `${importRunId}:${report}:${randomUUID()}`,
    })
  }

  const num = (value: unknown): number => Number(value ?? 0)

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

    // Live traffic around the cutover day. Two of these four exist to be
    // *excluded*, each by a different half of the partition:
    //
    //   * `2024-01-31 10:00` is a whole day before the cutover — the overlap a
    //     customer creates by publishing with a cutover of `first live day + 1`;
    //   * `2024-02-01 02:00` is on the cutover day but **before** it starts for a
    //     viewer west of UTC. It is the discriminator for the zone the boundary is
    //     rendered in: at a UTC boundary it counts, at New York's it does not.
    await insertRaw(`${site}:raw`, [
      { occurred_at: '2024-01-31 10:00:00.000', anonymous_id: 'v-old' },
      { occurred_at: '2024-02-01 02:00:00.000', anonymous_id: 'v-1' },
      { occurred_at: '2024-02-01 10:00:00.000', anonymous_id: 'v-1' },
      { occurred_at: '2024-02-01 11:00:00.000', anonymous_id: 'v-1' },
      { occurred_at: '2024-02-02 10:00:00.000', anonymous_id: 'v-2' },
    ])

    // The published run: two days before the cutover, and one row *on* it that
    // the imported branch must refuse.
    await stage('metrics', run, [
      {
        date: '2024-01-10',
        visitors: 10,
        visits: 12,
        pageviews: 25,
        bounces: 4,
        visitDuration: 600,
      },
      { date: '2024-01-11', visitors: 7, visits: 8, pageviews: 15, bounces: 3, visitDuration: 400 },
      {
        date: '2024-02-01',
        visitors: 99,
        visits: 99,
        pageviews: 99,
        bounces: 9,
        visitDuration: 900,
      },
    ])
    await stage('pages', run, [
      {
        date: '2024-01-10',
        hostname: 'shop.example.com',
        page: '/pricing',
        visitors: 6,
        visits: 7,
        pageviews: 12,
      },
      {
        date: '2024-01-11',
        hostname: 'docs.example.com',
        page: '/pricing',
        visitors: 3,
        visits: 3,
        pageviews: 5,
      },
      {
        date: '2024-01-11',
        hostname: 'shop.example.com',
        page: '/live',
        visitors: 2,
        visits: 2,
        pageviews: 4,
      },
    ])
    await stage('geography', run, [
      {
        date: '2024-01-10',
        country: 'DE',
        region: 'DE-BE',
        visitors: 5,
        visits: 6,
        pageviews: 9,
        bounces: 2,
        visitDuration: 240,
      },
      {
        date: '2024-01-11',
        country: 'GB',
        region: 'GB-ENG',
        visitors: 4,
        visits: 4,
        pageviews: 6,
        bounces: 1,
        visitDuration: 190,
      },
    ])
    await stage('custom_events', run, [
      { date: '2024-01-10', name: 'Signup', linkUrl: '', path: '', visitors: 3, events: 4 },
    ])

    // A second run of the same site — a superseded generation the cleanup has not
    // reached yet. The pointer names `run`, so none of this may be visible.
    await stage('metrics', otherRun, [
      {
        date: '2024-01-10',
        visitors: 1000,
        visits: 1000,
        pageviews: 1000,
        bounces: 0,
        visitDuration: 0,
      },
    ])
  }, 180_000)

  afterAll(async () => {
    await writer?.close()
    await client?.command({ query: `DROP DATABASE IF EXISTS ${database}` })
    await client?.close()
  })

  /** The site as it is: this run published, read by a UTC viewer. */
  const published = { pointer: { runId: run, cutoverDate: CUTOVER }, timezone: 'UTC' }
  /** The same site as a caller with no published import sees it — the nil run and
   * the epoch cutover, which is what makes every imported branch empty and every
   * live branch unrestricted. */
  const none = { pointer: null, timezone: 'UTC' }

  describe('the UTC day chart', () => {
    const range = { from: '2024-01-01T00:00:00.000Z', to: '2024-03-01T00:00:00.000Z' }

    it('returns provider days and live days in one ordered series with no overlap', async () => {
      const rows = await run_(
        'analytics.timeseries_day_utc',
        {
          site_id: site,
          ...range,
        },
        published,
      )
      const series = rows.map((row) => [String(row['bucket']), num(row['pageviews'])])
      expect(series).toEqual([
        // The provider's own daily numbers, before the cutover.
        ['2024-01-10 00:00:00', 25],
        ['2024-01-11 00:00:00', 15],
        // Live from the cutover on. `2024-01-31` is live but before the boundary
        // and the imported `2024-02-01` row is at it — neither appears. Three
        // page views on 2024-02-01: for a UTC viewer the 02:00 one is after the
        // boundary and counts.
        ['2024-02-01 00:00:00', 3],
        ['2024-02-02 00:00:00', 1],
      ])
      // No milliseconds suffix: the union kept the live branch's DateTime type,
      // which is what makes a live-only site's bytes unchanged.
      expect(String(rows[0]?.['bucket'])).not.toContain('.')
    })

    it('reads the published run only, never a superseded generation', async () => {
      const rows = await run_(
        'analytics.timeseries_day_utc',
        {
          site_id: site,
          ...range,
        },
        published,
      )
      // The other run staged 1000 pageviews on a day this range covers.
      expect(rows.map((row) => num(row['pageviews']))).not.toContain(1000)
    })

    it('answers exactly the live-only series when the api binds the nil run', async () => {
      const rows = await run_('analytics.timeseries_day_utc', { site_id: site, ...range }, none)
      expect(rows.map((row) => [String(row['bucket']), num(row['pageviews'])])).toEqual([
        // Including 2024-01-31, because with no import there is no cutover to
        // partition on — the epoch sentinel restricts nothing.
        ['2024-01-31 00:00:00', 1],
        ['2024-02-01 00:00:00', 3],
        ['2024-02-02 00:00:00', 1],
      ])
    })

    it('sums imported visitors and merges live ones in the same column', async () => {
      const rows = await run_(
        'analytics.timeseries_day_utc',
        {
          site_id: site,
          ...range,
        },
        published,
      )
      const byBucket = new Map(rows.map((row) => [String(row['bucket']), num(row['visitors'])]))
      // Provider's own count for its day.
      expect(byBucket.get('2024-01-10 00:00:00')).toBe(10)
      // The live day had two events from one visitor: `uniqMerge`, not a sum.
      expect(byBucket.get('2024-02-01 00:00:00')).toBe(1)
    })
  })

  describe('the timezone-local day chart', () => {
    it('places a provider day at that day’s local midnight', async () => {
      // Istanbul is +03:00 all year. 2024-01-10 local starts at 2024-01-09 21:00Z,
      // and the label is that instant rendered as UTC — the CP1 rule every
      // timezone-local bucket obeys.
      const rows = await run_(
        'analytics.timeseries_day',
        { site_id: site, from: '2024-01-01T00:00:00.000Z', to: '2024-03-01T00:00:00.000Z' },
        { pointer: { runId: run, cutoverDate: CUTOVER }, timezone: 'Europe/Istanbul' },
      )
      const buckets = rows.map((row) => String(row['bucket']))
      expect(buckets).toContain('2024-01-09 21:00:00.000')
      expect(buckets).toContain('2024-01-10 21:00:00.000')
    })
  })

  describe('the ISO week chart', () => {
    it('groups provider days onto their Monday', async () => {
      // 2024-01-10 and 2024-01-11 are both in the week beginning Monday
      // 2024-01-08, so the two provider days become one bucket of 40 pageviews.
      const rows = await run_(
        'analytics.timeseries_week_utc',
        {
          site_id: site,
          from: '2024-01-01T00:00:00.000Z',
          to: '2024-02-01T00:00:00.000Z',
        },
        published,
      )
      const week = rows.find((row) => String(row['bucket']).startsWith('2024-01-08'))
      expect(num(week?.['pageviews'])).toBe(40)
      // Summed, because there is no state to merge — which is exactly why D5
      // refuses to call a week over imported days `provider_defined`.
      expect(num(week?.['visitors'])).toBe(17)
    })
  })

  describe('range totals', () => {
    it('adds both sides and counts only live events as billable', async () => {
      const rows = await run_(
        'analytics.overview_day',
        {
          site_id: site,
          from: '2024-01-01T00:00:00.000Z',
          to: '2024-03-01T00:00:00.000Z',
        },
        published,
      )
      const row = rows[0] as Record<string, unknown>
      expect(num(row['pageviews'])).toBe(25 + 15 + 4)
      // Import data is not billable (D10): only the four live post-cutover
      // events count, never the provider's forty.
      expect(num(row['billable_events'])).toBe(4)
    })
  })

  describe('a western viewer sees one consistent window', () => {
    /**
     * The defect this pins, and it is the one nobody reports as a bug.
     *
     * The chart placed a provider day at *local* midnight while the range totals
     * and the breakdowns placed it at UTC midnight, and the api classified ranges
     * against a third boundary again. For a viewer four hours west of UTC those
     * are different windows, so a KPI card stopped equalling the sum of the chart
     * beneath it and a range the api called fully imported could still contain
     * live rows.
     *
     * Every case below is built so the two placements give **different numbers**
     * rather than merely agreeing by luck: each asserts a value that is only
     * reachable when the provider day and the cutover are both rendered in the
     * request's zone.
     */
    const NY = 'America/New_York'
    const nyPublished = { pointer: { runId: run, cutoverDate: CUTOVER }, timezone: NY }

    /**
     * Exactly the local day 2024-01-10 in New York.
     *
     * The discriminator: the provider's `2024-01-10` row sits at 05:00Z under
     * zoned placement — inside — and at 00:00Z under UTC placement, which is
     * before `from` and therefore *outside*, while the `2024-01-11` row moves the
     * opposite way. A surface reading UTC placement answers 15 pageviews here
     * instead of 25, with no error anywhere.
     */
    const localJan10 = {
      from: '2024-01-10T05:00:00.000Z',
      to: '2024-01-11T05:00:00.000Z',
      timezone: NY,
    }

    it('the day chart, the KPI total and the breakdown answer the same day', async () => {
      const chart = await run_(
        'analytics.timeseries_day',
        {
          site_id: site,
          ...localJan10,
        },
        nyPublished,
      )
      const totals = await run_(
        'analytics.overview_hour',
        {
          site_id: site,
          ...localJan10,
        },
        nyPublished,
      )
      const pages = await run_(
        'analytics.imported_pages',
        {
          site_id: site,
          ...localJan10,
          limit: 50,
        },
        nyPublished,
      )

      // One provider day, and it is the one the viewer asked for.
      expect(chart.map((row) => [String(row['bucket']), num(row['pageviews'])])).toEqual([
        ['2024-01-10 05:00:00.000', 25],
      ])
      expect(num(totals[0]?.['pageviews'])).toBe(25)
      expect(num(totals[0]?.['visitors'])).toBe(10)
      // The pages report of that same day: `/pricing` on one hostname, and not
      // the following day's rows.
      expect(pages.map((row) => [String(row['page_path']), num(row['views'])])).toEqual([
        ['/pricing', 12],
      ])
    })

    it('the live branch opens at the cutover rendered in the same zone', async () => {
      // The cutover day plus the next, in UTC terms, so the window contains both
      // the 02:00Z and the 10:00Z live events of 2024-02-01. New York's cutover
      // starts at 05:00Z: the 02:00Z event is before it and must not be counted,
      // which is exactly what a UTC-rendered boundary would get wrong.
      const acrossTheCutover = {
        from: '2024-02-01T00:00:00.000Z',
        to: '2024-02-03T00:00:00.000Z',
        timezone: NY,
      }
      const chart = await run_(
        'analytics.timeseries_day',
        {
          site_id: site,
          ...acrossTheCutover,
        },
        nyPublished,
      )
      const totals = await run_(
        'analytics.overview_hour',
        {
          site_id: site,
          ...acrossTheCutover,
        },
        nyPublished,
      )

      // Three of the four live page views in the window, never four.
      expect(chart.map((row) => [String(row['bucket']), num(row['pageviews'])])).toEqual([
        ['2024-02-01 05:00:00.000', 2],
        ['2024-02-02 05:00:00.000', 1],
      ])
      expect(num(totals[0]?.['pageviews'])).toBe(3)
      // And no imported row leaks past its own side of the boundary: the staged
      // `2024-02-01` row is refused by `date < cutover`.
      expect(chart.map((row) => num(row['pageviews']))).not.toContain(99)
    })
  })

  describe('the imported-only breakdowns', () => {
    const range = { from: '2024-01-01T00:00:00.000Z', to: '2024-02-01T00:00:00.000Z' }

    it('sums pages across hostnames and returns the live report’s columns', async () => {
      const rows = await run_(
        'analytics.imported_pages',
        {
          site_id: site,
          ...range,
          limit: 10,
        },
        published,
      )
      expect(rows.map((row) => [String(row['page_path']), num(row['views'])])).toEqual([
        // /pricing on two hostnames, summed before the top-N cut so the ranking
        // is over the key the api merges on.
        ['/pricing', 17],
        ['/live', 4],
      ])
    })

    it('returns countries with no city column at all', async () => {
      const rows = await run_(
        'analytics.imported_geography',
        {
          site_id: site,
          ...range,
          limit: 10,
        },
        published,
      )
      expect(rows.map((row) => String(row['country'])).sort()).toEqual(['DE', 'GB'])
      for (const row of rows) expect(Object.keys(row)).not.toContain('city')
    })

    it('returns custom events ranked by occurrence', async () => {
      const rows = await run_(
        'analytics.imported_custom_events',
        {
          site_id: site,
          ...range,
          limit: 10,
        },
        published,
      )
      // Read through `num()`, never compared against a literal `'4'`.
      // Whether a 64-bit integer arrives as a JSON number or a quoted string is
      // decided by `output_format_json_quote_64bit_integers` — a *server profile*
      // setting, not part of any read contract — and the api coerces with the
      // same `num()` for exactly that reason. A test that pinned the quoting
      // would be asserting the deployment's configuration.
      //
      // What is worth pinning is the column set: an imported breakdown must
      // project the live report's own names and nothing else, because the api
      // maps both lists with one mapper.
      expect(rows).toHaveLength(1)
      const row = rows[0] as Record<string, unknown>
      expect(Object.keys(row).sort()).toEqual(['event_name', 'events', 'visitors'])
      expect(String(row['event_name'])).toBe('Signup')
      expect(num(row['events'])).toBe(4)
      expect(num(row['visitors'])).toBe(3)
    })

    it('is empty for the nil run, which is what makes a live-only read one query', async () => {
      const rows = await run_(
        'analytics.imported_pages',
        {
          site_id: site,
          ...range,
          limit: 10,
        },
        none,
      )
      expect(rows).toEqual([])
    })
  })
})
