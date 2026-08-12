import type {
  RevenueAdapter,
  RevenueFetchOutcome,
  RevenueListOutcome,
  RevenueNormalizeOutcome,
  RevenueWebhookVerification,
} from '@openanalytics/domain'

/**
 * Revenue fixtures for the M12 ingest suites (ADR-0033, CP2).
 *
 * Two things live here.
 *
 * **`fakeRevenueAdapter`** is a complete `RevenueAdapter` whose every member has
 * a boring default, so a test overrides only the one it is about. That is worth
 * a shared helper rather than five inline object literals: CP1's tests were
 * written against a one-member interface, and CP2 widened it — with per-file
 * stubs, every future widening breaks every suite that ever touched an adapter,
 * and the pressure to answer that by loosening the type is exactly how a stub
 * becomes a second, weaker contract.
 *
 * **The Stripe payload builders** produce the *shapes Stripe actually sends*,
 * with the fields the normalizer reads and nothing invented. A fixture that
 * quietly used a field Stripe does not send would make the normalizer's tests
 * prove something about our imagination.
 */

/** Every member defaulted; override exactly what a test is about. */
export function fakeRevenueAdapter(overrides: Partial<RevenueAdapter> = {}): RevenueAdapter {
  return {
    providerId: 'stripe',
    verifyCredential: async () => ({ outcome: 'ok' }),
    verifyWebhook: (): RevenueWebhookVerification => ({ ok: true }),
    normalizeEvent: (): RevenueNormalizeOutcome => ({
      ok: true,
      event: {
        eventId: 'evt_default',
        eventType: 'charge.succeeded',
        eventAt: new Date('2026-07-31T00:00:00.000Z'),
        observations: [],
        ignored: 'no_observations',
      },
    }),
    listObjects: async (): Promise<RevenueListOutcome> => ({
      ok: true,
      page: { observations: [], nextCursor: null, hasMore: false },
    }),
    fetchObject: async (): Promise<RevenueFetchOutcome> => ({
      ok: true,
      observation: null,
      missing: true,
    }),
    ...overrides,
  }
}

const CREATED = Math.floor(new Date('2026-07-31T10:00:00.000Z').getTime() / 1000)

/** A Stripe charge object, in the shape a `charge.*` event's `data.object` has. */
export function stripeCharge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ch_test_1',
    object: 'charge',
    amount: 4999,
    amount_refunded: 0,
    refunded: false,
    currency: 'USD',
    created: CREATED,
    livemode: false,
    status: 'succeeded',
    customer: 'cus_test_1',
    payment_intent: 'pi_test_1',
    // The UNEXPANDED form, which is what a webhook delivery carries: `expand` is
    // a request parameter and a webhook is not a request we make. Present as an
    // id string so the adapter's tests prove it does not mistake a reference for
    // a fee.
    balance_transaction: 'txn_test_1',
    ...overrides,
  }
}

/**
 * A balance transaction, in the shape `expand[]=…balance_transaction` returns.
 *
 * `currency` here is the account's SETTLEMENT currency and is not required to
 * match the object's — the cross-currency case is the whole reason
 * `fee_currency` exists on the fact.
 */
export function stripeBalanceTransaction(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'txn_test_1',
    object: 'balance_transaction',
    amount: 4999,
    currency: 'usd',
    fee: 175,
    net: 4824,
    ...overrides,
  }
}

export function stripeRefund(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 're_test_1',
    object: 'refund',
    amount: 1500,
    currency: 'usd',
    created: CREATED + 60,
    livemode: false,
    status: 'succeeded',
    charge: 'ch_test_1',
    payment_intent: 'pi_test_1',
    ...overrides,
  }
}

export function stripeDispute(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'du_test_1',
    object: 'dispute',
    amount: 4999,
    currency: 'usd',
    created: CREATED + 120,
    livemode: false,
    status: 'needs_response',
    charge: 'ch_test_1',
    payment_intent: 'pi_test_1',
    ...overrides,
  }
}

/** The event envelope Stripe wraps an object in. */
export function stripeEvent(
  type: string,
  object: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `evt_${type.replace(/\./gu, '_')}`,
    object: 'event',
    type,
    created: CREATED,
    livemode: false,
    data: { object },
    ...overrides,
  }
}

/**
 * The ECB daily file, in the exact nesting the real document uses.
 *
 * Single-quoted attributes, because that is what the ECB publishes — a fixture
 * that used double quotes would pass against a regex that only reads one form
 * and then fail against production.
 */
export function ecbDocument(date: string, rates: readonly (readonly [string, string])[]): string {
  const cubes = rates
    .map(([currency, rate]) => `      <Cube currency='${currency}' rate='${rate}'/>`)
    .join('\n')
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01">`,
    `  <gesmes:subject>Reference rates</gesmes:subject>`,
    `  <Cube>`,
    `    <Cube time='${date}'>`,
    cubes,
    `    </Cube>`,
    `  </Cube>`,
    `</gesmes:Envelope>`,
    ``,
  ].join('\n')
}
