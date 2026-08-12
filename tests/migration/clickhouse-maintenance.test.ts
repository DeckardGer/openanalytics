import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createClient } from '@clickhouse/client'
import {
  DELETION_CLICKHOUSE_TABLES,
  InvalidSiteIdError,
  createClickhouseMaintenance,
  migrateClickHouse,
} from '@openanalytics/clickhouse'
import { DELETION_CLICKHOUSE_TARGETS } from '@openanalytics/domain'
import { createCapturedLogger } from '@openanalytics/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The per-site ClickHouse purge against a live server (ADR-0030, D4).
 *
 * Only a real ClickHouse can answer the questions this suite asks, because every
 * one of them is about the mutation machinery rather than about our code:
 * whether `ALTER … DELETE` submitted with `mutations_sync = 0` returns before it
 * has done anything, whether the mutation id can be recovered from
 * `system.mutations` by its command text, and whether `is_done` actually
 * precedes the rows disappearing. A fake would assert that we call the methods
 * we wrote, which proves nothing about any of that.
 *
 * **The discrimination proof is the point.** Deleting one site's rows is not
 * interesting on its own — an over-broad `WHERE` would pass a test that only
 * checked the purged site. So every case here inserts rows for *two* sites and
 * asserts both directions: the purged site reaches zero and the untouched site
 * keeps its exact count.
 *
 * Runs on the migration/default credential, like every other ClickHouse suite:
 * `oa_maintenance` is a users-file grant on the deployed server (CP6) and does
 * not exist in CI. What the credential changes is *authority*, not behaviour —
 * the statements are identical — so the grant is proven by the deploy step and
 * the statements are proven here.
 */

const URL_ = process.env['TEST_CLICKHOUSE_URL']
const USERNAME = process.env['TEST_CLICKHOUSE_USER'] ?? 'default'
const PASSWORD = process.env['TEST_CLICKHOUSE_PASSWORD'] ?? ''

const describeIfClickHouse = URL_ ? describe : describe.skip

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../packages/clickhouse/migrations/', import.meta.url),
)

/** A mutation is asynchronous; the phase polls, so the test polls the same way. */
const POLL_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 250

describeIfClickHouse('clickhouse site purge', () => {
  const url = URL_ as string
  const database = `m10purge_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let client: ReturnType<typeof createClient>
  let maintenance: ReturnType<typeof createClickhouseMaintenance>

  const siteA = randomUUID()
  const siteB = randomUUID()

  const scalar = async (query: string): Promise<number> => {
    const resultSet = await client.query({ query, format: 'JSONEachRow' })
    const rows = await resultSet.json<Record<string, string>>()
    return Number(Object.values(rows[0] ?? {})[0] ?? 0)
  }

  /** Two page views for a site, straight into `events_raw` — which also fires
   * every materialized view, so the rollup targets fill without a second write. */
  const insertEvents = async (siteId: string, count: number): Promise<void> => {
    await client.insert({
      table: 'events_raw',
      values: Array.from({ length: count }, (_, index) => ({
        schema_version: 1,
        site_id: siteId,
        event_id: randomUUID(),
        batch_id: `b-${siteId}-${String(index)}`,
        type: 'page_view',
        name: '',
        occurred_at: '2026-07-23 10:00:00.000',
        billable: 1,
        anonymous_id: `v${String(index)}`,
        user_id: '',
        page_path: '/a',
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
      })),
      format: 'JSONEachRow',
      clickhouse_settings: { insert_deduplication_token: `${siteId}-${String(count)}-seed` },
    })
  }

  /** One session-rollup row, so a table no materialized view feeds is covered too. */
  const insertRollup = async (siteId: string): Promise<void> => {
    await client.insert({
      table: 'session_rollups_1h',
      values: [
        {
          site_id: siteId,
          bucket_start: '2026-07-23 10:00:00',
          generation: 1,
          sessions: 2,
          engaged_sessions: 1,
          bounced_sessions: 1,
          pageviews: 3,
          total_session_duration_ms: 1000,
          total_active_duration_ms: 500,
          computed_at: '2026-07-23 11:00:00.000',
        },
      ],
      format: 'JSONEachRow',
      clickhouse_settings: { insert_deduplication_token: `${siteId}-rollup-seed` },
    })
  }

  const pollToDone = async (table: string, mutationId: string): Promise<void> => {
    const deadline = Date.now() + POLL_TIMEOUT_MS
    for (;;) {
      const progress = await maintenance.pollMutation(table, mutationId)
      expect(progress.failReason, `${table} mutation failed`).toBeNull()
      if (progress.done || progress.missing) return
      if (Date.now() > deadline) throw new Error(`mutation on ${table} did not finish in time`)
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }
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
    maintenance = createClickhouseMaintenance({
      url,
      database,
      username: USERNAME,
      password: PASSWORD,
    })

    await insertEvents(siteA, 3)
    await insertEvents(siteB, 2)
    await insertRollup(siteA)
    await insertRollup(siteB)
  }, 180_000)

  afterAll(async () => {
    await maintenance?.close()
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database}` })
      await client.close()
    }
  })

  it('names thirty-two tables, and every one of them exists', async () => {
    // Asserted against the vocabulary rather than a literal, so the number moves
    // with the registry it mirrors -- M11 CP2 took it from 20 to 28 by adding
    // the `imported_*` family (ADR-0032, D9), M12 CP3 to 29 with
    // `revenue_events`, CP4 to 30 with `revenue_attributions`, and CP5 to 32
    // with the `revenue_1h`/`revenue_1d` rollups (ADR-0033, D5/D7/D8). What the
    // loop below still proves is the part a count cannot: every name in the list
    // is a table that is really there -- so migration 0018 having created both
    // rollups is a precondition of this assertion passing, not an assumption.
    expect(DELETION_CLICKHOUSE_TABLES).toHaveLength(DELETION_CLICKHOUSE_TARGETS.length)
    // A derived list would silently stop covering a renamed table. A literal one
    // fails here instead, which is the whole reason it is a literal.
    for (const table of DELETION_CLICKHOUSE_TABLES) {
      await expect(maintenance.countSiteRows(table, siteA)).resolves.toBeGreaterThanOrEqual(0)
    }
  })

  it(
    'purges one site from events_raw and leaves the other untouched',
    async () => {
      const before = await maintenance.countSiteRows('events_raw', siteA)
      const otherBefore = await maintenance.countSiteRows('events_raw', siteB)
      expect(before).toBe(3)
      expect(otherBefore).toBe(2)

      const submitted = await maintenance.submitSiteDelete('events_raw', siteA)
      // The id is the handle a resumed job polls with; without it the phase
      // cannot tell "mine is running" from "nothing was submitted".
      expect(submitted.mutationId).not.toBeNull()

      await pollToDone('events_raw', submitted.mutationId as string)

      expect(await maintenance.countSiteRows('events_raw', siteA)).toBe(0)
      // The discrimination proof: an over-broad WHERE would pass the assertion
      // above and fail this one.
      expect(await maintenance.countSiteRows('events_raw', siteB)).toBe(2)
    },
    POLL_TIMEOUT_MS + 30_000,
  )

  it(
    'purges a rollup table the same way',
    async () => {
      expect(await maintenance.countSiteRows('session_rollups_1h', siteA)).toBe(1)

      const submitted = await maintenance.submitSiteDelete('session_rollups_1h', siteA)
      await pollToDone('session_rollups_1h', submitted.mutationId as string)

      expect(await maintenance.countSiteRows('session_rollups_1h', siteA)).toBe(0)
      expect(await maintenance.countSiteRows('session_rollups_1h', siteB)).toBe(1)
    },
    POLL_TIMEOUT_MS + 30_000,
  )

  it('reports a mutation id nobody registered as missing rather than done', async () => {
    // The resume path's third state. `missing` is not `done`: the caller falls
    // back to the count, which is the only statement that observes truth.
    const progress = await maintenance.pollMutation('events_raw', '9999999999')
    expect(progress).toEqual({ done: false, failReason: null, missing: true })
  })

  it('refuses a table that is not a table, rather than interpolating it', async () => {
    await expect(
      maintenance.submitSiteDelete('events_raw; DROP DATABASE x', siteA),
    ).rejects.toThrow(/Invalid ClickHouse table name/iu)
  })

  it('refuses a site id that is not a UUID', async () => {
    // The interpolation guard. The site id is a literal in the ALTER (the
    // mutation's `command` text has to contain it), so this regex is the
    // injection closure, not a nicety.
    await expect(maintenance.submitSiteDelete('events_raw', "x' OR 1=1 --")).rejects.toThrow(
      InvalidSiteIdError,
    )
    await expect(maintenance.countSiteRows('events_raw', 'not-a-uuid')).rejects.toThrow(
      InvalidSiteIdError,
    )
  })

  it('surfaces an error for a table that does not exist', async () => {
    // The failure path the executor records in `deletion_targets.last_error`.
    await expect(maintenance.submitSiteDelete('no_such_table', siteA)).rejects.toThrow()
  })

  it('reports a count that survives the purge for the untouched site', async () => {
    // Restated at the end deliberately: the two mutations above ran against a
    // shared database, and this is the assertion that would fail if either had
    // been broader than one site.
    expect(await scalar(`SELECT count() FROM events_raw WHERE site_id = '${siteB}'`)).toBe(2)
    expect(await scalar(`SELECT count() FROM events_raw WHERE site_id = '${siteA}'`)).toBe(0)
  })
})
