import {
  loadMigrations,
  planMigrations,
  type AppliedMigration,
  type MigrationFile,
} from '@openanalytics/migrations'
import type { Logger } from '@openanalytics/observability'
import { createClient, type ClickHouseClient } from '@clickhouse/client'

/**
 * ClickHouse migration runner.
 *
 * Docs snapshot 02 §15: ClickHouse DDL never runs from a request handler — the
 * legacy import route created tables and issued `ALTER DELETE` at runtime
 * (docs snapshot 01 §11.3). Schema changes are versioned files applied by this
 * runner, using a dedicated high-privilege credential that the ingest and read
 * users do not have.
 *
 * ClickHouse has no multi-statement transaction, so the ledger cannot be written
 * atomically with the DDL the way it is in Postgres. The runner compensates:
 *
 * - The ledger row is marked `pending` before the DDL and `applied` after it, so
 *   a crash in between is visible as an unfinished migration rather than being
 *   silently skipped on the next run.
 * - Statements are split and applied one at a time, so a partial failure names
 *   the exact statement.
 * - Migrations are expected to be idempotent (`IF NOT EXISTS`), which makes a
 *   re-run after an interrupted apply safe.
 *
 * Migration statements run with `options.database` as the session default, so a
 * file names its tables unqualified. That is what lets the same files build the
 * production `analytics` database and a throwaway one in CI — the empty-database
 * bootstrap docs snapshot 02 §15 requires. A file that hard-coded `analytics.`
 * could only ever be applied to one database, and would therefore be untestable
 * anywhere it was not already applied.
 */

export const MIGRATIONS_TABLE = 'schema_migrations'

const CREATE_LEDGER_SQL = (database: string) => `
CREATE TABLE IF NOT EXISTS ${database}.${MIGRATIONS_TABLE} (
  version     String,
  name        String,
  checksum    String,
  state       Enum8('pending' = 1, 'applied' = 2),
  applied_at  DateTime64(3, 'UTC') DEFAULT now64(3),
  duration_ms UInt32
)
ENGINE = ReplacingMergeTree(applied_at)
ORDER BY version
`

export interface ClickHouseMigrateOptions {
  readonly url: string
  readonly username: string
  readonly password: string
  readonly database: string
  readonly directory: string
  readonly logger: Logger
  readonly dryRun?: boolean
}

export interface MigrateResult {
  readonly applied: readonly string[]
  readonly pending: readonly string[]
  readonly alreadyApplied: number
}

/**
 * Splits a migration file into statements.
 *
 * Naive on purpose: it is a semicolon split that skips comments and blank
 * fragments. Migration files are hand-written and reviewed, so they stay within
 * what this handles rather than the runner growing a SQL parser.
 */
export function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((statement) =>
      statement
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((statement) => statement.length > 0)
}

async function readLedger(
  client: ClickHouseClient,
  database: string,
  logger: Logger,
): Promise<AppliedMigration[]> {
  const resultSet = await client.query({
    query: `
      SELECT version, name, checksum, state, applied_at
      FROM ${database}.${MIGRATIONS_TABLE} FINAL
      ORDER BY version
    `,
    format: 'JSONEachRow',
  })

  const rows = await resultSet.json<{
    version: string
    name: string
    checksum: string
    state: 'pending' | 'applied'
    applied_at: string
  }>()

  const unfinished = rows.filter((row) => row.state === 'pending')
  if (unfinished.length > 0) {
    // Surfaced rather than swallowed: an interrupted apply needs a human to
    // confirm the target state before the next migration stacks on top of it.
    logger.warn('migration_ledger_unfinished', {
      store: 'clickhouse',
      versions: unfinished.map((row) => row.version),
    })
  }

  return rows
    .filter((row) => row.state === 'applied')
    .map((row) => ({
      version: row.version,
      name: row.name,
      checksum: row.checksum,
      appliedAt: new Date(row.applied_at),
    }))
}

async function applyOne(
  client: ClickHouseClient,
  database: string,
  migration: MigrationFile,
  logger: Logger,
): Promise<void> {
  const startedAt = Date.now()

  await client.insert({
    table: `${database}.${MIGRATIONS_TABLE}`,
    values: [
      {
        version: migration.version,
        name: migration.name,
        checksum: migration.checksum,
        state: 'pending',
        duration_ms: 0,
      },
    ],
    format: 'JSONEachRow',
  })

  try {
    for (const statement of splitStatements(migration.sql)) {
      await client.command({ query: statement })
    }
  } catch (err) {
    logger.error('migration_failed', {
      store: 'clickhouse',
      version: migration.version,
      name: migration.name,
      retryable: false,
      err,
    })
    throw err
  }

  const durationMs = Date.now() - startedAt
  await client.insert({
    table: `${database}.${MIGRATIONS_TABLE}`,
    values: [
      {
        version: migration.version,
        name: migration.name,
        checksum: migration.checksum,
        state: 'applied',
        duration_ms: durationMs,
      },
    ],
    format: 'JSONEachRow',
  })

  logger.info('migration_applied', {
    store: 'clickhouse',
    version: migration.version,
    name: migration.name,
    duration_ms: durationMs,
  })
}

export async function migrateClickHouse(options: ClickHouseMigrateOptions): Promise<MigrateResult> {
  const files = await loadMigrations(options.directory)

  // Two clients, because a connection that names a database as its default
  // cannot be the one that creates it: ClickHouse resolves the session database
  // before the statement runs, so `CREATE DATABASE analytics` over a connection
  // already pointed at `analytics` fails on a fresh instance.
  const bootstrap = createClient({
    url: options.url,
    username: options.username,
    password: options.password,
  })

  try {
    await bootstrap.command({
      query: `CREATE DATABASE IF NOT EXISTS ${options.database}`,
    })
  } finally {
    await bootstrap.close()
  }

  const client = createClient({
    url: options.url,
    username: options.username,
    password: options.password,
    database: options.database,
  })

  try {
    await client.command({ query: CREATE_LEDGER_SQL(options.database) })

    const applied = await readLedger(client, options.database, options.logger)
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
      await applyOne(client, options.database, migration, options.logger)
      appliedNow.push(migration.version)
    }

    return { applied: appliedNow, pending: [], alreadyApplied: applied.length }
  } finally {
    await client.close()
  }
}
