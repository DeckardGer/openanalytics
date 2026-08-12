import type { KeyObject } from 'node:crypto'
import { ApiError } from '@openanalytics/contracts'
import type { RequestContextVariables } from '@openanalytics/observability/hono'
import type { MiddlewareHandler } from 'hono'
import type { NonceStore } from './nonce-store.ts'
import {
  SIGNATURE_HEADERS,
  SIGNATURE_LIFETIME_CEILING_MS,
  SIGNATURE_SCHEME,
  canonicalSigningString,
  sha256Hex,
  signedPathOf,
  verifySignature,
} from '@openanalytics/auth'

/**
 * Verification half of the D-208 signed service auth.
 *
 * Every rejection carries a distinct machine-readable reason. The HTTP code is
 * always `UNAUTHENTICATED` — the contract catalog is shared with the public API
 * and adding gateway-private codes to it would be a breaking contract change
 * (packages/contracts/src/errors.ts) — but the reason lands in `details.reason`
 * and in the structured log, so an operator can tell a clock-skew incident from
 * a replay attempt from a genuine forgery without reading message strings.
 */

export const SIGNED_REQUEST_FAILURES = [
  'MISSING_SIGNATURE',
  'MALFORMED_SIGNATURE',
  'BAD_SIGNATURE',
  'EXPIRED',
  'WRONG_AUDIENCE',
  'REPLAYED',
  'BODY_MISMATCH',
] as const

export type SignedRequestFailure = (typeof SIGNED_REQUEST_FAILURES)[number]

export class SignedRequestError extends ApiError {
  readonly reason: SignedRequestFailure

  constructor(reason: SignedRequestFailure, message: string) {
    super('UNAUTHENTICATED', message, { details: { reason } })
    this.name = 'SignedRequestError'
    this.reason = reason
  }
}

export interface SignedRequestVariables extends RequestContextVariables {
  /** Raw body text, captured once by the body-limit middleware. */
  rawBody: string
  /** Key ID whose signature authenticated this request. */
  signingKeyId: string
}

export interface SignedRequestAuthOptions {
  readonly verifyKey: KeyObject
  /** Expected audience. A signature minted for another environment must not verify here. */
  readonly audience: string
  /** When set, only this key ID is accepted — the standing half of key rotation. */
  readonly keyId?: string
  readonly nonceStore: NonceStore
  /** Longest signature validity the verifier accepts. D-208: short-lived. */
  readonly maxLifetimeMs: number
  /** Tolerance for the caller's clock running ahead of ours. */
  readonly clockSkewMs?: number
  readonly now?: () => Date
}

const RFC3339_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

function requireHeader(
  value: string | undefined,
  reason: SignedRequestFailure,
  name: string,
): string {
  if (value === undefined || value === '') {
    throw new SignedRequestError(reason, `Signed request is missing "${name}"`)
  }
  return value
}

function parseInstant(value: string, name: string): number {
  // The format is pinned rather than handed to `Date.parse`, whose lenient
  // fallback would accept a string the signer never produced and therefore make
  // the expiry window negotiable by the caller.
  if (!RFC3339_MS.test(value)) {
    throw new SignedRequestError('MALFORMED_SIGNATURE', `"${name}" is not an RFC 3339 UTC instant`)
  }
  return Date.parse(value)
}

export function signedRequestAuth(
  options: SignedRequestAuthOptions,
): MiddlewareHandler<{ Variables: SignedRequestVariables }> {
  const clockSkewMs = options.clockSkewMs ?? 5_000
  const now = options.now ?? (() => new Date())
  const maxLifetimeMs = Math.min(options.maxLifetimeMs, SIGNATURE_LIFETIME_CEILING_MS)

  return async (c, next) => {
    const header = (name: string): string | undefined => c.req.header(name)

    // A wholly unsigned request is its own failure: it is usually a
    // misconfigured caller, not an attack, and the distinction matters on call.
    const signature = requireHeader(
      header(SIGNATURE_HEADERS.signature),
      'MISSING_SIGNATURE',
      SIGNATURE_HEADERS.signature,
    )

    const scheme = requireHeader(
      header(SIGNATURE_HEADERS.scheme),
      'MALFORMED_SIGNATURE',
      SIGNATURE_HEADERS.scheme,
    )
    if (scheme !== SIGNATURE_SCHEME) {
      throw new SignedRequestError(
        'MALFORMED_SIGNATURE',
        `Unsupported signature scheme "${scheme}"`,
      )
    }

    const keyId = requireHeader(
      header(SIGNATURE_HEADERS.keyId),
      'MALFORMED_SIGNATURE',
      SIGNATURE_HEADERS.keyId,
    )
    const audience = requireHeader(
      header(SIGNATURE_HEADERS.audience),
      'MALFORMED_SIGNATURE',
      SIGNATURE_HEADERS.audience,
    )
    const issuedAtRaw = requireHeader(
      header(SIGNATURE_HEADERS.issuedAt),
      'MALFORMED_SIGNATURE',
      SIGNATURE_HEADERS.issuedAt,
    )
    const expiresAtRaw = requireHeader(
      header(SIGNATURE_HEADERS.expiresAt),
      'MALFORMED_SIGNATURE',
      SIGNATURE_HEADERS.expiresAt,
    )
    const nonce = requireHeader(
      header(SIGNATURE_HEADERS.nonce),
      'MALFORMED_SIGNATURE',
      SIGNATURE_HEADERS.nonce,
    )
    const bodySha256 = requireHeader(
      header(SIGNATURE_HEADERS.bodySha256),
      'MALFORMED_SIGNATURE',
      SIGNATURE_HEADERS.bodySha256,
    )

    // Audience first: a signature minted for staging must be rejected here even
    // if it is otherwise perfect, and the caller deserves to be told why.
    if (audience !== options.audience) {
      throw new SignedRequestError('WRONG_AUDIENCE', 'Signature audience does not match this host')
    }

    const issuedAt = parseInstant(issuedAtRaw, SIGNATURE_HEADERS.issuedAt)
    const expiresAt = parseInstant(expiresAtRaw, SIGNATURE_HEADERS.expiresAt)
    if (expiresAt <= issuedAt || expiresAt - issuedAt > maxLifetimeMs) {
      // A caller-chosen long window would defeat the point of short-lived
      // credentials, so the ceiling is enforced by the verifier, not trusted.
      throw new SignedRequestError(
        'MALFORMED_SIGNATURE',
        `Signature validity must be a positive window of at most ${maxLifetimeMs}ms`,
      )
    }

    const nowMs = now().getTime()
    if (nowMs >= expiresAt) {
      throw new SignedRequestError('EXPIRED', 'Signature has expired')
    }
    if (issuedAt > nowMs + clockSkewMs) {
      throw new SignedRequestError('EXPIRED', 'Signature is issued in the future')
    }

    // Body binding is checked before the signature so a mutated payload is
    // reported as tampering rather than as an unexplained bad signature.
    const rawBody = c.get('rawBody') ?? ''
    if (bodySha256.toLowerCase() !== sha256Hex(rawBody)) {
      throw new SignedRequestError('BODY_MISMATCH', 'Request body does not match its signed hash')
    }

    if (options.keyId !== undefined && keyId !== options.keyId) {
      throw new SignedRequestError('BAD_SIGNATURE', 'Unknown signing key')
    }

    const canonical = canonicalSigningString({
      keyId,
      audience,
      method: c.req.method,
      path: signedPathOf(c.req.url),
      issuedAt: issuedAtRaw,
      expiresAt: expiresAtRaw,
      nonce,
      bodySha256,
    })

    if (!verifySignature({ verifyKey: options.verifyKey, canonical, signatureBase64: signature })) {
      throw new SignedRequestError('BAD_SIGNATURE', 'Signature verification failed')
    }

    // Nonce consumption happens last, and only for a request that already
    // verified: otherwise an unauthenticated caller could fill the store, and a
    // forged request could burn a legitimate nonce before its owner used it.
    const fresh = await options.nonceStore.consume(nonce, new Date(expiresAt))
    if (!fresh) {
      throw new SignedRequestError('REPLAYED', 'Signature nonce has already been used')
    }

    c.set('signingKeyId', keyId)
    await next()
  }
}

export interface BodyLimitOptions {
  readonly maxBytes: number
}

/**
 * Reads the body once, under a hard cap, and stashes it for downstream use.
 *
 * The signature covers a hash of the raw bytes, so the verifier and the handler
 * must agree on exactly which bytes arrived — reading the stream in two places
 * invites that disagreement. The cap runs here, before any parsing or crypto, so
 * an oversized payload costs nothing beyond the read
 * (docs snapshot 04, Milestone 1 item 2).
 */
export function boundedBody(
  options: BodyLimitOptions,
): MiddlewareHandler<{ Variables: SignedRequestVariables }> {
  return async (c, next) => {
    const declared = c.req.header('content-length')
    if (declared !== undefined && Number(declared) > options.maxBytes) {
      throw new ApiError('VALIDATION_FAILED', 'Request body is too large', {
        status: 413,
        details: { limit_bytes: options.maxBytes },
      })
    }

    const rawBody = await c.req.text()
    // Content-Length is advisory — chunked encoding omits it entirely — so the
    // real length is what the limit is enforced against.
    if (Buffer.byteLength(rawBody, 'utf8') > options.maxBytes) {
      throw new ApiError('VALIDATION_FAILED', 'Request body is too large', {
        status: 413,
        details: { limit_bytes: options.maxBytes },
      })
    }

    c.set('rawBody', rawBody)
    await next()
  }
}
