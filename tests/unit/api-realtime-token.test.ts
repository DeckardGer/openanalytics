import { generateKeyPairSync } from 'node:crypto'
import { loadServiceEnv } from '@openanalytics/domain'
import { verifyRealtimeToken } from '@openanalytics/auth'
import type { Auth } from '@openanalytics/auth'
import type { Database } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import type { RealtimeCache } from '@openanalytics/redis'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The realtime token endpoints (docs snapshot 02 §17, 05 D-213), driven through
 * the real api app with the real middleware chain and injected fakes.
 *
 * The invariants proven: a token is minted only after authorization AND an epoch
 * seed succeed (503 if the seed fails — no token without a seeded epoch); the
 * token verifies with the codec, lives ≤ 60s, and carries the seeded epoch; the
 * private route is membership + billing gated; the public route is per-surface
 * opt-in, NOT_FOUND for anything closed, and rate-limited.
 */

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const VERIFY_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const SIGNING_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const membership = { value: null as { role: string; isBillingOwner: boolean } | null }
const siteBasics = {
  value: null as { siteId: string; slug: string; name: string; status: string } | null,
}
const share = {
  value: null as {
    siteId: string
    siteStatus: string
    enabled: boolean
    shareOverview: boolean
    shareGeography: boolean
    shareRealtime: boolean
  } | null,
}

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    getMembership: async () => membership.value,
    getSiteBasics: async () => siteBasics.value,
    resolvePublicShare: async () => share.value,
  }
})

const { createApp } = await import('../../apps/api/src/app.ts')
const { InProcessRateLimiter } = await import('../../apps/api/src/http/rate-limit.ts')

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const SLUG = 'sunny-otter-4821'
const USER = 'user-1'

function sessionAuthStub(hasSession: boolean): Auth {
  return {
    api: {
      getSession: async () =>
        hasSession
          ? {
              user: {
                id: USER,
                email: 'a@b.test',
                emailVerified: true,
                createdAt: new Date('2026-01-01T00:00:00.000Z'),
              },
              session: { createdAt: new Date('2026-07-23T00:00:00.000Z') },
            }
          : null,
    },
    handler: async () => new Response(null),
  } as unknown as Auth
}

interface CacheState {
  ensureEpochValue: number
  ensureEpochThrows: boolean
  ensureCalls: { siteId: string; subject: string }[]
}

function fakeCache(state: CacheState): RealtimeCache {
  return {
    ensureEpoch: async (input: { siteId: string; subject: string }) => {
      state.ensureCalls.push(input)
      if (state.ensureEpochThrows) throw new Error('redis down')
      return state.ensureEpochValue
    },
    bumpEpochAndPublishDisconnect: async () => 0,
  } as unknown as RealtimeCache
}

function buildApp(options: {
  hasSession?: boolean
  cache: CacheState
  signingKey?: string | undefined
  perMinute?: number
}) {
  const { logger } = createCapturedLogger()
  const env = loadServiceEnv(
    'api',
    testEnv(
      options.signingKey === undefined ? {} : { REALTIME_TOKEN_SIGNING_KEY: options.signingKey },
    ),
  )
  return createApp({
    service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
    logger,
    env,
    auth: sessionAuthStub(options.hasSession ?? true),
    db: {} as Database,
    realtime: {
      cache: fakeCache(options.cache),
      rateLimiter: new InProcessRateLimiter({
        requestsPerMinute: options.perMinute ?? 100,
        burst: options.perMinute ?? 100,
      }),
    },
  })
}

function newCacheState(overrides: Partial<CacheState> = {}): CacheState {
  return { ensureEpochValue: 7, ensureEpochThrows: false, ensureCalls: [], ...overrides }
}

const privateUrl = `http://api.test/v1/sites/${SITE}/realtime/token`
const publicUrl = `http://api.test/v1/public/${SLUG}/realtime/token`

const verify = (token: string) =>
  verifyRealtimeToken(token, { verifyKey: VERIFY_KEY, now: new Date(), maxTtlSeconds: 60 })

describe('private realtime token mint', () => {
  beforeEach(() => {
    membership.value = null
    siteBasics.value = null
  })

  it('mints a verifiable, epoch-seeded token for an active-site member', async () => {
    membership.value = { role: 'viewer', isBillingOwner: false }
    siteBasics.value = { siteId: SITE, slug: 's', name: 'S', status: 'active' }
    const cache = newCacheState({ ensureEpochValue: 42 })
    const res = await buildApp({ cache, signingKey: SIGNING_KEY }).fetch(
      new Request(privateUrl, { method: 'POST' }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      token: string
      expires_at: string
      epoch_check_seconds: number
    }
    // Both epochs are seeded at issuance and nowhere else: the subject's, and
    // the reserved site-level one (ADR-0030, decision 5). The gateway treats a
    // missing key as fail-closed, so a token must never exist without them.
    expect(cache.ensureCalls).toEqual([
      { siteId: SITE, subject: USER },
      { siteId: SITE, subject: 'site' },
    ])

    const result = verify(body.token)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.claims).toMatchObject({
      aud: 'realtime',
      site_id: SITE,
      subject: USER,
      scope: 'private',
      epoch: 42,
    })
    // Lifetime is at most 60s and epoch_check at most 15s (the D-213 ceilings).
    const ttlMs = Date.parse(body.expires_at) - Date.now()
    expect(ttlMs).toBeGreaterThan(0)
    expect(ttlMs).toBeLessThanOrEqual(60_000)
    expect(body.epoch_check_seconds).toBeLessThanOrEqual(15)
    // expires_at is exactly iat+ttl of the token.
    expect(Math.floor(Date.parse(body.expires_at) / 1000)).toBe(result.claims.exp)
  })

  it('503 and no token when the epoch seed fails', async () => {
    membership.value = { role: 'owner', isBillingOwner: true }
    siteBasics.value = { siteId: SITE, slug: 's', name: 'S', status: 'active' }
    const cache = newCacheState({ ensureEpochThrows: true })
    const res = await buildApp({ cache, signingKey: SIGNING_KEY }).fetch(
      new Request(privateUrl, { method: 'POST' }),
    )
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE')
  })

  it('401 without a session, and never seeds an epoch', async () => {
    const cache = newCacheState()
    const res = await buildApp({ hasSession: false, cache, signingKey: SIGNING_KEY }).fetch(
      new Request(privateUrl, { method: 'POST' }),
    )
    expect(res.status).toBe(401)
    expect(cache.ensureCalls).toHaveLength(0)
  })

  it('404 when the caller is not a member', async () => {
    membership.value = null
    const cache = newCacheState()
    const res = await buildApp({ cache, signingKey: SIGNING_KEY }).fetch(
      new Request(privateUrl, { method: 'POST' }),
    )
    expect(res.status).toBe(404)
    expect(cache.ensureCalls).toHaveLength(0)
  })

  it('403 SITE_SUSPENDED for a suspended site', async () => {
    membership.value = { role: 'owner', isBillingOwner: true }
    siteBasics.value = { siteId: SITE, slug: 's', name: 'S', status: 'suspended' }
    const cache = newCacheState()
    const res = await buildApp({ cache, signingKey: SIGNING_KEY }).fetch(
      new Request(privateUrl, { method: 'POST' }),
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('SITE_SUSPENDED')
    expect(cache.ensureCalls).toHaveLength(0)
  })

  it('is unmounted (404) without a signing key', async () => {
    membership.value = { role: 'owner', isBillingOwner: true }
    siteBasics.value = { siteId: SITE, slug: 's', name: 'S', status: 'active' }
    const cache = newCacheState()
    const res = await buildApp({ cache, signingKey: undefined }).fetch(
      new Request(privateUrl, { method: 'POST' }),
    )
    expect(res.status).toBe(404)
    expect(cache.ensureCalls).toHaveLength(0)
  })
})

describe('public realtime token mint', () => {
  beforeEach(() => {
    share.value = null
  })

  const sharedOn = {
    siteId: SITE,
    siteStatus: 'active',
    enabled: true,
    shareOverview: false,
    shareGeography: false,
    shareRealtime: true,
  }

  it('mints a public-scoped token when realtime is opted in', async () => {
    share.value = sharedOn
    const cache = newCacheState({ ensureEpochValue: 3 })
    const res = await buildApp({ cache, signingKey: SIGNING_KEY }).fetch(
      new Request(publicUrl, { method: 'POST' }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string }
    expect(cache.ensureCalls).toEqual([
      { siteId: SITE, subject: 'public' },
      { siteId: SITE, subject: 'site' },
    ])
    const result = verify(body.token)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.claims).toMatchObject({ scope: 'public', subject: 'public', site_id: SITE })
    // The public token carries the same site anchor, so a block cuts a shared
    // dashboard's stream exactly as it cuts a member's.
    expect(result.claims.site_epoch).toBe(3)
  })

  it('404 when realtime is not opted into the public share', async () => {
    share.value = { ...sharedOn, shareRealtime: false }
    const cache = newCacheState()
    const res = await buildApp({ cache, signingKey: SIGNING_KEY }).fetch(
      new Request(publicUrl, { method: 'POST' }),
    )
    expect(res.status).toBe(404)
    expect(cache.ensureCalls).toHaveLength(0)
  })

  it('404 when the master switch is off', async () => {
    share.value = { ...sharedOn, enabled: false }
    const res = await buildApp({ cache: newCacheState(), signingKey: SIGNING_KEY }).fetch(
      new Request(publicUrl, { method: 'POST' }),
    )
    expect(res.status).toBe(404)
  })

  it('404 for an unknown / rotated slug', async () => {
    share.value = null // a rotated slug no longer resolves
    const res = await buildApp({ cache: newCacheState(), signingKey: SIGNING_KEY }).fetch(
      new Request(publicUrl, { method: 'POST' }),
    )
    expect(res.status).toBe(404)
  })

  it('404 while suspended', async () => {
    share.value = { ...sharedOn, siteStatus: 'suspended' }
    const res = await buildApp({ cache: newCacheState(), signingKey: SIGNING_KEY }).fetch(
      new Request(publicUrl, { method: 'POST' }),
    )
    expect(res.status).toBe(404)
  })

  it('429 past the per-(IP, slug) budget', async () => {
    share.value = sharedOn
    const app = buildApp({ cache: newCacheState(), signingKey: SIGNING_KEY, perMinute: 1 })
    const first = await app.fetch(
      new Request(publicUrl, { method: 'POST', headers: { 'x-forwarded-for': '9.9.9.9' } }),
    )
    expect(first.status).toBe(200)
    const second = await app.fetch(
      new Request(publicUrl, { method: 'POST', headers: { 'x-forwarded-for': '9.9.9.9' } }),
    )
    expect(second.status).toBe(429)
    expect(second.headers.get('Retry-After')).toBeTruthy()
  })
})
