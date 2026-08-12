import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@clickhouse/client'
import { migrateClickHouse, splitStatements } from '@openanalytics/clickhouse'
import { createCapturedLogger } from '@openanalytics/testkit'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Same acceptance criterion as the Postgres suite, against ClickHouse.
 *
 * The interesting difference is that ClickHouse has no multi-statement
 * transaction, so the ledger's pending/applied states carry the recovery
 * information the Postgres transaction provides for free.
 */

const URL = process.env['TEST_CLICKHOUSE_URL']
const USERNAME = process.env['TEST_CLICKHOUSE_USER'] ?? 'default'
const PASSWORD = process.env['TEST_CLICKHOUSE_PASSWORD'] ?? ''

const describeIfClickHouse = URL ? describe : describe.skip

describe('statement splitting', () => {
  it('splits on semicolons and drops comments', () => {
    const statements = splitStatements(`
      -- create the table
      CREATE TABLE a (id UInt64) ENGINE = MergeTree ORDER BY id;

      -- and a view
      CREATE VIEW b AS SELECT * FROM a;
    `)

    expect(statements).toHaveLength(2)
    expect(statements[0]).toContain('CREATE TABLE a')
    expect(statements[0]).not.toContain('--')
    expect(statements[1]).toContain('CREATE VIEW b')
  })

  it('ignores trailing separators and blank fragments', () => {
    expect(splitStatements('SELECT 1;;\n\n;')).toEqual(['SELECT 1'])
  })
})

describeIfClickHouse('clickhouse migration runner', () => {
  const url = URL as string
  const databases: string[] = []
  let dir: string
  let database: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oa-ch-migrations-'))
    database = `migtest_${Date.now()}_${Math.floor(performance.now() * 1000)}`
    databases.push(database)
  })

  afterAll(async () => {
    const client = createClient({ url, username: USERNAME, password: PASSWORD })
    try {
      for (const name of databases) {
        await client.command({ query: `DROP DATABASE IF EXISTS ${name}` })
      }
    } finally {
      await client.close()
    }
  })

  function run(options: { dryRun?: boolean } = {}) {
    const { logger } = createCapturedLogger()
    return migrateClickHouse({
      url,
      username: USERNAME,
      password: PASSWORD,
      database,
      directory: dir,
      logger,
      ...options,
    })
  }

  it('creates the database and ledger, then applies migrations', async () => {
    await writeFile(
      join(dir, '0001_create_probe.sql'),
      `CREATE TABLE IF NOT EXISTS ${database}.probe (
         id UInt64,
         occurred_at DateTime64(3, 'UTC')
       ) ENGINE = MergeTree ORDER BY (id);`,
    )

    const result = await run()
    expect(result.applied).toEqual(['0001'])

    const client = createClient({ url, username: USERNAME, password: PASSWORD })
    try {
      const resultSet = await client.query({
        query: `SELECT count() AS c FROM system.tables WHERE database = '${database}' AND name = 'probe'`,
        format: 'JSONEachRow',
      })
      const rows = await resultSet.json<{ c: string }>()
      expect(Number(rows[0]?.c)).toBe(1)
    } finally {
      await client.close()
    }
  })

  it('is idempotent on a second run', async () => {
    await writeFile(
      join(dir, '0001_probe2.sql'),
      `CREATE TABLE IF NOT EXISTS ${database}.probe2 (id UInt64) ENGINE = MergeTree ORDER BY id;`,
    )

    expect((await run()).applied).toEqual(['0001'])
    expect((await run()).applied).toEqual([])
  })

  it('writes a pending row AND an applied row per version, which FINAL collapses', async () => {
    /**
     * Not a defect, and pinned here because it looked like one.
     *
     * The M12 CP7 deploy observed migration `0018` "recorded twice" in
     * `analytics.schema_migrations`, same checksum, 80 ms apart. That is the
     * design: `applyOne` inserts `pending` before running the DDL and `applied`
     * after, because ClickHouse has no multi-statement transaction and a crash
     * between the two has to be visible. The ledger is
     * `ReplacingMergeTree(applied_at) ORDER BY version`, so a raw `SELECT`
     * before the background merge sees both rows — 80 ms apart is simply how
     * long the DDL took — while every read the runner makes uses `FINAL` and
     * filters `state = 'applied'`. The deploy's own `FINAL` count of 18 was the
     * correct answer.
     *
     * What this asserts is exactly that pair, so the next operator who runs a
     * non-FINAL `SELECT` finds a test explaining it rather than filing it again.
     */
    await writeFile(
      join(dir, '0001_probe_ledger.sql'),
      `CREATE TABLE IF NOT EXISTS ${database}.probe_ledger (id UInt64) ENGINE = MergeTree ORDER BY id;`,
    )
    expect((await run()).applied).toEqual(['0001'])

    const client = createClient({ url, username: USERNAME, password: PASSWORD })
    try {
      const raw = await (
        await client.query({
          query: `SELECT state, checksum FROM ${database}.schema_migrations
                   WHERE version = '0001' ORDER BY applied_at`,
          format: 'JSONEachRow',
        })
      ).json<{ state: string; checksum: string }>()

      // Two rows, one key, in order — and the SAME checksum on both, which is
      // what makes them look like a duplicate to a reader that ignores `state`.
      expect(raw.map((row) => row.state)).toEqual(['pending', 'applied'])
      expect(raw[0]?.checksum).toBe(raw[1]?.checksum)

      // FINAL is what the runner reads through, and it keeps the later row.
      const collapsed = await (
        await client.query({
          query: `SELECT state FROM ${database}.schema_migrations FINAL WHERE version = '0001'`,
          format: 'JSONEachRow',
        })
      ).json<{ state: string }>()
      expect(collapsed).toHaveLength(1)
      expect(collapsed[0]?.state).toBe('applied')
    } finally {
      await client.close()
    }
  })

  it('refuses to run when an applied migration was edited', async () => {
    const file = join(dir, '0001_probe3.sql')
    await writeFile(
      file,
      `CREATE TABLE IF NOT EXISTS ${database}.probe3 (id UInt64) ENGINE = MergeTree ORDER BY id;`,
    )
    await run()

    await writeFile(
      file,
      `CREATE TABLE IF NOT EXISTS ${database}.probe3 (id Int64) ENGINE = MergeTree ORDER BY id;`,
    )

    await expect(run()).rejects.toThrow(/Checksum drift/)
  })

  it('reports pending work without applying it in dry-run mode', async () => {
    await writeFile(
      join(dir, '0001_dry.sql'),
      `CREATE TABLE IF NOT EXISTS ${database}.dry_probe (id UInt64) ENGINE = MergeTree ORDER BY id;`,
    )

    const result = await run({ dryRun: true })
    expect(result.applied).toEqual([])
    expect(result.pending).toEqual(['0001'])
  })
})
