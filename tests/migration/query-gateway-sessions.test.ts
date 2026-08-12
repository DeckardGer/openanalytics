import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createClient } from '@clickhouse/client'
import { migrateClickHouse } from '@openanalytics/clickhouse'
import { computeFunnel, type FunnelEvent } from '@openanalytics/domain'
import { createCapturedLogger } from '@openanalytics/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHttpClickHouseReader } from '../../apps/query-gateway/src/clickhouse-http.ts'
import { findOperation } from '../../apps/query-gateway/src/operations.ts'
import type { QueryParameterValue } from '../../apps/query-gateway/src/clickhouse.ts'

/**
 * The Milestone 8 session-read and funnel gateway operations, proven with data
 * (plan items 6-7, acceptance criterion 4; docs snapshot 05, D-211).
 *
 * Every assertion runs the real request path — `operation.bindParams(input)` →
 * placeholders + bound parameters → the HTTP read-only reader → an actual
 * migrated ClickHouse — so what it proves that the in-process suite cannot:
 *
 *   1. **The provisional layer reads current truth: argMax over version, THEN
 *      retracted = 0.** A late version flips a provisional bounce to engaged, and
 *      a retraction tombstone drops a superseded session id — never a pre-filter,
 *      never FINAL (migration 0013's read contract).
 *   2. **The finalized layer reads argMax over generation** from the swap rollup,
 *      and its additive measures sum across buckets (migration 0014).
 *   3. **Cross-site isolation** — a site's session read never returns another
 *      site's rows.
 *   4. **The funnel operation's `windowFunnel` matches the pure `computeFunnel`
 *      reference** on the same seeded events — the deterministic funnel spec.
 *   5. **A timezone-local session bucket is labelled by its instant, in UTC.**
 *      `session_start` is DateTime64(3, 'UTC') and `bucket_start` DateTime('UTC'),
 *      but `toStartOf*(col, tz)` renders in `tz`, and the API serializes a bucket
 *      by appending "Z" — so the label has to come back as the UTC rendering of
 *      the same instant.
 *
 * Skipped without TEST_CLICKHOUSE_URL; CI always provides one. Written to the
 * standing ClickHouse read rules (argMax-then-filter, alias-qualified aggregates)
 * because there is no local ClickHouse to run it against.
 */

const URL_ = process.env['TEST_CLICKHOUSE_URL']
const USERNAME = process.env['TEST_CLICKHOUSE_USER'] ?? 'default'
const PASSWORD = process.env['TEST_CLICKHOUSE_PASSWORD'] ?? ''

const describeIfClickHouse = URL_ ? describe : describe.skip

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../packages/clickhouse/migrations/', import.meta.url),
)

/** A session_facts_versions row with sensible defaults. */
function factRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    site_id: '',
    session_id: '',
    version: 1,
    visitor_id: '',
    user_id: '',
    anonymous_id: '',
    session_hint: '',
    midnight_bridged: 0,
    session_start: '2026-07-01 09:00:00.000',
    session_end: '2026-07-01 09:00:00.000',
    pageviews: 1,
    engaged: 0,
    active_duration_ms: 0,
    session_duration_ms: 0,
    entry_page_path: '',
    exit_page_path: '',
    referrer_domain: '',
    utm_source: '',
    utm_medium: '',
    utm_campaign: '',
    device_type: '',
    browser: '',
    os: '',
    country: '',
    finalized: 0,
    retracted: 0,
    computed_at: '2026-07-01 10:00:00.000',
    ...over,
  }
}

describeIfClickHouse('session-read and funnel gateway operations', () => {
  const url = URL_ as string
  const database = `m8gw_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let client: ReturnType<typeof createClient>

  const reader = createHttpClickHouseReader({
    url,
    database,
    username: USERNAME,
    password: PASSWORD,
  })

  const run = async (
    operationId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> => {
    const operation = findOperation(operationId)
    if (!operation) throw new Error(`no such operation ${operationId}`)
    const parameters = operation.bindParams(input) as Record<string, QueryParameterValue>
    const controller = new AbortController()
    const result = await reader.query({
      sql: operation.sql,
      parameters,
      signal: controller.signal,
      queryId: randomUUID(),
      settings: { max_execution_time: 20, max_result_rows: 200_000, result_overflow_mode: 'throw' },
    })
    return [...result.rows]
  }

  const insertFacts = async (rows: readonly Record<string, unknown>[]): Promise<void> => {
    await client.insert({ table: 'session_facts_versions', values: rows, format: 'JSONEachRow' })
  }

  const insertRawEvents = async (rows: readonly Record<string, unknown>[]): Promise<void> => {
    await client.insert({
      table: 'events_raw',
      values: rows.map((row) => ({
        schema_version: 1,
        batch_id: 'b',
        name: '',
        billable: 1,
        anonymous_id: '',
        user_id: '',
        session_id: '',
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
    })
  }

  const siteA = randomUUID()
  const siteB = randomUUID()

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

  it('provisional layer: argMax over version flips a bounce, retraction drops a session, sums are additive', async () => {
    const hourFrom = '2026-07-01T09:00:00.000Z'
    const hourTo = '2026-07-01T10:00:00.000Z'

    // Session 1: v1 provisional bounce (engaged 0) then v2 engaged. The read must
    // reflect v2 — engaged, not bounced.
    await insertFacts([
      factRow({
        site_id: siteA,
        session_id: 's1',
        version: 1,
        engaged: 0,
        pageviews: 1,
        session_duration_ms: 0,
        active_duration_ms: 0,
      }),
      factRow({
        site_id: siteA,
        session_id: 's1',
        version: 2,
        engaged: 1,
        pageviews: 2,
        session_duration_ms: 30_000,
        active_duration_ms: 12_000,
      }),
    ])
    // Session 2: a real finalized session, then a higher-version retraction
    // tombstone (a re-key/merge). argMax-then-filter must drop it entirely.
    await insertFacts([
      factRow({
        site_id: siteA,
        session_id: 's2',
        version: 1,
        engaged: 0,
        pageviews: 1,
        retracted: 0,
      }),
      factRow({
        site_id: siteA,
        session_id: 's2',
        version: 2,
        engaged: 0,
        pageviews: 1,
        retracted: 1,
      }),
    ])
    // Session 3: a plain bounce, current.
    await insertFacts([
      factRow({
        site_id: siteA,
        session_id: 's3',
        version: 1,
        engaged: 0,
        pageviews: 1,
        session_duration_ms: 0,
        active_duration_ms: 0,
      }),
    ])
    // Site B session that must never leak into site A's answer.
    await insertFacts([factRow({ site_id: siteB, session_id: 'b1', version: 1, engaged: 1 })])

    const rows = await run('analytics.sessions_provisional_hour', {
      site_id: siteA,
      from: hourFrom,
      to: hourTo,
      timezone: 'UTC',
    })
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    // s1 (engaged) + s3 (bounce) = 2 sessions; s2 retracted, dropped. Site B gone.
    expect(Number(row['sessions'])).toBe(2)
    expect(Number(row['engaged_sessions'])).toBe(1)
    expect(Number(row['bounced_sessions'])).toBe(1)
    // Additive totals from the current versions only: s1 v2 pageviews 2 + s3 1.
    expect(Number(row['pageviews'])).toBe(3)
    expect(Number(row['total_session_duration_ms'])).toBe(30_000)
    expect(Number(row['total_active_duration_ms'])).toBe(12_000)
  })

  it('finalized layer: argMax over generation, additive across buckets, site-scoped', async () => {
    const insertRollup = async (table: string, row: Record<string, unknown>): Promise<void> => {
      await client.insert({
        table,
        values: [
          {
            site_id: siteA,
            generation: 1,
            sessions: 0,
            engaged_sessions: 0,
            bounced_sessions: 0,
            pageviews: 0,
            total_session_duration_ms: 0,
            total_active_duration_ms: 0,
            computed_at: '2026-07-01 10:00:00.000',
            ...row,
          },
        ],
        format: 'JSONEachRow',
      })
    }

    // Bucket 09:00 — generation 1 then a superseding generation 2 (a late pageview
    // flipped a bounce). Bucket 10:00 — one generation. Site B bucket must not leak.
    await insertRollup('session_rollups_1h', {
      bucket_start: '2026-07-01 09:00:00',
      generation: 1,
      sessions: 3,
      engaged_sessions: 1,
      bounced_sessions: 2,
      pageviews: 4,
      total_session_duration_ms: 90_000,
      total_active_duration_ms: 30_000,
    })
    await insertRollup('session_rollups_1h', {
      bucket_start: '2026-07-01 09:00:00',
      generation: 2,
      sessions: 3,
      engaged_sessions: 2,
      bounced_sessions: 1,
      pageviews: 6,
      total_session_duration_ms: 120_000,
      total_active_duration_ms: 48_000,
    })
    await insertRollup('session_rollups_1h', {
      bucket_start: '2026-07-01 10:00:00',
      generation: 1,
      sessions: 2,
      engaged_sessions: 2,
      bounced_sessions: 0,
      pageviews: 5,
      total_session_duration_ms: 60_000,
      total_active_duration_ms: 24_000,
    })
    await client.insert({
      table: 'session_rollups_1h',
      values: [
        {
          site_id: siteB,
          bucket_start: '2026-07-01 09:00:00',
          generation: 1,
          sessions: 99,
          engaged_sessions: 99,
          bounced_sessions: 0,
          pageviews: 99,
          total_session_duration_ms: 99,
          total_active_duration_ms: 99,
          computed_at: '2026-07-01 10:00:00.000',
        },
      ],
      format: 'JSONEachRow',
    })

    const rows = await run('analytics.sessions_finalized_hour', {
      site_id: siteA,
      from: '2026-07-01T09:00:00.000Z',
      to: '2026-07-01T11:00:00.000Z',
      timezone: 'UTC',
    })
    // The bucket label is the bucket instant rendered in UTC — a timezone-local
    // re-bucketing is returned as DateTime64(3, 'UTC'), hence the milliseconds.
    const byBucket = Object.fromEntries(rows.map((r) => [String(r['bucket']), r]))
    // 09:00 reads generation 2 (the swap), not the sum of both generations.
    expect(Number(byBucket['2026-07-01 09:00:00.000']?.['sessions'])).toBe(3)
    expect(Number(byBucket['2026-07-01 09:00:00.000']?.['engaged_sessions'])).toBe(2)
    expect(Number(byBucket['2026-07-01 09:00:00.000']?.['pageviews'])).toBe(6)
    expect(Number(byBucket['2026-07-01 10:00:00.000']?.['sessions'])).toBe(2)
  })

  // -------------------------------------------------------------------------
  // Timezone-local session bucket labels. Istanbul is +03:00 all year (no DST
  // since 2016), so every instant below is offset-stable: the local hour is a
  // whole UTC hour, and the local day 2026-07-12 starts at 2026-07-11T21:00:00Z.
  // A label rendered in Istanbul reads three hours ahead of the instant it names,
  // which the API then stamps "Z" onto.
  // -------------------------------------------------------------------------

  const ISTANBUL = 'Europe/Istanbul'

  it('provisional session buckets carry the bucket instant in UTC, at hour and local-day grain', async () => {
    const site = randomUUID()
    await insertFacts([
      factRow({
        site_id: site,
        session_id: 'tz1',
        version: 1,
        session_start: '2026-07-12 10:30:00.000',
        session_end: '2026-07-12 10:40:00.000',
        engaged: 1,
        pageviews: 2,
        session_duration_ms: 600_000,
        active_duration_ms: 60_000,
      }),
      factRow({
        site_id: site,
        session_id: 'tz2',
        version: 1,
        session_start: '2026-07-12 18:15:00.000',
        session_end: '2026-07-12 18:15:00.000',
        engaged: 0,
        pageviews: 1,
      }),
    ])

    const hourFrom = '2026-07-12T10:00:00.000Z'
    const hourTo = '2026-07-12T19:00:00.000Z'
    const hourRows = await run('analytics.sessions_provisional_hour', {
      site_id: site,
      from: hourFrom,
      to: hourTo,
      timezone: ISTANBUL,
    })
    // Rendered in Istanbul these would read 13:00:00 and 21:00:00 — the second of
    // which is not even inside the range that was asked for.
    expect(hourRows.map((row) => String(row['bucket']))).toEqual([
      '2026-07-12 10:00:00.000',
      '2026-07-12 18:00:00.000',
    ])
    expect(hourRows.map((row) => Number(row['sessions']))).toEqual([1, 1])
    for (const row of hourRows) {
      const ms = Date.parse(`${String(row['bucket']).replace(' ', 'T')}Z`)
      expect(ms).toBeGreaterThanOrEqual(Date.parse(hourFrom))
      expect(ms).toBeLessThan(Date.parse(hourTo))
    }

    // The Istanbul day 2026-07-12 is the instant range [2026-07-11T21:00:00Z,
    // 2026-07-12T21:00:00Z); its bucket is named by that start instant.
    const dayRows = await run('analytics.sessions_provisional_day_local', {
      site_id: site,
      from: '2026-07-11T21:00:00.000Z',
      to: '2026-07-12T21:00:00.000Z',
      timezone: ISTANBUL,
    })
    expect(dayRows.map((row) => String(row['bucket']))).toEqual(['2026-07-11 21:00:00.000'])
    expect(Number(dayRows[0]?.['sessions'])).toBe(2)
    expect(Number(dayRows[0]?.['engaged_sessions'])).toBe(1)
    expect(Number(dayRows[0]?.['pageviews'])).toBe(3)
  })

  it('finalized session buckets carry the bucket instant in UTC', async () => {
    const site = randomUUID()
    await client.insert({
      table: 'session_rollups_1h',
      values: [
        {
          site_id: site,
          bucket_start: '2026-07-12 10:00:00',
          generation: 1,
          sessions: 4,
          engaged_sessions: 3,
          bounced_sessions: 1,
          pageviews: 9,
          total_session_duration_ms: 120_000,
          total_active_duration_ms: 48_000,
          computed_at: '2026-07-12 11:00:00.000',
        },
      ],
      format: 'JSONEachRow',
    })

    const rows = await run('analytics.sessions_finalized_hour', {
      site_id: site,
      from: '2026-07-12T10:00:00.000Z',
      to: '2026-07-12T11:00:00.000Z',
      timezone: ISTANBUL,
    })
    expect(rows.map((row) => String(row['bucket']))).toEqual(['2026-07-12 10:00:00.000'])
    expect(Number(rows[0]?.['sessions'])).toBe(4)
  })

  it('funnel operation matches the pure computeFunnel reference on the same events', async () => {
    const funnelSite = randomUUID()
    const steps = ['/pricing', 'signup_started', 'signup']
    const windowMs = 1_800_000
    const from = '2026-07-10T00:00:00.000Z'
    const to = '2026-07-11T00:00:00.000Z'

    // Two visitors: v1 completes all three in order; v2 reaches step two only.
    // event_id is a UUID column; fixed literals keep the seed deterministic.
    const seed: { anon: string; ms: number; id: string; type: string; key: string }[] = [
      {
        anon: 'v1',
        ms: Date.parse('2026-07-10T09:00:00.000Z'),
        id: '00000000-0000-4000-8000-000000000001',
        type: 'page_view',
        key: '/pricing',
      },
      {
        anon: 'v1',
        ms: Date.parse('2026-07-10T09:05:00.000Z'),
        id: '00000000-0000-4000-8000-000000000002',
        type: 'custom_event',
        key: 'signup_started',
      },
      {
        anon: 'v1',
        ms: Date.parse('2026-07-10T09:10:00.000Z'),
        id: '00000000-0000-4000-8000-000000000003',
        type: 'conversion',
        key: 'signup',
      },
      {
        anon: 'v2',
        ms: Date.parse('2026-07-10T12:00:00.000Z'),
        id: '00000000-0000-4000-8000-000000000004',
        type: 'page_view',
        key: '/pricing',
      },
      {
        anon: 'v2',
        ms: Date.parse('2026-07-10T12:03:00.000Z'),
        id: '00000000-0000-4000-8000-000000000005',
        type: 'custom_event',
        key: 'signup_started',
      },
    ]

    await insertRawEvents(
      seed.map((s) => ({
        site_id: funnelSite,
        event_id: s.id,
        type: s.type,
        occurred_at: new Date(s.ms).toISOString().replace('T', ' ').replace('Z', ''),
        anonymous_id: s.anon,
        ...(s.type === 'page_view' ? { page_path: s.key } : { name: s.key }),
      })),
    )

    const rows = await run('analytics.funnel_visitor', {
      site_id: funnelSite,
      from,
      to,
      steps,
      window_ms: windowMs,
    })
    const row = rows[0]!
    const chCounts = [Number(row['step_1']), Number(row['step_2']), Number(row['step_3'])]

    // The pure reference over the same events.
    const events: FunnelEvent[] = seed.map((s) => ({
      unitKey: s.anon,
      occurredMs: s.ms,
      eventId: s.id,
      stepKey: s.key,
    }))
    const reference = computeFunnel(events, { steps, windowMs }).map((r) => r.count)

    expect(chCounts).toEqual(reference)
    expect(chCounts).toEqual([2, 2, 1])
  })

  it('reads recent visitors and one visitor’s trail out of the raw events (ADR-0024)', async () => {
    const site = randomUUID()
    const from = '2026-07-12T00:00:00.000Z'
    const to = '2026-07-12T06:00:00.000Z'
    const at = (iso: string): string => iso.replace('T', ' ').replace('Z', '')

    // v1: two client-hinted sessions, and a later event whose UA/geo differ from
    // the first — the read must report the *latest* label, not whichever came
    // back first — followed by an unlabelled custom event, which must not blank
    // that label. v2: one page view, seen earlier, so the ordering is observable.
    await insertRawEvents([
      {
        site_id: site,
        event_id: '00000000-0000-4000-8000-0000000000a1',
        type: 'page_view',
        occurred_at: at('2026-07-12T01:00:00.000'),
        anonymous_id: 'v1',
        session_id: 's1',
        page_path: '/',
        page_title: 'Home',
        referrer_domain: 'google.com',
        country: 'AZ',
        device_type: 'mobile',
        browser: 'safari',
        os: 'ios',
      },
      {
        site_id: site,
        event_id: '00000000-0000-4000-8000-0000000000a2',
        type: 'page_view',
        occurred_at: at('2026-07-12T01:10:00.000'),
        anonymous_id: 'v1',
        session_id: 's1',
        page_path: '/pricing',
        page_title: 'Pricing',
        referrer_domain: 'google.com',
        country: 'AZ',
        device_type: 'mobile',
        browser: 'safari',
        os: 'ios',
      },
      {
        site_id: site,
        event_id: '00000000-0000-4000-8000-0000000000a3',
        type: 'page_view',
        occurred_at: at('2026-07-12T03:00:00.000'),
        anonymous_id: 'v1',
        session_id: 's2',
        page_path: '/checkout',
        page_title: 'Checkout',
        country: 'DE',
        device_type: 'desktop',
        browser: 'chrome',
        os: 'windows',
      },
      // A non-pageview by the same visitor, carrying no page context, so every
      // UA/geo column defaults to empty: it counts toward presence in the window
      // but not toward the pageview total, never joins the trail, and never
      // blanks the labels the 03:00 page view established.
      {
        site_id: site,
        event_id: '00000000-0000-4000-8000-0000000000a4',
        type: 'custom_event',
        name: 'signup',
        occurred_at: at('2026-07-12T03:05:00.000'),
        anonymous_id: 'v1',
        session_id: 's2',
      },
      // v1 identifies mid-visit. user_id exists on this row ALONE (the
      // collector never stamps it onward), and the row carries v1's anonymous
      // id too — which is exactly what folds it onto v1's own group instead of
      // minting a phantom "u_hash_1" row with zero pageviews (ADR-0036 D3).
      {
        site_id: site,
        event_id: '00000000-0000-4000-8000-0000000000a5',
        type: 'identify',
        occurred_at: at('2026-07-12T03:02:00.000'),
        anonymous_id: 'v1',
        user_id: 'u_hash_1',
        session_id: 's2',
      },
      {
        site_id: site,
        event_id: '00000000-0000-4000-8000-0000000000b1',
        type: 'page_view',
        occurred_at: at('2026-07-12T00:30:00.000'),
        anonymous_id: 'v2',
        session_id: 's9',
        page_path: '/',
        country: 'US',
        device_type: 'desktop',
        browser: 'firefox',
        os: 'linux',
      },
    ])

    const visitors = await run('analytics.recent_visitors', { site_id: site, from, to, limit: 100 })
    // Two people, not three: the identify event joined v1's group rather than
    // appearing as a phantom visitor keyed on the user hash.
    expect(visitors.map((row) => row['visitor'])).toEqual(['v1', 'v2'])
    expect(visitors[0]!['user_id']).toBe('u_hash_1')
    expect(visitors[1]!['user_id']).toBe('')

    const v1 = visitors[0]!
    expect(Number(v1['pageviews'])).toBe(3)
    // The label of the most recent *labelled* event (03:00), not of the first
    // one read, and not the empty label of the newer unlabelled custom event.
    expect(v1['country']).toBe('DE')
    expect(v1['browser']).toBe('chrome')
    expect(v1['os']).toBe('windows')
    expect(v1['device_type']).toBe('desktop')
    expect(String(v1['first_seen'])).toContain('01:00:00')
    expect(String(v1['last_seen'])).toContain('03:05:00')

    const trail = await run('analytics.visitor_trail', {
      site_id: site,
      from,
      to,
      visitor: 'v1',
      limit: 500,
    })
    // Page views only, newest first, and never another visitor's rows.
    expect(trail.map((row) => row['page_path'])).toEqual(['/checkout', '/pricing', '/'])
    expect(trail.map((row) => row['session_id'])).toEqual(['s2', 's1', 's1'])

    // A visitor with nothing in the window is an empty trail, not an error.
    expect(
      await run('analytics.visitor_trail', { site_id: site, from, to, visitor: 'nobody' }),
    ).toEqual([])
  })
})
