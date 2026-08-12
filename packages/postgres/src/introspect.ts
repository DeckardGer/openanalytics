import { is } from 'drizzle-orm'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import * as schema from './schema/index.ts'

/**
 * Reflection over the Drizzle schema, so a caller can compare it against a live
 * database without importing `drizzle-orm` itself — the dependency stays private
 * to this package. The bootstrap/drift test uses this to assert every declared
 * table and column actually exists in the migrated database (ADR-0006).
 */

export interface TableColumns {
  readonly name: string
  readonly columns: readonly string[]
}

export function tableColumnsOf(barrel: Record<string, unknown>): TableColumns[] {
  // Typed as `unknown` so the `is` guard narrows from a single type rather than
  // the wide union of concrete table types, which `exactOptionalPropertyTypes`
  // rejects for a hand-written predicate.
  const values: unknown[] = Object.values(barrel)
  const tables: TableColumns[] = []
  for (const value of values) {
    if (!is(value, PgTable)) continue
    const config = getTableConfig(value)
    tables.push({ name: config.name, columns: config.columns.map((column) => column.name) })
  }
  return tables
}

/** Table name and column names for every table in the product schema barrel. */
export function schemaTableColumns(): TableColumns[] {
  return tableColumnsOf(schema)
}

// `cloudSchemaTableColumns` was here until the open-core boundary was enforced.
// It is `./cloud/introspect.ts` now: reflecting over the hosted schema means
// importing it, and a product module may not (`scripts/check-boundaries.mjs`).
