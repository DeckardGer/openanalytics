import {
  addMember,
  createDatabase,
  createPool,
  createSite,
  createSiteWithOwner,
  getSiteForUser,
  listSitesForUser,
  markSitesFirstEvent,
  newId,
  updateMemberRole,
  updateSiteSettings,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The management-surface write paths: guarded site creation, the settings
 * replace-set, and the member role change.
 *
 * One named test per invariant. The create path's serialization and both role
 * invariants are database-enforced (the subscription row lock, and the deferred
 * ownership triggers of migration 0007), so they are proven against a real
 * Postgres rather than a mock.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

describeIfPostgres('site management', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m10site_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database

  const makeUser = async (): Promise<string> => {
    const id = newId()
    await pool.query(
      `INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'U', $2, true)`,
      [id, `${id}@example.com`],
    )
    return id
  }

  const siteRow = async (siteId: string) => {
    const r = await pool.query<{
      status: string
      config_version: number
      name: string
      owner_user_id: string
    }>(
      // `first_entitled_at` was selected here and never asserted; it is a column
      // the cloud stream adds, so selecting it made this product helper fail on
      // a product-only database for a value nothing read.
      `SELECT status, config_version, name, owner_user_id
       FROM sites WHERE id = $1`,
      [siteId],
    )
    return r.rows[0]
  }

  /** `sites.first_event_at` straight from SQL, past every mapping layer. */
  const firstEventRow = async (siteId: string): Promise<Date | null> => {
    const r = await pool.query<{ first_event_at: Date | null }>(
      `SELECT first_event_at FROM sites WHERE id = $1`,
      [siteId],
    )
    return r.rows[0]?.first_event_at ?? null
  }

  const auditCount = async (siteId: string, action: string): Promise<number> => {
    const r = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs WHERE site_id = $1 AND action = $2`,
      [siteId, action],
    )
    return Number(r.rows[0]?.n ?? '0')
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

  // --- create ---

  it('makes the creator the first owner and the owner of record (D-008/D-009)', async () => {
    const user = await makeUser()

    const created = await createSite(db, { slug: `s-${newId()}`, name: 'Acme', ownerUserId: user })

    expect(created.role).toBe('owner')
    expect(created.isBillingOwner).toBe(true)
    // Born active, with nothing to fund it: what a deployment that sells plans
    // additionally writes here is `tests/migration/cloud/site-create-gate.test.ts`.
    expect(created.status).toBe('active')

    const site = await siteRow(created.siteId)
    expect(site?.owner_user_id).toBe(user)

    const members = await pool.query<{ role: string }>(
      `SELECT role FROM site_members WHERE site_id = $1 AND user_id = $2`,
      [created.siteId, user],
    )
    expect(members.rows[0]?.role).toBe('owner')
  })

  it('mints a tracking_write key in the same transaction', async () => {
    const user = await makeUser()
    const created = await createSite(db, { slug: `s-${newId()}`, name: 'S', ownerUserId: user })

    expect(created.trackingKey.publicToken.startsWith('oa_pk_')).toBe(true)

    const keys = await pool.query<{ id: string; type: string; public_token: string }>(
      `SELECT id, type, public_token FROM api_keys WHERE site_id = $1`,
      [created.siteId],
    )
    expect(keys.rows).toHaveLength(1)
    expect(keys.rows[0]?.type).toBe('tracking_write')
    expect(keys.rows[0]?.id).toBe(created.trackingKey.id)
    // No private_read key is auto-created.
    expect(keys.rows[0]?.public_token).toBe(created.trackingKey.publicToken)
  })

  it('reports a taken slug distinctly from a duplicate membership', async () => {
    const user = await makeUser()
    const slug = `s-${newId()}`
    const first = await createSite(db, { slug, name: 'S', ownerUserId: user })

    // Same slug: a unique violation on sites_slug_key, not on the membership.
    await expect(createSite(db, { slug, name: 'S', ownerUserId: user })).rejects.toMatchObject({
      violation: 'slug_taken',
    })

    // The other 23505 reachable from this repository still maps to its own
    // violation, which is what makes the distinction meaningful.
    const other = await makeUser()
    await addMember(db, { siteId: first.siteId, userId: other, role: 'viewer' })
    await expect(
      addMember(db, { siteId: first.siteId, userId: other, role: 'viewer' }),
    ).rejects.toMatchObject({ violation: 'already_member' })
  })

  // --- settings ---

  it('bumps config_version when the domain set changes', async () => {
    const user = await makeUser()
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId: user,
    })
    const before = (await siteRow(siteId))?.config_version as number

    const updated = await updateSiteSettings(db, {
      siteId,
      domains: ['shop.example.com', 'www.example.com'],
      actorUserId: user,
    })

    expect(updated.configVersionBumped).toBe(true)
    expect(updated.configVersion).toBe(before + 1)
    expect((await siteRow(siteId))?.config_version).toBe(before + 1)
    expect(updated.domains).toEqual(['shop.example.com', 'www.example.com'])
  })

  it('does not bump config_version on a name-only change', async () => {
    const user = await makeUser()
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'Before',
      ownerUserId: user,
    })
    const before = (await siteRow(siteId))?.config_version as number

    const updated = await updateSiteSettings(db, { siteId, name: 'After', actorUserId: user })

    expect(updated.configVersionBumped).toBe(false)
    expect(updated.configVersion).toBe(before)
    // Returned unchanged so the route can answer with a whole SiteSummary.
    expect(updated.createdAt).toBeInstanceOf(Date)
    expect((await siteRow(siteId))?.name).toBe('After')
    expect((await siteRow(siteId))?.config_version).toBe(before)
  })

  it('replaces the domain set, removing the ones dropped from the list', async () => {
    const user = await makeUser()
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId: user,
    })
    await updateSiteSettings(db, {
      siteId,
      domains: ['a.example.com', 'b.example.com', 'c.example.com'],
      actorUserId: user,
    })

    const replaced = await updateSiteSettings(db, {
      siteId,
      domains: ['b.example.com', 'd.example.com'],
      actorUserId: user,
    })
    expect(replaced.domains).toEqual(['b.example.com', 'd.example.com'])

    const rows = await pool.query<{ domain: string }>(
      `SELECT domain FROM site_domains WHERE site_id = $1 ORDER BY domain`,
      [siteId],
    )
    expect(rows.rows.map((r) => r.domain)).toEqual(['b.example.com', 'd.example.com'])

    // An empty list clears the allowlist entirely.
    const cleared = await updateSiteSettings(db, { siteId, domains: [], actorUserId: user })
    expect(cleared.domains).toEqual([])
  })

  it('audits a settings change with the changed fields and the domain count only', async () => {
    const user = await makeUser()
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId: user,
    })
    await updateSiteSettings(db, {
      siteId,
      name: 'Renamed',
      domains: ['one.example.com'],
      actorUserId: user,
    })

    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_logs WHERE site_id = $1 AND action = 'site.settings.updated'`,
      [siteId],
    )
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0]?.metadata).toEqual({ fields: ['name', 'domains'], domain_count: 1 })
  })

  it('returns the domain set from the site reads without a query per site', async () => {
    const user = await makeUser()
    const a = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'A',
      ownerUserId: user,
    })
    const b = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'B',
      ownerUserId: user,
    })
    await updateSiteSettings(db, {
      siteId: a.siteId,
      domains: ['z.example.com', 'a.example.com'],
      actorUserId: user,
    })

    const listed = await listSitesForUser(db, user)
    expect(listed.find((s) => s.siteId === a.siteId)?.domains).toEqual([
      'a.example.com',
      'z.example.com',
    ])
    // A site with no allowlist reads as an empty array, never as null.
    expect(listed.find((s) => s.siteId === b.siteId)?.domains).toEqual([])

    const one = await getSiteForUser(db, { siteId: a.siteId, userId: user })
    expect(one?.domains).toEqual(['a.example.com', 'z.example.com'])

    // Both reads also carry the site's creation instant, which the dashboard
    // anchors its "All time" interval at.
    expect(listed.find((s) => s.siteId === a.siteId)?.createdAt).toBeInstanceOf(Date)
    expect(one?.createdAt).toBeInstanceOf(Date)
  })

  // --- the install-verified signal (ADR-0027) ---

  it('starts a site with no first event, and reads it back as null', async () => {
    const user = await makeUser()
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId: user,
    })

    // NULL is the statement "no event has ever been ingested", which is exactly
    // what onboarding's "tracker installed" step reads. It must survive the
    // round trip as null rather than as an absent field or an epoch.
    expect(await firstEventRow(siteId)).toBeNull()
    const listed = await listSitesForUser(db, user)
    expect(listed.find((s) => s.siteId === siteId)?.firstEventAt).toBeNull()
    expect((await getSiteForUser(db, { siteId, userId: user }))?.firstEventAt).toBeNull()
  })

  it('fills the signal once and never moves it again', async () => {
    const user = await makeUser()
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId: user,
    })

    const first = new Date('2026-07-25T12:00:00.000Z')
    expect(await markSitesFirstEvent(db, [{ siteId, occurredAt: first }])).toEqual([siteId])
    expect((await firstEventRow(siteId))?.toISOString()).toBe(first.toISOString())

    // A later batch matches nothing: the `first_event_at IS NULL` guard, not any
    // caller-side memory, is what makes the fill idempotent across processes.
    const later = new Date('2026-07-26T12:00:00.000Z')
    expect(await markSitesFirstEvent(db, [{ siteId, occurredAt: later }])).toEqual([])
    expect((await firstEventRow(siteId))?.toISOString()).toBe(first.toISOString())

    // And an event that *occurred* earlier but arrives later does not pull it
    // backwards either — there is deliberately no LEAST. The signal is a stable
    // instant a client may cache, not a running minimum.
    const earlier = new Date('2026-07-24T12:00:00.000Z')
    expect(await markSitesFirstEvent(db, [{ siteId, occurredAt: earlier }])).toEqual([])
    expect((await firstEventRow(siteId))?.toISOString()).toBe(first.toISOString())
  })

  it('fills a batch of sites in one statement, touching only the unset ones', async () => {
    const user = await makeUser()
    const already = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'A',
      ownerUserId: user,
    })
    const fresh = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'B',
      ownerUserId: user,
    })

    const seeded = new Date('2026-07-20T00:00:00.000Z')
    await markSitesFirstEvent(db, [{ siteId: already.siteId, occurredAt: seeded }])

    const at = new Date('2026-07-27T08:30:00.000Z')
    const filled = await markSitesFirstEvent(db, [
      { siteId: already.siteId, occurredAt: at },
      { siteId: fresh.siteId, occurredAt: at },
      // A site that no longer exists is not an error: the fence drops its events
      // anyway, and the write must not fail the batch that carried them.
      { siteId: newId(), occurredAt: at },
    ])

    expect(filled).toEqual([fresh.siteId])
    expect((await firstEventRow(already.siteId))?.toISOString()).toBe(seeded.toISOString())
    expect((await firstEventRow(fresh.siteId))?.toISOString()).toBe(at.toISOString())
  })

  it('carries the signal through a settings update rather than dropping it', async () => {
    const user = await makeUser()
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId: user,
    })
    const at = new Date('2026-07-22T06:45:00.000Z')
    await markSitesFirstEvent(db, [{ siteId, occurredAt: at }])

    // The PATCH route answers with a whole SiteSummary built from this result,
    // so a missing field here would make a rename look like an uninstall.
    const updated = await updateSiteSettings(db, { siteId, name: 'Renamed', actorUserId: user })
    expect(updated.firstEventAt?.toISOString()).toBe(at.toISOString())
    expect((await getSiteForUser(db, { siteId, userId: user }))?.firstEventAt?.toISOString()).toBe(
      at.toISOString(),
    )
  })

  it('writes nothing at all for an empty candidate list', async () => {
    expect(await markSitesFirstEvent(db, [])).toEqual([])
  })

  // --- member role ---

  it('refuses to demote the last owner (OA001)', async () => {
    const user = await makeUser()
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId: user,
    })

    await expect(
      updateMemberRole(db, { siteId, userId: user, role: 'admin', actorUserId: user }),
    ).rejects.toMatchObject({ violation: 'last_owner' })

    const members = await pool.query<{ role: string }>(
      `SELECT role FROM site_members WHERE site_id = $1 AND user_id = $2`,
      [siteId, user],
    )
    expect(members.rows[0]?.role).toBe('owner')
  })

  it('refuses to demote the billing owner below owner (OA002)', async () => {
    const billing = await makeUser()
    const second = await makeUser()
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId: billing,
    })
    // A second owner, so the last-owner invariant is satisfied and the failure
    // can only be the billing-owner one.
    await addMember(db, { siteId, userId: second, role: 'owner' })

    await expect(
      updateMemberRole(db, { siteId, userId: billing, role: 'admin', actorUserId: second }),
    ).rejects.toMatchObject({ violation: 'billing_owner' })
  })

  it('demotes a non-billing owner and writes exactly one audit row', async () => {
    const billing = await makeUser()
    const second = await makeUser()
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId: billing,
    })
    await addMember(db, { siteId, userId: second, role: 'owner' })

    const result = await updateMemberRole(db, {
      siteId,
      userId: second,
      role: 'viewer',
      actorUserId: billing,
    })
    expect(result).toEqual({
      userId: second,
      role: 'viewer',
      previousRole: 'owner',
      changed: true,
    })
    expect(await auditCount(siteId, 'site.member.role_changed')).toBe(1)

    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_logs WHERE site_id = $1 AND action = 'site.member.role_changed'`,
      [siteId],
    )
    expect(audit.rows[0]?.metadata).toEqual({ from: 'owner', to: 'viewer' })
  })

  it('treats setting the role a member already holds as a no-op with no audit row', async () => {
    const owner = await makeUser()
    const viewer = await makeUser()
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId: owner,
    })
    await addMember(db, { siteId, userId: viewer, role: 'viewer' })

    const result = await updateMemberRole(db, {
      siteId,
      userId: viewer,
      role: 'viewer',
      actorUserId: owner,
    })
    expect(result.changed).toBe(false)
    expect(result.role).toBe('viewer')
    expect(await auditCount(siteId, 'site.member.role_changed')).toBe(0)
  })

  it('rejects a target who is not a member of this site', async () => {
    const owner = await makeUser()
    const stranger = await makeUser()
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId: owner,
    })

    await expect(
      updateMemberRole(db, { siteId, userId: stranger, role: 'admin', actorUserId: owner }),
    ).rejects.toMatchObject({ violation: 'not_a_member' })
  })
})
