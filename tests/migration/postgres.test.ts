import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migratePostgres } from '@openanalytics/postgres'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client } from 'pg'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Proves the acceptance criterion directly: an *empty* Postgres can be built by
 * the runner, and an edit to an applied migration is caught rather than silently
 * producing a database that no longer matches the repository.
 *
 * Skipped when no database is configured, so a contributor without Docker can
 * still run the rest of the suite. CI always provides one.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

describeIfPostgres('postgres migration runner', () => {
  const connectionString = CONNECTION_STRING as string
  const createdSchemas: string[] = []
  let dir: string
  let schema: string
  let scopedConnectionString: string

  /**
   * A fresh schema *per test*, not per file.
   *
   * The ledger lives in the database, so a schema shared across tests carries
   * the previous test's applied `0001` into the next one. Every test here
   * writes its own `0001_*.sql` with different contents, so a shared schema
   * makes the runner correctly report checksum drift — and the suite would be
   * measuring leaked state rather than the behaviour under test. Each test
   * needs to start from genuinely empty, which is the whole claim being proven.
   */
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oa-pg-migrations-'))

    schema = `migtest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
    createdSchemas.push(schema)

    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
    } finally {
      await admin.end()
    }

    const url = new URL(connectionString)
    url.searchParams.set('options', `-c search_path=${schema}`)
    scopedConnectionString = url.toString()
  })

  afterAll(async () => {
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      for (const name of createdSchemas) {
        await admin.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
      }
    } finally {
      await admin.end()
    }
  })

  it('bootstraps an empty database and records the ledger', async () => {
    await writeFile(
      join(dir, '0001_create_probe.sql'),
      'CREATE TABLE probe (id integer PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());',
    )

    const { logger } = createCapturedLogger()
    const result = await migratePostgres({
      connectionString: scopedConnectionString,
      directory: dir,
      logger,
    })

    expect(result.applied).toEqual(['0001'])

    const client = new Client({ connectionString: scopedConnectionString })
    await client.connect()
    try {
      const ledger = await client.query('SELECT version, name FROM schema_migrations')
      expect(ledger.rows).toEqual([{ version: '0001', name: 'create_probe' }])

      const table = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'probe'`,
        [schema],
      )
      expect(table.rowCount).toBe(1)
    } finally {
      await client.end()
    }
  })

  it('is idempotent on a second run', async () => {
    await writeFile(join(dir, '0001_create_probe2.sql'), 'CREATE TABLE probe2 (id integer);')

    const { logger } = createCapturedLogger()
    const first = await migratePostgres({
      connectionString: scopedConnectionString,
      directory: dir,
      logger,
    })
    const second = await migratePostgres({
      connectionString: scopedConnectionString,
      directory: dir,
      logger,
    })

    expect(first.applied).toEqual(['0001'])
    expect(second.applied).toEqual([])
  })

  it('refuses to run when an applied migration was edited', async () => {
    const file = join(dir, '0001_create_probe3.sql')
    await writeFile(file, 'CREATE TABLE probe3 (id integer);')

    const { logger } = createCapturedLogger()
    await migratePostgres({ connectionString: scopedConnectionString, directory: dir, logger })

    // Same version, different content: the live schema no longer matches the file.
    await writeFile(file, 'CREATE TABLE probe3 (id bigint);')

    await expect(
      migratePostgres({ connectionString: scopedConnectionString, directory: dir, logger }),
    ).rejects.toThrow(/Checksum drift/)
  })

  it('does not record a migration whose DDL failed', async () => {
    // Otherwise the ledger would claim a schema change that never committed, and
    // the next empty-database build would skip it.
    await writeFile(join(dir, '0001_broken.sql'), 'CREATE TABLE ((( invalid;')

    const { logger } = createCapturedLogger()
    await expect(
      migratePostgres({ connectionString: scopedConnectionString, directory: dir, logger }),
    ).rejects.toThrow()

    const client = new Client({ connectionString: scopedConnectionString })
    await client.connect()
    try {
      const ledger = await client.query(
        `SELECT version FROM schema_migrations WHERE version = '0001'`,
      )
      expect(ledger.rowCount).toBe(0)
    } finally {
      await client.end()
    }
  })

  it('reports pending work without applying it in dry-run mode', async () => {
    await writeFile(join(dir, '0001_dry.sql'), 'CREATE TABLE dry_probe (id integer);')

    const { logger } = createCapturedLogger()
    const result = await migratePostgres({
      connectionString: scopedConnectionString,
      directory: dir,
      logger,
      dryRun: true,
    })

    expect(result.applied).toEqual([])
    expect(result.pending).toEqual(['0001'])
  })
})
