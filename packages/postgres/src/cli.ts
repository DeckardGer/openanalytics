import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger, createServiceMetadata } from '@openanalytics/observability'
import { CLOUD_MIGRATIONS_TABLE, MIGRATIONS_TABLE, migratePostgres } from './migrate.ts'

/**
 * `pnpm run migrate:postgres [--dry-run] [--stream cloud]`
 *
 * Two independent streams over one database (see `migrate.ts`):
 *
 *   * product (default): `packages/postgres/migrations`, ledger
 *     `schema_migrations`;
 *   * cloud (`--stream cloud`): `packages/postgres/cloud/migrations`, ledger
 *     `cloud_schema_migrations`.
 *
 * Deploy order is product first, then cloud — the cloud stream references
 * product tables, never the other way around.
 *
 * The migration credential is separate from the runtime one by design
 * (docs snapshot 02 §25): the application user must not be able to change
 * schema. It is read from `POSTGRES_MIGRATION_URL`, falling back to
 * `DATABASE_URL` for local development only.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const STREAMS = {
  product: {
    directory: join(packageRoot, 'migrations'),
    directoryEnv: 'POSTGRES_MIGRATIONS_DIR',
    ledgerTable: MIGRATIONS_TABLE,
  },
  cloud: {
    directory: join(packageRoot, 'cloud', 'migrations'),
    directoryEnv: 'POSTGRES_CLOUD_MIGRATIONS_DIR',
    ledgerTable: CLOUD_MIGRATIONS_TABLE,
  },
} as const

type StreamName = keyof typeof STREAMS

const logger = createLogger({
  service: createServiceMetadata({
    name: 'migrator',
    version: process.env['SERVICE_VERSION'] ?? '0.0.0',
    commit: process.env['GIT_COMMIT'] ?? 'unknown',
    environment: process.env['ENVIRONMENT'] ?? 'local',
  }),
})

const connectionString = process.env['POSTGRES_MIGRATION_URL'] ?? process.env['DATABASE_URL']

if (!connectionString) {
  process.stderr.write('POSTGRES_MIGRATION_URL (or DATABASE_URL) is required\n')
  process.exit(78) // EX_CONFIG
}

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')

const streamFlag = args.indexOf('--stream')
const streamName = streamFlag === -1 ? 'product' : args[streamFlag + 1]
if (streamName === undefined || !(streamName in STREAMS)) {
  process.stderr.write(
    `--stream must name one of: ${Object.keys(STREAMS).join(', ')} (got ${JSON.stringify(streamName ?? null)})\n`,
  )
  process.exit(64) // EX_USAGE
}
const stream = STREAMS[streamName as StreamName]

try {
  const result = await migratePostgres({
    connectionString,
    directory: process.env[stream.directoryEnv] ?? stream.directory,
    ledgerTable: stream.ledgerTable,
    logger,
    dryRun,
  })

  logger.info('migrate_finished', {
    store: 'postgres',
    stream: streamName,
    ledger: stream.ledgerTable,
    dry_run: dryRun,
    applied: result.applied.length,
    pending: result.pending.length,
    already_applied: result.alreadyApplied,
  })

  // A dry run that still has pending work must fail CI: it means a deploy would
  // have changed the schema without anyone approving it in this pipeline.
  if (dryRun && result.pending.length > 0) {
    process.stderr.write(`Pending migrations: ${result.pending.join(', ')}\n`)
    process.exit(1)
  }
} catch (err) {
  logger.error('migrate_failed', { store: 'postgres', stream: streamName, retryable: false, err })
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}
