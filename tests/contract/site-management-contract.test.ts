import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  createdSiteFixture,
  expiredSiteInviteFixture,
  inviteResentFixture,
  siteInviteFixture,
  statusForErrorCode,
} from '@openanalytics/contracts'
import { describe, expect, it } from 'vitest'

const SPEC_PATH = fileURLToPath(
  new URL('../../packages/contracts/openapi/openapi.yaml', import.meta.url),
)

/**
 * The management-API surface completion: site create and settings, invite
 * listing and revocation, and the member role change.
 *
 * The billing usage read and the billing-transfer offer flow were here too until
 * the open-core split; both are documented by the cloud spec now
 * (`tests/contract/cloud/site-management-contract.test.ts`).
 *
 * The contract is edited before the implementation (AGENTS.md), so this asserts
 * the document itself. The fixtures are annotated with their generated schema
 * types, so importing them here also proves the generated client and the spec
 * agree about these shapes.
 */

async function spec(): Promise<string> {
  return readFile(SPEC_PATH, 'utf8')
}

describe('OpenAPI documents the management operations', () => {
  it('declares all five new operationIds', async () => {
    const text = await spec()
    for (const operationId of [
      'createSite',
      'updateSite',
      'listSiteInvites',
      'revokeSiteInvite',
      'updateSiteMemberRole',
    ]) {
      expect(text, `openapi.yaml is missing operationId ${operationId}`).toContain(
        `operationId: ${operationId}`,
      )
    }
  })

  it('declares each operationId exactly once', async () => {
    const text = await spec()
    for (const operationId of [
      'createSite',
      'updateSite',
      'listSiteInvites',
      'revokeSiteInvite',
      'updateSiteMemberRole',
    ]) {
      const occurrences = text.split(`operationId: ${operationId}\n`).length - 1
      expect(occurrences, operationId).toBe(1)
    }
  })

  it('routes the invite revocation at its own path item', async () => {
    const text = await spec()
    expect(text).toContain('/v1/sites/{site_id}/invites/{invite_id}:')
  })
})

describe('POST /v1/sites', () => {
  it('declares the Idempotency-Key header through a reusable component', async () => {
    const text = await spec()
    // The header parameter is shared, so later create endpoints reuse one
    // definition rather than restating the bounds (docs snapshot 02 §18).
    expect(text).toContain('IdempotencyKey:')
    expect(text).toContain('name: Idempotency-Key')
    expect(text).toContain('in: header')

    const block = text.slice(
      text.indexOf('operationId: createSite'),
      text.indexOf('/v1/sites/resolve:'),
    )
    expect(block).toContain("$ref: '#/components/parameters/IdempotencyKey'")
  })

  it('documents the create path’s refusals with their codes', async () => {
    const text = await spec()
    const block = text.slice(
      text.indexOf('operationId: createSite'),
      text.indexOf('/v1/sites/resolve:'),
    )
    expect(block).toContain("'201'")
    expect(block).toContain('CreatedSite')
    expect(block).toContain("'400'")
    expect(block).toContain("'401'")
    // No payment status and no capacity code: a site is born active, and the two
    // commercial refusals a hosted deployment adds are documented in its own
    // spec (`tests/contract/cloud/site-management-contract.test.ts`).
    expect(block).not.toContain("'402'")
    expect(block).not.toContain('SUBSCRIPTION_REQUIRED')
    expect(block).not.toContain('SITE_CAPACITY_EXCEEDED')
    expect(block).toContain("'409'")
    expect(block).toContain('IDEMPOTENCY_CONFLICT')
  })

  it('returns the tracking key with the created site', async () => {
    const text = await spec()
    expect(text).toContain('CreatedTrackingKey:')
    expect(createdSiteFixture.tracking_key.public_token).toMatch(/^oa_pk_/)
    expect(createdSiteFixture.is_billing_owner).toBe(true)
    // The fixture is an *entitled* create, which still yields `active`. An
    // unfunded create yields `suspended` instead (ADR-0040) — the "a site
    // is never created blocked" rule is reversed, and `status` is now decided by
    // whether the caller has a plan rather than being a constant of this route.
    expect(createdSiteFixture.status).toBe('active')
  })
})

describe('PATCH /v1/sites/{site_id}', () => {
  it('takes an UpdateSiteRequest that cannot be empty and cannot carry a slug', async () => {
    const text = await spec()
    const block = text.slice(
      text.indexOf('UpdateSiteRequest:'),
      text.indexOf('SiteResolution:', text.indexOf('UpdateSiteRequest:')),
    )
    expect(block).toContain('minProperties: 1')
    expect(block).toContain('additionalProperties: false')
    expect(block).toContain('name:')
    expect(block).toContain('domains:')
    expect(block).toContain(`maxItems: 10`)
    expect(block).not.toContain('slug:')
  })

  it('names the site:settings capability as the authorization', async () => {
    const text = await spec()
    const block = text.slice(
      text.indexOf('operationId: updateSite'),
      text.indexOf('/v1/sites/{site_id}/keys:'),
    )
    expect(block).toContain('site:settings')
  })
})

describe('SiteSummary carries the origin allowlist', () => {
  it('makes domains a required field so an empty list is unambiguous', async () => {
    const text = await spec()
    const block = text.slice(
      text.indexOf('SiteSummary:'),
      text.indexOf('SiteDomain:', text.indexOf('SiteSummary:')),
    )
    const required = block.slice(block.indexOf('required:'), block.indexOf('properties:'))
    for (const field of [
      'site_id',
      'slug',
      'name',
      'status',
      'role',
      'is_billing_owner',
      'domains',
      'created_at',
      'first_event_at',
    ]) {
      expect(required).toContain(field)
    }
    expect(text).toContain('SiteDomain:')
  })

  it('carries the lifecycle triple as required-and-nullable instants (ADR-0030)', async () => {
    const text = await spec()
    const block = text.slice(
      text.indexOf('SiteSummary:'),
      text.indexOf('SiteDomain:', text.indexOf('SiteSummary:')),
    )
    const required = block.slice(block.indexOf('required:'), block.indexOf('properties:'))

    // Required *and* nullable, the ADR-0027 convention. The blocked screen and
    // the retention countdown read these three plus `status`; an absent key
    // would mean "the server did not say", and a client that cannot tell that
    // from "not blocked" would either hide a real block or invent a fake one.
    for (const field of ['suspended_at', 'ingest_grace_until', 'retention_deadline']) {
      expect(required).toContain(field)
      const property = block.slice(block.indexOf(`${field}:`))
      const nullable = property.slice(0, property.indexOf('oneOf:') + 200)
      expect(nullable).toContain("- $ref: '#/components/schemas/UtcInstant'")
      expect(nullable).toContain("- type: 'null'")
    }
  })

  it('carries the creation instant, which the dashboard anchors "All time" at', async () => {
    const text = await spec()
    const block = text.slice(
      text.indexOf('SiteSummary:'),
      text.indexOf('SiteDomain:', text.indexOf('SiteSummary:')),
    )
    // Required, not optional: a client that has to guess a start date for the
    // widest interval would guess differently from the data.
    expect(block).toContain('created_at:')
    expect(block).toContain("$ref: '#/components/schemas/UtcInstant'")
  })

  it('carries the install-verified signal as a required, nullable instant', async () => {
    const text = await spec()
    const block = text.slice(
      text.indexOf('SiteSummary:'),
      text.indexOf('SiteDomain:', text.indexOf('SiteSummary:')),
    )
    // Required *and* nullable (ADR-0027). Optional would collapse the two
    // answers this field exists to separate: `null` means "no event has ever
    // been ingested", while an absent key would mean "the server did not say" —
    // and onboarding acts on the first, so it must never see the second.
    expect(block).toContain('first_event_at:')
    expect(block).toMatch(
      /first_event_at:[\s\S]*oneOf:\s*\n\s*- \$ref: '#\/components\/schemas\/UtcInstant'\s*\n\s*- type: 'null'/,
    )
  })

  it('leaves first_event_at off CreatedSite, where it is always null', async () => {
    const text = await spec()
    const block = text.slice(
      text.indexOf('CreatedSite:'),
      text.indexOf('UpdateSiteRequest:', text.indexOf('CreatedSite:')),
    )
    // A field that is a constant in the only response that could carry it is
    // noise: a site has no events at the instant it is created.
    expect(block).not.toContain('first_event_at')
  })
})

describe('site invites', () => {
  it('lists pending invites as SiteInvite items', async () => {
    const text = await spec()
    const block = text.slice(
      text.indexOf('operationId: listSiteInvites'),
      text.indexOf('operationId: createSiteInvite'),
    )
    expect(block).toContain('SiteInvite')
    expect(block).toContain('team:manage')
    expect(siteInviteFixture.email).toContain('@')
    expect(siteInviteFixture.expires_at > siteInviteFixture.created_at).toBe(true)
  })

  it('makes an invite say which state it is in', async () => {
    // The list carries lapsed invitations, because hiding them was the dead end:
    // the row kept blocking new invites to the address while nothing on the
    // screen could revoke or resend it. A client cannot tell the two apart —
    // or offer the right action — without a required `status`.
    const text = await spec()
    const block = text.slice(
      text.indexOf('    SiteInvite:'),
      text.indexOf('    CreateInviteRequest:'),
    )
    expect(block).toContain(
      'required: [invite_id, email, role, invited_by_user_id, created_at, expires_at, status]',
    )
    expect(block).toContain('enum: [pending, expired]')
    expect(siteInviteFixture.status).toBe('pending')
    expect(expiredSiteInviteFixture.status).toBe('expired')
    expect(expiredSiteInviteFixture.expires_at < siteInviteFixture.expires_at).toBe(true)
  })

  it('revokes with a 204 and refuses a replay with 404', async () => {
    const text = await spec()
    const block = text.slice(
      text.indexOf('operationId: revokeSiteInvite'),
      text.indexOf('/v1/sites/{site_id}/invites/{invite_id}/resend:'),
    )
    expect(block).toContain("'204'")
    expect(block).toContain("'404'")
    expect(block).toContain('NOT_FOUND')
  })

  it('documents the resend, its 404 and its two 409s', async () => {
    const text = await spec()
    const block = text.slice(
      text.indexOf('operationId: resendSiteInvite'),
      text.indexOf('/v1/invites/accept:'),
    )
    expect(block).toContain('team:manage')
    expect(block).toContain('InviteResent')
    expect(block).toContain("'404'")
    expect(block).toContain('ALREADY_MEMBER')
    // The revived invitation is live again, whatever it was a moment earlier.
    expect(inviteResentFixture.status).toBe('pending')
  })

  it('tells the two invite 409s apart by code', async () => {
    // One says "revoke or resend the invitation that already exists", the other
    // says "there is nothing to do". A single IDEMPOTENCY_CONFLICT could say
    // neither, and the frontend branches on the code, never on the message.
    const text = await spec()
    const block = text.slice(
      text.indexOf('operationId: createSiteInvite'),
      text.indexOf('/v1/sites/{site_id}/invites/{invite_id}:'),
    )
    expect(block).toContain('IDEMPOTENCY_CONFLICT')
    expect(block).toContain('ALREADY_MEMBER')
    expect(statusForErrorCode('ALREADY_MEMBER')).toBe(409)
  })
})

describe('PATCH /v1/sites/{site_id}/members/{user_id}', () => {
  it('documents BILLING_OWNER_SUCCESSOR_REQUIRED on its 409', async () => {
    const text = await spec()
    const block = text.slice(
      text.indexOf('operationId: updateSiteMemberRole'),
      text.indexOf('operationId: removeSiteMember'),
    )
    expect(block).toContain("'409'")
    expect(block).toContain('BILLING_OWNER_SUCCESSOR_REQUIRED')
  })

  it('documents the owner-only escalation guard and the last-owner invariant', async () => {
    const text = await spec()
    const block = text.slice(
      text.indexOf('operationId: updateSiteMemberRole'),
      text.indexOf('operationId: removeSiteMember'),
    )
    // An admin holds team:manage; without this rule they could promote
    // themselves to owner.
    expect(block).toContain('UpdateMemberRoleRequest')
    expect(block).toContain('at least one owner')
    expect(block).toContain('VALIDATION_FAILED')
    expect(block).toContain('FORBIDDEN')
  })
})

describe('the member list names people, not UUIDs', () => {
  it('requires email and name on every member', async () => {
    const text = await spec()
    const block = text.slice(
      text.indexOf('    SiteMember:'),
      text.indexOf('    UpdateMemberRoleRequest:'),
    )

    expect(block).toContain('required: [user_id, role, email, name]')
    expect(block).toContain('format: email')
    // Null is the "never set" answer, distinct from an empty display name — the
    // frontend renders a fallback for one and a blank label for the other.
    expect(block).toContain("type: [string, 'null']")
  })

  it('discloses the address only to a fellow member', async () => {
    const text = await spec()
    const block = text.slice(
      text.indexOf('  /v1/sites/{site_id}/members:'),
      text.indexOf('  /v1/sites/{site_id}/members/{user_id}:'),
    )
    // The route is membership-gated; the summary is what says so on the
    // contract, and this is the disclosure the schema change makes.
    expect(block).toContain('Any member may view the team.')
  })
})

describe('OpenAPI documents the sign-in methods', () => {
  it('declares listAuthProviders as an unauthenticated operation', async () => {
    const text = await spec()
    const block = text.slice(text.indexOf('  /v1/auth/providers:'), text.indexOf('  /v1/sites:'))

    expect(block).toContain('operationId: listAuthProviders')
    // `security: []` is the contract's way of saying "no session"; the login
    // screen asks this before one exists.
    expect(block).toContain('security: []')
    expect(block).toContain("$ref: '#/components/schemas/AuthProvider'")
  })

  it('enumerates the three doors and never a password form', async () => {
    const text = await spec()
    const block = text.slice(text.indexOf('    AuthProvider:'), text.indexOf('    SiteMember:'))

    expect(block).toContain('enum: [google, github, magic_link]')
    expect(block).toContain('enum: [oauth, email]')
    expect(block).not.toContain('password')
  })
})

/**
 * A key states who holds its secret, and says when a departure exposed it
 * (ADR-0043 D8; docs snapshot 02 §19).
 *
 * These two fields carry an argument, not just data. D8 accepts that a
 * site-held key **survives** the departure of somebody who was shown its value,
 * because revoking it would take a working installation down over a personnel
 * change. That trade is only defensible if the exposure it accepts is visible to
 * the owner who has to decide whether to rotate — so a `rotation_required_at`
 * that is written and never read would leave the decision unpaid for.
 */
describe('ApiKeySummary says who holds the key', () => {
  const summaryBlock = (text: string) =>
    text.slice(text.indexOf('    ApiKeySummary:'), text.indexOf('    ApiKeyHolder:'))

  it('requires both fields, so neither can be reported by omission', async () => {
    const text = await spec()
    const block = summaryBlock(text)
    const required = block.slice(block.indexOf('required:'), block.indexOf('description:'))
    // Required-and-nullable, the ADR-0027 convention: `null` on
    // rotation_required_at states "nobody who knew this key has left", which is
    // a fact. An absent key would state "this server did not say", and the
    // owner cannot tell that from "you are fine".
    expect(required).toContain('held_by')
    expect(required).toContain('rotation_required_at')
    expect(block).toContain("$ref: '#/components/schemas/ApiKeyHolder'")
  })

  it('lets rotation_required_at be null but never absent', async () => {
    const text = await spec()
    const block = summaryBlock(text)
    const field = block.slice(block.indexOf('rotation_required_at:'), block.indexOf('created_at:'))
    expect(field).toContain("type: 'null'")
    expect(field).toContain('UtcInstant')
  })

  it('offers exactly two holders and no third', async () => {
    const text = await spec()
    const block = text.slice(text.indexOf('    ApiKeyHolder:'), text.indexOf('    ApiKeyScope:'))
    // Every entry between `enum:` and the description, not just the two we hope
    // are there: an alternation over the expected names would match a list that
    // had grown a third value and report it as unchanged.
    const enumBlock = block.slice(block.indexOf('enum:'), block.indexOf('description:'))
    const values = [...enumBlock.matchAll(/^\s+- (\S+)\s*$/gmu)].map((match) => match[1])
    expect(values).toEqual(['user', 'site'])
    // The whole point of the column, stated where an integrator reads it.
    expect(block).toContain('survives')
  })

  it('lets a create request declare the holder, and defaults it to the one that revokes', async () => {
    const text = await spec()
    const block = text.slice(
      text.indexOf('    CreateApiKeyRequest:'),
      text.indexOf('    CreatedApiKey:'),
    )
    expect(block).toContain('held_by:')
    expect(block).toContain('ApiKeyHolder')
    // The default is not merely undocumented-and-safe; the document says which
    // way it leans, because an integrator choosing wrongly here is choosing
    // between an outage and a live credential in a stranger's hands.
    expect(block).toContain('`user`')
  })
})
