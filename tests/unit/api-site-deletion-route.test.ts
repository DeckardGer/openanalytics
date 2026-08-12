import { loadServiceEnv } from '@openanalytics/domain'
import type { Auth, SiteRole } from '@openanalytics/auth'
import type { Database } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `DELETE /v1/sites/{site_id}` — the guards, and nothing else (ADR-0030, D4).
 *
 * The transaction has a Postgres suite; what lives only at this route is the
 * chain in front of it, and every link answers a different question:
 *
 * - membership: is the caller party to this site at all (404, never 403 — the
 *   API does not reveal that a site it cannot see exists);
 * - `site:delete`: owner-only, the capability that has existed unreferenced
 *   since M2;
 * - `isRecentReauth`: was the *session* recently proven, not merely valid. A
 *   live cookie on a stolen laptop must not be able to erase a customer's data;
 * - the name confirmation: checked against the name this request read, so a
 *   rename between the screen loading and the button being pressed refuses.
 *
 * Each is asserted to run *before* the repository, because a guard that only
 * runs after the write has already lost.
 */

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const OWNER = 'u-owner'
const ADMIN = 'u-admin'
const VIEWER = 'u-viewer'
const STRANGER = 'u-stranger'

const SITE_NAME = 'Acme Analytics'

const memberships = new Map<string, { role: SiteRole; isBillingOwner: boolean }>([
  [OWNER, { role: 'owner', isBillingOwner: true }],
  [ADMIN, { role: 'admin', isBillingOwner: false }],
  [VIEWER, { role: 'viewer', isBillingOwner: false }],
])

const calls = { startSiteDeletion: [] as { siteId: string; requestedByUserId: string }[] }

/** Drives the route's two data reads: the site it confirms against and the
 * repository's answer. */
const world = {
  siteStatus: 'active' as 'active' | 'suspended' | 'deleting' | 'deleted',
  requestId: '9a1d0b3c-0000-4000-8000-00000000abcd',
  started: true,
}

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    getMembership: async (_db: unknown, params: { siteId: string; userId: string }) =>
      memberships.get(params.userId) ?? null,
    getSiteForUser: async (_db: unknown, params: { siteId: string }) => {
      // A `deleted` site is invisible here — the tombstone is not a site
      // (ADR-0027), which is what makes the 404 structural rather than a
      // special case in the handler.
      if (world.siteStatus === 'deleted') return null
      return {
        siteId: params.siteId,
        slug: 'acme',
        name: SITE_NAME,
        status: world.siteStatus,
        role: 'owner' as const,
        isBillingOwner: true,
        domains: [],
        createdAt: new Date('2026-02-03T04:05:06.000Z'),
        firstEventAt: null,
        suspendedAt: null,
        ingestGraceUntil: null,
        retentionDeadline: null,
      }
    },
    startSiteDeletion: async (
      _db: unknown,
      input: { siteId: string; requestedByUserId: string },
    ) => {
      calls.startSiteDeletion.push(input)
      return { deletionRequestId: world.requestId, jobId: 'job-1', started: world.started }
    },
  }
})

const { createApp } = await import('../../apps/api/src/app.ts')

/**
 * The caller is chosen with a test header; the session's age with a second one,
 * so one app instance can exercise both the fresh and the stale-session paths.
 */
const auth = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const id = headers.get('x-test-user')
      if (id === null) return null
      const staleSeconds = Number(headers.get('x-test-session-age') ?? '0')
      return {
        user: {
          id,
          email: `${id}@example.test`,
          emailVerified: true,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        session: { createdAt: new Date(Date.now() - staleSeconds * 1000) },
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

const del = (user: string | null, body: unknown, sessionAgeSeconds = 0) =>
  app.fetch(
    new Request(`http://api.test/v1/sites/${SITE}`, {
      method: 'DELETE',
      headers: {
        ...(user === null ? {} : { 'x-test-user': user }),
        'x-test-session-age': String(sessionAgeSeconds),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  )

const errorCode = async (res: Response): Promise<string> =>
  ((await res.json()) as { error: { code: string } }).error.code

beforeEach(() => {
  calls.startSiteDeletion = []
  world.siteStatus = 'active'
  world.started = true
})

describe('DELETE /v1/sites/{site_id}', () => {
  it('refuses an unauthenticated caller', async () => {
    const res = await del(null, { confirm: SITE_NAME })
    expect(res.status).toBe(401)
    expect(calls.startSiteDeletion).toEqual([])
  })

  it('404s a caller who is not a member, without revealing the site exists', async () => {
    const res = await del(STRANGER, { confirm: SITE_NAME })
    expect(res.status).toBe(404)
    expect(await errorCode(res)).toBe('SITE_NOT_FOUND')
    expect(calls.startSiteDeletion).toEqual([])
  })

  it('refuses an admin: site:delete is owner-only', async () => {
    const res = await del(ADMIN, { confirm: SITE_NAME })
    expect(res.status).toBe(403)
    expect(await errorCode(res)).toBe('FORBIDDEN')
    expect(calls.startSiteDeletion).toEqual([])
  })

  it('refuses a viewer', async () => {
    expect((await del(VIEWER, { confirm: SITE_NAME })).status).toBe(403)
    expect(calls.startSiteDeletion).toEqual([])
  })

  it('refuses a session that is not recent enough, before any write', async () => {
    // Well past SENSITIVE_ACTION_MAX_SESSION_AGE_SECONDS (300).
    const res = await del(OWNER, { confirm: SITE_NAME }, 3_600)
    expect(res.status).toBe(403)
    expect(await errorCode(res)).toBe('REAUTH_REQUIRED')
    expect(calls.startSiteDeletion).toEqual([])
  })

  it('refuses a confirmation that is not the site name, and says what it must be', async () => {
    const res = await del(OWNER, { confirm: 'acme' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as {
      error: { code: string; message: string; details: { issues: unknown[] } }
    }
    expect(body.error.code).toBe('VALIDATION_FAILED')
    // The message names the exact string to type: a confirmation the user
    // cannot satisfy is a dead end, not a safety measure.
    expect(body.error.message).toContain(SITE_NAME)
    expect(body.error.details.issues).toEqual([{ field: 'confirm', code: 'name_mismatch' }])
    expect(calls.startSiteDeletion).toEqual([])
  })

  it('refuses a missing confirmation', async () => {
    expect((await del(OWNER, {})).status).toBe(400)
    expect(calls.startSiteDeletion).toEqual([])
  })

  it('accepts an owner with a fresh session and the exact name, answering 202', async () => {
    const res = await del(OWNER, { confirm: SITE_NAME })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({
      deletion_request_id: world.requestId,
      status: 'deleting',
    })
    expect(calls.startSiteDeletion).toEqual([{ siteId: SITE, requestedByUserId: OWNER }])
  })

  it('answers 202 with the same request id when the site is already deleting', async () => {
    // The repository found the live request rather than minting a second one;
    // the route reports it identically, so a double-click, a retry and a
    // sweeper racing an operator all converge on one deletion.
    world.siteStatus = 'deleting'
    world.started = false

    const res = await del(OWNER, { confirm: SITE_NAME })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({
      deletion_request_id: world.requestId,
      status: 'deleting',
    })
  })

  it('404s a site that is already deleted', async () => {
    world.siteStatus = 'deleted'
    const res = await del(OWNER, { confirm: SITE_NAME })
    expect(res.status).toBe(404)
    expect(await errorCode(res)).toBe('SITE_NOT_FOUND')
    expect(calls.startSiteDeletion).toEqual([])
  })
})
