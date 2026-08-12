import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createClient } from '@clickhouse/client'
import { createSessionFactsStore, migrateClickHouse } from '@openanalytics/clickhouse'
import { DEFAULT_SESSION_CONFIG } from '@openanalytics/domain'
import { createRecordingMetrics } from '@openanalytics/observability'
import { createCapturedLogger } from '@openanalytics/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { finalizeSite } from '../../apps/worker/src/sessions/finalizer.ts'
import type { FinalizerDeps } from '../../apps/worker/src/sessions/deps.ts'
import type { FinalizerState } from '../../apps/worker/src/sessions/state.ts'

/**
 * The M8 session finalizer, proven end-to-end against a real ClickHouse (plan
 * Milestone 8 acceptance criteria 1-3; docs snapshot 05, D-211). Checkpoint B.
 *
 * The three acceptance criteria, each with a named test:
 *   1. a late second pageview flips a recorded bounce to engaged and the read
 *      reflects it — no incremental-MV shortcut, the finalizer re-sessionizes;
 *   2. re-running over an already-finalized range changes nothing and produces
 *      no duplicate versions or generations;
 *   3. a duplicated duration beacon does not inflate active duration.
 *
 * The finalizer is driven with a real ClickHouse store and an in-memory
 * watermark, so the whole recompute/version/swap path runs without needing
 * Postgres too. Skipped without TEST_CLICKHOUSE_URL; CI always provides one.
 */

const URL_ = process.env['TEST_CLICKHOUSE_URL']
const USERNAME = process.env['TEST_CLICKHOUSE_USER'] ?? 'default'
const PASSWORD = process.env['TEST_CLICKHOUSE_PASSWORD'] ?? ''
const describeIfClickHouse = URL_ ? describe : describe.skip

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../packages/clickhouse/migrations/', import.meta.url),
)

const INACTIVITY_MS = DEFAULT_SESSION_CONFIG.SESSION_INACTIVITY_MINUTES * 60_000
const LATENESS_MS = 24 * 60 * 60_000

function chDateTime64(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '')
}

/** An in-memory finalizer watermark + lease, so the data test needs no Postgres. */
function memoryState(): FinalizerState & {
  set(siteId: string, ms: number): void
  get(siteId: string): number
} {
  const watermark = new Map<string, number>()
  const held = new Set<string>()
  return {
    async claim(siteId) {
      if (held.has(siteId)) return null
      held.add(siteId)
      return { finalizedThroughMs: watermark.get(siteId) ?? 0, runSeq: 0 }
    },
    async advance(siteId, ms) {
      watermark.set(siteId, ms)
      held.delete(siteId)
    },
    async release(siteId) {
      held.delete(siteId)
    },
    set(siteId, ms) {
      watermark.set(siteId, ms)
    },
    get(siteId) {
      return watermark.get(siteId) ?? 0
    },
  }
}

describeIfClickHouse('session finalizer behaviour', () => {
  const url = URL_ as string
  const database = `m8final_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let client: ReturnType<typeof createClient>
  let store: ReturnType<typeof createSessionFactsStore>

  const queryRows = async <T>(query: string): Promise<T[]> => {
    const resultSet = await client.query({ query, format: 'JSONEachRow' })
    return await resultSet.json<T>()
  }
  const scalar = async (query: string): Promise<number> => {
    const [row] = await queryRows<Record<string, string>>(query)
    return Number(Object.values(row ?? {})[0] ?? 0)
  }

  interface RawEvent {
    eventId?: string
    type: string
    occurredMs: number
    anonymousId?: string
    sessionHint?: string
    userId?: string
    pagePath?: string
    activeMs?: number
  }

  const insertEvents = async (siteId: string, events: readonly RawEvent[]): Promise<void> => {
    const rows = events.map((event) => ({
      site_id: siteId,
      event_id: event.eventId ?? randomUUID(),
      type: event.type,
      occurred_at: chDateTime64(event.occurredMs),
      accepted_at: chDateTime64(event.occurredMs),
      anonymous_id: event.anonymousId ?? 'anonA',
      session_id: event.sessionHint ?? 'hintA',
      user_id: event.userId ?? '',
      page_path: event.pagePath ?? '/',
      properties:
        event.type === 'engagement'
          ? JSON.stringify({
              oa_active_ms: event.activeMs ?? 0,
              oa_visible_ms: event.activeMs ?? 0,
            })
          : '{}',
    }))
    await client.insert({ table: 'events_raw', values: rows, format: 'JSONEachRow' })
  }

  /** Sites this suite's finalizer may work. Overridden by the lifecycle-fence
   * test to prove a `deleting` site is skipped after the claim. */
  const finalizable = { blocked: new Set<string>() }

  const makeDeps = (state: FinalizerState, nowRef: { ms: number }): FinalizerDeps => ({
    store,
    state,
    filterFinalizable: async (siteIds) =>
      await Promise.resolve(siteIds.filter((siteId) => !finalizable.blocked.has(siteId))),
    sessionConfig: DEFAULT_SESSION_CONFIG,
    latenessMs: LATENESS_MS,
    logger: createCapturedLogger().logger,
    metrics: createRecordingMetrics(),
    now: () => new Date(nowRef.ms),
  })

  /** The current (latest-version, non-retracted) fact of a session. */
  const currentFact = (siteId: string, sessionId: string) =>
    queryRows<{
      engaged: string
      pageviews: string
      finalized: string
      retracted: string
      active: string
    }>(
      `SELECT
         argMax(sfv.engaged, sfv.version)            AS engaged,
         argMax(sfv.pageviews, sfv.version)          AS pageviews,
         argMax(sfv.finalized, sfv.version)          AS finalized,
         argMax(sfv.retracted, sfv.version)          AS retracted,
         argMax(sfv.active_duration_ms, sfv.version) AS active
       FROM session_facts_versions AS sfv
       WHERE site_id = '${siteId}' AND session_id = '${sessionId}'
       GROUP BY site_id, session_id`,
    )

  /** The current (latest-generation) hour rollup of a site. */
  const currentRollup1h = (siteId: string) =>
    queryRows<{ sessions: string; engaged: string; bounced: string }>(
      `SELECT
         sum(cur.sessions) AS sessions,
         sum(cur.engaged)  AS engaged,
         sum(cur.bounced)  AS bounced
       FROM (
         SELECT
           argMax(srh.sessions, srh.generation)         AS sessions,
           argMax(srh.engaged_sessions, srh.generation) AS engaged,
           argMax(srh.bounced_sessions, srh.generation) AS bounced
         FROM session_rollups_1h AS srh
         WHERE site_id = '${siteId}' GROUP BY site_id, bucket_start
       ) AS cur`,
    )

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
    store = createSessionFactsStore({ url, username: USERNAME, password: PASSWORD, database })
  }, 120_000)

  afterAll(async () => {
    await store?.close()
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database}` })
      await client.close()
    }
  })

  it('flips a recorded bounce to engaged when a late second pageview arrives (criterion 1)', async () => {
    const site = randomUUID()
    const state = memoryState()
    const baseMs = Date.parse('2026-05-01T10:00:00.000Z')

    // First pageview only: the first run records a provisional bounce.
    await insertEvents(site, [{ type: 'page_view', occurredMs: baseMs, pagePath: '/' }])
    const now = { ms: baseMs + 5 * 60_000 }
    const deps = makeDeps(state, now)
    const first = await finalizeSite(deps, site)
    expect(first.changed).toBe(1)

    // The session id is the sessionizer's hash of (site, earliest event id); read
    // the single stored session and confirm it bounced and is provisional.
    const [bouncedRow] = await queryRows<{
      session_id: string
      engaged: string
      finalized: string
    }>(
      `SELECT session_id, argMax(sfv.engaged, sfv.version) AS engaged,
              argMax(sfv.finalized, sfv.version) AS finalized
         FROM session_facts_versions AS sfv WHERE site_id = '${site}'
        GROUP BY site_id, session_id`,
    )
    expect(Number(bouncedRow!.engaged)).toBe(0)
    expect(Number(bouncedRow!.finalized)).toBe(0)
    const sessionId = bouncedRow!.session_id

    // The provisional rollup shows one bounced session.
    let [rollup] = await currentRollup1h(site)
    expect([Number(rollup!.sessions), Number(rollup!.engaged), Number(rollup!.bounced)]).toEqual([
      1, 0, 1,
    ])

    // A late second pageview arrives (4 minutes after the first, inside the gap).
    await insertEvents(site, [
      { type: 'page_view', occurredMs: baseMs + 4 * 60_000, pagePath: '/pricing' },
    ])
    now.ms = baseMs + 10 * 60_000
    const second = await finalizeSite(deps, site)
    expect(second.changed).toBe(1)

    // The read now reflects an engaged session on the SAME id — the bounce is
    // undone, with no incremental view anywhere.
    const [engagedRow] = await currentFact(site, sessionId)
    expect(Number(engagedRow!.engaged)).toBe(1)
    expect(Number(engagedRow!.pageviews)).toBe(2)
    expect(Number(engagedRow!.finalized)).toBe(0)

    // Two physical versions exist; the rollup swapped to engaged.
    expect(
      await scalar(
        `SELECT count() FROM session_facts_versions WHERE site_id = '${site}' AND session_id = '${sessionId}'`,
      ),
    ).toBe(2)
    ;[rollup] = await currentRollup1h(site)
    expect([Number(rollup!.sessions), Number(rollup!.engaged), Number(rollup!.bounced)]).toEqual([
      1, 1, 0,
    ])

    // Long past the horizon: the session finalizes, and the read stays engaged.
    now.ms = baseMs + LATENESS_MS + INACTIVITY_MS + 60 * 60_000
    const third = await finalizeSite(deps, site)
    expect(third.changed).toBe(1)
    const [finalRow] = await currentFact(site, sessionId)
    expect(Number(finalRow!.finalized)).toBe(1)
    expect(Number(finalRow!.engaged)).toBe(1)
  })

  it('changes nothing and adds no duplicates on a re-run over a finalized range (criterion 2)', async () => {
    const site = randomUUID()
    const state = memoryState()
    const baseMs = Date.parse('2026-05-02T10:00:00.000Z')
    await insertEvents(site, [
      { type: 'page_view', occurredMs: baseMs, pagePath: '/' },
      { type: 'page_view', occurredMs: baseMs + 3 * 60_000, pagePath: '/next' },
    ])

    // Finalize the range fully (now well past the horizon).
    const now = { ms: baseMs + LATENESS_MS + INACTIVITY_MS + 60 * 60_000 }
    const deps = makeDeps(state, now)
    await finalizeSite(deps, site)

    const factCountBefore = await scalar(
      `SELECT count() FROM session_facts_versions WHERE site_id = '${site}'`,
    )
    const rollupCountBefore = await scalar(
      `SELECT count() FROM session_rollups_1h WHERE site_id = '${site}'`,
    )
    const [rollupBefore] = await currentRollup1h(site)

    // Force a recompute of the already-finalized range by resetting the watermark
    // to zero, then re-run. The pure sessionizer reproduces byte-identical
    // sessions, so the diff is empty: no new version, no new generation.
    state.set(site, 0)
    const rerun = await finalizeSite(deps, site)
    expect(rerun.changed).toBe(0)
    expect(rerun.retracted).toBe(0)
    expect(rerun.rollupSwaps).toBe(0)

    expect(
      await scalar(`SELECT count() FROM session_facts_versions WHERE site_id = '${site}'`),
    ).toBe(factCountBefore)
    expect(await scalar(`SELECT count() FROM session_rollups_1h WHERE site_id = '${site}'`)).toBe(
      rollupCountBefore,
    )
    const [rollupAfter] = await currentRollup1h(site)
    expect(rollupAfter).toEqual(rollupBefore)

    // Exactly one current session, exactly one current bucket — no resurrection.
    expect(
      await scalar(
        `SELECT count() FROM (SELECT 1 FROM session_rollups_1h WHERE site_id = '${site}' GROUP BY site_id, bucket_start)`,
      ),
    ).toBe(1)
  })

  it('does not inflate active duration when a duration beacon is duplicated (criterion 3)', async () => {
    const site = randomUUID()
    const state = memoryState()
    const baseMs = Date.parse('2026-05-03T10:00:00.000Z')
    const beaconId = randomUUID()

    // A pageview, an engagement beacon, and the SAME beacon delivered twice (a
    // retried event, one id, two rows in events_raw).
    await insertEvents(site, [
      { type: 'page_view', occurredMs: baseMs, pagePath: '/' },
      { eventId: beaconId, type: 'engagement', occurredMs: baseMs + 8_000, activeMs: 8_000 },
      { eventId: beaconId, type: 'engagement', occurredMs: baseMs + 8_000, activeMs: 8_000 },
    ])

    const now = { ms: baseMs + LATENESS_MS + INACTIVITY_MS + 60 * 60_000 }
    await finalizeSite(makeDeps(state, now), site)

    const [row] = await queryRows<{ active: string; sessions: string }>(
      `SELECT
         argMax(sfv.active_duration_ms, sfv.version) AS active,
         count() OVER () AS sessions
       FROM session_facts_versions AS sfv WHERE site_id = '${site}'
       GROUP BY site_id, session_id`,
    )
    // 8 seconds of active time, not 16 — the duplicate beacon collapsed.
    expect(Number(row!.active)).toBe(8_000)
  })
})
