import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createClient } from '@clickhouse/client'
import { migrateClickHouse } from '@openanalytics/clickhouse'
import { createCapturedLogger } from '@openanalytics/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The Milestone 7 additive rollup family, proven with data (plan items 1-2).
 *
 * The bootstrap test (`clickhouse-analytics.test.ts`) proves the schema builds
 * and every dedup-bearing table carries the window. This one proves the three
 * behavioural invariants that the schema alone cannot:
 *
 *   1. **A deduplicated raw retry does not double any rollup.** Every rollup in
 *      the family reads directly from events_raw, so this is ADR-0005's finding
 *      applied to the whole family at once: three re-inserts of one batch under
 *      the same insert_deduplication_token must leave every rollup unchanged.
 *      Without the window on a target, the raw block deduplicates while that
 *      view fires again — a silent multiplication invisible in the raw table.
 *   2. **Unique visitors merge, they are not summed** (plan item 2). uniqMerge
 *      over several buckets counts a visitor active in two of them once; the
 *      naive sum of per-bucket uniques double-counts it.
 *   3. **The shipped identity rule (ADR-0036)**: a bucket's visitors are the
 *      distinct anonymous ids with at least one page view in it. `user_id`
 *      exists on the identify event alone, so an identified person is one
 *      visitor exactly when the merge is filtered to the page-view state —
 *      the filter the gateway ships — and `visitors <= pageviews` holds even
 *      when departure beacons land in the bucket after their page view.
 *      (This suite once seeded page_view rows carrying a user_id — a fixture
 *      production cannot produce — and asserted a fold that never ran; that
 *      is the drift ADR-0036 closed.)
 *
 * Plus the performance rollup's t-digest state answers a percentile of the
 * union, merged across buckets.
 *
 * Inserts run under the migration/default credential straight into events_raw,
 * which is what fires the views — the worker's row mapping is proven separately
 * in the M6 live suite. Skipped without TEST_CLICKHOUSE_URL; CI always provides
 * one.
 */

const URL_ = process.env['TEST_CLICKHOUSE_URL']
const USERNAME = process.env['TEST_CLICKHOUSE_USER'] ?? 'default'
const PASSWORD = process.env['TEST_CLICKHOUSE_PASSWORD'] ?? ''

const describeIfClickHouse = URL_ ? describe : describe.skip

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../packages/clickhouse/migrations/', import.meta.url),
)

interface RawRow {
  site_id: string
  event_id: string
  batch_id: string
  type: string
  name?: string
  occurred_at: string
  billable?: number
  anonymous_id?: string
  user_id?: string
  page_path?: string
  referrer_domain?: string
  utm_source?: string
  utm_medium?: string
  utm_campaign?: string
  country?: string
  city?: string
  device_type?: string
  browser?: string
  os?: string
  properties?: string
}

describeIfClickHouse('analytics rollup family behaviour', () => {
  const url = URL_ as string
  const database = `m7rollup_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let client: ReturnType<typeof createClient>

  const queryRows = async <T>(query: string): Promise<T[]> => {
    const resultSet = await client.query({ query, format: 'JSONEachRow' })
    return await resultSet.json<T>()
  }

  const scalar = async (query: string): Promise<number> => {
    const [row] = await queryRows<Record<string, string>>(query)
    return Number(Object.values(row ?? {})[0] ?? 0)
  }

  /** Inserts a block into events_raw under a stable dedup token, as the worker does. */
  const insertRaw = async (token: string, rows: readonly RawRow[]): Promise<void> => {
    await client.insert({
      table: 'events_raw',
      values: rows.map((row) => ({
        schema_version: 1,
        name: '',
        billable: 1,
        anonymous_id: '',
        user_id: '',
        page_path: '',
        referrer_domain: '',
        utm_source: '',
        utm_medium: '',
        utm_campaign: '',
        country: '',
        city: '',
        device_type: '',
        browser: '',
        os: '',
        properties: '{}',
        ...row,
      })),
      format: 'JSONEachRow',
      clickhouse_settings: { insert_deduplication_token: token },
    })
  }

  const newSite = (): string => randomUUID()
  const newEvent = (): string => randomUUID()

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
    client = createClient({
      url,
      username: USERNAME,
      password: PASSWORD,
      database,
      clickhouse_settings: { async_insert: 0, wait_for_async_insert: 1 },
    })
  }, 120_000)

  afterAll(async () => {
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database}` })
      await client.close()
    }
  })

  it('populates the metric rollups and does not double them on a deduplicated retry', async () => {
    const site = newSite()
    const at = '2026-07-23 10:00:00.000'
    // Three page views, two distinct anonymous visitors, two distinct paths.
    const rows: RawRow[] = [
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'b1',
        type: 'page_view',
        occurred_at: at,
        anonymous_id: 'v1',
        page_path: '/a',
      },
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'b1',
        type: 'page_view',
        occurred_at: at,
        anonymous_id: 'v1',
        page_path: '/a',
      },
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'b1',
        type: 'page_view',
        occurred_at: at,
        anonymous_id: 'v2',
        page_path: '/b',
      },
    ]

    await insertRaw('token-b1', rows)

    const events = () =>
      scalar(
        `SELECT sum(events) FROM metrics_1h WHERE site_id = '${site}' AND event_type = 'page_view'`,
      )
    const visitors = () =>
      scalar(
        `SELECT uniqMerge(visitors) FROM metrics_1h WHERE site_id = '${site}' AND event_type = 'page_view'`,
      )
    const pageViews = (path: string) =>
      scalar(`SELECT sum(views) FROM pages_1h WHERE site_id = '${site}' AND page_path = '${path}'`)

    expect(await events()).toBe(3)
    expect(await visitors()).toBe(2)
    expect(await pageViews('/a')).toBe(2)
    expect(await pageViews('/b')).toBe(1)
    // Day rollup answers the same question at the day grain.
    expect(
      await scalar(
        `SELECT sum(events) FROM metrics_1d WHERE site_id = '${site}' AND event_type = 'page_view'`,
      ),
    ).toBe(3)

    // Three more inserts of the identical block under the same token. The raw
    // block deduplicates on every retry; each rollup target's own window keeps
    // the view from firing twice. Without it, events would climb to 12.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await insertRaw('token-b1', rows)
    }

    expect(await scalar(`SELECT count() FROM events_raw WHERE site_id = '${site}'`)).toBe(3)
    expect(await events()).toBe(3)
    expect(await visitors()).toBe(2)
    expect(await pageViews('/a')).toBe(2)
    expect(await pageViews('/b')).toBe(1)
  })

  it('merges unique visitors across buckets rather than summing them', async () => {
    const site = newSite()
    // v1 appears in two different hours of the same day; v2 in one. Per-hour
    // uniques sum to 3, but the true distinct count over the day is 2.
    await insertRaw('token-merge', [
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'm',
        type: 'page_view',
        occurred_at: '2026-07-23 10:30:00.000',
        anonymous_id: 'v1',
      },
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'm',
        type: 'page_view',
        occurred_at: '2026-07-23 10:45:00.000',
        anonymous_id: 'v2',
      },
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'm',
        type: 'page_view',
        occurred_at: '2026-07-23 11:30:00.000',
        anonymous_id: 'v1',
      },
    ])

    // Two hour buckets exist.
    const hourBuckets = await scalar(
      `SELECT count() FROM (SELECT bucket_start FROM metrics_1h WHERE site_id = '${site}' AND event_type = 'page_view' GROUP BY bucket_start)`,
    )
    expect(hourBuckets).toBe(2)

    // The naive sum of per-hour uniq counts would be 3.
    const summed = await scalar(
      `SELECT sum(u) FROM (
         SELECT uniqMerge(visitors) AS u FROM metrics_1h
          WHERE site_id = '${site}' AND event_type = 'page_view' GROUP BY bucket_start)`,
    )
    expect(summed).toBe(3)

    // Merged across both hours it is 2 — the property that a bucket sum destroys.
    const merged = await scalar(
      `SELECT uniqMerge(visitors) FROM metrics_1h WHERE site_id = '${site}' AND event_type = 'page_view'`,
    )
    expect(merged).toBe(2)

    // And the day rollup, which buckets to the same day, also reports 2.
    expect(
      await scalar(
        `SELECT uniqMerge(visitors) FROM metrics_1d WHERE site_id = '${site}' AND event_type = 'page_view'`,
      ),
    ).toBe(2)
  })

  it('counts one identified person as a single visitor under the shipped page-view rule', async () => {
    const site = newSite()
    // Production reality (ADR-0036): the collector sets user_id on the identify
    // event ALONE. One person — anonymous id anonA — views two pages and calls
    // identify() mid-visit (the identify row carries both anonA and the hash
    // u1); a second, purely anonymous visitor anonC views one page.
    await insertRaw('token-identity', [
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'i',
        type: 'page_view',
        occurred_at: '2026-07-23 09:00:00.000',
        anonymous_id: 'anonA',
      },
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'i',
        type: 'identify',
        occurred_at: '2026-07-23 09:02:00.000',
        anonymous_id: 'anonA',
        user_id: 'u1',
      },
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'i',
        type: 'page_view',
        occurred_at: '2026-07-23 09:05:00.000',
        anonymous_id: 'anonA',
      },
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'i',
        type: 'page_view',
        occurred_at: '2026-07-23 09:10:00.000',
        anonymous_id: 'anonC',
      },
    ])

    // The shipped read: the merge filtered to the page-view state, exactly as
    // the gateway's timeseries and overview branches filter it. Two people.
    expect(
      await scalar(
        `SELECT uniqMergeIf(visitors, event_type = 'page_view') FROM metrics_1h WHERE site_id = '${site}'`,
      ),
    ).toBe(2)

    // The bare merge this replaced also counted the identify-typed state's
    // user hash — one person as two visitors. Pinned so the double count the
    // filter closes stays visible in the data, not only in prose.
    expect(
      await scalar(`SELECT uniqMerge(visitors) FROM metrics_1h WHERE site_id = '${site}'`),
    ).toBe(3)
  })

  it('keeps visitors <= pageviews per bucket when departure beacons land in the next one', async () => {
    const site = newSite()
    // The dominant real-world generator of the "2 visitors / 1 pageview"
    // symptom: a page opened at 09:58 whose engagement and web_vital fire at
    // departure, 10:03, landing in the NEXT hour bucket (the events are
    // stamped when they happen, and that is correct — ADR-0036 changed the
    // definition, not the clock).
    await insertRaw('token-departure', [
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'd',
        type: 'page_view',
        occurred_at: '2026-07-23 09:58:00.000',
        anonymous_id: 'vd',
      },
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'd',
        type: 'engagement',
        occurred_at: '2026-07-23 10:03:00.000',
        anonymous_id: 'vd',
      },
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'd',
        type: 'web_vital',
        occurred_at: '2026-07-23 10:03:00.000',
        anonymous_id: 'vd',
      },
    ])

    const buckets = await queryRows<{ bucket: string; pageviews: string; visitors: string }>(
      `SELECT bucket_start AS bucket,
              sumIf(events, event_type = 'page_view') AS pageviews,
              uniqMergeIf(visitors, event_type = 'page_view') AS visitors
         FROM metrics_1h WHERE site_id = '${site}'
        GROUP BY bucket_start ORDER BY bucket_start`,
    )
    // Two buckets exist (the departure events are real rows in 10:00), and the
    // shipped rule holds in both: 09:00 is 1/1, 10:00 is 0 visitors beside 0
    // pageviews — not the 1-visitor/0-pageview bucket the bare merge produced.
    expect(buckets.map((row) => [Number(row.visitors), Number(row.pageviews)])).toEqual([
      [1, 1],
      [0, 0],
    ])
    for (const row of buckets) {
      expect(Number(row.visitors)).toBeLessThanOrEqual(Number(row.pageviews))
    }
  })

  it('rolls up custom events and conversions by name, and keeps page_views out', async () => {
    const site = newSite()
    await insertRaw('token-custom', [
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'c',
        type: 'page_view',
        occurred_at: '2026-07-23 12:00:00.000',
        anonymous_id: 'v1',
      },
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'c',
        type: 'custom_event',
        name: 'signup_started',
        occurred_at: '2026-07-23 12:01:00.000',
        anonymous_id: 'v1',
      },
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'c',
        type: 'custom_event',
        name: 'signup_started',
        occurred_at: '2026-07-23 12:02:00.000',
        anonymous_id: 'v2',
      },
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'c',
        type: 'conversion',
        name: 'purchase',
        occurred_at: '2026-07-23 12:03:00.000',
        anonymous_id: 'v1',
      },
    ])

    const rows = await queryRows<{
      event_name: string
      event_type: string
      events: string
      visitors: string
    }>(
      `SELECT event_name, event_type, sum(events) AS events, uniqMerge(visitors) AS visitors
         FROM custom_events_1h WHERE site_id = '${site}'
        GROUP BY event_name, event_type ORDER BY event_name`,
    )
    expect(
      rows.map((row) => [row.event_name, row.event_type, Number(row.events), Number(row.visitors)]),
    ).toEqual([
      ['purchase', 'conversion', 1, 1],
      ['signup_started', 'custom_event', 2, 2],
    ])
    // The page_view carried no name, so it never entered the custom-event rollup.
    expect(
      await scalar(
        `SELECT count() FROM custom_events_1h WHERE site_id = '${site}' AND event_name = ''`,
      ),
    ).toBe(0)
  })

  it('samples the newest event per name, by occurred_at and not by arrival', async () => {
    // ADR-0038 D5. The whole point of argMax over `occurred_at` rather than
    // anyLast: the newest event is inserted FIRST here and the older one second,
    // which is what a retried batch or a late arrival looks like from inside
    // ClickHouse. anyLast would answer `/old`.
    const site = newSite()
    const event = (name: string, at: string, path: string, properties: string): RawRow => ({
      site_id: site,
      event_id: newEvent(),
      batch_id: 's',
      type: 'custom_event',
      name,
      occurred_at: at,
      anonymous_id: 'v1',
      page_path: path,
      properties,
    })

    await insertRaw('token-sample-new', [
      event('signup', '2026-07-23 12:30:00.000', '/new', '{"section":"hero"}'),
    ])
    await insertRaw('token-sample-old', [
      event('signup', '2026-07-23 12:10:00.000', '/old', '{"section":"footer"}'),
      // A second name in the same bucket, so the argMax is per group rather
      // than per bucket.
      event('newsletter_joined', '2026-07-23 12:20:00.000', '/blog', '{}'),
    ])

    const rows = await queryRows<{
      event_name: string
      events: string
      last_seen_at: string
      sample_page_path: string
      sample_properties: string
    }>(
      // Qualified through `t` for the same reason the gateway operation is:
      // every alias here shares its source column's name. The unqualified form
      // passed on 26.3, so this mirrors the read rather than fixing it.
      `SELECT
         t.event_name                       AS event_name,
         sum(t.events)                      AS events,
         max(t.last_seen_at)                AS last_seen_at,
         argMaxMerge(t.sample_page_path)    AS sample_page_path,
         argMaxMerge(t.sample_properties)   AS sample_properties
       FROM custom_event_samples_1h AS t WHERE t.site_id = '${site}'
       GROUP BY event_name ORDER BY event_name`,
    )

    expect(
      rows.map((row) => [
        row.event_name,
        Number(row.events),
        row.last_seen_at,
        row.sample_page_path,
        row.sample_properties,
      ]),
    ).toEqual([
      ['newsletter_joined', 1, '2026-07-23 12:20:00.000', '/blog', '{}'],
      ['signup', 2, '2026-07-23 12:30:00.000', '/new', '{"section":"hero"}'],
    ])

    // Same filter as custom_events_1h: a row with no name never enters.
    await insertRaw('token-sample-pv', [
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 's',
        type: 'page_view',
        occurred_at: '2026-07-23 12:40:00.000',
        anonymous_id: 'v1',
        page_path: '/x',
      },
    ])
    expect(
      await scalar(
        `SELECT count() FROM custom_event_samples_1h WHERE site_id = '${site}' AND event_name = ''`,
      ),
    ).toBe(0)

    // The day twin answers the same question at the day grain, and the counts
    // agree with the rollup the read cuts its top-N by.
    expect(
      await scalar(`SELECT sum(events) FROM custom_event_samples_1d WHERE site_id = '${site}'`),
    ).toBe(await scalar(`SELECT sum(events) FROM custom_events_1d WHERE site_id = '${site}'`))

    // And a deduplicated retry does not double it (ADR-0005, the family rule).
    await insertRaw('token-sample-old', [
      event('signup', '2026-07-23 12:10:00.000', '/old', '{"section":"footer"}'),
      event('newsletter_joined', '2026-07-23 12:20:00.000', '/blog', '{}'),
    ])
    expect(
      await scalar(
        `SELECT sum(events) FROM custom_event_samples_1h
          WHERE site_id = '${site}' AND event_name = 'signup'`,
      ),
    ).toBe(2)
  })

  it('answers merged percentiles from the performance t-digest state', async () => {
    const site = newSite()
    const vital = (value: number, rating: string, at: string): RawRow => ({
      site_id: site,
      event_id: newEvent(),
      batch_id: 'p',
      type: 'web_vital',
      billable: 0,
      device_type: 'desktop',
      occurred_at: at,
      properties: JSON.stringify({ oa_metric: 'LCP', oa_value: value, oa_rating: rating }),
    })
    // Two different hours so the read has to merge two sketches.
    await insertRaw('token-perf', [
      vital(100, 'good', '2026-07-23 08:10:00.000'),
      vital(200, 'good', '2026-07-23 08:20:00.000'),
      vital(300, 'needs-improvement', '2026-07-23 09:10:00.000'),
      vital(400, 'poor', '2026-07-23 09:20:00.000'),
    ])

    const [row] = await queryRows<{
      samples: string
      value_sum: string
      good: string
      ni: string
      poor: string
      p50: string
      p95: string
    }>(
      `SELECT
         sum(samples) AS samples,
         sum(value_sum) AS value_sum,
         sum(good_samples) AS good,
         sum(needs_improvement_samples) AS ni,
         sum(poor_samples) AS poor,
         arrayElement(quantilesTDigestMerge(0.5, 0.75, 0.9, 0.95, 0.99)(value_quantiles), 1) AS p50,
         arrayElement(quantilesTDigestMerge(0.5, 0.75, 0.9, 0.95, 0.99)(value_quantiles), 4) AS p95
       FROM performance_1h WHERE site_id = '${site}' AND metric = 'LCP'`,
    )

    expect(Number(row?.samples)).toBe(4)
    expect(Number(row?.value_sum)).toBe(1000)
    expect(Number(row?.good)).toBe(2)
    expect(Number(row?.ni)).toBe(1)
    expect(Number(row?.poor)).toBe(1)
    // The median of {100,200,300,400} lies in [100,400]; the exact t-digest
    // value is not asserted, only that a merged percentile is answerable and
    // ordered. This is a percentile of the union, not an average of per-hour
    // percentiles.
    expect(Number(row?.p50)).toBeGreaterThanOrEqual(100)
    expect(Number(row?.p50)).toBeLessThanOrEqual(400)
    expect(Number(row?.p95)).toBeGreaterThanOrEqual(Number(row?.p50))
    expect(Number(row?.p95)).toBeLessThanOrEqual(400)
  })

  // Milestone 7 acceptance criterion 4 (DST through the composed-day path). The
  // read API composes a non-UTC day from metrics_1h with
  // toStartOfDay(bucket_start, tz) — exactly the analytics.timeseries_day
  // operation. On a DST transition that local "day" is 23 or 25 UTC hours long,
  // and this proves the composition lands every one of those hours in the right
  // local day, so the 23h/25h day is neither short-changed nor padded.
  it('composes a 23h spring-forward and a 25h fall-back local day from the hour rollup', async () => {
    const site = newSite()
    const NY = 'America/New_York'

    // One page_view at each UTC hour across a range that covers three NY local
    // days around each transition, so the composed grouping has neighbours to be
    // distinguished from.
    const hourlyPageViews = async (startUtc: string, hours: number, token: string) => {
      const start = Date.parse(`${startUtc}Z`)
      const rows: RawRow[] = []
      for (let h = 0; h < hours; h += 1) {
        const at = new Date(start + h * 3_600_000).toISOString().replace('T', ' ').replace('Z', '')
        rows.push({
          site_id: site,
          event_id: newEvent(),
          batch_id: token,
          type: 'page_view',
          occurred_at: at,
          anonymous_id: `v${h}`,
          page_path: '/',
        })
      }
      await insertRaw(token, rows)
    }

    // Spring forward: 2026-03-08 is a 23h NY day (local midnight 05:00Z → next
    // local midnight 04:00Z). Fall back: 2026-11-01 is a 25h NY day (04:00Z →
    // 05:00Z next day). Seed a wide UTC window around both so the composed
    // grouping includes the neighbouring days too.
    await hourlyPageViews('2026-03-07 00:00:00.000', 24 * 4, 'dst-spring')
    await hourlyPageViews('2026-10-31 00:00:00.000', 24 * 4, 'dst-fall')

    const composed = await queryRows<{ local_day: string; events: string }>(
      `SELECT
         toString(toStartOfDay(bucket_start, '${NY}')) AS local_day,
         sum(events) AS events
       FROM metrics_1h
       WHERE site_id = '${site}' AND event_type = 'page_view'
       GROUP BY local_day
       ORDER BY local_day`,
    )
    const eventsOn = (day: string): number =>
      Number(composed.find((r) => r.local_day.startsWith(day))?.events ?? -1)

    // The DST days have exactly their true local length; the surrounding days are
    // ordinary 24h days.
    expect(eventsOn('2026-03-08')).toBe(23)
    expect(eventsOn('2026-03-07')).toBe(24)
    expect(eventsOn('2026-11-01')).toBe(25)
    expect(eventsOn('2026-11-02')).toBe(24)

    // And the composed days partition the events: no hour is dropped or
    // double-counted across the local-day boundaries.
    const springTotal = eventsOn('2026-03-07') + eventsOn('2026-03-08')
    expect(springTotal).toBe(47) // 24 + 23, the first two full local days seeded
  })
})
