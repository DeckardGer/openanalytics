import {
  createDatabase,
  createPool,
  createSiteWithOwner,
  newId,
  type Database,
} from '@openanalytics/postgres'
import { CLOUD_STREAM_PRESENT, applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Site lifecycle/ingest columns (migration 0013).
 *
 * A freshly created site starts at ingest_generation 1 and config_version 1
 * (docs snapshot 05, D-210: every accepted event snapshots the generation; the
 * fence bumps it) and carries no billing block and no ingest grace. first_
 * entitled_at is null until the site is first entitled — that null is exactly
 * what separates a never-entitled site (no grace) from a previously-entitled one
 * (24h grace) — docs snapshot 05, D-012/D-013.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

describeIfPostgres('sites lifecycle columns', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m3sites_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database

  beforeAll(async () => {
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`CREATE SCHEMA ${schemaName}`)
    } finally {
      await admin.end()
    }
    const url = new URL(connectionString)
    url.searchParams.set('options', `-c search_path=${schemaName}`)
    const scoped = url.toString()
    const { logger } = createCapturedLogger()
    await applyPostgresStreams({ connectionString: scoped, logger })
    pool = createPool(scoped)
    db = createDatabase(pool)
  })

  afterAll(async () => {
    await pool?.end()
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
    } finally {
      await admin.end()
    }
  })

  it('defaults a new site to generation 1, config 1, no block and no grace', async () => {
    const userId = newId()
    await pool.query(
      `INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'U', $2, true)`,
      [userId, `${userId}@example.com`],
    )
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId: userId,
    })

    // `ingest_grace_until` and `first_entitled_at` are columns the cloud stream
    // adds to this table; a product-only database has the first three.
    const cloudColumns = CLOUD_STREAM_PRESENT ? ', ingest_grace_until, first_entitled_at' : ''
    const row = await pool.query<{
      ingest_generation: number
      config_version: number
      suspended_at: Date | null
      ingest_grace_until?: Date | null
      first_entitled_at?: Date | null
    }>(
      `SELECT ingest_generation, config_version, suspended_at${cloudColumns}
       FROM sites WHERE id = $1`,
      [siteId],
    )
    const site = row.rows[0]
    expect(site?.ingest_generation).toBe(1)
    expect(site?.config_version).toBe(1)
    expect(site?.suspended_at).toBeNull()
    if (CLOUD_STREAM_PRESENT) {
      expect(site?.ingest_grace_until).toBeNull()
      expect(site?.first_entitled_at).toBeNull()
    }
  })
})
