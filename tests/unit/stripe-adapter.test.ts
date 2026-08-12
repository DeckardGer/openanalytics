import { verifyStripeSignature } from '@openanalytics/integrations'
import { signStripeWebhook } from '@openanalytics/testkit'
import { describe, expect, it } from 'vitest'

/**
 * The webhook signature check, and only that.
 *
 * The event normalizer and the HTTP client were here too until the open-core
 * split; both are in `tests/unit/cloud/stripe-adapter.test.ts` now. This one
 * stayed because the function did: `stripe-signature.ts` is shared with the
 * per-site revenue webhook (ADR-0033), which is a product surface — a customer
 * connecting *their* Stripe account is not us selling them a plan.
 */

const SECRET = 'whsec_test_secret'
const NOW = new Date('2026-07-22T00:00:00.000Z')
const T = Math.floor(NOW.getTime() / 1000)

describe('verifyStripeSignature', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' })

  it('accepts a correctly signed body', () => {
    const header = signStripeWebhook({ payload: body, secret: SECRET, timestamp: T })
    expect(verifyStripeSignature({ rawBody: body, header, secret: SECRET, now: NOW })).toEqual({
      ok: true,
    })
  })

  it('rejects a tampered body', () => {
    const header = signStripeWebhook({ payload: body, secret: SECRET, timestamp: T })
    const result = verifyStripeSignature({
      rawBody: body + ' ',
      header,
      secret: SECRET,
      now: NOW,
    })
    expect(result).toEqual({ ok: false, reason: 'no_matching_signature' })
  })

  it('rejects a signature made with the wrong secret', () => {
    const header = signStripeWebhook({ payload: body, secret: 'whsec_other', timestamp: T })
    expect(verifyStripeSignature({ rawBody: body, header, secret: SECRET, now: NOW })).toEqual({
      ok: false,
      reason: 'no_matching_signature',
    })
  })

  it('rejects a timestamp outside tolerance (replay)', () => {
    const old = T - 10 * 60
    const header = signStripeWebhook({ payload: body, secret: SECRET, timestamp: old })
    expect(verifyStripeSignature({ rawBody: body, header, secret: SECRET, now: NOW })).toEqual({
      ok: false,
      reason: 'timestamp_out_of_tolerance',
    })
  })

  it('rejects a missing or malformed header', () => {
    expect(
      verifyStripeSignature({ rawBody: body, header: undefined, secret: SECRET, now: NOW }),
    ).toEqual({ ok: false, reason: 'malformed_header' })
    expect(
      verifyStripeSignature({ rawBody: body, header: 'garbage', secret: SECRET, now: NOW }),
    ).toEqual({ ok: false, reason: 'malformed_header' })
  })

  it('accepts when any v1 matches during a secret rotation', () => {
    const good = signStripeWebhook({ payload: body, secret: SECRET, timestamp: T }).split('v1=')[1]
    const header = `t=${T},v1=deadbeef,v1=${good}`
    expect(verifyStripeSignature({ rawBody: body, header, secret: SECRET, now: NOW })).toEqual({
      ok: true,
    })
  })
})
