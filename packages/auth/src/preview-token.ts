import { createPublicKey, createPrivateKey, sign, verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'

/**
 * Rule-preview scoped-token codec (ADR-0034, D6).
 *
 * A preview lets a site owner try an *unpublished* rule version against their
 * own real site. The api mints this token after it has checked membership and
 * the `site:settings` capability; the collector verifies it on
 * `GET /v1/tracker/config` and answers with the draft rule set instead of the
 * published one. The signing key is on the collector's FORBIDDEN_KEYS list
 * (`packages/domain/src/env.ts`), so a compromised collector cannot mint the
 * credential it exists to check — the same verify-without-mint split as
 * `realtime-token.ts` and `service-signature.ts`.
 *
 * **This token gates one thing: being served draft rules.** It is deliberately
 * *not* checked on the event path. Preview events are marked `test_mode`, and
 * under ADR-0034 D6 a `test_mode` claim buys nothing worth forging — the events
 * are non-billable *and* excluded from every production read, so a forged claim
 * costs its author their own data and gains them nothing. Putting a signature
 * verification on the hot ingest path to defend a claim with no value would be
 * the expensive half of a trade with no upside.
 *
 * A separate key pair rather than a second audience on the realtime pair: one
 * pair for two purposes means rotating either rotates both, and M12's rotation
 * incident is recent enough to be worth designing away from.
 *
 * Wire format, matching the realtime scheme so the two read alike:
 *
 * ```text
 * OA1-PV1.<base64url(claims JSON bytes)>.<base64url(Ed25519 detached sig)>
 * ```
 */

export const PREVIEW_TOKEN_SCHEME = 'OA1-PV1'

/** `aud` every preview token carries; the verifier rejects anything else. */
export const PREVIEW_TOKEN_AUDIENCE = 'tracker-preview'

/**
 * Preview lifetime, in seconds (ADR-0034, D6).
 *
 * Fifteen minutes is the length of the task: open your site, click the thing,
 * see whether the rule fired. Long enough that a person is not re-issuing mid
 * flow, short enough that a token pasted into a chat is dead before it is read.
 * The verifier enforces it as a ceiling on `exp - iat`, so a fatter lifetime
 * from a future issuer is still invalid.
 */
export const PREVIEW_TOKEN_TTL_SECONDS = 900

/** Clock skew tolerated on `iat`; the api and collector are different hosts. */
export const PREVIEW_TOKEN_IAT_SKEW_SECONDS = 30

export interface PreviewTokenClaims {
  /** Claim-format version. Bumped only by a breaking change to this shape. */
  readonly v: 1
  readonly aud: typeof PREVIEW_TOKEN_AUDIENCE
  readonly site_id: string
  /** The definition whose draft is being previewed. */
  readonly definition_id: string
  /** The exact version number to serve. Not "the latest draft": a preview is of
   * one version, and resolving it at request time would silently change what the
   * user is looking at when someone else saves. */
  readonly version: number
  /** Who asked for the preview. Correlation only; the collector does not use it. */
  readonly subject: string
  readonly iat: number
  readonly exp: number
  readonly jti: string
}

export type PreviewTokenRejectReason =
  'malformed' | 'bad_signature' | 'wrong_audience' | 'expired' | 'ttl_exceeded' | 'not_yet_valid'

export type PreviewTokenVerifyResult =
  | { readonly ok: true; readonly claims: PreviewTokenClaims }
  | { readonly ok: false; readonly reason: PreviewTokenRejectReason }

/** Loads and asserts an Ed25519 verify key. May throw: a wrong key type is a
 * deployment mistake, not attacker-supplied input. */
export function loadPreviewVerifyKey(publicKeyPem: string): KeyObject {
  const key = createPublicKey(publicKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `preview token verify key must be ed25519, got "${key.asymmetricKeyType ?? 'unknown'}"`,
    )
  }
  return key
}

function loadSigningKey(privateKeyPem: string): KeyObject {
  const key = createPrivateKey(privateKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `preview token signing key must be ed25519, got "${key.asymmetricKeyType ?? 'unknown'}"`,
    )
  }
  return key
}

export interface SignPreviewTokenInput {
  readonly privateKeyPem: string
  readonly siteId: string
  readonly definitionId: string
  readonly version: number
  readonly subject: string
  readonly issuedAt: Date
  readonly ttlSeconds?: number
  readonly jti: string
}

/**
 * Mints a preview token. The claims are serialised once and both the
 * transmitted payload and the signed bytes are that single serialisation, so a
 * verifier never depends on byte-identical JSON re-encoding.
 */
export function signPreviewToken(input: SignPreviewTokenInput): string {
  const iat = Math.floor(input.issuedAt.getTime() / 1000)
  const claims: PreviewTokenClaims = {
    v: 1,
    aud: PREVIEW_TOKEN_AUDIENCE,
    site_id: input.siteId,
    definition_id: input.definitionId,
    version: input.version,
    subject: input.subject,
    iat,
    exp: iat + (input.ttlSeconds ?? PREVIEW_TOKEN_TTL_SECONDS),
    jti: input.jti,
  }

  const claimsBytes = Buffer.from(JSON.stringify(claims), 'utf8')
  const signature = sign(null, claimsBytes, loadSigningKey(input.privateKeyPem))

  return [
    PREVIEW_TOKEN_SCHEME,
    claimsBytes.toString('base64url'),
    signature.toString('base64url'),
  ].join('.')
}

export interface VerifyPreviewTokenOptions {
  readonly verifyKey: string | KeyObject
  readonly now: Date
  readonly maxTtlSeconds?: number
}

function looksLikeClaims(value: unknown): value is PreviewTokenClaims {
  if (value === null || typeof value !== 'object') return false
  const c = value as Record<string, unknown>
  return (
    c['v'] === 1 &&
    typeof c['aud'] === 'string' &&
    typeof c['site_id'] === 'string' &&
    c['site_id'].length > 0 &&
    typeof c['definition_id'] === 'string' &&
    c['definition_id'].length > 0 &&
    typeof c['version'] === 'number' &&
    Number.isInteger(c['version']) &&
    (c['version'] as number) >= 1 &&
    typeof c['subject'] === 'string' &&
    typeof c['iat'] === 'number' &&
    Number.isInteger(c['iat']) &&
    typeof c['exp'] === 'number' &&
    Number.isInteger(c['exp']) &&
    typeof c['jti'] === 'string' &&
    c['jti'].length > 0
  )
}

/**
 * Verifies a token and returns its claims or a typed reason. Never throws for
 * attacker-supplied input — a verification failure is a normal result, and an
 * exception would leak how far the token parsed before it failed.
 *
 * Site matching is not done here: this returns the claims and lets the config
 * endpoint compare `site_id` against the site the tracking key resolved to, so
 * the one place that knows which site is being asked about owns that check.
 */
export function verifyPreviewToken(
  token: string,
  options: VerifyPreviewTokenOptions,
): PreviewTokenVerifyResult {
  const verifyKey =
    typeof options.verifyKey === 'string'
      ? loadPreviewVerifyKey(options.verifyKey)
      : options.verifyKey

  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'malformed' }
  }

  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== PREVIEW_TOKEN_SCHEME) {
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
  if (claims.aud !== PREVIEW_TOKEN_AUDIENCE) return { ok: false, reason: 'wrong_audience' }

  const nowSeconds = Math.floor(options.now.getTime() / 1000)
  const maxTtl = options.maxTtlSeconds ?? PREVIEW_TOKEN_TTL_SECONDS

  if (claims.iat > nowSeconds + PREVIEW_TOKEN_IAT_SKEW_SECONDS) {
    return { ok: false, reason: 'not_yet_valid' }
  }
  if (claims.exp <= nowSeconds) return { ok: false, reason: 'expired' }
  if (claims.exp - claims.iat > maxTtl) return { ok: false, reason: 'ttl_exceeded' }

  return { ok: true, claims }
}
