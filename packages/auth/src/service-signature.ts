import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'

/**
 * Signed service auth for the Vercel → gateway hop (docs snapshot 05, D-208).
 *
 * D-208 requires a short-lived service credential bound to audience, method,
 * path and body hash. Ed25519 detached signatures are used rather than a shared
 * HMAC secret because the gateway must be able to *verify* without being able to
 * *mint*: `QUERY_SIGNING_PRIVATE_KEY` is on the gateway's FORBIDDEN_KEYS list
 * (packages/domain/src/env.ts), so a compromised gateway cannot forge the
 * requests it exists to authenticate.
 *
 * The canonical signing string is newline-joined, in this fixed order:
 *
 * ```text
 * OA1-ED25519\n
 * <key id>\n
 * <audience>\n
 * <METHOD, uppercase>\n
 * <path, including the query string>\n
 * <issued-at, RFC 3339 UTC with milliseconds>\n
 * <expires-at, RFC 3339 UTC with milliseconds>\n
 * <nonce>\n
 * <lowercase hex SHA-256 of the raw request body>
 * ```
 *
 * Every field is also sent as a header, so the verifier reconstructs the string
 * from the wire rather than from an assumption. Three properties follow:
 *
 * - The scheme is the first line, so a future scheme cannot be validated by an
 *   older verifier that happens to accept the same field order.
 * - The path carries its query string. Signing only the pathname would leave
 *   query parameters attacker-mutable while the signature still verified.
 * - The body appears as a hash, not as bytes, so verification does not depend on
 *   byte-identical re-serialisation of a parsed body.
 */

export const SIGNATURE_SCHEME = 'OA1-ED25519'

/** Maximum signature lifetime the verifier will ever accept, regardless of config. */
export const SIGNATURE_LIFETIME_CEILING_MS = 300_000

export const SIGNATURE_HEADERS = {
  scheme: 'x-oa-scheme',
  keyId: 'x-oa-key-id',
  audience: 'x-oa-audience',
  issuedAt: 'x-oa-issued-at',
  expiresAt: 'x-oa-expires-at',
  nonce: 'x-oa-nonce',
  bodySha256: 'x-oa-body-sha256',
  signature: 'x-oa-signature',
} as const

export interface SignatureFields {
  readonly keyId: string
  readonly audience: string
  readonly method: string
  /** Pathname plus query string, exactly as it appears on the request line. */
  readonly path: string
  readonly issuedAt: string
  readonly expiresAt: string
  readonly nonce: string
  /** Lowercase hex SHA-256 of the raw body; the empty-string hash when there is none. */
  readonly bodySha256: string
}

export function canonicalSigningString(fields: SignatureFields): string {
  return [
    SIGNATURE_SCHEME,
    fields.keyId,
    fields.audience,
    fields.method.toUpperCase(),
    fields.path,
    fields.issuedAt,
    fields.expiresAt,
    fields.nonce,
    fields.bodySha256,
  ].join('\n')
}

export function sha256Hex(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

/**
 * Request target as it must be signed.
 *
 * Derived from the absolute URL so the caller and the verifier cannot disagree
 * about default ports, the origin, or a missing leading slash.
 */
export function signedPathOf(url: string): string {
  const parsed = new URL(url)
  return `${parsed.pathname}${parsed.search}`
}

export function loadVerifyKey(publicKeyPem: string): KeyObject {
  const key = createPublicKey(publicKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `query signing key must be ed25519, got "${key.asymmetricKeyType ?? 'unknown'}"`,
    )
  }
  return key
}

export function verifySignature(input: {
  readonly verifyKey: KeyObject
  readonly canonical: string
  readonly signatureBase64: string
}): boolean {
  let signature: Buffer
  try {
    signature = Buffer.from(input.signatureBase64, 'base64')
  } catch {
    return false
  }
  // Ed25519 signatures are exactly 64 bytes; anything else is malformed input
  // that `crypto.verify` would reject anyway, but rejecting early keeps the
  // failure attributable.
  if (signature.length !== 64) return false
  return verify(null, Buffer.from(input.canonical, 'utf8'), input.verifyKey, signature)
}

export interface SignRequestInput {
  readonly privateKeyPem: string
  readonly keyId: string
  readonly audience: string
  readonly method: string
  /** Absolute URL; the signed path is derived from it. */
  readonly url: string
  readonly body: string
  readonly nonce: string
  readonly issuedAt: Date
  readonly lifetimeMs: number
}

/**
 * Caller side of the scheme.
 *
 * It lives here so the wire format has exactly one definition — a signer that
 * drifts from the verifier is the failure mode this scheme is most likely to
 * hit. The gateway never calls it; it exists for the Vercel caller
 * (docs snapshot 04, Milestone 1 item 3) and for the tests that exercise the
 * tamper/replay matrix.
 */
export function signRequest(input: SignRequestInput): Record<string, string> {
  const fields: SignatureFields = {
    keyId: input.keyId,
    audience: input.audience,
    method: input.method,
    path: signedPathOf(input.url),
    issuedAt: input.issuedAt.toISOString(),
    expiresAt: new Date(input.issuedAt.getTime() + input.lifetimeMs).toISOString(),
    nonce: input.nonce,
    bodySha256: sha256Hex(input.body),
  }

  const key = createPrivateKey(input.privateKeyPem)
  const signature = sign(null, Buffer.from(canonicalSigningString(fields), 'utf8'), key)

  return {
    [SIGNATURE_HEADERS.scheme]: SIGNATURE_SCHEME,
    [SIGNATURE_HEADERS.keyId]: fields.keyId,
    [SIGNATURE_HEADERS.audience]: fields.audience,
    [SIGNATURE_HEADERS.issuedAt]: fields.issuedAt,
    [SIGNATURE_HEADERS.expiresAt]: fields.expiresAt,
    [SIGNATURE_HEADERS.nonce]: fields.nonce,
    [SIGNATURE_HEADERS.bodySha256]: fields.bodySha256,
    [SIGNATURE_HEADERS.signature]: signature.toString('base64'),
  }
}
