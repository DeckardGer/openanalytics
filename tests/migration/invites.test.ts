import {
  InviteError,
  acceptInvite,
  createDatabase,
  createInvite,
  createPool,
  createSiteWithOwner,
  expireStaleInvites,
  listMembers,
  listSiteInvites,
  newId,
  resendInvite,
  revokeInvite,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Invitation acceptance (plan Milestone 2 item 6): a hashed-token invite is
 * accepted only by the invited email, exactly once, and turns into a membership
 * atomically.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

describeIfPostgres('site invites', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m2inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database
  let ownerId: string
  let inviteeId: string
  const inviteeEmail = `invitee-${Date.now()}@example.com`
  let strangerId: string
  let siteId: string

  const makeUser = async (email: string): Promise<string> => {
    const id = newId()
    await pool.query(
      `INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'U', $2, true)`,
      [id, email],
    )
    return id
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
    ownerId = await makeUser(`owner-${Date.now()}@example.com`)
    inviteeId = await makeUser(inviteeEmail)
    strangerId = await makeUser(`stranger-${Date.now()}@example.com`)
    const created = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId: ownerId,
    })
    siteId = created.siteId
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

  it('refuses a second pending invite for the same email', async () => {
    // A distinct email so this pending invite does not collide with the
    // acceptance test's invite for `inviteeEmail`.
    const dupEmail = `dup-${Date.now()}@example.com`
    await createInvite(db, { siteId, email: dupEmail, role: 'admin', invitedByUserId: ownerId })
    await expect(
      createInvite(db, { siteId, email: dupEmail, role: 'viewer', invitedByUserId: ownerId }),
    ).rejects.toMatchObject({ violation: 'already_invited' })
  })

  it('accepts only for the invited email, exactly once', async () => {
    const invite = await createInvite(db, {
      siteId,
      email: `fresh-${Date.now()}@example.com`,
      role: 'viewer',
      invitedByUserId: ownerId,
    })
    // The stranger's email does not match the invite.
    await expect(
      acceptInvite(db, { rawToken: invite.rawToken, userId: strangerId }),
    ).rejects.toMatchObject({ violation: 'email_mismatch' })
    // A bogus token is invalid.
    await expect(
      acceptInvite(db, { rawToken: 'oa_inv_nope', userId: strangerId }),
    ).rejects.toMatchObject({ violation: 'invalid_or_expired' })
  })

  it('turns an accepted invite into a membership and cannot be reused', async () => {
    const invite = await createInvite(db, {
      siteId,
      email: inviteeEmail,
      role: 'admin',
      invitedByUserId: ownerId,
    })

    const accepted = await acceptInvite(db, { rawToken: invite.rawToken, userId: inviteeId })
    expect(accepted).toEqual({ siteId, role: 'admin' })

    const members = await listMembers(db, siteId)
    // With the identity the team screen needs: a list of UUIDs beside an invite
    // list that already shows email addresses made one screen disagree with
    // itself about who a person is.
    expect(members).toContainEqual(
      expect.objectContaining({ userId: inviteeId, role: 'admin', email: expect.any(String) }),
    )

    // The same token cannot be used twice.
    await expect(
      acceptInvite(db, { rawToken: invite.rawToken, userId: inviteeId }),
    ).rejects.toBeInstanceOf(InviteError)

    // The audit trail records the invite lifecycle without the invited email.
    const audit = await pool.query<{ row: unknown }>(
      `SELECT to_jsonb(t) AS row FROM audit_logs t
       WHERE action IN ('site.invite.created', 'site.invite.accepted') AND site_id = $1`,
      [siteId],
    )
    const actions = new Set(audit.rows.map((r) => (r.row as { action: string }).action))
    expect(actions).toContain('site.invite.created')
    expect(actions).toContain('site.invite.accepted')
    expect(JSON.stringify(audit.rows.map((r) => r.row))).not.toContain(inviteeEmail)
  })

  // --- listing and revocation (the team-management surface) ---

  /** A site of its own, so the invites created above do not appear in the lists. */
  const freshSite = async (): Promise<string> => {
    const created = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId: ownerId,
    })
    return created.siteId
  }

  it('lists pending and recently expired invites, oldest first, never the token hash', async () => {
    const listSiteId = await freshSite()
    const acceptorEmail = `acceptor-${Date.now()}@example.com`
    const acceptor = await makeUser(acceptorEmail)

    const first = await createInvite(db, {
      siteId: listSiteId,
      email: `pending-1-${Date.now()}@example.com`,
      role: 'viewer',
      invitedByUserId: ownerId,
    })
    const second = await createInvite(db, {
      siteId: listSiteId,
      email: `pending-2-${Date.now()}@example.com`,
      role: 'admin',
      invitedByUserId: ownerId,
    })
    // Accepted and revoked invites are settled history; neither of the screen's
    // two actions means anything on them.
    const accepted = await createInvite(db, {
      siteId: listSiteId,
      email: acceptorEmail,
      role: 'viewer',
      invitedByUserId: ownerId,
    })
    await acceptInvite(db, { rawToken: accepted.rawToken, userId: acceptor })

    const revoked = await createInvite(db, {
      siteId: listSiteId,
      email: `revoked-${Date.now()}@example.com`,
      role: 'viewer',
      invitedByUserId: ownerId,
    })
    await revokeInvite(db, {
      siteId: listSiteId,
      inviteId: revoked.inviteId,
      actorUserId: ownerId,
    })

    // Recently lapsed: still on the screen, because it can be resent or revoked.
    const expired = await createInvite(db, {
      siteId: listSiteId,
      email: `expired-${Date.now()}@example.com`,
      role: 'viewer',
      invitedByUserId: ownerId,
    })
    await pool.query(
      `UPDATE site_invites SET expires_at = now() - interval '1 day' WHERE id = $1`,
      [expired.inviteId],
    )

    // Lapsed long ago: past the visibility bound, so it is history like the rest.
    const ancient = await createInvite(db, {
      siteId: listSiteId,
      email: `ancient-${Date.now()}@example.com`,
      role: 'viewer',
      invitedByUserId: ownerId,
    })
    await pool.query(
      `UPDATE site_invites SET expires_at = now() - interval '31 days' WHERE id = $1`,
      [ancient.inviteId],
    )

    const listed = await listSiteInvites(db, listSiteId)
    expect(listed.map((invite) => invite.inviteId)).toEqual([
      first.inviteId,
      second.inviteId,
      expired.inviteId,
    ])
    expect(listed.map((invite) => invite.status)).toEqual(['pending', 'pending', 'expired'])
    expect(listed[0]?.role).toBe('viewer')
    expect(listed[0]?.invitedByUserId).toBe(ownerId)
    // The acceptance token's hash is a credential-equivalent and never leaves.
    expect(Object.keys(listed[0] ?? {})).not.toContain('tokenHash')

    // Reading the list is what settled the lapsed row's stored status: nothing
    // may report `pending` after its expiry has passed.
    const swept = await pool.query<{ status: string }>(
      `SELECT status FROM site_invites WHERE id = $1`,
      [expired.inviteId],
    )
    expect(swept.rows[0]?.status).toBe('expired')
  })

  it('revokes a pending invite, audits the role only, and refuses a second revoke', async () => {
    const revokeSiteId = await freshSite()
    const email = `revoke-me-${Date.now()}@example.com`
    const invite = await createInvite(db, {
      siteId: revokeSiteId,
      email,
      role: 'admin',
      invitedByUserId: ownerId,
    })

    expect(
      await revokeInvite(db, {
        siteId: revokeSiteId,
        inviteId: invite.inviteId,
        actorUserId: ownerId,
      }),
    ).toEqual({ revoked: true })

    const row = await pool.query<{ status: string }>(
      `SELECT status FROM site_invites WHERE id = $1`,
      [invite.inviteId],
    )
    expect(row.rows[0]?.status).toBe('revoked')

    // Not idempotent by replay: a second DELETE has nothing to revoke.
    expect(
      await revokeInvite(db, {
        siteId: revokeSiteId,
        inviteId: invite.inviteId,
        actorUserId: ownerId,
      }),
    ).toEqual({ revoked: false })

    const audit = await pool.query<{ row: unknown }>(
      `SELECT to_jsonb(t) AS row FROM audit_logs t
       WHERE action = 'site.invite.revoked' AND site_id = $1`,
      [revokeSiteId],
    )
    expect(audit.rows).toHaveLength(1)
    expect(JSON.stringify(audit.rows[0]?.row)).toContain('"role":"admin"')
    expect(JSON.stringify(audit.rows[0]?.row)).not.toContain(email)
  })

  it('a revoked invite can no longer be accepted', async () => {
    const revokeSiteId = await freshSite()
    const email = `revoked-accept-${Date.now()}@example.com`
    const userId = await makeUser(email)
    const invite = await createInvite(db, {
      siteId: revokeSiteId,
      email,
      role: 'viewer',
      invitedByUserId: ownerId,
    })

    await revokeInvite(db, { siteId: revokeSiteId, inviteId: invite.inviteId })

    await expect(acceptInvite(db, { rawToken: invite.rawToken, userId })).rejects.toMatchObject({
      violation: 'invalid_or_expired',
    })
    const members = await listMembers(db, revokeSiteId)
    expect(members.map((m) => m.userId)).not.toContain(userId)
  })

  it('refuses to revoke an accepted invite - a membership is not undone here', async () => {
    const revokeSiteId = await freshSite()
    const email = `accepted-revoke-${Date.now()}@example.com`
    const invite = await createInvite(db, {
      siteId: revokeSiteId,
      email,
      role: 'viewer',
      invitedByUserId: ownerId,
    })
    const userId = await makeUser(email)
    await acceptInvite(db, { rawToken: invite.rawToken, userId })

    expect(
      await revokeInvite(db, {
        siteId: revokeSiteId,
        inviteId: invite.inviteId,
        actorUserId: ownerId,
      }),
    ).toEqual({ revoked: false })
    // The membership the acceptance created is untouched.
    const members = await listMembers(db, revokeSiteId)
    expect(members.map((m) => m.userId)).toContain(userId)
  })

  it("cannot revoke another site's invite by id", async () => {
    const siteA = await freshSite()
    const siteB = await freshSite()
    const invite = await createInvite(db, {
      siteId: siteA,
      email: `cross-site-${Date.now()}@example.com`,
      role: 'viewer',
      invitedByUserId: ownerId,
    })

    // Authorization was granted on site B; the invite belongs to site A.
    expect(
      await revokeInvite(db, { siteId: siteB, inviteId: invite.inviteId, actorUserId: ownerId }),
    ).toEqual({ revoked: false })

    const row = await pool.query<{ status: string }>(
      `SELECT status FROM site_invites WHERE id = $1`,
      [invite.inviteId],
    )
    expect(row.rows[0]?.status).toBe('pending')
  })

  // --- lazy expiry (the invisible-block dead end) ---

  const lapse = async (inviteId: string, interval = '1 day'): Promise<void> => {
    await pool.query(
      `UPDATE site_invites SET expires_at = now() - interval '${interval}' WHERE id = $1`,
      [inviteId],
    )
  }

  it('flips only overdue pending rows, and leaves settled ones alone', async () => {
    const sweepSiteId = await freshSite()
    const live = await createInvite(db, {
      siteId: sweepSiteId,
      email: `live-${Date.now()}@example.com`,
      role: 'viewer',
      invitedByUserId: ownerId,
    })
    const overdue = await createInvite(db, {
      siteId: sweepSiteId,
      email: `overdue-${Date.now()}@example.com`,
      role: 'viewer',
      invitedByUserId: ownerId,
    })
    const revoked = await createInvite(db, {
      siteId: sweepSiteId,
      email: `revoked-sweep-${Date.now()}@example.com`,
      role: 'viewer',
      invitedByUserId: ownerId,
    })
    await revokeInvite(db, { siteId: sweepSiteId, inviteId: revoked.inviteId })
    // Both lapse *after* the last `createInvite`: that call sweeps this site
    // inside its own transaction, and would have settled `overdue` for us,
    // leaving this test asserting on a sweep with nothing left to do.
    await lapse(overdue.inviteId)
    await lapse(revoked.inviteId)

    expect(await expireStaleInvites(db, { siteId: sweepSiteId })).toBe(1)
    // Idempotent: the second pass has nothing left to settle.
    expect(await expireStaleInvites(db, { siteId: sweepSiteId })).toBe(0)

    const rows = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM site_invites WHERE site_id = $1`,
      [sweepSiteId],
    )
    const byId = new Map(rows.rows.map((row) => [row.id, row.status]))
    expect(byId.get(live.inviteId)).toBe('pending')
    expect(byId.get(overdue.inviteId)).toBe('expired')
    // A revoked row stays revoked: the clock does not undo a decision.
    expect(byId.get(revoked.inviteId)).toBe('revoked')

    // The sweep is the clock catching up, not an account acting — no audit row.
    const audit = await pool.query(
      `SELECT 1 FROM audit_logs WHERE site_id = $1 AND action LIKE 'site.invite.expire%'`,
      [sweepSiteId],
    )
    expect(audit.rows).toHaveLength(0)
  })

  it('lets a lapsed invite be re-issued instead of blocking it invisibly', async () => {
    // The regression: nothing set `status = 'expired'`, so a lapsed invite went on
    // holding the partial unique index while every clock-filtered read hid it —
    // a 409 pointing at an invitation nobody could see, revoke or resend.
    const deadEndSiteId = await freshSite()
    const email = `dead-end-${Date.now()}@example.com`
    const stale = await createInvite(db, {
      siteId: deadEndSiteId,
      email,
      role: 'viewer',
      invitedByUserId: ownerId,
    })
    await lapse(stale.inviteId)

    const fresh = await createInvite(db, {
      siteId: deadEndSiteId,
      email,
      role: 'admin',
      invitedByUserId: ownerId,
    })
    expect(fresh.inviteId).not.toBe(stale.inviteId)

    const listed = await listSiteInvites(db, deadEndSiteId)
    expect(listed.map((invite) => [invite.inviteId, invite.status])).toEqual([
      [stale.inviteId, 'expired'],
      [fresh.inviteId, 'pending'],
    ])

    // The live one still blocks a third: the index is the authority on that.
    await expect(
      createInvite(db, { siteId: deadEndSiteId, email, role: 'viewer', invitedByUserId: ownerId }),
    ).rejects.toMatchObject({ violation: 'already_invited' })
  })

  it('refuses to invite an address that already belongs to a member', async () => {
    const memberSiteId = await freshSite()
    const email = `already-member-${Date.now()}@example.com`
    const userId = await makeUser(email)
    const invite = await createInvite(db, {
      siteId: memberSiteId,
      email,
      role: 'viewer',
      invitedByUserId: ownerId,
    })
    await acceptInvite(db, { rawToken: invite.rawToken, userId })

    // Up front, rather than only when the recipient clicks a link that can never
    // work — and case-insensitively, as the pending index compares addresses.
    await expect(
      createInvite(db, {
        siteId: memberSiteId,
        email: email.toUpperCase(),
        role: 'admin',
        invitedByUserId: ownerId,
      }),
    ).rejects.toMatchObject({ violation: 'already_member' })
  })

  // --- resend ---

  it('revives an expired invite, invalidates the old token and audits the resend', async () => {
    const resendSiteId = await freshSite()
    const email = `resend-${Date.now()}@example.com`
    const userId = await makeUser(email)
    const invite = await createInvite(db, {
      siteId: resendSiteId,
      email,
      role: 'admin',
      invitedByUserId: ownerId,
    })
    await lapse(invite.inviteId)

    const resent = await resendInvite(db, {
      siteId: resendSiteId,
      inviteId: invite.inviteId,
      actorUserId: ownerId,
    })
    expect(resent.inviteId).toBe(invite.inviteId)
    expect(resent.email).toBe(email)
    expect(resent.rawToken).not.toBe(invite.rawToken)
    expect(resent.rawToken.startsWith('oa_inv_')).toBe(true)
    expect(resent.expiresAt.getTime()).toBeGreaterThan(Date.now())
    expect(resent.tokenHashPrefix).toMatch(/^[0-9a-f]{16}$/)

    // Back to pending, and listed as such.
    const listed = await listSiteInvites(db, resendSiteId)
    expect(listed.map((row) => [row.inviteId, row.status])).toEqual([[invite.inviteId, 'pending']])

    // Exactly one live link: the old token is dead, the new one works.
    await expect(acceptInvite(db, { rawToken: invite.rawToken, userId })).rejects.toMatchObject({
      violation: 'invalid_or_expired',
    })
    expect(await acceptInvite(db, { rawToken: resent.rawToken, userId })).toEqual({
      siteId: resendSiteId,
      role: 'admin',
    })

    const audit = await pool.query<{ row: unknown }>(
      `SELECT to_jsonb(t) AS row FROM audit_logs t
       WHERE action = 'site.invite.resent' AND site_id = $1`,
      [resendSiteId],
    )
    expect(audit.rows).toHaveLength(1)
    expect(JSON.stringify(audit.rows[0]?.row)).toContain('"from_status":"expired"')
    // The invited address is PII and never enters the audit trail.
    expect(JSON.stringify(audit.rows[0]?.row)).not.toContain(email)
  })

  it('resends a live invite with a fresh token and a later deadline', async () => {
    const resendSiteId = await freshSite()
    const invite = await createInvite(db, {
      siteId: resendSiteId,
      email: `resend-live-${Date.now()}@example.com`,
      role: 'viewer',
      invitedByUserId: ownerId,
      ttlHours: 1,
    })

    const resent = await resendInvite(db, {
      siteId: resendSiteId,
      inviteId: invite.inviteId,
      actorUserId: ownerId,
    })
    // A different token every time, so two resends never share an outbox key.
    const again = await resendInvite(db, {
      siteId: resendSiteId,
      inviteId: invite.inviteId,
      actorUserId: ownerId,
    })
    expect(again.rawToken).not.toBe(resent.rawToken)
    expect(again.tokenHashPrefix).not.toBe(resent.tokenHashPrefix)

    const row = await pool.query<{ expires_at: Date; status: string }>(
      `SELECT expires_at, status FROM site_invites WHERE id = $1`,
      [invite.inviteId],
    )
    expect(row.rows[0]?.status).toBe('pending')
    // The one-hour TTL this invite was created with is replaced by the default.
    expect(row.rows[0]?.expires_at.getTime()).toBeGreaterThan(Date.now() + 60 * 60 * 1000)
  })

  it('refuses to resend an accepted, revoked or another site’s invite', async () => {
    const siteA = await freshSite()
    const siteB = await freshSite()

    const revoked = await createInvite(db, {
      siteId: siteA,
      email: `resend-revoked-${Date.now()}@example.com`,
      role: 'viewer',
      invitedByUserId: ownerId,
    })
    await revokeInvite(db, { siteId: siteA, inviteId: revoked.inviteId })
    await expect(
      resendInvite(db, { siteId: siteA, inviteId: revoked.inviteId, actorUserId: ownerId }),
    ).rejects.toMatchObject({ violation: 'invalid_or_expired' })

    const acceptedEmail = `resend-accepted-${Date.now()}@example.com`
    const acceptedUser = await makeUser(acceptedEmail)
    const accepted = await createInvite(db, {
      siteId: siteA,
      email: acceptedEmail,
      role: 'viewer',
      invitedByUserId: ownerId,
    })
    await acceptInvite(db, { rawToken: accepted.rawToken, userId: acceptedUser })
    await expect(
      resendInvite(db, { siteId: siteA, inviteId: accepted.inviteId, actorUserId: ownerId }),
    ).rejects.toMatchObject({ violation: 'invalid_or_expired' })

    // Authorization was granted on site B; the invite belongs to site A.
    const live = await createInvite(db, {
      siteId: siteA,
      email: `resend-cross-${Date.now()}@example.com`,
      role: 'viewer',
      invitedByUserId: ownerId,
    })
    await expect(
      resendInvite(db, { siteId: siteB, inviteId: live.inviteId, actorUserId: ownerId }),
    ).rejects.toMatchObject({ violation: 'invalid_or_expired' })
  })

  it('refuses to revive an expired invite that a newer live one has replaced', async () => {
    const clashSiteId = await freshSite()
    const email = `resend-clash-${Date.now()}@example.com`
    const stale = await createInvite(db, {
      siteId: clashSiteId,
      email,
      role: 'viewer',
      invitedByUserId: ownerId,
    })
    await lapse(stale.inviteId)
    await createInvite(db, { siteId: clashSiteId, email, role: 'admin', invitedByUserId: ownerId })

    // The partial unique index decides this, not a pre-read: one live invitation
    // per address, and the newer one is it.
    await expect(
      resendInvite(db, { siteId: clashSiteId, inviteId: stale.inviteId, actorUserId: ownerId }),
    ).rejects.toMatchObject({ violation: 'already_invited' })
  })

  it('refuses to resend to an address that has since joined the site', async () => {
    const joinedSiteId = await freshSite()
    const email = `resend-joined-${Date.now()}@example.com`
    const userId = await makeUser(email)
    // An older invitation to the address, which lapsed unused. It has to exist
    // before the person joins: `createInvite` refuses an address that already
    // belongs to a member, so this row could not be made afterwards.
    const orphan = await createInvite(db, {
      siteId: joinedSiteId,
      email,
      role: 'admin',
      invitedByUserId: ownerId,
    })
    await lapse(orphan.inviteId)

    // Then a second invitation, which they accepted - so they are a member and
    // the orphan is an expired row a manager can still see and resend.
    const joined = await createInvite(db, {
      siteId: joinedSiteId,
      email,
      role: 'viewer',
      invitedByUserId: ownerId,
    })
    await acceptInvite(db, { rawToken: joined.rawToken, userId })

    await expect(
      resendInvite(db, { siteId: joinedSiteId, inviteId: orphan.inviteId, actorUserId: ownerId }),
    ).rejects.toMatchObject({ violation: 'already_member' })
  })

  it('revokes an expired invite, so a listed row never carries a dead action', async () => {
    const revokeSiteId = await freshSite()
    const invite = await createInvite(db, {
      siteId: revokeSiteId,
      email: `revoke-expired-${Date.now()}@example.com`,
      role: 'viewer',
      invitedByUserId: ownerId,
    })
    await lapse(invite.inviteId)
    await expireStaleInvites(db, { siteId: revokeSiteId })

    expect(
      await revokeInvite(db, {
        siteId: revokeSiteId,
        inviteId: invite.inviteId,
        actorUserId: ownerId,
      }),
    ).toEqual({ revoked: true })
    // And once revoked it is settled: no resend can revive it.
    await expect(
      resendInvite(db, { siteId: revokeSiteId, inviteId: invite.inviteId, actorUserId: ownerId }),
    ).rejects.toMatchObject({ violation: 'invalid_or_expired' })
    expect(await listSiteInvites(db, revokeSiteId)).toEqual([])
  })
})
