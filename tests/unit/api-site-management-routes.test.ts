import { loadServiceEnv } from '@openanalytics/domain'
import type { Auth, SiteRole } from '@openanalytics/auth'
import type { Database } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The management routes' own authorization and validation, without Postgres.
 *
 * These are the rules that live at the route and nowhere else, so no repository
 * suite can prove them:
 *
 * - the owner-only escalation guard on the member role change, which exists
 *   because an `admin` holds `team:manage` and could otherwise promote
 *   themselves to owner;
 * - that the guard runs *before* any write — `updateMemberRole` is asserted not
 *   to have been called on a refusal;
 * - the `site:settings` capability on the settings update, and the shape rules
 *   (at least one property, a domain list that is an array of bare hostnames)
 *   that must be applied before the replace-set is written.
 */

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const OWNER = 'u-owner'
const SECOND_OWNER = 'u-owner-2'
const ADMIN = 'u-admin'
const VIEWER = 'u-viewer'
const STRANGER = 'u-stranger'

const memberships = new Map<string, { role: SiteRole; isBillingOwner: boolean }>([
  [OWNER, { role: 'owner', isBillingOwner: true }],
  [SECOND_OWNER, { role: 'owner', isBillingOwner: false }],
  [ADMIN, { role: 'admin', isBillingOwner: false }],
  [VIEWER, { role: 'viewer', isBillingOwner: false }],
])

const calls = {
  updateMemberRole: [] as { userId: string; role: SiteRole }[],
  updateSiteSettings: [] as {
    name?: string
    domains?: readonly string[]
    reportingTimezone?: string | null
  }[],
  revokeInvite: [] as string[],
  resendInvite: [] as { siteId: string; inviteId: string }[],
  createInvite: [] as { email: string; role: SiteRole }[],
  outbox: [] as string[],
}
const revokeResult = { revoked: true }
/** Set by a test to make the next invite write fail the way the repository would. */
const inviteViolation: { create: string | null; resend: string | null } = {
  create: null,
  resend: null,
}

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    getMembership: async (_db: unknown, params: { siteId: string; userId: string }) =>
      memberships.get(params.userId) ?? null,
    updateMemberRole: async (_db: unknown, input: { userId: string; role: SiteRole }) => {
      calls.updateMemberRole.push({ userId: input.userId, role: input.role })
      return {
        userId: input.userId,
        role: input.role,
        previousRole: memberships.get(input.userId)?.role ?? 'viewer',
        changed: true,
      }
    },
    updateSiteSettings: async (
      _db: unknown,
      input: { name?: string; domains?: readonly string[]; reportingTimezone?: string | null },
    ) => {
      calls.updateSiteSettings.push({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.domains === undefined ? {} : { domains: input.domains }),
        // Recorded on `undefined` vs present rather than on truthiness: `null`
        // is a value here (it clears the setting), so a truthiness test would
        // make "clear it" indistinguishable from "do not touch it".
        ...(input.reportingTimezone === undefined
          ? {}
          : { reportingTimezone: input.reportingTimezone }),
      })
      return {
        siteId: SITE,
        slug: 'acme',
        name: input.name ?? 'Acme',
        status: 'active' as const,
        domains: [...(input.domains ?? [])],
        configVersion: 2,
        configVersionBumped: input.domains !== undefined,
        createdAt: new Date('2026-02-03T04:05:06.000Z'),
        firstEventAt: new Date('2026-02-03T05:00:00.000Z'),
        reportingTimezone: input.reportingTimezone ?? null,
      }
    },
    listSiteInvites: async () => [
      {
        inviteId: 'inv-1',
        email: 'invited@example.com',
        role: 'viewer' as const,
        invitedByUserId: OWNER,
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        expiresAt: new Date('2026-07-08T00:00:00.000Z'),
        status: 'pending' as const,
      },
      {
        inviteId: 'inv-2',
        email: 'lapsed@example.com',
        role: 'admin' as const,
        invitedByUserId: OWNER,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        expiresAt: new Date('2026-06-08T00:00:00.000Z'),
        status: 'expired' as const,
      },
    ],
    revokeInvite: async (_db: unknown, input: { inviteId: string }) => {
      calls.revokeInvite.push(input.inviteId)
      return { revoked: revokeResult.revoked }
    },
    getSiteBasics: async () => ({
      siteId: SITE,
      slug: 'acme',
      name: 'Acme',
      status: 'active' as const,
    }),
    createInvite: async (_db: unknown, input: { email: string; role: SiteRole }) => {
      if (inviteViolation.create !== null) {
        throw new actual.InviteError(
          inviteViolation.create as 'already_invited',
          'refused by the repository',
        )
      }
      calls.createInvite.push({ email: input.email, role: input.role })
      return { inviteId: 'inv-new', rawToken: 'oa_inv_raw' }
    },
    resendInvite: async (_db: unknown, input: { siteId: string; inviteId: string }) => {
      if (inviteViolation.resend !== null) {
        throw new actual.InviteError(
          inviteViolation.resend as 'invalid_or_expired',
          'refused by the repository',
        )
      }
      calls.resendInvite.push({ siteId: input.siteId, inviteId: input.inviteId })
      return {
        inviteId: input.inviteId,
        email: 'invited@example.com',
        role: 'viewer' as const,
        expiresAt: new Date('2026-07-15T00:00:00.000Z'),
        rawToken: 'oa_inv_resent',
        tokenHashPrefix: 'abcdef0123456789',
      }
    },
    enqueueOutbox: async (_db: unknown, input: { idempotencyKey: string }) => {
      calls.outbox.push(input.idempotencyKey)
      return { enqueued: true, id: 'outbox-1' }
    },
  }
})

const { createApp } = await import('../../apps/api/src/app.ts')

/** The caller is chosen per request with a test header, so one app instance can
 * exercise every role. */
const auth = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const id = headers.get('x-test-user')
      if (id === null) return null
      return {
        user: {
          id,
          email: `${id}@example.test`,
          emailVerified: true,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        session: { createdAt: new Date('2026-01-01T00:00:00.000Z') },
      }
    },
  },
  handler: async () => new Response(null),
} as unknown as Auth

const { logger } = createCapturedLogger()
const app = createApp({
  service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
  logger,
  env: loadServiceEnv('api', testEnv()),
  auth,
  db: {} as Database,
})

const send = (method: string, path: string, user: string, body?: unknown) =>
  app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: {
        'x-test-user': user,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )

beforeEach(() => {
  calls.updateMemberRole = []
  calls.updateSiteSettings = []
  calls.revokeInvite = []
  calls.resendInvite = []
  calls.createInvite = []
  calls.outbox = []
  revokeResult.revoked = true
  inviteViolation.create = null
  inviteViolation.resend = null
})

describe('PATCH /v1/sites/{site_id}/members/{user_id}', () => {
  it('refuses an admin granting the owner role, before any write', async () => {
    const res = await send('PATCH', `/v1/sites/${SITE}/members/${ADMIN}`, ADMIN, { role: 'owner' })
    expect(res.status).toBe(403)
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'FORBIDDEN' },
    })
    // The guard has to run before the repository is reached: `updateMemberRole`
    // reports the previous role only once it has already written.
    expect(calls.updateMemberRole).toEqual([])
  })

  it('refuses an admin revoking the owner role, before any write', async () => {
    const res = await send('PATCH', `/v1/sites/${SITE}/members/${SECOND_OWNER}`, ADMIN, {
      role: 'viewer',
    })
    expect(res.status).toBe(403)
    expect(calls.updateMemberRole).toEqual([])
  })

  it('lets an owner grant and revoke the owner role', async () => {
    const granted = await send('PATCH', `/v1/sites/${SITE}/members/${ADMIN}`, OWNER, {
      role: 'owner',
    })
    expect(granted.status).toBe(200)
    expect(await granted.json()).toEqual({ user_id: ADMIN, role: 'owner' })

    const revoked = await send('PATCH', `/v1/sites/${SITE}/members/${SECOND_OWNER}`, OWNER, {
      role: 'viewer',
    })
    expect(revoked.status).toBe(200)
    expect(calls.updateMemberRole).toHaveLength(2)
  })

  it('lets an admin change a non-owner to a non-owner role', async () => {
    const res = await send('PATCH', `/v1/sites/${SITE}/members/${VIEWER}`, ADMIN, { role: 'admin' })
    expect(res.status).toBe(200)
    expect(calls.updateMemberRole).toEqual([{ userId: VIEWER, role: 'admin' }])
  })

  it('404s a target who is not a member of this site, without writing', async () => {
    const res = await send('PATCH', `/v1/sites/${SITE}/members/${STRANGER}`, OWNER, {
      role: 'admin',
    })
    expect(res.status).toBe(404)
    expect(calls.updateMemberRole).toEqual([])
  })

  it('refuses a viewer, who does not hold team:manage', async () => {
    expect(
      (await send('PATCH', `/v1/sites/${SITE}/members/${ADMIN}`, VIEWER, { role: 'viewer' }))
        .status,
    ).toBe(403)
    expect(calls.updateMemberRole).toEqual([])
  })

  it('rejects a role that is not a site role', async () => {
    const res = await send('PATCH', `/v1/sites/${SITE}/members/${VIEWER}`, OWNER, {
      role: 'superuser',
    })
    expect(res.status).toBe(400)
    expect(calls.updateMemberRole).toEqual([])
  })
})

describe('PATCH /v1/sites/{site_id}', () => {
  it('normalizes and de-duplicates the domain replace-set before writing it', async () => {
    const res = await send('PATCH', `/v1/sites/${SITE}`, ADMIN, {
      name: '  Renamed  ',
      domains: ['Shop.Example.com', 'shop.example.com.', 'www.example.com'],
    })
    expect(res.status).toBe(200)
    expect(calls.updateSiteSettings).toEqual([
      { name: 'Renamed', domains: ['shop.example.com', 'www.example.com'] },
    ])
    const body = (await res.json()) as {
      domains: string[]
      role: string
      is_billing_owner: boolean
      created_at: string
      first_event_at: string | null
    }
    expect(body.domains).toEqual(['shop.example.com', 'www.example.com'])
    // The caller's own role and billing-owner flag, from the membership the
    // middleware already resolved.
    expect(body.role).toBe('admin')
    expect(body.is_billing_owner).toBe(false)
    // The creation instant survives an update: it is what the dashboard anchors
    // its "All time" interval at, so a settings save must not drop it.
    expect(body.created_at).toBe('2026-02-03T04:05:06.000Z')
    // And so does the install-verified signal (ADR-0027): renaming a site must
    // not make onboarding think the tracker was uninstalled.
    expect(body.first_event_at).toBe('2026-02-03T05:00:00.000Z')
  })

  it('refuses a viewer — site:settings is owner/admin only', async () => {
    const res = await send('PATCH', `/v1/sites/${SITE}`, VIEWER, { name: 'Nope' })
    expect(res.status).toBe(403)
    expect(calls.updateSiteSettings).toEqual([])
  })

  it('refuses an update that changes nothing', async () => {
    const res = await send('PATCH', `/v1/sites/${SITE}`, OWNER, {})
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    })
    expect(calls.updateSiteSettings).toEqual([])
  })

  it('names the offending domain entry rather than guessing what it meant', async () => {
    const res = await send('PATCH', `/v1/sites/${SITE}`, OWNER, {
      domains: ['shop.example.com', 'https://nope.example.com/app'],
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as {
      error: {
        details: { issues: { field: string; code: string; index: number; value: string }[] }
      }
    }
    expect(body.error.details.issues[0]).toMatchObject({
      field: 'domains',
      code: 'invalid',
      index: 1,
      value: 'https://nope.example.com/app',
    })
    expect(calls.updateSiteSettings).toEqual([])
  })

  it('refuses more domains than a site may carry', async () => {
    const res = await send('PATCH', `/v1/sites/${SITE}`, OWNER, {
      domains: Array.from({ length: 11 }, (_, i) => `d${i}.example.com`),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as {
      error: { details: { issues: { code: string; count: number }[] } }
    }
    expect(body.error.details.issues[0]).toMatchObject({ code: 'too_many', count: 11 })
  })

  it('refuses domains that are not an array', async () => {
    const res = await send('PATCH', `/v1/sites/${SITE}`, OWNER, { domains: 'example.com' })
    expect(res.status).toBe(400)
    expect(calls.updateSiteSettings).toEqual([])
  })

  /**
   * `reporting_timezone` (ADR-0044, D4).
   *
   * The validation is `isValidTimezone`, reused rather than reimplemented, and
   * what it buys over a pattern is both halves of ADR-0026 decision 6: the
   * runtime's own tz database, and the identifier shape that keeps a UTC offset
   * off this column.
   */
  it('accepts a valid IANA zone and passes it through', async () => {
    const res = await send('PATCH', `/v1/sites/${SITE}`, ADMIN, {
      reporting_timezone: 'Europe/Istanbul',
    })
    expect(res.status).toBe(200)
    expect(calls.updateSiteSettings).toEqual([{ reportingTimezone: 'Europe/Istanbul' }])
    const body = (await res.json()) as { reporting_timezone: string | null }
    expect(body.reporting_timezone).toBe('Europe/Istanbul')
  })

  it('refuses a UTC offset, which Intl would have accepted as a zone', async () => {
    // `new Intl.DateTimeFormat('en-US', { timeZone: '+05:00' })` does not throw,
    // so the runtime check alone would store this — and the column CHECK would
    // then refuse it as an unhandled database error: a caller's mistake turned
    // into our 500. The shape guard is what makes it a clean 400, and an offset
    // is not a timezone anyway (it is one evaluated at a single instant).
    const res = await send('PATCH', `/v1/sites/${SITE}`, OWNER, {
      reporting_timezone: '+05:00',
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as {
      error: { code: string; details: { issues: { field: string; value: string }[] } }
    }
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.details.issues[0]).toMatchObject({
      field: 'reporting_timezone',
      value: '+05:00',
    })
    expect(calls.updateSiteSettings).toEqual([])
  })

  it('refuses a well-formed identifier the tz database does not know', async () => {
    const res = await send('PATCH', `/v1/sites/${SITE}`, OWNER, {
      reporting_timezone: 'Europe/Atlantis',
    })
    expect(res.status).toBe(400)
    expect(calls.updateSiteSettings).toEqual([])
  })

  it('accepts an explicit null as "clear it", which is not the same as omitting it', async () => {
    const res = await send('PATCH', `/v1/sites/${SITE}`, OWNER, { reporting_timezone: null })
    expect(res.status).toBe(200)
    expect(calls.updateSiteSettings).toEqual([{ reportingTimezone: null }])
  })

  it('a lone reporting_timezone satisfies the at-least-one-field rule', async () => {
    // Regression guard for the four-way `if`: adding a settable field without
    // adding it to that condition makes the endpoint refuse a request that names
    // only the new field.
    const res = await send('PATCH', `/v1/sites/${SITE}`, OWNER, { reporting_timezone: 'UTC' })
    expect(res.status).toBe(200)
  })

  it('accepts an empty list, which clears the allowlist', async () => {
    const res = await send('PATCH', `/v1/sites/${SITE}`, OWNER, { domains: [] })
    expect(res.status).toBe(200)
    expect(calls.updateSiteSettings).toEqual([{ domains: [] }])
  })
})

describe('site invites over HTTP', () => {
  it('lists pending and expired invites for a team manager, with ISO-Z timestamps', async () => {
    const res = await send('GET', `/v1/sites/${SITE}/invites`, ADMIN)
    expect(res.status).toBe(200)
    // `status` is what makes the two rows distinguishable: the list carries
    // lapsed invitations now, and the screen has to know which link is dead.
    expect(await res.json()).toEqual({
      items: [
        {
          invite_id: 'inv-1',
          email: 'invited@example.com',
          role: 'viewer',
          invited_by_user_id: OWNER,
          created_at: '2026-07-01T00:00:00.000Z',
          expires_at: '2026-07-08T00:00:00.000Z',
          status: 'pending',
        },
        {
          invite_id: 'inv-2',
          email: 'lapsed@example.com',
          role: 'admin',
          invited_by_user_id: OWNER,
          created_at: '2026-06-01T00:00:00.000Z',
          expires_at: '2026-06-08T00:00:00.000Z',
          status: 'expired',
        },
      ],
    })
  })

  it('refuses a viewer the invite list, the revocation and the resend', async () => {
    expect((await send('GET', `/v1/sites/${SITE}/invites`, VIEWER)).status).toBe(403)
    expect((await send('DELETE', `/v1/sites/${SITE}/invites/inv-1`, VIEWER)).status).toBe(403)
    // Resend mints an acceptance credential, so it carries the same guard as
    // creating one; a viewer must not reach the repository at all.
    expect((await send('POST', `/v1/sites/${SITE}/invites/inv-1/resend`, VIEWER)).status).toBe(403)
    expect(calls.revokeInvite).toEqual([])
    expect(calls.resendInvite).toEqual([])
  })

  it('refuses a non-member the resend, as a site they cannot see', async () => {
    const res = await send('POST', `/v1/sites/${SITE}/invites/inv-1/resend`, STRANGER)
    expect(res.status).toBe(404)
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'SITE_NOT_FOUND' },
    })
    expect(calls.resendInvite).toEqual([])
  })

  it('resends with a new deadline and an outbox key that cannot collide', async () => {
    const res = await send('POST', `/v1/sites/${SITE}/invites/inv-1/resend`, ADMIN)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      invite_id: 'inv-1',
      expires_at: '2026-07-15T00:00:00.000Z',
      status: 'pending',
    })
    expect(calls.resendInvite).toEqual([{ siteId: SITE, inviteId: 'inv-1' }])
    // Not `email.invite:inv-1`: `enqueueOutbox` is ON CONFLICT DO NOTHING, so
    // reusing the create key would make every resend a silent no-op.
    expect(calls.outbox).toEqual(['email.invite:inv-1:resend:abcdef0123456789'])
  })

  it('404s a resend the repository will not act on', async () => {
    inviteViolation.resend = 'invalid_or_expired'
    const res = await send('POST', `/v1/sites/${SITE}/invites/inv-9/resend`, ADMIN)
    expect(res.status).toBe(404)
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'NOT_FOUND' },
    })
    // No email for a resend that did not happen.
    expect(calls.outbox).toEqual([])
  })

  it('gives the two invite 409s their own codes', async () => {
    // One is fixed by revoking or resending the invitation that already exists;
    // the other means there is nothing to do at all. Collapsed into a single
    // IDEMPOTENCY_CONFLICT the frontend could only shrug at both.
    inviteViolation.create = 'already_member'
    const member = await send('POST', `/v1/sites/${SITE}/invites`, ADMIN, {
      email: 'someone@example.com',
      role: 'viewer',
    })
    expect(member.status).toBe(409)
    expect((await member.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'ALREADY_MEMBER' },
    })

    inviteViolation.create = 'already_invited'
    const invited = await send('POST', `/v1/sites/${SITE}/invites`, ADMIN, {
      email: 'someone@example.com',
      role: 'viewer',
    })
    expect(invited.status).toBe(409)
    expect((await invited.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    })

    inviteViolation.resend = 'already_member'
    const resent = await send('POST', `/v1/sites/${SITE}/invites/inv-1/resend`, ADMIN)
    expect(resent.status).toBe(409)
    expect((await resent.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'ALREADY_MEMBER' },
    })
    expect(calls.outbox).toEqual([])
  })

  it('revokes with 204 and 404s a replay', async () => {
    const first = await send('DELETE', `/v1/sites/${SITE}/invites/inv-1`, ADMIN)
    expect(first.status).toBe(204)
    expect(calls.revokeInvite).toEqual(['inv-1'])

    // Only a `pending` row is revocable, so a second call revokes nothing and
    // must not claim it did.
    revokeResult.revoked = false
    const second = await send('DELETE', `/v1/sites/${SITE}/invites/inv-1`, ADMIN)
    expect(second.status).toBe(404)
    expect((await second.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'NOT_FOUND' },
    })
  })
})
