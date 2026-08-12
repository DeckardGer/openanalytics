import { fileURLToPath } from 'node:url'
import { createClient } from '@clickhouse/client'
import {
  IMPORTED_AGGREGATE_TABLE_LIST,
  createImportedAggregatesMaintenance,
  createImportedAggregatesWriter,
  migrateClickHouse,
  toStoredImportedRow,
  type ImportedAggregatesMaintenance,
  type ImportedAggregatesWriter,
} from '@openanalytics/clickhouse'
import { IMPORTED_REPORTS, IMPORTED_REPORT_TABLES } from '@openanalytics/domain'
import { createCapturedLogger } from '@openanalytics/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The imported aggregate family against a live ClickHouse (ADR-0032, D2/D7;
 * migration 0015).
 *
 * Two of the three assertions here cannot be made anywhere else, and ADR-0032's
 * own consequences section says so: "the retry-no-duplicate guarantee leans on
 * ClickHouse insert dedup, which only a live-ClickHouse suite can prove — the M5
 * «live suite unexecuted locally» trap applies; CI has the container."
 *
 * 1. **The eight tables exist with the columns the writer sends.** A row shape
 *    that disagrees with the table is not a type error — ClickHouse fills an
 *    absent column with its type default, so a renamed dimension becomes silent
 *    empty strings on a customer's dashboard.
 * 2. **Retry does not duplicate.** The same chunk inserted twice under the same
 *    `insert_deduplication_token` must leave the row count unchanged. This is the
 *    plan-04 acceptance criterion, and it only holds because migration 0015 sets
 *    `non_replicated_deduplication_window` on every table — without it the token
 *    is accepted and silently ignored (ADR-0005).
 * 3. **Cleanup deletes exactly one run.** Publish erases the grandparent while
 *    the rollback generation is sitting in the same tables under a different run
 *    id; a delete keyed on the site alone would take both.
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

const SITE = '11111111-1111-4111-8111-111111111111'
const RUN_A = '22222222-2222-4222-8222-222222222222'
const RUN_B = '33333333-3333-4333-8333-333333333333'
const MULTI_MONTH_RUN = '55555555-5555-4555-8555-555555555555'
const OTHER_SITE = '44444444-4444-4444-8444-444444444444'

describeIfClickHouse('imported aggregates', () => {
  const url = URL_ as string
  const database = `m11imp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let client: ReturnType<typeof createClient>
  let writer: ImportedAggregatesWriter
  let maintenance: ImportedAggregatesMaintenance

  const queryRows = async <T>(query: string): Promise<T[]> => {
    const resultSet = await client.query({ query, format: 'JSONEachRow' })
    return await resultSet.json<T>()
  }

  const countIn = async (table: string, runId: string): Promise<number> => {
    const rows = await queryRows<{ n: string }>(
      `SELECT count() AS n FROM ${table} WHERE site_id = '${SITE}' AND import_run_id = '${runId}'`,
    )
    return Number(rows[0]?.n ?? 0)
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
    maintenance = createImportedAggregatesMaintenance({
      url,
      username: USERNAME,
      password: PASSWORD,
      database,
    })
  }, 120_000)

  afterAll(async () => {
    await writer?.close()
    await maintenance?.close()
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database}` })
      await client.close()
    }
  })

  describe('migration 0015', () => {
    it('creates all eight tables the report vocabulary names', async () => {
      const rows = await queryRows<{ name: string }>(
        `SELECT name FROM system.tables WHERE database = '${database}' AND name LIKE 'imported_%'`,
      )
      const names = new Set(rows.map((row) => row.name))
      for (const table of IMPORTED_AGGREGATE_TABLE_LIST) {
        expect(names, table).toContain(table)
      }
      expect(IMPORTED_AGGREGATE_TABLE_LIST).toHaveLength(8)
    })

    it('keys every table by (site_id, import_run_id, date) and partitions monthly', async () => {
      // The run id is the staging generation (D2), so it has to lead the sort
      // key after the site: publish and rollback select by it, and cleanup
      // deletes by it.
      for (const table of IMPORTED_AGGREGATE_TABLE_LIST) {
        const rows = await queryRows<{ sorting_key: string; partition_key: string }>(
          `SELECT sorting_key, partition_key FROM system.tables
            WHERE database = '${database}' AND name = '${table}'`,
        )
        expect(rows[0]?.sorting_key, table).toMatch(/^site_id, import_run_id, date/)
        expect(rows[0]?.partition_key, table).toBe('toYYYYMM(date)')
      }
    })

    it('feeds no materialized view and is fed by none', async () => {
      // D2: an MV here would fire on the staging insert and make the publish
      // pointer a fiction.
      const rows = await queryRows<{ name: string; as_select: string }>(
        `SELECT name, as_select FROM system.tables
          WHERE database = '${database}' AND engine = 'MaterializedView'`,
      )
      for (const row of rows) {
        for (const table of IMPORTED_AGGREGATE_TABLE_LIST) {
          expect(row.as_select, `${row.name} reads ${table}`).not.toContain(table)
        }
      }
    })

    it('sets the deduplication window on every one of them', async () => {
      // Without it the insert token is accepted and silently ignored, which is
      // exactly the failure ADR-0005 measured.
      for (const table of IMPORTED_AGGREGATE_TABLE_LIST) {
        const rows = await queryRows<{ create_table_query: string }>(
          `SELECT create_table_query FROM system.tables
            WHERE database = '${database}' AND name = '${table}'`,
        )
        expect(rows[0]?.create_table_query, table).toContain(
          'non_replicated_deduplication_window = 1000',
        )
      }
    })
  })

  describe('staging inserts', () => {
    it('writes every report through the row shapes the writer builds', async () => {
      // The compiler checks the row against the interface; only this checks the
      // interface against the table. A dimension renamed in one and not the
      // other becomes a silent empty string on a dashboard.
      const key = { site_id: SITE, import_run_id: RUN_A }
      const measures = { visitors: 1, visits: 2, pageviews: 3, bounces: 1, visitDuration: 60 }

      await writer.insertRows({
        report: 'metrics',
        rows: [toStoredImportedRow('metrics', key, { date: '2024-01-01', ...measures })],
        insertDeduplicationToken: `${RUN_A}:metrics:0`,
      })
      await writer.insertRows({
        report: 'pages',
        rows: [
          toStoredImportedRow('pages', key, {
            date: '2024-01-01',
            hostname: 'shop.example.com',
            page: '/pricing',
            visitors: 4,
            visits: 5,
            pageviews: 6,
          }),
        ],
        insertDeduplicationToken: `${RUN_A}:pages:0`,
      })
      await writer.insertRows({
        report: 'sources',
        rows: [
          toStoredImportedRow('sources', key, {
            date: '2024-01-01',
            source: 'Google',
            referrer: 'google.com/search',
            utmSource: 'nl',
            utmMedium: 'email',
            utmCampaign: 'spring',
            utmContent: 'hero',
            utmTerm: 'shoes',
            ...measures,
          }),
        ],
        insertDeduplicationToken: `${RUN_A}:sources:0`,
      })
      await writer.insertRows({
        report: 'geography',
        rows: [
          toStoredImportedRow('geography', key, {
            date: '2024-01-01',
            country: 'AZ',
            region: 'BA',
            ...measures,
          }),
        ],
        insertDeduplicationToken: `${RUN_A}:geography:0`,
      })
      await writer.insertRows({
        report: 'devices',
        rows: [
          toStoredImportedRow('devices', key, {
            date: '2024-01-01',
            device: 'Mobile',
            ...measures,
          }),
        ],
        insertDeduplicationToken: `${RUN_A}:devices:0`,
      })
      await writer.insertRows({
        report: 'browsers',
        rows: [
          toStoredImportedRow('browsers', key, {
            date: '2024-01-01',
            browser: 'Safari',
            browserVersion: '17.4',
            ...measures,
          }),
        ],
        insertDeduplicationToken: `${RUN_A}:browsers:0`,
      })
      await writer.insertRows({
        report: 'os',
        rows: [
          toStoredImportedRow('os', key, {
            date: '2024-01-01',
            operatingSystem: 'macOS',
            osVersion: '14.4',
            ...measures,
          }),
        ],
        insertDeduplicationToken: `${RUN_A}:os:0`,
      })
      await writer.insertRows({
        report: 'custom_events',
        rows: [
          toStoredImportedRow('custom_events', key, {
            date: '2024-01-01',
            name: 'Signup',
            linkUrl: '',
            path: '',
            visitors: 3,
            events: 4,
          }),
        ],
        insertDeduplicationToken: `${RUN_A}:custom_events:0`,
      })

      for (const report of IMPORTED_REPORTS) {
        expect(await countIn(IMPORTED_REPORT_TABLES[report], RUN_A), report).toBe(1)
      }

      // Spot-check that the values landed in the columns they were named for,
      // rather than every dimension being a type default.
      const sources = await queryRows<{
        source: string
        utm_campaign: string
        visit_duration: string
      }>(
        `SELECT source, utm_campaign, visit_duration FROM imported_sources_1d
          WHERE import_run_id = '${RUN_A}'`,
      )
      expect(sources[0]).toMatchObject({ source: 'Google', utm_campaign: 'spring' })
      expect(Number(sources[0]?.visit_duration)).toBe(60)
    })

    it('refuses an empty chunk rather than spending a token on it', async () => {
      // An empty insert still consumes the token, which would make it stop
      // recognising the real chunk that follows.
      await expect(
        writer.insertRows({
          report: 'metrics',
          rows: [],
          insertDeduplicationToken: `${RUN_A}:metrics:99`,
        }),
      ).rejects.toThrow(/empty chunk/i)
    })
  })

  describe('retry-no-duplicate (plan-04 acceptance criterion)', () => {
    it('leaves the row count unchanged when the same chunk token is inserted twice', async () => {
      // The guarantee the whole staging retry design rests on: a reclaimed lease
      // re-inserts a chunk whose progress was not recorded, and the token makes
      // that a no-op. Without migration 0015's dedup window this test would show
      // six rows.
      const key = { site_id: SITE, import_run_id: RUN_B }
      const rows = [
        toStoredImportedRow('metrics', key, {
          date: '2024-02-01',
          visitors: 10,
          visits: 11,
          pageviews: 12,
          bounces: 3,
          visitDuration: 300,
        }),
        toStoredImportedRow('metrics', key, {
          date: '2024-02-02',
          visitors: 20,
          visits: 21,
          pageviews: 22,
          bounces: 4,
          visitDuration: 400,
        }),
        toStoredImportedRow('metrics', key, {
          date: '2024-02-03',
          visitors: 30,
          visits: 31,
          pageviews: 32,
          bounces: 5,
          visitDuration: 500,
        }),
      ]
      const token = `${RUN_B}:metrics:0`

      await writer.insertRows({ report: 'metrics', rows, insertDeduplicationToken: token })
      const afterFirst = await countIn('imported_metrics_1d', RUN_B)
      expect(afterFirst).toBe(3)

      await writer.insertRows({ report: 'metrics', rows, insertDeduplicationToken: token })
      await writer.insertRows({ report: 'metrics', rows, insertDeduplicationToken: token })

      expect(await countIn('imported_metrics_1d', RUN_B)).toBe(afterFirst)

      // And the sums are untouched, which is what a dashboard would show.
      const totals = await queryRows<{ visitors: string }>(
        `SELECT sum(visitors) AS visitors FROM imported_metrics_1d
          WHERE site_id = '${SITE}' AND import_run_id = '${RUN_B}'`,
      )
      expect(Number(totals[0]?.visitors)).toBe(60)
    })

    it('holds for a chunk spanning MANY months, which is one block per partition', async () => {
      // The arithmetic the migration's sizing note states, proven rather than
      // asserted in prose. These tables are partitioned monthly and an INSERT is
      // split by partition before anything is written, so a chunk covering
      // fourteen months writes fourteen parts and **fourteen deduplication
      // records** — not one. If the token were recorded per statement, or the
      // window counted statements, a retry would deduplicate the first partition
      // and duplicate the other thirteen.
      //
      // It also exercises `max_partitions_per_insert_block = 0`: without it a
      // block touching more than 100 partitions is refused outright, which a
      // multi-year history import reaches on its own.
      const key = { site_id: SITE, import_run_id: MULTI_MONTH_RUN }
      const rows = Array.from({ length: 14 }, (_unused, index) => {
        const month = String((index % 12) + 1).padStart(2, '0')
        const year = 2020 + Math.floor(index / 12)
        return toStoredImportedRow('metrics', key, {
          date: `${String(year)}-${month}-15`,
          visitors: 1,
          visits: 1,
          pageviews: 1,
          bounces: 0,
          visitDuration: 10,
        })
      })
      const token = `${MULTI_MONTH_RUN}:metrics:0`

      await writer.insertRows({ report: 'metrics', rows, insertDeduplicationToken: token })
      expect(await countIn('imported_metrics_1d', MULTI_MONTH_RUN)).toBe(14)

      // Fourteen distinct partitions, so fourteen dedup records to match.
      const partitions = await queryRows<{ n: string }>(
        `SELECT uniqExact(partition) AS n FROM system.parts
          WHERE database = '${database}' AND table = 'imported_metrics_1d' AND active`,
      )
      expect(Number(partitions[0]?.n)).toBeGreaterThanOrEqual(14)

      await writer.insertRows({ report: 'metrics', rows, insertDeduplicationToken: token })
      expect(await countIn('imported_metrics_1d', MULTI_MONTH_RUN)).toBe(14)

      const totals = await queryRows<{ visitors: string }>(
        `SELECT sum(visitors) AS visitors FROM imported_metrics_1d
          WHERE site_id = '${SITE}' AND import_run_id = '${MULTI_MONTH_RUN}'`,
      )
      expect(Number(totals[0]?.visitors)).toBe(14)
    })

    it('treats a different chunk number as a different chunk', async () => {
      // The token has to distinguish chunks, or a long report would deduplicate
      // itself down to its first chunk.
      const key = { site_id: SITE, import_run_id: RUN_B }
      await writer.insertRows({
        report: 'metrics',
        rows: [
          toStoredImportedRow('metrics', key, {
            date: '2024-02-04',
            visitors: 40,
            visits: 41,
            pageviews: 42,
            bounces: 6,
            visitDuration: 600,
          }),
        ],
        insertDeduplicationToken: `${RUN_B}:metrics:1`,
      })
      expect(await countIn('imported_metrics_1d', RUN_B)).toBe(4)
    })
  })

  describe('per-run cleanup', () => {
    it('deletes exactly one run and leaves the other generation intact', async () => {
      // Publish erases the grandparent while the rollback generation sits in the
      // same tables under a different run id. A delete keyed on the site alone
      // would take both — and the customer's next rollback would show nothing.
      expect(await countIn('imported_metrics_1d', RUN_A)).toBe(1)
      expect(await countIn('imported_metrics_1d', RUN_B)).toBe(4)

      await maintenance.deleteImportRunRows({ siteId: SITE, importRunId: RUN_A })

      expect(await maintenance.countImportRunRows({ siteId: SITE, importRunId: RUN_A })).toBe(0)
      for (const report of IMPORTED_REPORTS) {
        expect(await countIn(IMPORTED_REPORT_TABLES[report], RUN_A), report).toBe(0)
      }
      expect(await countIn('imported_metrics_1d', RUN_B)).toBe(4)
      expect(await maintenance.countImportRunRows({ siteId: SITE, importRunId: RUN_B })).toBe(4)
    })

    it('is idempotent: deleting an already-clean run is a no-op', async () => {
      // The prepare job's failure path, the publish job's cleanup and the
      // sweeper's backstop can all reach the same run.
      await maintenance.deleteImportRunRows({ siteId: SITE, importRunId: RUN_A })
      expect(await maintenance.countImportRunRows({ siteId: SITE, importRunId: RUN_A })).toBe(0)
    })

    it('refuses a non-UUID key rather than interpolating it', async () => {
      // `ALTER ... DELETE` takes no query parameters portably, so both ids are
      // literals in the statement text. This is the guard that closes the only
      // injection surface the module has.
      await expect(
        maintenance.deleteImportRunRows({ siteId: "' OR 1=1 --", importRunId: RUN_A }),
      ).rejects.toThrow(/Invalid site_id/)
      await expect(
        maintenance.countImportRunRows({ siteId: SITE, importRunId: 'not-a-uuid' }),
      ).rejects.toThrow(/Invalid import_run_id/)
    })

    it('counts nothing for a site that never imported', async () => {
      expect(await maintenance.countImportRunRows({ siteId: OTHER_SITE, importRunId: RUN_B })).toBe(
        0,
      )
    })
  })
})
