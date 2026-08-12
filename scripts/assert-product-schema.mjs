#!/usr/bin/env node
/**
 * The open-core boundary, asserted against a database instead of a file list.
 *
 * Runs the PRODUCT migration stream — the only one a public checkout has — into
 * a throwaway schema and proves two things about the result:
 *
 *   1. none of the hosted service's commercial tables exist, and
 *   2. the product tables do.
 *
 * The second half is what makes the first half worth running: "no commercial
 * tables" is trivially true of an empty schema, and a migration step that
 * silently did nothing would otherwise pass. The two claims together say the
 * product schema built, and built without the commercial half.
 *
 * The commercial list below is ADR-0061 §(c) — the same object as the export's
 * EXCLUDE list and this repository's `packages/postgres/cloud/migrations`.
 * A new commercial table is added in all three places or in none.
 *
 *   TEST_POSTGRES_URL=postgres://... node scripts/assert-product-schema.mjs
 *
 * Skips (exit 0) with no TEST_POSTGRES_URL, the same way the migration test
 * tier does, so a contributor with no database can still run everything else.
 */
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import pg from 'pg'

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
if (!CONNECTION_STRING) {
  console.log('[schema] TEST_POSTGRES_URL is not set — skipping')
  process.exit(0)
}

/** Tables owned by the hosted service. None of these may exist here. */
const COMMERCIAL_TABLES = [
  'billing_accounts',
  'billing_account_sites',
  'billing_transfer_offers',
  'site_billing_assignments',
  'subscriptions',
  'trial_claims',
  'trial_policies',
  'trial_reservations',
  'usage_counters',
  'usage_windows',
  'webhook_events',
]

/** A sample of the product schema, wide enough that a no-op migration fails. */
const PRODUCT_TABLES = ['users', 'sites', 'site_members', 'api_keys', 'jobs', 'audit_logs']

// A schema rather than a database: it needs no CREATE DATABASE right, and it is
// how the migration tier isolates its own runs.
const schema = `product_schema_assertion_${process.pid}`

const scoped = (() => {
  const url = new URL(CONNECTION_STRING)
  url.searchParams.set('options', `-c search_path=${schema}`)
  return url.toString()
})()

const admin = new pg.Client({ connectionString: CONNECTION_STRING })
await admin.connect()

let failure
try {
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  await admin.query(`CREATE SCHEMA ${schema}`)

  // The published command, not an internal helper: what a fork actually runs.
  execFileSync('pnpm', ['run', 'migrate:postgres'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, DATABASE_URL: scoped, POSTGRES_MIGRATION_URL: scoped },
  })

  const { rows } = await admin.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
    [schema],
  )
  const present = new Set(rows.map((row) => row.table_name))

  const commercial = COMMERCIAL_TABLES.filter((name) => present.has(name))
  const missing = PRODUCT_TABLES.filter((name) => !present.has(name))

  if (commercial.length > 0)
    failure =
      `the product migration stream created ${commercial.length} commercial table(s): ` +
      `${commercial.join(', ')}.\nThey belong to the hosted service's stream. ` +
      'Move the migration, do not widen the list.'
  else if (missing.length > 0)
    failure =
      `the product migration stream did not create: ${missing.join(', ')}.\n` +
      'The "no commercial tables" claim above is vacuous unless the schema built.'
  else
    console.log(
      `[schema] ${present.size} tables built by the product stream; ` +
        `0 of the ${COMMERCIAL_TABLES.length} commercial tables present`,
    )
} finally {
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  await admin.end()
}

if (failure) {
  console.error(`\nPRODUCT SCHEMA ASSERTION FAILED: ${failure}`)
  process.exit(1)
}
