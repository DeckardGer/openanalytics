import { randomUUID } from 'node:crypto'
import { signRealtimeToken } from '@openanalytics/auth'
import { ApiError } from '@openanalytics/contracts'
import { isSurfaceShared, resolvePublicShare, type Database } from '@openanalytics/postgres'
import { REALTIME_SITE_EPOCH_SUBJECT, type RealtimeCache } from '@openanalytics/redis'
import { Hono } from 'hono'
import { requireAnalyticsAccess, siteMembership, type ApiVariables } from './middleware.ts'
import type { RateLimiter } from './rate-limit.ts'

/**
 * The realtime scoped-token endpoints (docs snapshot 02 §17, 05 D-213).
 *
 * The api is the only minter of `aud=realtime` tokens and mints one only *after*
 * authorization has passed and an access epoch has been seeded. Seeding is
 * `ensureEpoch` (SET NX 0 + read): it happens here, at issuance, and nowhere
 * else — the gateway treats a missing epoch as fail-closed, so a token must
 * never exist without its epoch. If the cache is unreachable the endpoint answers
 * 503 and no token is minted, rather than issuing a credential the gateway cannot
 * anchor to a live epoch.
 *
 * The token string is never logged; only its `jti` and the site id are.
 */

/** Shared token-minting configuration for both endpoints. */
export interface RealtimeTokenConfig {
  /** Ed25519 signing key PEM (`REALTIME_TOKEN_SIGNING_KEY`). */
  readonly signingKey: string
  /** Token lifetime, from `REALTIME_TOKEN_TTL_SECONDS` (≤ 60). */
  readonly ttlSeconds: number
  /** Epoch re-check cadence the client is told, from `REALTIME_EPOCH_CHECK_SECONDS`. */
  readonly epochCheckSeconds: number
  /** The realtime cache; only `ensureEpoch` is used here (seed-at-issuance). */
  readonly cache: Pick<RealtimeCache, 'ensureEpoch'>
}

type Env = { Variables: ApiVariables }

/** Best-effort client IP for the anonymous rate-limit key (mirrors the public
 * dashboard route). */
function clientIp(headerValue: string | undefined): string {
  if (!headerValue) return 'unknown'
  return headerValue.split(',')[0]?.trim() || 'unknown'
}

interface MintInput {
  readonly siteId: string
  readonly subject: string
  readonly scope: 'private' | 'public'
  readonly epoch: number
  /** The site-level epoch, seeded in the same breath as the subject's
   * (ADR-0030, decision 5). Both are snapshotted onto the token. */
  readonly siteEpoch: number
  readonly now: Date
}

interface RealtimeTokenResponseBody {
  readonly token: string
  readonly expires_at: string
  readonly epoch_check_seconds: number
}

/**
 * Mints a token and shapes the `RealtimeTokenResponse`. `expires_at` is exactly
 * `iat + ttl` in ISO form, where `iat` is the whole-second issue time the codec
 * itself uses, so the response's expiry and the token's `exp` claim agree.
 */
function mint(
  config: RealtimeTokenConfig,
  input: MintInput,
): { body: RealtimeTokenResponseBody; jti: string } {
  const iatSeconds = Math.floor(input.now.getTime() / 1000)
  const jti = randomUUID()
  const token = signRealtimeToken({
    privateKeyPem: config.signingKey,
    siteId: input.siteId,
    subject: input.subject,
    scope: input.scope,
    epoch: input.epoch,
    siteEpoch: input.siteEpoch,
    issuedAt: input.now,
    ttlSeconds: config.ttlSeconds,
    jti,
  })
  return {
    body: {
      token,
      expires_at: new Date((iatSeconds + config.ttlSeconds) * 1000).toISOString(),
      epoch_check_seconds: config.epochCheckSeconds,
    },
    jti,
  }
}

export interface RealtimeRoutesDeps extends RealtimeTokenConfig {
  readonly db: Database
}

/**
 * The authenticated private-token route, mounted on the session subtree.
 *
 * Membership + analytics-access gates: a viewer may stream (§19), and a
 * `suspended` site is closed with the same typed 402 the analytics reads
 * use — enforced by `requireAnalyticsAccess`, not re-implemented here.
 */
export function createRealtimeRoutes(deps: RealtimeRoutesDeps): Hono<Env> {
  const app = new Hono<Env>()

  app.post(
    '/sites/:site_id/realtime/token',
    siteMembership(deps.db),
    requireAnalyticsAccess(deps.db),
    async (c) => {
      const user = c.get('user')
      const { siteId } = c.get('membership')
      const now = new Date()

      // Both epochs are seeded here and nowhere else: the gateway treats a
      // missing key as fail-closed, so a token must never exist without the two
      // counters it is anchored to.
      let epoch: number
      let siteEpoch: number
      try {
        epoch = await deps.cache.ensureEpoch({ siteId, subject: user.id })
        siteEpoch = await deps.cache.ensureEpoch({
          siteId,
          subject: REALTIME_SITE_EPOCH_SUBJECT,
        })
      } catch (err) {
        c.get('logger')?.warn('realtime_epoch_seed_failed', {
          err,
          site_id: siteId,
          scope: 'private',
          retryable: true,
        })
        throw new ApiError('SERVICE_UNAVAILABLE', 'Realtime is temporarily unavailable')
      }

      const { body, jti } = mint(deps, {
        siteId,
        subject: user.id,
        scope: 'private',
        epoch,
        siteEpoch,
        now,
      })
      c.get('logger')?.info('realtime_token_issued', { site_id: siteId, scope: 'private', jti })
      return c.json(body)
    },
  )

  return app
}

export interface PublicRealtimeRoutesDeps extends RealtimeTokenConfig {
  readonly db: Database
  readonly rateLimiter: RateLimiter
}

/**
 * The unauthenticated public-token route, mounted before the business session
 * catch-all (like the public dashboard reads). Realtime is a separate opt-in
 * surface with `scope=public`, subject `public`; a share that has not opted
 * realtime in (or a disabled/blocked/rotated share) is `NOT_FOUND`, never a
 * signal of which check failed. Rate-limited per (IP, slug) on the same config
 * as the historical public reads.
 */
export function createPublicRealtimeRoutes(deps: PublicRealtimeRoutesDeps): Hono<Env> {
  const app = new Hono<Env>()

  // Rate limit before any database or cache work, exactly as the public reads do.
  app.use('/public/:share_slug/*', async (c, next) => {
    const slug = c.req.param('share_slug')
    const ip = clientIp(c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'))
    const decision = deps.rateLimiter.check(`${ip}:${slug}`)
    if (!decision.allowed) {
      c.header('Retry-After', String(decision.retryAfterSeconds))
      throw new ApiError('RATE_LIMITED', 'Too many requests', {
        details: { retry_after_seconds: decision.retryAfterSeconds },
      })
    }
    await next()
  })

  app.post('/public/:share_slug/realtime/token', async (c) => {
    const slug = c.req.param('share_slug')
    const share = await resolvePublicShare(deps.db, slug)
    if (!share || !isSurfaceShared(share, 'realtime')) {
      throw new ApiError('NOT_FOUND', 'No such public dashboard')
    }

    const now = new Date()
    let epoch: number
    let siteEpoch: number
    try {
      epoch = await deps.cache.ensureEpoch({ siteId: share.siteId, subject: 'public' })
      siteEpoch = await deps.cache.ensureEpoch({
        siteId: share.siteId,
        subject: REALTIME_SITE_EPOCH_SUBJECT,
      })
    } catch (err) {
      c.get('logger')?.warn('realtime_epoch_seed_failed', {
        err,
        site_id: share.siteId,
        scope: 'public',
        retryable: true,
      })
      throw new ApiError('SERVICE_UNAVAILABLE', 'Realtime is temporarily unavailable')
    }

    const { body, jti } = mint(deps, {
      siteId: share.siteId,
      subject: 'public',
      scope: 'public',
      epoch,
      siteEpoch,
      now,
    })
    c.get('logger')?.info('realtime_token_issued', {
      site_id: share.siteId,
      scope: 'public',
      jti,
    })
    return c.json(body)
  })

  return app
}
