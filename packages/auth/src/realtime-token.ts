import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'

/**
 * Realtime scoped-token codec (docs snapshot 05, D-213; 02 §17).
 *
 * The api mints a short-lived `aud=realtime` bearer token after it has checked
 * membership, entitlement, site scope and access epoch; the realtime gateway
 * verifies it at connect time and cannot mint one — `REALTIME_TOKEN_SIGNING_KEY`
 * is on the realtime service's FORBIDDEN_KEYS list (packages/domain/src/env.ts),
 * so a compromised gateway cannot forge the credential it exists to check. This
 * mirrors the Ed25519-detached-signature choice of `service-signature.ts` for the
 * same reason (verify-without-mint), and lives in a package rather than either
 * app because the api signs and the realtime gateway verifies — a signer that
 * drifts from its verifier is the most likely way the scheme breaks, and apps are
 * forbidden from importing each other (`pnpm run boundaries`).
 *
 * Wire format — a scheme tag and two base64url segments, dot-joined:
 *
 * ```text
 * OA1-RT1.<base64url(claims JSON bytes)>.<base64url(Ed25519 detached sig)>
 * ```
 *
 * The signature is over the exact claims JSON *bytes* that travel on the wire,
 * not over a re-serialisation of the parsed claims, so verification never depends
 * on byte-identical JSON encoding. The scheme tag is the first token, so a future
 * scheme cannot be validated by an older verifier that happens to accept the same
 * field set.
 */

export const REALTIME_TOKEN_SCHEME = 'OA1-RT1'

/** `aud` every realtime token carries; the verifier rejects anything else. */
export const REALTIME_TOKEN_AUDIENCE = 'realtime'

/**
 * Clock skew tolerated on `iat`.
 *
 * A token whose issued-at is in the future by more than this is `not_yet_valid`:
 * the api and the gateway may run on different machines, and a few seconds of
 * drift must not reject a freshly minted token — but a token minted far in the
 * future is a signing-clock bug or a forgery attempt, not skew.
 */
export const REALTIME_TOKEN_IAT_SKEW_SECONDS = 30

/**
 * Token scope (D-213). `public` tokens address the narrow public allowlist and
 * never carry a real user subject; `private` tokens are bound to a member.
 */
export type RealtimeTokenScope = 'private' | 'public'

export interface RealtimeTokenClaims {
  /** Claim-format version. Bumped only by a breaking change to this shape. */
  readonly v: 1
  readonly aud: typeof REALTIME_TOKEN_AUDIENCE
  readonly site_id: string
  /** The resolved user id, or the literal `public` for a public share token. */
  readonly subject: string
  readonly scope: RealtimeTokenScope
  /** Access epoch snapshotted at issue time; the gateway compares it live. */
  readonly epoch: number
  /**
   * The *site-level* access epoch, snapshotted beside `epoch` (ADR-0030,
   * decision 5).
   *
   * The per-subject epoch can only cut one member's streams; nothing before M10
   * could cut all of a site's at once, which is exactly what a billing block and
   * a deletion start have to do. The reserved subject `site` gives the site its
   * own counter, and the gateway checks both at connect and on every tick.
   *
   * Required on every newly minted token, and read as `0` when a token does not
   * carry it — a token minted before this shipped therefore has the lowest
   * possible value, so the first site-level bump cuts it. That is the correct
   * failure direction: an unknown snapshot must lose to any bump, never win.
   */
  readonly site_epoch: number
  /** Issued-at, unix seconds. */
  readonly iat: number
  /** Expiry, unix seconds. */
  readonly exp: number
  /** Unique token id (UUID), for correlation and future revocation lists. */
  readonly jti: string
}

/**
 * Why a token was rejected. Never thrown — a verification failure is a normal
 * result, and a raw exception would leak the fact that the token parsed far
 * enough to reach a comparison.
 */
export type RealtimeTokenRejectReason =
  'malformed' | 'bad_signature' | 'wrong_audience' | 'expired' | 'ttl_exceeded' | 'not_yet_valid'

export type RealtimeTokenVerifyResult =
  | { readonly ok: true; readonly claims: RealtimeTokenClaims }
  | { readonly ok: false; readonly reason: RealtimeTokenRejectReason }

/**
 * Loads and asserts an Ed25519 verify key, like `service-signature.ts`.
 *
 * A non-Ed25519 key is a deployment mistake worth failing on rather than a token
 * that can never verify — this is the one place that may throw, because it is a
 * configuration error, not an attacker-supplied token.
 */
export function loadRealtimeVerifyKey(publicKeyPem: string): KeyObject {
  const key = createPublicKey(publicKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `realtime token verify key must be ed25519, got "${key.asymmetricKeyType ?? 'unknown'}"`,
    )
  }
  return key
}

function loadSigningKey(privateKeyPem: string): KeyObject {
  const key = createPrivateKey(privateKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `realtime token signing key must be ed25519, got "${key.asymmetricKeyType ?? 'unknown'}"`,
    )
  }
  return key
}

export interface SignRealtimeTokenInput {
  readonly privateKeyPem: string
  readonly siteId: string
  /** User id, or the literal `public` for a public share token. */
  readonly subject: string
  readonly scope: RealtimeTokenScope
  readonly epoch: number
  /** The site-level epoch at issue time (ADR-0030, decision 5). */
  readonly siteEpoch: number
  readonly issuedAt: Date
  /** Lifetime in seconds; the verifier enforces its own hard ceiling too. */
  readonly ttlSeconds: number
  /** Unique token id (UUID). */
  readonly jti: string
}

/**
 * Mints a realtime token. The api side of the scheme.
 *
 * The claims are serialised once, and both the transmitted payload and the
 * signed bytes are that single serialisation — so a verifier that decodes the
 * payload recovers exactly the bytes that were signed.
 */
export function signRealtimeToken(input: SignRealtimeTokenInput): string {
  const iat = Math.floor(input.issuedAt.getTime() / 1000)
  const claims: RealtimeTokenClaims = {
    v: 1,
    aud: REALTIME_TOKEN_AUDIENCE,
    site_id: input.siteId,
    subject: input.subject,
    scope: input.scope,
    epoch: input.epoch,
    site_epoch: input.siteEpoch,
    iat,
    exp: iat + input.ttlSeconds,
    jti: input.jti,
  }

  const claimsBytes = Buffer.from(JSON.stringify(claims), 'utf8')
  const signature = sign(null, claimsBytes, loadSigningKey(input.privateKeyPem))

  return [
    REALTIME_TOKEN_SCHEME,
    claimsBytes.toString('base64url'),
    signature.toString('base64url'),
  ].join('.')
}

export interface VerifyRealtimeTokenOptions {
  /** Ed25519 verify key, PEM or a pre-loaded `KeyObject`. */
  readonly verifyKey: string | KeyObject
  readonly now: Date
  /**
   * Hard ceiling on `exp - iat`, from `REALTIME_TOKEN_TTL_SECONDS`. A correctly
   * signed token with a fatter lifetime is still invalid: the ceiling is what
   * keeps a revoked member's connection from outliving the epoch bump that
   * revoked them (D-213), so it cannot be a property the issuer alone decides.
   */
  readonly maxTtlSeconds: number
}

/**
 * Structural check over everything a token *must* carry.
 *
 * `site_epoch` is deliberately not required here (ADR-0030, decision 5). Tokens
 * minted before it existed are still in flight for up to their 60-second
 * lifetime across a deploy, and rejecting them as `malformed` would log a
 * signature failure for a correctly signed credential. `normalizeClaims` reads
 * an absent claim as 0, which is the strictest possible interpretation: any
 * site-level bump is ahead of it and cuts the stream.
 */
type StructuralClaims = Omit<RealtimeTokenClaims, 'site_epoch'> & { site_epoch?: unknown }

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function looksLikeClaims(value: unknown): value is StructuralClaims {
  if (value === null || typeof value !== 'object') return false
  const c = value as Record<string, unknown>
  if ('site_epoch' in c && !isNonNegativeInt(c['site_epoch'])) return false
  return (
    c['v'] === 1 &&
    typeof c['aud'] === 'string' &&
    typeof c['site_id'] === 'string' &&
    typeof c['subject'] === 'string' &&
    (c['scope'] === 'private' || c['scope'] === 'public') &&
    typeof c['epoch'] === 'number' &&
    Number.isInteger(c['epoch']) &&
    (c['epoch'] as number) >= 0 &&
    typeof c['iat'] === 'number' &&
    Number.isInteger(c['iat']) &&
    typeof c['exp'] === 'number' &&
    Number.isInteger(c['exp']) &&
    typeof c['jti'] === 'string' &&
    c['jti'].length > 0
  )
}

/** Fills in the one claim old tokens can be missing. */
function normalizeClaims(claims: StructuralClaims): RealtimeTokenClaims {
  return {
    ...claims,
    site_epoch: isNonNegativeInt(claims.site_epoch) ? claims.site_epoch : 0,
  }
}

/**
 * Verifies a token and returns its claims or a typed reason.
 *
 * Scope/site matching is deliberately *not* done here: this returns the claims
 * and lets the gateway compare them against the connection it is authorising, so
 * the one place that knows which site and scope a stream is for owns that check
 * (D-213). What this owns is everything intrinsic to the token — structure,
 * signature, audience, and the time/lifetime window.
 */
export function verifyRealtimeToken(
  token: string,
  options: VerifyRealtimeTokenOptions,
): RealtimeTokenVerifyResult {
  const verifyKey =
    typeof options.verifyKey === 'string'
      ? loadRealtimeVerifyKey(options.verifyKey)
      : options.verifyKey

  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'malformed' }
  }

  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== REALTIME_TOKEN_SCHEME) {
    return { ok: false, reason: 'malformed' }
  }

  const [, payloadSegment, signatureSegment] = parts as [string, string, string]

  let claimsBytes: Buffer
  let signature: Buffer
  try {
    claimsBytes = Buffer.from(payloadSegment, 'base64url')
    signature = Buffer.from(signatureSegment, 'base64url')
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (claimsBytes.length === 0) return { ok: false, reason: 'malformed' }
  // Ed25519 signatures are exactly 64 bytes; anything else is malformed input
  // `crypto.verify` would reject anyway, but this keeps the failure attributable.
  if (signature.length !== 64) return { ok: false, reason: 'bad_signature' }

  // Verify over the transmitted bytes before trusting anything they contain.
  let signatureOk: boolean
  try {
    signatureOk = verify(null, claimsBytes, verifyKey, signature)
  } catch {
    return { ok: false, reason: 'bad_signature' }
  }
  if (!signatureOk) return { ok: false, reason: 'bad_signature' }

  let claims: unknown
  try {
    claims = JSON.parse(claimsBytes.toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (!looksLikeClaims(claims)) return { ok: false, reason: 'malformed' }

  if (claims.aud !== REALTIME_TOKEN_AUDIENCE) {
    return { ok: false, reason: 'wrong_audience' }
  }

  const nowSeconds = Math.floor(options.now.getTime() / 1000)

  if (claims.iat > nowSeconds + REALTIME_TOKEN_IAT_SKEW_SECONDS) {
    return { ok: false, reason: 'not_yet_valid' }
  }
  if (claims.exp <= nowSeconds) {
    return { ok: false, reason: 'expired' }
  }
  if (claims.exp - claims.iat > options.maxTtlSeconds) {
    return { ok: false, reason: 'ttl_exceeded' }
  }

  return { ok: true, claims: normalizeClaims(claims) }
}
