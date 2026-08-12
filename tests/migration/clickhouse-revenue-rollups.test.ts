import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createClient } from '@clickhouse/client'
import {
  createRevenueEventsStore,
  createRevenueRollupsStore,
  migrateClickHouse,
  type RevenueEventRow,
} from '@openanalytics/clickhouse'
import { createCapturedLogger } from '@openanalytics/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  affectedBucketSecondsOf,
  aggregateRevenueBuckets,
  planRevenueRollupSwap,
  toRollupFact,
} from '../../apps/worker/src/revenue/rollup-plan.ts'
import { revenueRollupRange, rollUpRevenueSite } from '../../apps/worker/src/revenue/rollup.ts'
import { NOOP_METRICS } from '@openanalytics/observability'

/**
 * Migration 0018 against a live ClickHouse (ADR-0033, D7). Milestone 12
 * Checkpoint 5.
 *
 * Only a real server can answer these, because each is about the engine rather
 * than about our code:
 *
 * 1. **The two rollups are what D7 specifies** — `ReplacingMergeTree(generation)`
 *    keyed on `(site_id, bucket_start)`, partitioned by month, with a
 *    deduplication window. Without the window the content-derived insert token
 *    is accepted and silently ignored (ADR-0005 measured a 3x from exactly that).
 * 2. **Neither is a materialized view, and no MV targets them.** Revenue is
 *    refundable and versioned, so an insert-only view is structurally wrong —
 *    D-211's rule, asserted against `system.tables` rather than against the
 *    migration text (which the always-run unit guard already covers).
 * 3. **A higher generation supersedes a lower one under the argMax read, BEFORE
 *    any merge has run.** Replacing is a space reclamation, not a correctness
 *    mechanism, and `FINAL` is never used. A refund that lands later has to be
 *    visible immediately, not after a merge somebody scheduled.
 * 4. **The whole loop is idempotent end to end**: recompute → compare → swap,
 *    twice, writes once. That is the property the attribution job's 15-minute
 *    staleness sweep rests on.
 * 5. **Facts and buckets agree** — the sign rules, applied through the real
 *    argMax fact read rather than through an in-memory fixture.
 *
 * Runs on the migration/default credential like every other ClickHouse suite:
 * `oa_ingest`'s grant on these tables is a users-file entry on the deployed
 * server (CP7) and does not exist in CI. The grant is proven by the deploy step;
 * the statements are proven here.
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

const DAY_START = '2026-07-20T00:00:00.000Z'
const HOUR_MS = Date.parse('2026-07-20T10:00:00.000Z')

function factRow(
  overrides: Partial<RevenueEventRow> & Pick<RevenueEventRow, 'site_id' | 'object_id'>,
): RevenueEventRow {
  return {
    provider: 'stripe',
    object_kind: 'charge',
    version: 1,
    occurred_at: '2026-07-20 10:00:00.000',
    status: 'succeeded',
    livemode: 1,
    currency: 'eur',
    gross_minor: 10_000,
    fee_minor: 500,
    fee_currency: 'eur',
    net_minor: 9_500,
    reporting_currency: 'usd',
    reporting_gross_minor: 10_800,
    reporting_net_minor: 10_260,
    conversion_source: 'ecb',
    conversion_rate: 1.08,
    conversion_rate_date: '2026-07-20',
    parent_object_id: '',
    order_id: 'pi_1',
    checkout_session_id: '',
    client_reference_id: '',
    subscription_id: '',
    product_id: '',
    product_name: '',
    customer_hash: '',
    external_user_hash: '',
    ingested_via: 'webhook',
    ingested_at: '2026-07-20 10:00:05.000',
    ...overrides,
  }
}

describeIfClickHouse('ClickHouse migration 0018 — the revenue rollups', () => {
  const url = URL_ as string
  const database = `m12roll_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let client: ReturnType<typeof createClient>
  let facts: ReturnType<typeof createRevenueEventsStore>
  let rollups: ReturnType<typeof createRevenueRollupsStore>

  const queryRows = async <T>(query: string): Promise<T[]> => {
    const resultSet = await client.query({ query, format: 'JSONEachRow' })
    return await resultSet.json<T>()
  }

  /** Inserts fact rows without the store's content token, so a test can write
   * the same logical row twice at different versions. */
  const insertFacts = async (rows: readonly RevenueEventRow[]): Promise<void> => {
    await client.insert({
      table: 'revenue_events',
      values: rows,
      format: 'JSONEachRow',
      clickhouse_settings: { insert_deduplication_token: randomUUID() },
    })
  }

  /** The current generation of every bucket, read the way the api's gateway
   * operation reads it — argMax, never FINAL. */
  const currentBuckets = async (
    table: string,
    siteId: string,
  ): Promise<{ bucket: string; generation: number; net: number; charge: number }[]> => {
    const rows = await queryRows<Record<string, string>>(
      `SELECT
         formatDateTime(rr.bucket_start, '%F %T') AS bucket,
         max(rr.generation) AS generation,
         argMax(rr.net_minor, rr.generation) AS net,
         argMax(rr.charge_gross_minor, rr.generation) AS charge
       FROM ${table} AS rr
       WHERE rr.site_id = '${siteId}'
       GROUP BY rr.site_id, rr.bucket_start
       ORDER BY bucket`,
    )
    return rows.map((row) => ({
      bucket: row['bucket'] as string,
      generation: Number(row['generation']),
      net: Number(row['net']),
      charge: Number(row['charge']),
    }))
  }

  const deps = () => {
    const { logger } = createCapturedLogger()
    return { logger, metrics: NOOP_METRICS, rollups }
  }

  /**
   * One pass, at a caller-chosen generation.
   *
   * The generation is a parameter because CP5 mints it from the lease claim's
   * per-site counter rather than from `max(stored) + 1`, so every test here has
   * to say which run it is simulating — which is also what makes the
   * supersede-under-lease-theft case expressible at all.
   */
  let generation = 0
  const runRollup = async (siteId: string) => {
    generation += 1
    const { range } = revenueRollupRange({
      fromMs: Date.parse(DAY_START),
      toMs: Date.parse('2026-07-21T00:00:00.000Z'),
    })
    const current = await facts.readCurrentRows({
      siteId,
      fromMs: range.loMs,
      toMs: range.hiMs,
    })
    return await rollUpRevenueSite(deps(), {
      siteId,
      range,
      facts: current.map(toRollupFact),
      generation,
      computedAtMs: Date.parse('2026-07-21T01:00:00.000Z'),
    })
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
    facts = createRevenueEventsStore({ url, username: USERNAME, password: PASSWORD, database })
    rollups = createRevenueRollupsStore({ url, username: USERNAME, password: PASSWORD, database })
  }, 180_000)

  afterAll(async () => {
    await facts?.close()
    await rollups?.close()
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database}` })
      await client.close()
    }
  })

  describe('schema', () => {
    it('creates both rollups with the engine, keys and window D7 specifies', async () => {
      const rows = await queryRows<{
        name: string
        engine_full: string
        partition_key: string
        sorting_key: string
      }>(
        `SELECT name, engine_full, partition_key, sorting_key
           FROM system.tables
          WHERE database = '${database}' AND name IN ('revenue_1h', 'revenue_1d')
          ORDER BY name`,
      )
      expect(rows.map((row) => row.name)).toEqual(['revenue_1d', 'revenue_1h'])
      for (const row of rows) {
        // The generation IS the replacing column; without it a swap would be an
        // append and every recompute would double the totals.
        expect(row.engine_full, row.name).toContain('ReplacingMergeTree(generation)')
        expect(row.partition_key, row.name).toBe('toYYYYMM(bucket_start)')
        expect(row.sorting_key, row.name).toBe('site_id, bucket_start')
        // Without the window the content-derived insert token is accepted and
        // silently ignored (ADR-0005 measured a 3x from exactly that).
        expect(row.engine_full, row.name).toContain('non_replicated_deduplication_window = 1000')
      }
    })

    it('stores every money column as Int64 and every count as UInt64', async () => {
      const rows = await queryRows<{ name: string; type: string }>(
        `SELECT name, type FROM system.columns
          WHERE database = '${database}' AND table = 'revenue_1h'
          ORDER BY name`,
      )
      const types = new Map(rows.map((row) => [row.name, row.type]))
      for (const column of [
        'charge_gross_minor',
        'refund_minor',
        'dispute_withdrawn_minor',
        'dispute_reinstated_minor',
        'fee_minor',
        'net_minor',
      ]) {
        // Int64, not UInt64: `net_minor` is genuinely negative in a bucket whose
        // refunds exceed its charges, and `fee_minor` is signed by the movement
        // it belongs to.
        expect(types.get(column), column).toBe('Int64')
      }
      for (const column of [
        'charge_count',
        'refund_count',
        'dispute_count',
        'unconverted_count',
        'generation',
      ]) {
        expect(types.get(column), column).toBe('UInt64')
      }
      expect(types.get('bucket_start')).toBe("DateTime('UTC')")
      expect(types.get('computed_at')).toBe("DateTime64(3, 'UTC')")
      // The remainder is a COUNT here; its per-currency totals are read from the
      // facts, because a currency dimension would change the unit of replacement.
      expect(types.has('currency')).toBe(false)
    })

    it('is not a materialized view, and nothing targets it as one', async () => {
      const views = await queryRows<{ name: string }>(
        `SELECT name FROM system.tables
          WHERE database = '${database}' AND engine = 'MaterializedView'`,
      )
      for (const view of views) expect(view.name).not.toMatch(/revenue/u)

      const engines = await queryRows<{ name: string; engine: string }>(
        `SELECT name, engine FROM system.tables
          WHERE database = '${database}' AND name IN ('revenue_1h', 'revenue_1d')`,
      )
      for (const row of engines) expect(row.engine).toBe('ReplacingMergeTree')
    })
  })

  describe('the swap', () => {
    it('supersedes a lower generation under argMax, with no merge run', async () => {
      const siteId = randomUUID()
      await insertFacts([factRow({ site_id: siteId, object_id: 'ch_1' })])
      const first = await runRollup(siteId)
      expect(first.changed).toBe(2)

      const afterFirst = await currentBuckets('revenue_1h', siteId)
      expect(afterFirst).toHaveLength(1)
      const firstGeneration = afterFirst[0]?.generation as number
      expect(firstGeneration).toBeGreaterThan(0)
      expect(afterFirst[0]?.charge).toBe(10_800)
      expect(afterFirst[0]?.net).toBe(10_260)

      // A refund lands in the same hour under a new fact. The bucket must change
      // immediately — a merge is a space reclamation, not a correctness step.
      await insertFacts([
        factRow({
          site_id: siteId,
          object_id: 're_1',
          object_kind: 'refund',
          reporting_gross_minor: 4_000,
          reporting_net_minor: 4_000,
          gross_minor: 3_700,
          net_minor: 3_700,
          parent_object_id: 'ch_1',
        }),
      ])
      const second = await runRollup(siteId)
      expect(second.changed).toBe(2)

      const afterSecond = await currentBuckets('revenue_1h', siteId)
      expect(afterSecond).toHaveLength(1)
      expect(afterSecond[0]?.generation).toBeGreaterThan(firstGeneration)
      expect(afterSecond[0]?.net).toBe(10_260 - 4_000)
      // The charge's gross is untouched — the refund carries the negative.
      expect(afterSecond[0]?.charge).toBe(10_800)

      // Both generations are still physically present; the read is what selects.
      const raw = await queryRows<{ n: string }>(
        `SELECT count()::text AS n FROM revenue_1h WHERE site_id = '${siteId}'`,
      )
      expect(Number(raw[0]?.n)).toBe(2)
    })

    it('writes nothing on a re-run over an unchanged range', async () => {
      const siteId = randomUUID()
      await insertFacts([factRow({ site_id: siteId, object_id: 'ch_1' })])
      await runRollup(siteId)
      const again = await runRollup(siteId)

      expect(again.changed).toBe(0)
      const raw = await queryRows<{ n: string }>(
        `SELECT count()::text AS n FROM revenue_1h WHERE site_id = '${siteId}'`,
      )
      // One row per unit, not two: the planner compared before it wrote. Without
      // this the 15-minute staleness sweep would grow a generation per bucket
      // four times an hour, forever.
      expect(Number(raw[0]?.n)).toBe(1)
    })

    it('re-versions a fact and the bucket follows', async () => {
      const siteId = randomUUID()
      await insertFacts([factRow({ site_id: siteId, object_id: 'ch_1' })])
      await runRollup(siteId)

      // The same object at a higher version, now failed: it moved no money.
      await insertFacts([
        factRow({ site_id: siteId, object_id: 'ch_1', version: 2, status: 'failed' }),
      ])
      const after = await runRollup(siteId)
      expect(after.changed).toBe(2)

      const buckets = await currentBuckets('revenue_1h', siteId)
      expect(buckets[0]?.charge).toBe(0)
      expect(buckets[0]?.net).toBe(0)
      expect(buckets[0]?.generation).toBeGreaterThan(1)
    })

    it('keeps the day rollup equal to the sum of its hours', async () => {
      const siteId = randomUUID()
      await insertFacts([
        factRow({ site_id: siteId, object_id: 'ch_1', occurred_at: '2026-07-20 10:00:00.000' }),
        factRow({ site_id: siteId, object_id: 'ch_2', occurred_at: '2026-07-20 15:30:00.000' }),
      ])
      await runRollup(siteId)

      const hours = await currentBuckets('revenue_1h', siteId)
      const days = await currentBuckets('revenue_1d', siteId)
      expect(hours).toHaveLength(2)
      expect(days).toHaveLength(1)
      expect(days[0]?.bucket).toBe('2026-07-20 00:00:00')
      expect(days[0]?.charge).toBe(hours.reduce((total, hour) => total + hour.charge, 0))
      expect(days[0]?.net).toBe(hours.reduce((total, hour) => total + hour.net, 0))
    })

    it('excludes an unconverted fact from the money and counts it separately', async () => {
      const siteId = randomUUID()
      await insertFacts([
        factRow({ site_id: siteId, object_id: 'ch_1' }),
        factRow({
          site_id: siteId,
          object_id: 'ch_isk',
          currency: 'isk',
          conversion_source: 'unavailable',
          conversion_rate: 0,
          conversion_rate_date: '1970-01-01',
          reporting_gross_minor: 0,
          reporting_net_minor: 0,
        }),
      ])
      await runRollup(siteId)

      const rows = await queryRows<Record<string, string>>(
        `SELECT
           argMax(rr.charge_gross_minor, rr.generation) AS charge,
           argMax(rr.charge_count, rr.generation) AS charge_count,
           argMax(rr.unconverted_count, rr.generation) AS unconverted
         FROM revenue_1h AS rr
         WHERE rr.site_id = '${siteId}'
         GROUP BY rr.site_id, rr.bucket_start`,
      )
      expect(Number(rows[0]?.['charge'])).toBe(10_800)
      expect(Number(rows[0]?.['charge_count'])).toBe(1)
      // Never zero-folded into the total; surfaced as its own count, with the
      // original-currency amounts read from the facts by the summary endpoint.
      expect(Number(rows[0]?.['unconverted'])).toBe(1)
    })

    it('reads facts back through argMax and agrees with the pure planner', async () => {
      // The end-to-end shape: the real fact read feeding the real aggregation.
      const siteId = randomUUID()
      await insertFacts([
        factRow({ site_id: siteId, object_id: 'ch_1' }),
        factRow({ site_id: siteId, object_id: 'ch_1', version: 2, reporting_net_minor: 9_000 }),
      ])
      const { range } = revenueRollupRange({
        fromMs: Date.parse(DAY_START),
        toMs: Date.parse('2026-07-21T00:00:00.000Z'),
      })
      const current = await facts.readCurrentRows({
        siteId,
        fromMs: range.loMs,
        toMs: range.hiMs,
      })
      // One current fact, at the higher version — never two.
      expect(current).toHaveLength(1)
      expect(current[0]?.version).toBe(2)

      const rollupFacts = current.map(toRollupFact)
      const plan = planRevenueRollupSwap({
        siteId,
        recomputed: aggregateRevenueBuckets(rollupFacts, '1h'),
        stored: [],
        affectedBucketSeconds: affectedBucketSecondsOf({
          facts: rollupFacts,
          stored: [],
          unit: '1h',
        }),
        generation: 1,
        computedAtMs: Date.parse('2026-07-21T01:00:00.000Z'),
      })
      expect(plan.rows).toHaveLength(1)
      expect(plan.rows[0]?.net_minor).toBe(9_000)
      expect(plan.rows[0]?.bucket_start).toBe('2026-07-20 10:00:00')
      expect(new Date(HOUR_MS).toISOString()).toBe('2026-07-20T10:00:00.000Z')
    })

    it('does not let a stale run overwrite a newer one, even writing later', async () => {
      // The lease-theft shape, against the real engine. The "thief" writes
      // generation 9 and the slow "victim" writes generation 8 afterwards. With
      // `max(stored) + 1` both would have computed the same number from the same
      // stored state and the outcome would be undefined per column; with
      // claim-minted generations the newer run wins regardless of write order.
      const siteId = randomUUID()
      await insertFacts([factRow({ site_id: siteId, object_id: 'ch_1' })])
      const { range } = revenueRollupRange({
        fromMs: Date.parse(DAY_START),
        toMs: Date.parse('2026-07-21T00:00:00.000Z'),
      })
      const current = await facts.readCurrentRows({ siteId, fromMs: range.loMs, toMs: range.hiMs })
      const shared = current.map(toRollupFact)

      await rollUpRevenueSite(deps(), {
        siteId,
        range,
        facts: shared,
        generation: 9,
        computedAtMs: Date.parse('2026-07-21T01:00:00.000Z'),
      })
      // The victim recomputed from a fact set that has since been superseded,
      // and it writes second.
      await rollUpRevenueSite(deps(), {
        siteId,
        range,
        facts: shared.map((fact) => ({ ...fact, reportingNetMinor: 1 })),
        generation: 8,
        computedAtMs: Date.parse('2026-07-21T01:00:00.000Z'),
      })

      const buckets = await currentBuckets('revenue_1h', siteId)
      expect(buckets).toHaveLength(1)
      expect(buckets[0]?.generation).toBe(9)
      expect(buckets[0]?.net).toBe(10_260)
    })

    it('does not leak one site’s buckets into another’s', async () => {
      const siteA = randomUUID()
      const siteB = randomUUID()
      await insertFacts([
        factRow({ site_id: siteA, object_id: 'ch_a' }),
        factRow({
          site_id: siteB,
          object_id: 'ch_b',
          reporting_gross_minor: 1,
          reporting_net_minor: 1,
        }),
      ])
      await runRollup(siteA)

      expect(await currentBuckets('revenue_1h', siteA)).toHaveLength(1)
      // B was never rolled up: the whole pipeline is per site, from the claim to
      // the insert.
      expect(await currentBuckets('revenue_1h', siteB)).toHaveLength(0)
    })
  })
})
