import {
  addMember,
  createDatabase,
  createPool,
  createSiteWithOwner,
  getPublicDashboardSettings,
  isSurfaceShared,
  newId,
  removeMember,
  resolvePublicShare,
  updatePublicDashboardSettings,
  type Database,
  type PublicSurfaceFlags,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { REALTIME_ACCESS_REVOKED_TOPIC } from '@openanalytics/domain'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The M9 realtime-revocation surface at the database level (docs snapshot 02 §17,
 * 05 D-213): migration 0018 adds the public realtime opt-in, and the two
 * membership-severing writes each enqueue a durable `realtime.access_revoked`
 * outbox row in the SAME transaction as the removal — so it exists exactly when
 * the removal commits, and never when the removal rolls back.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

/** Every surface off, so a test names only the flag it is about (ADR-0039). */
const ALL_OFF: PublicSurfaceFlags = {
  shareOverview: false,
  shareGeography: false,
  shareRealtime: false,
  shareTimeseries: false,
  shareSessions: false,
  sharePages: false,
  shareSources: false,
  shareDevices: false,
  shareIdentity: false,
}

describeIfPostgres('realtime revocation and public opt-in', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m9rev_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database

  const makeUser = async () => {
    const id = newId()
    await pool.query(
      `INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'U', $2, true)`,
      [id, `${id}@example.com`],
    )
    return id
  }

  const revocationRows = async (siteId: string, userId: string) => {
    const r = await pool.query<{ reason: string }>(
      `SELECT payload->>'reason' AS reason FROM outbox
       WHERE topic = $1 AND payload->>'site_id' = $2 AND payload->>'user_id' = $3`,
      [REALTIME_ACCESS_REVOKED_TOPIC, siteId, userId],
    )
    return r.rows
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

  it('applies migration 0018: share_realtime column round-trips through the repo', async () => {
    const owner = await makeUser()
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId: owner,
    })

    const updated = await updatePublicDashboardSettings(db, {
      siteId,
      actorUserId: owner,
      enabled: true,
      ...ALL_OFF,
      shareRealtime: true,
      rotateSlug: false,
    })
    expect(updated.shareRealtime).toBe(true)
    expect(updated.shareSlug).toBeTruthy()

    const read = await getPublicDashboardSettings(db, siteId)
    expect(read.shareRealtime).toBe(true)

    const share = await resolvePublicShare(db, updated.shareSlug as string)
    expect(share?.shareRealtime).toBe(true)
    // The realtime surface is shared only with the master switch on and the flag set.
    expect(isSurfaceShared(share!, 'realtime')).toBe(true)

    // Turning realtime off closes the surface while overview/geography rules are unaffected.
    await updatePublicDashboardSettings(db, {
      siteId,
      actorUserId: owner,
      enabled: true,
      ...ALL_OFF,
      rotateSlug: false,
    })
    const off = await resolvePublicShare(db, updated.shareSlug as string)
    expect(isSurfaceShared(off!, 'realtime')).toBe(false)
  })

  it('removeMember writes a revocation row in-tx, and a rolled-back removal leaves none', async () => {
    const a = await makeUser()
    const b = await makeUser()
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId: a,
    })
    await addMember(db, { siteId, userId: b, role: 'owner' })

    // Removing the billing owner (a) is refused; the transaction rolls back, so no
    // revocation row is written for a.
    await expect(removeMember(db, { siteId, userId: a })).rejects.toMatchObject({
      violation: 'billing_owner',
    })
    expect(await revocationRows(siteId, a)).toHaveLength(0)

    // Removing the non-billing owner (b) succeeds and enqueues exactly one row.
    await removeMember(db, { siteId, userId: b })
    const rows = await revocationRows(siteId, b)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.reason).toBe('member_removed')
  })
})
