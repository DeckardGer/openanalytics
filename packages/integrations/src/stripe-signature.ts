import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Stripe webhook signature verification.
 *
 * Its own module because it has two callers on opposite sides of the open-core
 * line: the hosted billing webhook, which moved to `cloud/stripe.ts`, and the
 * per-site revenue webhook in `stripe-revenue.ts`, which is a customer
 * connecting *their* Stripe account and stays in the product. Leaving it beside
 * the billing adapter would have made a self-hosted install unable to
 * authenticate its own revenue deliveries.
 *
 * Verified directly rather than through the SDK: the scheme is a small,
 * well-specified HMAC, the security-critical path has no third-party code, and
 * tests can sign with a test secret.
 */

export type StripeSignatureFailure =
  'malformed_header' | 'timestamp_out_of_tolerance' | 'no_matching_signature'

export type StripeSignatureResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: StripeSignatureFailure }

/** Default replay tolerance, matching Stripe's own libraries. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300

function parseSignatureHeader(header: string): { t: number; v1: string[] } | null {
  let t: number | null = null
  const v1: string[] = []
  for (const part of header.split(',')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key === 't') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) t = parsed
    } else if (key === 'v1') {
      v1.push(value)
    }
  }
  if (t === null || v1.length === 0) return null
  return { t, v1 }
}

function safeEqualHex(a: string, b: string): boolean {
  // timingSafeEqual throws on length mismatch, so compare lengths first — a
  // length mismatch is already a non-match and leaks nothing useful.
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

/**
 * Verifies a Stripe webhook signature against the raw request body.
 *
 * The signed payload is `${t}.${rawBody}`; the expected value is its
 * HMAC-SHA256 under the endpoint secret, compared constant-time against every
 * `v1` in the header (Stripe may send more than one during a secret rotation).
 * The timestamp must be within tolerance of `now` to bound replay.
 */
export function verifyStripeSignature(input: {
  readonly rawBody: string
  readonly header: string | undefined
  readonly secret: string
  readonly now?: Date
  readonly toleranceSeconds?: number
}): StripeSignatureResult {
  if (!input.header) return { ok: false, reason: 'malformed_header' }
  const parsed = parseSignatureHeader(input.header)
  if (!parsed) return { ok: false, reason: 'malformed_header' }

  const nowSeconds = Math.floor((input.now?.getTime() ?? Date.now()) / 1000)
  const tolerance = input.toleranceSeconds ?? STRIPE_SIGNATURE_TOLERANCE_SECONDS
  if (Math.abs(nowSeconds - parsed.t) > tolerance) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' }
  }

  const expected = createHmac('sha256', input.secret)
    .update(`${parsed.t}.${input.rawBody}`)
    .digest('hex')

  const matches = parsed.v1.some((candidate) => safeEqualHex(candidate, expected))
  return matches ? { ok: true } : { ok: false, reason: 'no_matching_signature' }
}
