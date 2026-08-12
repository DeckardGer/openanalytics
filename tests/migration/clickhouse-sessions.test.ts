import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createClient } from '@clickhouse/client'
import { migrateClickHouse } from '@openanalytics/clickhouse'
import { sessionize, type CanonicalSession, type SessionizerEvent } from '@openanalytics/domain'
import { createCapturedLogger } from '@openanalytics/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The Milestone 8 Checkpoint A session schema, proven with data (plan items 2
 * and 8; docs snapshot 05, D-211).
 *
 * The bootstrap test proves the tables build and carry the dedup window. This
 * one proves the two behaviours the schema exists for, and that the tables
 * accept exactly the shape the pure sessionizer in @openanalytics/domain
 * produces:
 *
 *   1. **Latest version per session wins, before any merge.** A provisional
 *      session version (finalized = 0) is superseded by a higher, finalized
 *      version, and the read — a plain argMax over `version`, never FINAL —
 *      reflects only the latest. This is D-211's "a late pageview undoes a
 *      recorded bounce": the provisional bounce version is replaced by an
 *      engaged finalized one and the read flips.
 *   2. **The rollup swap is a generation the reader filters on.** A recomputed
 *      (site, bucket) row at a higher generation supersedes the earlier one; the
 *      read is argMax over `generation`. A re-run at the same generation is a
 *      no-op (idempotent, duplicate-free — acceptance criterion 2).
 *
 * Inserts run under the migration/default credential. Skipped without
 * TEST_CLICKHOUSE_URL; CI always provides one.
 */

const URL_ = process.env['TEST_CLICKHOUSE_URL']
const USERNAME = process.env['TEST_CLICKHOUSE_USER'] ?? 'default'
const PASSWORD = process.env['TEST_CLICKHOUSE_PASSWORD'] ?? ''

const describeIfClickHouse = URL_ ? describe : describe.skip

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../packages/clickhouse/migrations/', import.meta.url),
)

/** ClickHouse DateTime64 literal from an ISO instant: 'YYYY-MM-DD HH:MM:SS.mmm'. */
function chDateTime(iso: string): string {
  return iso.replace('T', ' ').replace('Z', '')
}

/** Maps a domain CanonicalSession to a session_facts_versions row. */
function factRow(
  session: CanonicalSession,
  version: number,
  finalized: boolean,
  retracted = false,
): Record<string, unknown> {
  return {
    site_id: session.siteId,
    session_id: session.sessionId,
    version,
    visitor_id: session.visitorId,
    user_id: session.userId,
    anonymous_id: session.anonymousId,
    session_hint: session.sessionHint,
    midnight_bridged: session.midnightBridged ? 1 : 0,
    session_start: chDateTime(session.startIso),
    session_end: chDateTime(session.endIso),
    pageviews: session.pageviews,
    engaged: session.engaged ? 1 : 0,
    active_duration_ms: session.activeDurationMs,
    session_duration_ms: session.sessionDurationMs,
    entry_page_path: session.entryPagePath,
    exit_page_path: session.exitPagePath,
    referrer_domain: session.referrerDomain,
    utm_source: session.utmSource,
    utm_medium: session.utmMedium,
    utm_campaign: session.utmCampaign,
    device_type: session.deviceType,
    browser: session.browser,
    os: session.os,
    country: session.country,
    finalized: finalized ? 1 : 0,
    retracted: retracted ? 1 : 0,
    computed_at: chDateTime(new Date().toISOString()),
  }
}

describeIfClickHouse('session facts and rollups behaviour', () => {
  const url = URL_ as string
  const database = `m8session_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let client: ReturnType<typeof createClient>

  const queryRows = async <T>(query: string): Promise<T[]> => {
    const resultSet = await client.query({ query, format: 'JSONEachRow' })
    return await resultSet.json<T>()
  }

  const scalar = async (query: string): Promise<number> => {
    const [row] = await queryRows<Record<string, string>>(query)
    return Number(Object.values(row ?? {})[0] ?? 0)
  }

  const insertFacts = async (rows: readonly Record<string, unknown>[]): Promise<void> => {
    await client.insert({ table: 'session_facts_versions', values: rows, format: 'JSONEachRow' })
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

  it('accepts the sessionizer output shape and reports the latest version per session', async () => {
    const site = randomUUID()
    const hint = 'hintA'
    const anon = 'anonA'
    // A single pageview → a provisional bounce (version 1).
    const first: SessionizerEvent[] = [
      {
        eventId: randomUUID(),
        type: 'page_view',
        occurredAt: '2026-07-23T10:00:00.000Z',
        anonymousId: anon,
        sessionHint: hint,
        pagePath: '/',
      },
    ]
    const [provisional] = sessionize(site, first)
    expect(provisional!.bounced).toBe(true)
    await insertFacts([factRow(provisional!, 1, false)])

    // A late second pageview → the same session id, now engaged. The finalizer
    // recomputes it and writes version 2, finalized.
    const withLate: SessionizerEvent[] = [
      ...first,
      {
        eventId: randomUUID(),
        type: 'page_view',
        occurredAt: '2026-07-23T10:04:00.000Z',
        anonymousId: anon,
        sessionHint: hint,
        pagePath: '/pricing',
      },
    ]
    const [finalizedSession] = sessionize(site, withLate)
    expect(finalizedSession!.sessionId).toBe(provisional!.sessionId)
    expect(finalizedSession!.engaged).toBe(true)
    await insertFacts([factRow(finalizedSession!, 2, true)])

    // Two physical versions exist before any merge.
    expect(
      await scalar(`SELECT count() FROM session_facts_versions WHERE site_id = '${site}'`),
    ).toBe(2)

    // The correct read selects the latest version per session explicitly — never
    // FINAL. The provisional bounce is gone; the engaged, finalized truth remains.
    const [current] = await queryRows<{
      pageviews: string
      engaged: string
      bounced: string
      finalized: string
      retracted: string
      version: string
    }>(
      `SELECT
         argMax(sfv.pageviews, sfv.version)   AS pageviews,
         argMax(sfv.engaged, sfv.version)     AS engaged,
         argMax(1 - sfv.engaged, sfv.version) AS bounced,
         argMax(sfv.finalized, sfv.version)   AS finalized,
         argMax(sfv.retracted, sfv.version)   AS retracted,
         max(sfv.version)                     AS version
       FROM session_facts_versions AS sfv
       WHERE site_id = '${site}'
       GROUP BY site_id, session_id`,
    )
    expect(Number(current?.version)).toBe(2)
    expect(Number(current?.pageviews)).toBe(2)
    expect(Number(current?.engaged)).toBe(1)
    expect(Number(current?.bounced)).toBe(0)
    expect(Number(current?.finalized)).toBe(1)
    expect(Number(current?.retracted)).toBe(0)
  })

  it('retracts a superseded session id: argMax-then-filter drops it, pre-filter wrongly keeps it', async () => {
    const site = randomUUID()
    const [session] = sessionize(site, [
      {
        eventId: randomUUID(),
        type: 'page_view',
        occurredAt: '2026-07-23T10:00:00.000Z',
        anonymousId: 'anonA',
        sessionHint: 'hintA',
        pagePath: '/',
      },
    ])
    // v1 is a real, finalized session. A later finalizer run merged or re-keyed
    // it (a late earlier event, or a bridge/stitch), so this id is no longer in
    // the recomputed set — it writes a higher-version retraction tombstone.
    await insertFacts([factRow(session!, 1, true)])
    await insertFacts([factRow(session!, 2, true, true)])

    // Correct read: pick the latest version per session, THEN drop retracted.
    const correct = await queryRows<{ session_id: string }>(
      `SELECT session_id FROM (
         SELECT session_id, argMax(sfv.retracted, sfv.version) AS retracted
           FROM session_facts_versions AS sfv WHERE site_id = '${site}'
          GROUP BY site_id, session_id)
        WHERE retracted = 0`,
    )
    expect(correct).toHaveLength(0)

    // The trap: filtering retracted = 0 BEFORE the version selection discards the
    // tombstone and resurrects the stale v1. This read is wrong on purpose, to
    // prove the ordering in the schema comment matters.
    const naive = await queryRows<{ session_id: string; version: string }>(
      `SELECT session_id, max(sfv.version) AS version
         FROM session_facts_versions AS sfv
        WHERE site_id = '${site}' AND retracted = 0
        GROUP BY site_id, session_id`,
    )
    expect(naive).toHaveLength(1)
    expect(Number(naive[0]?.version)).toBe(1)
  })

  it('preserves a midnight-bridged session through the fact table', async () => {
    const site = randomUUID()
    const events: SessionizerEvent[] = [
      {
        eventId: randomUUID(),
        type: 'page_view',
        occurredAt: '2026-07-23T23:55:00.000Z',
        anonymousId: 'anon-2026-07-23',
        sessionHint: 'sticky',
        pagePath: '/',
      },
      {
        eventId: randomUUID(),
        type: 'page_view',
        occurredAt: '2026-07-24T00:05:00.000Z',
        anonymousId: 'anon-2026-07-24',
        sessionHint: 'sticky',
        pagePath: '/next',
      },
    ]
    const [bridged] = sessionize(site, events)
    expect(bridged!.midnightBridged).toBe(true)
    await insertFacts([factRow(bridged!, 1, true)])

    const [row] = await queryRows<{ midnight_bridged: string; pageviews: string }>(
      `SELECT argMax(sfv.midnight_bridged, sfv.version) AS midnight_bridged,
              argMax(sfv.pageviews, sfv.version)        AS pageviews
         FROM session_facts_versions AS sfv WHERE site_id = '${site}'
        GROUP BY site_id, session_id`,
    )
    expect(Number(row?.midnight_bridged)).toBe(1)
    expect(Number(row?.pageviews)).toBe(2)
  })

  it('swaps a session rollup bucket by generation, idempotently', async () => {
    const site = randomUUID()
    const bucket = '2026-07-23 10:00:00'
    const insertRollup = async (
      table: string,
      generation: number,
      values: { sessions: number; engaged: number; bounced: number },
    ) => {
      await client.insert({
        table,
        values: [
          {
            site_id: site,
            bucket_start: bucket,
            generation,
            sessions: values.sessions,
            engaged_sessions: values.engaged,
            bounced_sessions: values.bounced,
            pageviews: values.sessions * 2,
            total_session_duration_ms: values.sessions * 30_000,
            total_active_duration_ms: values.sessions * 12_000,
            computed_at: chDateTime(new Date().toISOString()),
          },
        ],
        format: 'JSONEachRow',
      })
    }

    // Generation 1: the provisional recompute counted 3 sessions, 1 engaged.
    await insertRollup('session_rollups_1h', 1, { sessions: 3, engaged: 1, bounced: 2 })

    const current = () =>
      queryRows<{ sessions: string; engaged: string; bounced: string }>(
        `SELECT argMax(srh.sessions, srh.generation)         AS sessions,
                argMax(srh.engaged_sessions, srh.generation) AS engaged,
                argMax(srh.bounced_sessions, srh.generation) AS bounced
           FROM session_rollups_1h AS srh
          WHERE site_id = '${site}' GROUP BY site_id, bucket_start`,
      )

    let [row] = await current()
    expect([Number(row?.sessions), Number(row?.engaged), Number(row?.bounced)]).toEqual([3, 1, 2])

    // Generation 2: a later finalizer run re-sessionized the bucket — a late
    // pageview flipped a bounce, so now 3 sessions, 2 engaged. The swap is a
    // higher-generation insert; the read follows it.
    await insertRollup('session_rollups_1h', 2, { sessions: 3, engaged: 2, bounced: 1 })
    ;[row] = await current()
    expect([Number(row?.sessions), Number(row?.engaged), Number(row?.bounced)]).toEqual([3, 2, 1])

    // Re-running generation 2 with identical aggregates is a no-op: the read is
    // unchanged and no duplicate current row appears (acceptance criterion 2).
    await insertRollup('session_rollups_1h', 2, { sessions: 3, engaged: 2, bounced: 1 })
    ;[row] = await current()
    expect([Number(row?.sessions), Number(row?.engaged), Number(row?.bounced)]).toEqual([3, 2, 1])
    expect(
      await scalar(
        `SELECT count() FROM (SELECT 1 FROM session_rollups_1h WHERE site_id = '${site}' GROUP BY site_id, bucket_start)`,
      ),
    ).toBe(1)

    // Average duration is a sum over sums at read, never a stored average.
    const [avg] = await queryRows<{ avg_ms: string }>(
      `SELECT sum(total)/sum(sess) AS avg_ms FROM (
         SELECT argMax(srh.total_session_duration_ms, srh.generation) AS total,
                argMax(srh.sessions, srh.generation)                  AS sess
           FROM session_rollups_1h AS srh
          WHERE site_id = '${site}' GROUP BY site_id, bucket_start)`,
    )
    expect(Number(avg?.avg_ms)).toBe(30_000)
  })
})
