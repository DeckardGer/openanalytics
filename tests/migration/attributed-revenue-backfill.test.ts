import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createDatabase,
  createPool,
  createSiteWithOwner,
  newId,
  upsertSiteIngestSettings,
  type Database,
} from '@openanalytics/postgres'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PRODUCT_MIGRATIONS_DIR, applyPostgresStreams } from '../support/postgres-streams.ts'

/**
 * Migration 0045 — the one-off backfill that reads an existing revenue
 * connection as an existing opt-in to attributed revenue (ADR-0064 D4a; Rahul,
 * 2026-08-13).
 *
 * A backfill runs once, against a database nobody can rehearse on, and the way
 * it fails is silent: too wide and a site that disconnected starts sending a
 * linking hint again; too narrow and a paying customer's journeys stop
 * appearing with no error anywhere. So it is proven the only way that means
 * anything — by seeding the four cases it has to tell apart and executing the
 * migration's own SQL, read from the file, against them.
 *
 * The file has already been applied once by `applyPostgresStreams` (as a no-op
 * on an empty database), so running it here is also the re-run its own rollout
 * note claims is safe.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

describeIfPostgres('attributed revenue backfill (migration 0045)', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `backfill_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database
  let backfillSql: string

  const newUser = async (): Promise<string> => {
    const userId = newId()
    await pool.query(
      `INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'U', $2, true)`,
      [userId, `${userId}@example.com`],
    )
    return userId
  }

  const newSite = async (): Promise<{ siteId: string; userId: string }> => {
    const userId = await newUser()
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'Shop',
      ownerUserId: userId,
    })
    return { siteId, userId }
  }

  const connectRevenue = async (
    siteId: string,
    userId: string,
    status: 'active' | 'degraded' | 'disabled',
  ): Promise<void> => {
    await pool.query(
      `INSERT INTO revenue_credentials
         (id, site_id, provider, key_version, api_key_last4, webhook_token, status,
          created_by_user_id, disabled_at)
       VALUES ($1, $2, 'stripe', 'k1', '1234', $3, $4, $5, $6)`,
      [
        newId(),
        siteId,
        `wht_${newId()}`,
        status,
        userId,
        status === 'disabled' ? new Date() : null,
      ],
    )
  }

  const settingsOf = async (
    siteId: string,
  ): Promise<{ attributed: boolean | null; version: number }> => {
    const { rows } = await pool.query<{
      attributed_revenue: boolean | null
      config_version: number
    }>(
      `SELECT s.config_version, i.attributed_revenue
         FROM sites s LEFT JOIN site_ingest_settings i ON i.site_id = s.id
        WHERE s.id = $1`,
      [siteId],
    )
    const row = rows[0]
    if (!row) throw new Error('site not found')
    return { attributed: row.attributed_revenue, version: Number(row.config_version) }
  }

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
    backfillSql = await readFile(
      join(PRODUCT_MIGRATIONS_DIR, '0045_backfill_attributed_revenue.sql'),
      'utf8',
    )
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

  it('turns attribution on for a connected site and leaves everyone else alone', async () => {
    // Four sites, four answers. The two that must move differ in whether they
    // already have a settings row at all — the row is optional, so the backfill
    // has to insert for one and update the other, and getting only one of those
    // right is the failure that looks like success.
    const active = await newSite()
    await connectRevenue(active.siteId, active.userId, 'active')

    const degraded = await newSite()
    await connectRevenue(degraded.siteId, degraded.userId, 'degraded')
    await upsertSiteIngestSettings(db, { siteId: degraded.siteId, timezone: 'Asia/Baku' })

    const disconnected = await newSite()
    await connectRevenue(disconnected.siteId, disconnected.userId, 'disabled')

    const never = await newSite()

    const before = {
      active: await settingsOf(active.siteId),
      degraded: await settingsOf(degraded.siteId),
      disconnected: await settingsOf(disconnected.siteId),
      never: await settingsOf(never.siteId),
    }
    expect(before.active.attributed).toBeNull()
    expect(before.degraded.attributed).toBe(false)

    await pool.query(backfillSql)

    const after = {
      active: await settingsOf(active.siteId),
      degraded: await settingsOf(degraded.siteId),
      disconnected: await settingsOf(disconnected.siteId),
      never: await settingsOf(never.siteId),
    }

    // Connected, no settings row: a row is created carrying the opt-in.
    expect(after.active.attributed).toBe(true)
    // Connected, settings row already there: updated without disturbing it.
    expect(after.degraded.attributed).toBe(true)
    const { rows: kept } = await pool.query<{ timezone: string }>(
      `SELECT timezone FROM site_ingest_settings WHERE site_id = $1`,
      [degraded.siteId],
    )
    expect(kept[0]?.timezone).toBe('Asia/Baku')

    // A site that disconnected is NOT re-enabled, and one that never connected
    // does not acquire a settings row at all.
    expect(after.disconnected.attributed).toBeNull()
    expect(after.never.attributed).toBeNull()

    // Only the two that changed are told to re-fetch their configuration.
    expect(after.active.version).toBe(before.active.version + 1)
    expect(after.degraded.version).toBe(before.degraded.version + 1)
    expect(after.disconnected.version).toBe(before.disconnected.version)
    expect(after.never.version).toBe(before.never.version)
  })

  it('is safe to run twice, which is what makes a failed deploy re-runnable', async () => {
    const site = await newSite()
    await connectRevenue(site.siteId, site.userId, 'active')

    await pool.query(backfillSql)
    const once = await settingsOf(site.siteId)
    await pool.query(backfillSql)
    const twice = await settingsOf(site.siteId)

    expect(once.attributed).toBe(true)
    expect(twice.attributed).toBe(true)
    // The version moves again — a second tracker revalidation, and nothing else.
    // Stated rather than asserted-away: re-running is safe, not free.
    expect(twice.version).toBe(once.version + 1)
  })
})
