import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema/index.ts'

/**
 * Drizzle client over a `pg` Pool.
 *
 * The pool is created separately from the client so the owning service controls
 * its lifecycle (a Vercel function and a long-lived worker want very different
 * pool settings, and both must be able to `end()` it). The migration runner
 * keeps its own single `Client` on the separate migration credential
 * (`packages/postgres/src/migrate.ts`); this client uses the runtime credential
 * and never runs DDL.
 */

export type Schema = typeof schema

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString })
}

export function createDatabase(pool: Pool) {
  return drizzle(pool, { schema })
}

export type Database = ReturnType<typeof createDatabase>

/**
 * A database handle *or* an open transaction on one.
 *
 * A repository function that takes this can be called on its own — where it runs
 * in its own implicit transaction — or composed into a caller's transaction so
 * its write commits atomically with the caller's. That is not a convenience: the
 * deletion-start transaction (ADR-0030, D4 step 2) has to write the deletion
 * request, flip the site to `deleting` and enqueue the job as one unit, because
 * a crash between any two of them leaves a site nobody will ever delete.
 */
export type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0]
