import {
  loadMigrations,
  planMigrations,
  type AppliedMigration,
  type MigrationFile,
} from '@openanalytics/migrations'
import type { Logger } from '@openanalytics/observability'
import { Client } from 'pg'

/**
 * Postgres migration runner.
 *
 * Each migration runs inside a transaction together with its ledger insert, so a
 * migration cannot be recorded as applied unless its DDL actually committed.
 * That single property is what lets an empty database be rebuilt from the
 * repository — the failure the legacy system could not recover from
 * (docs snapshot 01 §3.6).
 *
 * There are two independent migration streams over one database, each with its
 * own directory and its own ledger table: the product stream
 * (`packages/postgres/migrations`, ledger `schema_migrations`) and the cloud
 * stream (`packages/postgres/cloud/migrations`, ledger
 * `cloud_schema_migrations`). Deploy order is product first, then cloud — the
 * cloud stream references product tables, never the other way around. The
 * checksum/ordering rules (`@openanalytics/migrations`) hold within each
 * stream.
 *
 * A separate advisory lock keeps two concurrent deploys from racing. The lock
 * key is shared by both streams on purpose: the streams touch the same tables
 * (`sites`, `usage_batch_deltas`), so their DDL must serialize too.
 */

export const MIGRATIONS_TABLE = 'schema_migrations'
export const CLOUD_MIGRATIONS_TABLE = 'cloud_schema_migrations'

/** Arbitrary but fixed: the advisory lock key for schema migrations. */
const ADVISORY_LOCK_KEY = 4_310_710_001

/** Ledger names are compile-time constants, never user input; guarded anyway so
 * a future caller cannot turn the interpolated DDL below into an injection. */
const LEDGER_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/

function createLedgerSql(ledgerTable: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${ledgerTable} (
  version     text PRIMARY KEY,
  name        text NOT NULL,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  duration_ms integer NOT NULL
)
`
}

export interface PostgresMigrateOptions {
  readonly connectionString: string
  readonly directory: string
  /** Ledger table for this stream. Defaults to the product stream's. */
  readonly ledgerTable?: string
  readonly logger: Logger
  /** Reports drift and pending work without applying anything. */
  readonly dryRun?: boolean
}

export interface MigrateResult {
  readonly applied: readonly string[]
  readonly pending: readonly string[]
  readonly alreadyApplied: number
}

async function readLedger(client: Client, ledgerTable: string): Promise<AppliedMigration[]> {
  const result = await client.query<{
    version: string
    name: string
    checksum: string
    applied_at: Date
  }>(`SELECT version, name, checksum, applied_at FROM ${ledgerTable} ORDER BY version`)

  return result.rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }))
}

async function applyOne(
  client: Client,
  ledgerTable: string,
  migration: MigrationFile,
  logger: Logger,
): Promise<void> {
  const startedAt = Date.now()
  await client.query('BEGIN')
  try {
    await client.query(migration.sql)
    await client.query(
      `INSERT INTO ${ledgerTable} (version, name, checksum, duration_ms)
       VALUES ($1, $2, $3, $4)`,
      [migration.version, migration.name, migration.checksum, Date.now() - startedAt],
    )
    await client.query('COMMIT')
    logger.info('migration_applied', {
      store: 'postgres',
      ledger: ledgerTable,
      version: migration.version,
      name: migration.name,
      duration_ms: Date.now() - startedAt,
    })
  } catch (err) {
    await client.query('ROLLBACK')
    logger.error('migration_failed', {
      store: 'postgres',
      ledger: ledgerTable,
      version: migration.version,
      name: migration.name,
      retryable: false,
      err,
    })
    throw err
  }
}

export async function migratePostgres(options: PostgresMigrateOptions): Promise<MigrateResult> {
  const ledgerTable = options.ledgerTable ?? MIGRATIONS_TABLE
  if (!LEDGER_NAME_PATTERN.test(ledgerTable)) {
    throw new Error(`Invalid migration ledger table name: ${JSON.stringify(ledgerTable)}`)
  }

  const files = await loadMigrations(options.directory)
  const client = new Client({ connectionString: options.connectionString })
  await client.connect()

  try {
    await client.query(`SELECT pg_advisory_lock($1)`, [ADVISORY_LOCK_KEY])
    try {
      await client.query(createLedgerSql(ledgerTable))

      const applied = await readLedger(client, ledgerTable)
      // Throws on checksum drift, missing files or out-of-order versions.
      const pending = planMigrations(files, applied)

      if (options.dryRun) {
        return {
          applied: [],
          pending: pending.map((file) => file.version),
          alreadyApplied: applied.length,
        }
      }

      const appliedNow: string[] = []
      for (const migration of pending) {
        await applyOne(client, ledgerTable, migration, options.logger)
        appliedNow.push(migration.version)
      }

      return { applied: appliedNow, pending: [], alreadyApplied: applied.length }
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY])
    }
  } finally {
    await client.end()
  }
}
