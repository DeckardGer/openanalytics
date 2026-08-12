import type { KeyObject } from 'node:crypto'
import { ApiError } from '@openanalytics/contracts'
import {
  type RealtimeTokenClaims,
  type RealtimeTokenRejectReason,
  verifyRealtimeToken,
} from '@openanalytics/auth'
import { REALTIME_SITE_EPOCH_SUBJECT, type EpochRef } from '@openanalytics/redis'
import type { Context } from 'hono'

/**
 * Connect-time authorization for the SSE stream (docs snapshot 05, D-213).
 *
 * Fail-closed, and bearer-only. Every rejection is a `401 UNAUTHENTICATED` whose
 * `details.reason` names the exact cause — mirroring the query gateway's
 * `SignedRequestError` mapping (apps/query-gateway/src/auth.ts): the HTTP code is
 * shared and adding realtime-private codes to the contract catalog would be a
 * breaking change, so the distinguishing reason lands in `details.reason` and in
 * the structured log instead of in a message string.
 */

export const REALTIME_AUTH_FAILURES = [
  // Before the token is even read.
  'missing_bearer',
  'query_token_rejected',
  // Verifier-intrinsic reasons (passed through from `verifyRealtimeToken`).
  'malformed',
  'bad_signature',
  'wrong_audience',
  'expired',
  'ttl_exceeded',
  'not_yet_valid',
  // The live epoch anchor.
  'auth_unreachable',
  'revoked',
] as const

export type RealtimeAuthFailure = (typeof REALTIME_AUTH_FAILURES)[number]

export class RealtimeAuthError extends ApiError {
  readonly reason: RealtimeAuthFailure

  constructor(reason: RealtimeAuthFailure, message: string) {
    super('UNAUTHENTICATED', message, { details: { reason } })
    this.name = 'RealtimeAuthError'
    this.reason = reason
  }
}

/**
 * Query-string keys that would carry a token. Any of them present is an outright
 * rejection *without reading the value*: a native `EventSource` cannot set an
 * `Authorization` header and would smuggle the token in the URL, where it lands
 * in every access log on the path (D-213). Refusing the shape — not just
 * ignoring the value — is what makes query-token auth structurally absent.
 */
const QUERY_TOKEN_KEYS: ReadonlySet<string> = new Set(['token', 'access_token', 'auth'])

/** Read-only epoch anchor the gateway needs from the cache. */
export interface EpochReader {
  getEpoch(input: EpochRef): Promise<number | null>
}

export interface AuthenticateOptions {
  readonly verifyKey: KeyObject
  /** `REALTIME_TOKEN_TTL_SECONDS`: the verifier's hard lifetime ceiling. */
  readonly maxTtlSeconds: number
  readonly cache: EpochReader
  readonly now: () => Date
}

/** Verifier reasons are already the machine reasons the gateway reports. */
function mapVerifyReason(reason: RealtimeTokenRejectReason): RealtimeAuthFailure {
  return reason
}

/**
 * Authenticates one connection request and returns its claims, or throws a
 * `RealtimeAuthError` that the shared error handler renders as a 401. Runs fully
 * before the stream is opened, so a rejection is a normal JSON error and never a
 * half-open `text/event-stream`.
 */
export async function authenticateConnection(
  c: Context,
  options: AuthenticateOptions,
): Promise<RealtimeTokenClaims> {
  // 1. Refuse a query-string token outright, before anything else looks at it.
  for (const key of Object.keys(c.req.query())) {
    if (QUERY_TOKEN_KEYS.has(key.toLowerCase())) {
      throw new RealtimeAuthError(
        'query_token_rejected',
        'a realtime token must be presented as a Bearer header, never in the query string',
      )
    }
  }

  // 2. Bearer header only.
  const authorization = c.req.header('authorization')
  if (authorization === undefined || !/^Bearer\s+/i.test(authorization)) {
    throw new RealtimeAuthError('missing_bearer', 'a Bearer authorization header is required')
  }
  const token = authorization.replace(/^Bearer\s+/i, '').trim()

  // 3. Verify the token itself — structure, signature, audience, time window.
  const verified = verifyRealtimeToken(token, {
    verifyKey: options.verifyKey,
    now: options.now(),
    maxTtlSeconds: options.maxTtlSeconds,
  })
  if (!verified.ok) {
    throw new RealtimeAuthError(mapVerifyReason(verified.reason), 'realtime token rejected')
  }
  const { claims } = verified

  // 4. Live epoch anchor. A missing key (never seeded, or evicted) or a Redis
  //    error is fail-closed as `auth_unreachable` — never fail-open: a stream
  //    that cannot prove the member is still entitled must not open. A value
  //    that no longer matches the token's snapshot is a revoked member.
  let current: number | null
  try {
    current = await options.cache.getEpoch({ siteId: claims.site_id, subject: claims.subject })
  } catch {
    throw new RealtimeAuthError(
      'auth_unreachable',
      'realtime authorization state could not be read',
    )
  }
  if (current === null) {
    throw new RealtimeAuthError(
      'auth_unreachable',
      'realtime authorization state is not available for this subject',
    )
  }
  if (current !== claims.epoch) {
    throw new RealtimeAuthError(
      'revoked',
      'the access epoch has advanced since this token was minted',
    )
  }

  // 5. The site-level anchor (ADR-0030, decision 5). A block or a deletion start
  //    bumps `rt_epoch:{site}:site`, which is the only way to cut *every* stream
  //    on a site rather than one subject's.
  //
  //    A null site key is read as 0 here, unlike the subject key above, and the
  //    asymmetry is deliberate. The site key is only ever created by a mint or a
  //    bump; "absent" therefore means "never bumped", which is epoch 0 — the
  //    exact value a token from before this shipped carries. Failing closed on
  //    absence would refuse every stream for every site that has not had a
  //    lifecycle event since the deploy. It is not a fail-open hole: the subject
  //    key is checked first and still fails closed, so a wiped cache cannot let
  //    anyone through this branch.
  let currentSite: number | null
  try {
    currentSite = await options.cache.getEpoch({
      siteId: claims.site_id,
      subject: REALTIME_SITE_EPOCH_SUBJECT,
    })
  } catch {
    throw new RealtimeAuthError(
      'auth_unreachable',
      'realtime authorization state could not be read',
    )
  }
  if ((currentSite ?? 0) > claims.site_epoch) {
    throw new RealtimeAuthError(
      'revoked',
      'the site access epoch has advanced since this token was minted',
    )
  }

  return claims
}
