import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createClient } from '@clickhouse/client'
import {
  createRevenueEventsStore,
  migrateClickHouse,
  revenueEventsToken,
  type RevenueEventRow,
} from '@openanalytics/clickhouse'
import { createCapturedLogger } from '@openanalytics/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The canonical revenue fact against a live ClickHouse (ADR-0033, D5; migration
 * 0016). Milestone 12 Checkpoint 3.
 *
 * Only a real server can answer any of these, because every one of them is about
 * the engine rather than about our code:
 *
 * 1. **The schema is what D5 specifies** — engine, partition key, sort key,
 *    deduplication window, and `LowCardinality` on the enumerable dimensions. A
 *    unit test could only assert that we typed a string.
 * 2. **A higher version supersedes a lower one under the argMax read, BEFORE any
 *    merge has run.** ReplacingMergeTree's replacement is a space reclamation,
 *    not a correctness mechanism, and the whole read contract depends on the
 *    difference. `FINAL` is deliberately never used.
 * 3. **The content-derived deduplication token drops a replayed batch.** That is
 *    what makes the projection's insert-then-mark ordering safe rather than
 *    merely likely to be safe, and it only works because the migration sets
 *    `non_replicated_deduplication_window` — a setting that is accepted and
 *    silently ignored when absent (ADR-0005 measured a 3x from exactly that).
 * 4. **A genuinely different batch is never dropped**, which is the other half:
 *    a token that deduplicated too eagerly would lose facts.
 * 5. **A pre-filter on a versioned column resurrects a superseded row.** Asserted
 *    as a demonstration, not as desired behaviour, so the trap the migration's
 *    read contract warns about is visible in a test rather than only in prose.
 *
 * Runs on the migration/default credential like every other ClickHouse suite:
 * `oa_ingest`'s grant on this table is a users-file entry on the deployed server
 * (CP7) and does not exist in CI. What the credential changes is *authority*,
 * not behaviour — the statements are identical — so the grant is proven by the
 * deploy step and the statements are proven here.
 *
 * Skipped without `TEST_CLICKHOUSE_URL`; CI always provides one.
 */

const URL_ = process.env['TEST_CLICKHOUSE_URL']
const USERNAME = process.env['TEST_CLICKHOUSE_USER'] ?? 'default'
const PASSWORD = process.env['TEST_CLICKHOUSE_PASSWORD'] ?? ''

const describeIfClickHouse = URL_ ? describe : describe.skip

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../packages/clickhouse/migrations/', import.meta.url),
)

function factRow(
  overrides: Partial<RevenueEventRow> & Pick<RevenueEventRow, 'site_id'>,
): RevenueEventRow {
  return {
    provider: 'stripe',
    object_id: 'ch_1',
    object_kind: 'charge',
    version: 1,
    occurred_at: '2026-07-30 12:00:00.000',
    status: 'succeeded',
    livemode: 1,
    currency: 'usd',
    gross_minor: 10_000,
    fee_minor: 320,
    fee_currency: 'usd',
    net_minor: 9_680,
    reporting_currency: 'usd',
    reporting_gross_minor: 10_000,
    reporting_net_minor: 9_680,
    conversion_source: 'none',
    conversion_rate: 1,
    conversion_rate_date: '1970-01-01',
    parent_object_id: '',
    order_id: 'pi_1',
    checkout_session_id: '',
    client_reference_id: '',
    subscription_id: '',
    product_id: '',
    product_name: '',
    customer_hash: 'a'.repeat(64),
    external_user_hash: '',
    ingested_via: 'webhook',
    ingested_at: '2026-07-31 09:00:00.000',
    ...overrides,
  }
}

describeIfClickHouse('revenue_events (ClickHouse 0016)', () => {
  const url = URL_ as string
  const database = `m12rev_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let client: ReturnType<typeof createClient>
  let store: ReturnType<typeof createRevenueEventsStore>

  const queryRows = async <T>(query: string): Promise<T[]> => {
    const resultSet = await client.query({ query, format: 'JSONEachRow' })
    return await resultSet.json<T>()
  }

  const scalar = async (query: string): Promise<number> => {
    const [row] = await queryRows<Record<string, string>>(query)
    return Number(Object.values(row ?? {})[0] ?? 0)
  }

  /**
   * The distinct partitions holding rows for one object, sorted.
   *
   * Read through `_partition_id` on the table itself rather than from
   * `system.parts`, so the answer is scoped to the object's own rows. A
   * `system.parts` query answers "which partitions does this table have", which
   * is a different and much weaker question — every other test's rows are in
   * there too.
   */
  const partitionsOf = async (siteId: string, objectId: string): Promise<string[]> => {
    const rows = await queryRows<{ partition_id: string }>(
      `SELECT DISTINCT _partition_id AS partition_id
         FROM revenue_events
        WHERE site_id = '${siteId}' AND object_id = '${objectId}'
        ORDER BY partition_id`,
    )
    return rows.map((row) => row.partition_id)
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
    store = createRevenueEventsStore({
      url,
      username: USERNAME,
      password: PASSWORD,
      database,
    })
  }, 180_000)

  afterAll(async () => {
    await store?.close()
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database}` })
      await client.close()
    }
  })

  describe('schema (D5)', () => {
    it('is a ReplacingMergeTree(version) partitioned and sorted as D5 specifies', async () => {
      const [table] = await queryRows<{
        engine_full: string
        partition_key: string
        sorting_key: string
      }>(
        `SELECT engine_full, partition_key, sorting_key
           FROM system.tables
          WHERE database = '${database}' AND name = 'revenue_events'`,
      )
      expect(table?.engine_full).toContain('ReplacingMergeTree(version)')
      expect(table?.partition_key).toContain('toYYYYMM(occurred_at)')
      // The object's identity, and therefore the replacing key. `version` is the
      // engine's replacing column and is deliberately NOT in the sort key.
      expect(table?.sorting_key.replace(/\s+/gu, '')).toBe('site_id,provider,object_id')
      expect(table?.sorting_key).not.toContain('version')
    })

    it('carries the deduplication window without which the insert token is ignored', async () => {
      const [table] = await queryRows<{ create_table_query: string }>(
        `SELECT create_table_query FROM system.tables
          WHERE database = '${database}' AND name = 'revenue_events'`,
      )
      expect(table?.create_table_query).toMatch(/non_replicated_deduplication_window\s*=\s*[1-9]/u)
    })

    it('holds every D5 column with the right type', async () => {
      const rows = await queryRows<{ name: string; type: string }>(
        `SELECT name, type FROM system.columns
          WHERE database = '${database}' AND table = 'revenue_events'`,
      )
      const types = new Map(rows.map((row) => [row.name, row.type]))

      expect(types.get('site_id')).toBe('UUID')
      expect(types.get('version')).toBe('UInt64')
      expect(types.get('occurred_at')).toBe("DateTime64(3, 'UTC')")
      expect(types.get('ingested_at')).toBe("DateTime64(3, 'UTC')")
      expect(types.get('conversion_rate_date')).toBe('Date')
      expect(types.get('conversion_rate')).toBe('Float64')
      expect(types.get('livemode')).toBe('UInt8')

      // Money is Int64 minor units, every one of them. A Float here would be the
      // one place a cent goes missing (03 §6.5, `money.ts`).
      for (const money of [
        'gross_minor',
        'fee_minor',
        'net_minor',
        'reporting_gross_minor',
        'reporting_net_minor',
      ]) {
        expect(types.get(money), money).toBe('Int64')
      }

      // LowCardinality on the enumerable dimensions, and NOT on the
      // high-cardinality provider handles.
      for (const dim of [
        'provider',
        'object_kind',
        'status',
        'currency',
        'reporting_currency',
        'conversion_source',
        'ingested_via',
      ]) {
        expect(types.get(dim), dim).toBe('LowCardinality(String)')
      }
      for (const id of ['object_id', 'order_id', 'checkout_session_id', 'customer_hash']) {
        expect(types.get(id), id).toBe('String')
      }

      // Nullable is avoided the way the raw table avoids it: an absent string is
      // the empty string, which saves a mark stream per read.
      for (const [name, type] of types) {
        expect(type, `${name} must not be Nullable`).not.toContain('Nullable')
      }
    })

    it('keeps no raw identifier column anywhere (D-102, the D5 privacy boundary)', async () => {
      const rows = await queryRows<{ name: string }>(
        `SELECT name FROM system.columns
          WHERE database = '${database}' AND table = 'revenue_events'`,
      )
      const names = rows.map((row) => row.name)
      expect(names.some((name) => /mail/i.test(name))).toBe(false)
      expect(names.some((name) => /(^|_)ip(_|$)/i.test(name))).toBe(false)
      expect(names).not.toContain('customer_id')
      expect(names).not.toContain('payload')
    })
  })

  describe('versioning and the argMax read rule', () => {
    it('supersedes a lower version before any merge has run', async () => {
      const siteId = randomUUID()
      await store.insertRows([
        factRow({ site_id: siteId, object_id: 'ch_v', version: 1, status: 'succeeded' }),
      ])
      await store.insertRows([
        factRow({
          site_id: siteId,
          object_id: 'ch_v',
          version: 2,
          status: 'refunded',
          net_minor: 9_680,
        }),
      ])

      // Two physical rows, unmerged.
      expect(
        await scalar(
          `SELECT count() FROM revenue_events WHERE site_id = '${siteId}' AND object_id = 'ch_v'`,
        ),
      ).toBe(2)

      // One logical row, and it is the newer state. No FINAL anywhere.
      const current = await store.readCurrentRows({
        siteId,
        fromMs: Date.parse('2026-07-01T00:00:00Z'),
        toMs: Date.parse('2026-08-01T00:00:00Z'),
      })
      const row = current.find((entry) => entry.objectId === 'ch_v')
      expect(row?.version).toBe(2)
      expect(row?.status).toBe('refunded')
    })

    it('is unaffected by insert order — a late lower version cannot win', async () => {
      const siteId = randomUUID()
      await store.insertRows([
        factRow({ site_id: siteId, object_id: 'ch_late', version: 5, status: 'refunded' }),
      ])
      await store.insertRows([
        factRow({ site_id: siteId, object_id: 'ch_late', version: 3, status: 'succeeded' }),
      ])

      const [row] = await store.readCurrentRows({
        siteId,
        fromMs: Date.parse('2026-07-01T00:00:00Z'),
        toMs: Date.parse('2026-08-01T00:00:00Z'),
      })
      expect(row?.version).toBe(5)
      expect(row?.status).toBe('refunded')
    })

    it('shows why a pre-filter on a versioned column is the trap', async () => {
      // Demonstration, not desired behaviour. The migration's read contract says
      // every filter on a column a version can change must be applied AFTER the
      // grouping; this is what happens when it is not.
      const siteId = randomUUID()
      await store.insertRows([
        factRow({ site_id: siteId, object_id: 'ch_trap', version: 1, status: 'succeeded' }),
      ])
      await store.insertRows([
        factRow({ site_id: siteId, object_id: 'ch_trap', version: 2, status: 'refunded' }),
      ])

      // Naive: filter first. The superseded `succeeded` version comes back.
      const naive = await scalar(
        `SELECT count() FROM (
           SELECT object_id, max(version) AS v FROM revenue_events
            WHERE site_id = '${siteId}' AND status = 'succeeded'
            GROUP BY object_id)`,
      )
      expect(naive).toBe(1)

      // Correct: group first, filter the current value after.
      const correct = await scalar(
        `SELECT count() FROM (
           SELECT object_id, argMax(status, version) AS status FROM revenue_events
            WHERE site_id = '${siteId}'
            GROUP BY object_id)
          WHERE status = 'succeeded'`,
      )
      expect(correct).toBe(0)
    })

    it('scopes a read to its own site', async () => {
      const siteA = randomUUID()
      const siteB = randomUUID()
      await store.insertRows([factRow({ site_id: siteA, object_id: 'ch_a' })])
      await store.insertRows([factRow({ site_id: siteB, object_id: 'ch_b' })])

      const rows = await store.readCurrentRows({
        siteId: siteA,
        fromMs: Date.parse('2026-07-01T00:00:00Z'),
        toMs: Date.parse('2026-08-01T00:00:00Z'),
      })
      expect(rows.map((row) => row.objectId)).toEqual(['ch_a'])
    })
  })

  describe('the content-derived deduplication token', () => {
    it('drops a REBUILT replay, not merely the same array twice', async () => {
      // The property the projection's insert-then-mark ordering rests on: the
      // crash between the insert and the marker means the next tick re-reads the
      // head and **builds the rows again from scratch**. Re-sending the same
      // array object would prove nothing about that — it would pass even if the
      // builder embedded a clock, which is exactly the bug this shape exists to
      // catch. So the second batch is rebuilt with a fresh call, the way a
      // re-projection produces it.
      const siteId = randomUUID()
      const build = (): RevenueEventRow[] => [
        factRow({ site_id: siteId, object_id: 'ch_dedup', version: 1 }),
      ]

      const first = await store.insertRows(build())
      const second = await store.insertRows(build())
      expect(second.token).toBe(first.token)
      expect(second.token).toBe(revenueEventsToken(build()))

      expect(
        await scalar(
          `SELECT count() FROM revenue_events WHERE site_id = '${siteId}' AND object_id = 'ch_dedup'`,
        ),
      ).toBe(1)
    })

    it('never drops a genuinely different batch', async () => {
      // The other half. A token that deduplicated too eagerly would lose facts,
      // which is far worse than writing one twice.
      //
      // `count() = 2` was the wrong observable: a background merge between the
      // insert and the read collapses the two versions into one row on its own
      // schedule, so the assertion failed for a batch that was accepted. The
      // version is merge-independent — a dropped second insert leaves `max` at 1
      // whether or not anything merged — and `OPTIMIZE … FINAL` first makes the
      // collapse happen at a known moment rather than at an unknown one.
      const siteId = randomUUID()
      await store.insertRows([factRow({ site_id: siteId, object_id: 'ch_diff', version: 1 })])
      await store.insertRows([
        factRow({ site_id: siteId, object_id: 'ch_diff', version: 2, status: 'refunded' }),
      ])
      await client.command({ query: `OPTIMIZE TABLE revenue_events FINAL` })

      const [current] = await queryRows<{ max_version: string; status: string }>(
        `SELECT toString(max(version)) AS max_version, argMax(status, version) AS status
           FROM revenue_events
          WHERE site_id = '${siteId}' AND object_id = 'ch_diff'`,
      )
      expect(current?.max_version).toBe('2')
      expect(current?.status).toBe('refunded')
    })

    it('writes nothing and mints no token for an empty batch', async () => {
      // An empty insert would consume a token and make it stop recognising the
      // real batch that follows.
      expect((await store.insertRows([])).token).toBeNull()
    })
  })

  describe('conversion columns (D2c)', () => {
    it('stores an unavailable conversion as zeros beside the original amounts', async () => {
      // The read contract CP5 has to honour: this row is an unconverted
      // remainder in `currency`/`gross_minor`, never revenue of zero.
      const siteId = randomUUID()
      await store.insertRows([
        factRow({
          site_id: siteId,
          object_id: 'ch_unconverted',
          currency: 'xyz',
          gross_minor: 12_345,
          net_minor: 12_345,
          reporting_currency: 'usd',
          reporting_gross_minor: 0,
          reporting_net_minor: 0,
          conversion_source: 'unavailable',
          conversion_rate: 0,
          conversion_rate_date: '1970-01-01',
        }),
      ])

      const [row] = await store.readCurrentRows({
        siteId,
        fromMs: Date.parse('2026-07-01T00:00:00Z'),
        toMs: Date.parse('2026-08-01T00:00:00Z'),
      })
      // Both currency columns are lowercase, so `currency = reporting_currency`
      // is a usable "was this converted?" predicate — see 0016's case rule.
      expect(row?.reportingCurrency).toBe('usd')
      expect(row?.conversionSource).toBe('unavailable')
      expect(row?.reportingGrossMinor).toBe(0)
      expect(row?.currency).toBe('xyz')
      expect(row?.grossMinor).toBe(12_345)
    })

    it('keeps every version of one object in exactly one monthly partition', async () => {
      // ReplacingMergeTree only replaces WITHIN a partition, so partitioning on
      // `occurred_at` — which never moves for a money object — is what lets the
      // engine ever collapse the versions at all. Partitioning by ingest time
      // would scatter them and no merge could ever reclaim a superseded version.
      //
      // Asserted as the EXACT partition set for this object, via
      // `partitionsOf`, rather than as "202607 is among the partitions": the
      // weaker form passes under wrong partitioning too, because some other
      // row's part would supply the expected value.
      const siteId = randomUUID()
      await store.insertRows([
        factRow({
          site_id: siteId,
          object_id: 'ch_part',
          version: 1,
          ingested_at: '2026-07-31 09:00:00.000',
        }),
      ])
      await store.insertRows([
        factRow({
          site_id: siteId,
          object_id: 'ch_part',
          version: 2,
          // Two months later. Under `PARTITION BY toYYYYMM(ingested_at)` this
          // second version would land in 202609 and the set below would have
          // two members.
          ingested_at: '2026-09-02 09:00:00.000',
        }),
      ])

      expect(await partitionsOf(siteId, 'ch_part')).toEqual(['202607'])

      // And a genuinely different `occurred_at` DOES get its own partition,
      // which is what proves the assertion above is measuring the partition key
      // rather than an accident of one insert.
      await store.insertRows([
        factRow({
          site_id: siteId,
          object_id: 'ch_part_aug',
          occurred_at: '2026-08-03 12:00:00.000',
        }),
      ])
      expect(await partitionsOf(siteId, 'ch_part_aug')).toEqual(['202608'])
    })
  })
})
