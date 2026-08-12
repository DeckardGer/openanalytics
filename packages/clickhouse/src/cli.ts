import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger, createServiceMetadata } from '@openanalytics/observability'
import { migrateClickHouse } from './migrate.ts'

/**
 * `pnpm run migrate:clickhouse [--dry-run]`
 *
 * Uses the dedicated migration credential. Docs snapshot 02 §5: the ingest user
 * may only insert and the query-gateway user may only read; neither can alter
 * schema.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATIONS_DIR = join(packageRoot, 'migrations')

const logger = createLogger({
  service: createServiceMetadata({
    name: 'migrator',
    version: process.env['SERVICE_VERSION'] ?? '0.0.0',
    commit: process.env['GIT_COMMIT'] ?? 'unknown',
    environment: process.env['ENVIRONMENT'] ?? 'local',
  }),
})

const url = process.env['CLICKHOUSE_URL']
const username = process.env['CLICKHOUSE_MIGRATION_USER']
const password = process.env['CLICKHOUSE_MIGRATION_PASSWORD']
const database = process.env['CLICKHOUSE_DATABASE'] ?? 'analytics'

if (!url || !username || password === undefined) {
  process.stderr.write(
    'CLICKHOUSE_URL, CLICKHOUSE_MIGRATION_USER and CLICKHOUSE_MIGRATION_PASSWORD are required\n',
  )
  process.exit(78) // EX_CONFIG
}

const dryRun = process.argv.includes('--dry-run')

try {
  const result = await migrateClickHouse({
    url,
    username,
    password,
    database,
    directory: process.env['CLICKHOUSE_MIGRATIONS_DIR'] ?? MIGRATIONS_DIR,
    logger,
    dryRun,
  })

  logger.info('migrate_finished', {
    store: 'clickhouse',
    dry_run: dryRun,
    applied: result.applied.length,
    pending: result.pending.length,
    already_applied: result.alreadyApplied,
  })

  if (dryRun && result.pending.length > 0) {
    process.stderr.write(`Pending migrations: ${result.pending.join(', ')}\n`)
    process.exit(1)
  }
} catch (err) {
  logger.error('migrate_failed', { store: 'clickhouse', retryable: false, err })
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}
