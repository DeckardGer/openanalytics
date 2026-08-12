import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  CLOUD_MIGRATIONS_TABLE,
  migratePostgres,
  type MigrateResult,
} from '@openanalytics/postgres'
import type { Logger } from '@openanalytics/observability'

/**
 * Applies the Postgres migration streams in deploy order: product
 * (`packages/postgres/migrations`, ledger `schema_migrations`) first, then
 * cloud (`packages/postgres/cloud/migrations`, ledger
 * `cloud_schema_migrations`) — if that stream is present at all.
 *
 * Running them in sequence is a standing proof that the product stream applies
 * cleanly on its own: the product run completes before the cloud stream starts.
 *
 * The cloud stream is optional because it is optional in the tree. The public
 * export cuts every `cloud/` directory, so a checkout of the open-source
 * repository has one stream and a database with no commercial tables in it, and
 * this suite has to be the same suite there. Tests that seed or assert a cloud
 * table therefore guard on `CLOUD_STREAM_PRESENT` rather than existing in two
 * versions — a fork skips those few claims, and every product claim around them
 * still runs. What a build without the hosted surface does to those tables is
 * itself asserted (it leaves them alone), which is why the guards sit inside the
 * tests rather than around them.
 */

export const PRODUCT_MIGRATIONS_DIR = fileURLToPath(
  new URL('../../packages/postgres/migrations/', import.meta.url),
)

export const CLOUD_MIGRATIONS_DIR = fileURLToPath(
  new URL('../../packages/postgres/cloud/migrations/', import.meta.url),
)

/**
 * Whether this checkout carries the cloud migration stream — and therefore
 * whether the databases these tests build have the commercial tables at all.
 */
export const CLOUD_STREAM_PRESENT = existsSync(CLOUD_MIGRATIONS_DIR)

export interface AppliedStreams {
  readonly product: MigrateResult
  /** Absent when this checkout has no cloud stream (the public export). */
  readonly cloud?: MigrateResult
}

export async function applyPostgresStreams(options: {
  readonly connectionString: string
  readonly logger: Logger
}): Promise<AppliedStreams> {
  const product = await migratePostgres({
    connectionString: options.connectionString,
    directory: PRODUCT_MIGRATIONS_DIR,
    logger: options.logger,
  })
  if (!CLOUD_STREAM_PRESENT) return { product }
  const cloud = await migratePostgres({
    connectionString: options.connectionString,
    directory: CLOUD_MIGRATIONS_DIR,
    ledgerTable: CLOUD_MIGRATIONS_TABLE,
    logger: options.logger,
  })
  return { product, cloud }
}
