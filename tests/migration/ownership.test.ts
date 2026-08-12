import {
  OwnershipError,
  addMember,
  countOwners,
  createSiteWithOwner,
  createDatabase,
  createPool,
  listMembers,
  newId,
  removeMember,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The Milestone 2 ownership invariants: a site always has at least one owner, and
 * the billing owner is an accepted owner member. Proven both at the database
 * level (raw transactions cannot reach a broken state) and through the
 * transaction service, including a concurrency case.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

describeIfPostgres('ownership invariants', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m2own_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database
  let userA: string
  let userB: string
  let userC: string

  async function makeUser(): Promise<string> {
    const id = newId()
    await pool.query(
      `INSERT INTO users (id, name, email, email_verified) VALUES ($1, $2, $3, true)`,
      [id, 'User', `${id}@example.com`],
    )
    return id
  }

  /** Runs `fn` inside a transaction and returns the SQLSTATE if COMMIT fails. */
  async function commitCode(
    fn: (client: PoolClient) => Promise<void>,
  ): Promise<string | undefined> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await fn(client)
      try {
        await client.query('COMMIT')
        return undefined
      } catch (error) {
        return (error as { code?: string }).code
      }
    } finally {
      try {
        await client.query('ROLLBACK')
      } catch {
        // Already resolved; nothing to roll back.
      }
      client.release()
    }
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
    userA = await makeUser()
    userB = await makeUser()
    userC = await makeUser()
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

  it('creates a site with its owner and opening billing assignment', async () => {
    const created = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'Site',
      ownerUserId: userA,
    })
    expect(created.siteId).toBeTruthy()
    expect(await countOwners(db, created.siteId)).toBe(1)
    expect(await listMembers(db, created.siteId)).toEqual([
      { userId: userA, role: 'owner', email: `${userA}@example.com`, name: 'User' },
    ])
  })

  it('refuses a site whose billing owner is not an owner member', async () => {
    const code = await commitCode(async (client) => {
      await client.query(
        `INSERT INTO sites (id, slug, name, owner_user_id) VALUES ($1, $2, $3, $4)`,
        [newId(), `s-${newId()}`, 'Orphan', userB],
      )
    })
    // No owner exists for the site → the at-least-one-owner check fires first.
    expect(code).toBe('OA001')
  })

  it('refuses to leave a site with zero owners', async () => {
    const created = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'Site',
      ownerUserId: userA,
    })
    const code = await commitCode(async (client) => {
      await client.query(`DELETE FROM site_members WHERE site_id = $1`, [created.siteId])
    })
    expect(code).toBe('OA001')
  })

  it('refuses to point the billing owner at a non-owner member', async () => {
    const created = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'Site',
      ownerUserId: userA,
    })
    await addMember(db, { siteId: created.siteId, userId: userB, role: 'viewer' })

    const code = await commitCode(async (client) => {
      await client.query(`UPDATE sites SET owner_user_id = $1 WHERE id = $2`, [
        userB,
        created.siteId,
      ])
    })
    expect(code).toBe('OA002')
  })

  it('removes a non-billing owner but not the billing owner', async () => {
    const created = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'Site',
      ownerUserId: userA,
    })
    await addMember(db, { siteId: created.siteId, userId: userB, role: 'owner' })

    // The billing owner (userA) cannot be removed while another owner exists.
    await expect(removeMember(db, { siteId: created.siteId, userId: userA })).rejects.toMatchObject(
      {
        violation: 'billing_owner',
      },
    )

    // The non-billing owner is removed cleanly.
    await removeMember(db, { siteId: created.siteId, userId: userB })
    expect(await countOwners(db, created.siteId)).toBe(1)

    // Now the billing owner is also the last owner; removal is refused as such.
    await expect(removeMember(db, { siteId: created.siteId, userId: userA })).rejects.toMatchObject(
      {
        violation: 'last_owner',
      },
    )
  })

  it('rejects adding the same member twice', async () => {
    const created = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'Site',
      ownerUserId: userA,
    })
    await addMember(db, { siteId: created.siteId, userId: userC, role: 'admin' })
    await expect(
      addMember(db, { siteId: created.siteId, userId: userC, role: 'viewer' }),
    ).rejects.toBeInstanceOf(OwnershipError)
  })

  it('keeps the invariant under concurrent removals', async () => {
    const created = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'Site',
      ownerUserId: userA,
    })
    await addMember(db, { siteId: created.siteId, userId: userB, role: 'owner' })

    // Concurrently try to remove the billing owner and the other owner. No
    // interleaving may remove the billing owner or drop the site to zero owners.
    const [billing, other] = await Promise.allSettled([
      removeMember(db, { siteId: created.siteId, userId: userA }),
      removeMember(db, { siteId: created.siteId, userId: userB }),
    ])

    expect(billing?.status).toBe('rejected')
    expect(other?.status).toBe('fulfilled')
    expect(await countOwners(db, created.siteId)).toBe(1)
    expect(await listMembers(db, created.siteId)).toEqual([
      { userId: userA, role: 'owner', email: `${userA}@example.com`, name: 'User' },
    ])
  })

  it('writes an audit trail for site and membership changes', async () => {
    const created = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'Site',
      ownerUserId: userA,
    })
    await addMember(db, {
      siteId: created.siteId,
      userId: userB,
      role: 'admin',
      actorUserId: userA,
    })
    await removeMember(db, { siteId: created.siteId, userId: userB, actorUserId: userA })

    const rows = await pool.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE site_id = $1`,
      [created.siteId],
    )
    const actions = rows.rows.map((row) => row.action)
    expect(actions).toContain('site.created')
    expect(actions).toContain('site.member.added')
    expect(actions).toContain('site.member.removed')
  })
})
