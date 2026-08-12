import { generateKeyPairSync } from 'node:crypto'
import { loadServiceEnv } from '@openanalytics/domain'
import type { Auth } from '@openanalytics/auth'
import type { Database } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import type { RealtimeCache } from '@openanalytics/redis'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The api's immediate best-effort realtime revocation (the "immediate" bump of
 * D-213). After a membership change commits, the api bumps the removed subject's
 * access epoch so an open stream is closed at once; the durable outbox row the
 * same transaction wrote is the recovery path if this bump is lost. These tests
 * prove the bump fires with the right subject on each mutation, and that a bump
 * failure never fails the request.
 *
 * The billing-ownership cutover was a third case here until the open-core split;
 * it is `tests/unit/cloud/api-realtime-revocation.test.ts` now, because the route
 * that performs it is.
 */

const { privateKey } = generateKeyPairSync('ed25519')
const SIGNING_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const membership = { value: null as { role: string; isBillingOwner: boolean } | null }
const removeMemberMock = vi.fn(async () => {})
const updateSettingsMock = vi.fn()

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    getMembership: async () => membership.value,
    removeMember: (...args: unknown[]) => removeMemberMock(...(args as [])),
    updatePublicDashboardSettings: (...args: unknown[]) => updateSettingsMock(...(args as [])),
  }
})

const { createApp } = await import('../../apps/api/src/app.ts')
const { InProcessRateLimiter } = await import('../../apps/api/src/http/rate-limit.ts')

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const ACTOR = 'actor-1'
const REMOVED = 'removed-9'

function sessionAuthStub(): Auth {
  return {
    api: {
      getSession: async () => ({
        user: {
          id: ACTOR,
          email: 'a@b.test',
          emailVerified: true,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        // Fresh session, so a reauth-gated verb is allowed.
        session: { createdAt: new Date() },
      }),
    },
    handler: async () => new Response(null),
  } as unknown as Auth
}

interface BumpRecorder {
  calls: { siteId: string; subject: string }[]
  throws: boolean
}

function fakeCache(rec: BumpRecorder): RealtimeCache {
  return {
    ensureEpoch: async () => 0,
    bumpEpochAndPublishDisconnect: async (input: { siteId: string; subject: string }) => {
      rec.calls.push(input)
      if (rec.throws) throw new Error('redis down')
      return 1
    },
  } as unknown as RealtimeCache
}

function buildApp(rec: BumpRecorder) {
  const { logger } = createCapturedLogger()
  return createApp({
    service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
    logger,
    env: loadServiceEnv('api', testEnv({ REALTIME_TOKEN_SIGNING_KEY: SIGNING_KEY })),
    auth: sessionAuthStub(),
    db: {} as Database,
    realtime: {
      cache: fakeCache(rec),
      rateLimiter: new InProcessRateLimiter({ requestsPerMinute: 100, burst: 100 }),
    },
  })
}

function newRecorder(throws = false): BumpRecorder {
  return { calls: [], throws }
}

beforeEach(() => {
  membership.value = null
  removeMemberMock.mockReset()
  removeMemberMock.mockResolvedValue(undefined)
  updateSettingsMock.mockReset()
})

describe('member removal revokes the removed member', () => {
  it('bumps the removed member subject after removeMember succeeds', async () => {
    membership.value = { role: 'owner', isBillingOwner: false }
    const rec = newRecorder()
    const res = await buildApp(rec).fetch(
      new Request(`http://api.test/v1/sites/${SITE}/members/${REMOVED}`, { method: 'DELETE' }),
    )
    expect(res.status).toBe(204)
    expect(rec.calls).toEqual([{ siteId: SITE, subject: REMOVED }])
  })

  it('still returns 204 when the bump fails (durable outbox is the backup)', async () => {
    membership.value = { role: 'admin', isBillingOwner: false }
    const rec = newRecorder(true)
    const res = await buildApp(rec).fetch(
      new Request(`http://api.test/v1/sites/${SITE}/members/${REMOVED}`, { method: 'DELETE' }),
    )
    expect(res.status).toBe(204)
    expect(rec.calls).toHaveLength(1)
  })
})

describe('public-dashboard settings change revokes public subject when closed', () => {
  async function put(rec: BumpRecorder, body: Record<string, unknown>) {
    membership.value = { role: 'owner', isBillingOwner: false }
    return buildApp(rec).fetch(
      new Request(`http://api.test/v1/sites/${SITE}/public-dashboard`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  }

  it('bumps public when the share is disabled', async () => {
    updateSettingsMock.mockResolvedValue({
      enabled: false,
      shareSlug: 'sunny-otter-4821',
      shareOverview: false,
      shareGeography: false,
      shareRealtime: false,
    })
    const rec = newRecorder()
    const res = await put(rec, { enabled: false })
    expect(res.status).toBe(200)
    expect(rec.calls).toEqual([{ siteId: SITE, subject: 'public' }])
  })

  it('bumps public when realtime is turned off while sharing stays on', async () => {
    updateSettingsMock.mockResolvedValue({
      enabled: true,
      shareSlug: 'sunny-otter-4821',
      shareOverview: true,
      shareGeography: false,
      shareRealtime: false,
    })
    const rec = newRecorder()
    const res = await put(rec, { enabled: true, share_overview: true, share_realtime: false })
    expect(res.status).toBe(200)
    expect(rec.calls).toEqual([{ siteId: SITE, subject: 'public' }])
  })

  it('bumps public when the slug is rotated', async () => {
    updateSettingsMock.mockResolvedValue({
      enabled: true,
      shareSlug: 'fresh-slug-0001',
      shareOverview: false,
      shareGeography: false,
      shareRealtime: true,
    })
    const rec = newRecorder()
    const res = await put(rec, { enabled: true, share_realtime: true, rotate_slug: true })
    expect(res.status).toBe(200)
    expect(rec.calls).toEqual([{ siteId: SITE, subject: 'public' }])
  })

  it('does NOT bump when realtime stays enabled and the slug is unchanged', async () => {
    updateSettingsMock.mockResolvedValue({
      enabled: true,
      shareSlug: 'sunny-otter-4821',
      shareOverview: false,
      shareGeography: false,
      shareRealtime: true,
    })
    const rec = newRecorder()
    const res = await put(rec, { enabled: true, share_realtime: true })
    expect(res.status).toBe(200)
    expect(rec.calls).toHaveLength(0)
  })
})
