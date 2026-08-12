import { randomUUID } from 'node:crypto'
import { revenueEventsToken } from '@openanalytics/clickhouse'
import {
  externalUserIdHash,
  planCurrencyConversion,
  resolveRevenueExternalUserId,
  revenueCustomerHash,
  type IdentityKey,
  type RevenueNormalizedObject,
} from '@openanalytics/domain'
import { describe, expect, it, vi } from 'vitest'
import {
  buildRevenueEventRow,
  type BuildRevenueEventRowInput,
} from '../../apps/worker/src/revenue/project.ts'

/**
 * The projection row builder and its two identity derivations (ADR-0033,
 * D5/D6). Milestone 12 CP3.
 *
 * Three properties are asserted here and each one has a failure mode that no
 * other test in the repository would catch:
 *
 * 1. **Idempotence.** The ClickHouse insert's deduplication token is a hash of
 *    the rows, so re-projecting an unchanged head has to rebuild a byte-
 *    identical row. If it does not, the token changes, the retry writes a
 *    duplicate, and the safety of the insert-then-mark ordering — which is the
 *    whole exactly-once story — silently evaporates.
 * 2. **Purpose-tag separation.** `customer_hash` and `external_user_hash` are
 *    derived from the same secret under different tags. One must be joinable
 *    against `events_raw.user_id` byte for byte; the other must NOT be, or a
 *    provider customer id starts looking like a browsing identity.
 * 3. **`unavailable` writes zeros beside a flag, never a silent zero.** The row
 *    keeps its original currency and amount intact, so a read layer can render
 *    the unconverted remainder.
 */

const KEY: IdentityKey = { keyVersion: 1, secret: 'test-identity-secret-000000000000' }

const SITE = '11111111-1111-4111-8111-111111111111'
const OTHER_SITE = '22222222-2222-4222-8222-222222222222'

function normalized(overrides: Partial<RevenueNormalizedObject> = {}): RevenueNormalizedObject {
  return {
    object_kind: 'charge',
    status: 'succeeded',
    livemode: true,
    currency: 'usd',
    gross_minor: 10_000,
    fee_minor: 320,
    fee_currency: 'usd',
    net_minor: 9_680,
    occurred_at: '2026-07-30T12:00:00.000Z',
    parent_object_id: '',
    order_id: 'pi_1',
    checkout_session_id: '',
    client_reference_id: '',
    subscription_id: '',
    product_id: '',
    product_name: '',
    customer_id: 'cus_1',
    ...overrides,
  }
}

function head(overrides: Partial<BuildRevenueEventRowInput['head']> = {}) {
  return {
    id: randomUUID(),
    siteId: SITE,
    provider: 'stripe',
    objectId: 'ch_1',
    objectKind: 'charge' as const,
    version: 3,
    normalized: normalized(),
    firstSeenAt: new Date('2026-07-30T12:00:01.000Z'),
    updatedAt: new Date('2026-07-30T12:00:01.000Z'),
    projectionEpoch: 0,
    ...overrides,
  }
}

const USD_RATE = { ratePerEur: '1.0850', rateDate: '2026-07-30' }
const EUR_RATE = { ratePerEur: '1', rateDate: '2026-07-30' }

function build(overrides: Partial<BuildRevenueEventRowInput> = {}) {
  const input: BuildRevenueEventRowInput = {
    head: head(),
    reportingCurrency: 'USD',
    conversion: planCurrencyConversion({
      fromCurrency: 'USD',
      toCurrency: 'USD',
      fromRate: USD_RATE,
      toRate: USD_RATE,
    }),
    hint: null,
    identityKey: KEY,
    ...overrides,
  }
  return buildRevenueEventRow(input)
}

describe('identity derivations — purpose-tag separation (D5/D6)', () => {
  it('gives the same input two different hashes under the two tags', () => {
    // The value that would break CP4 if it were wrong: a provider customer id
    // hashed under the `identify()` tag would look exactly like a `user_id` and
    // join against a visitor who never existed.
    const value = 'cus_shared'
    const customer = revenueCustomerHash({ siteId: SITE, customerId: value, key: KEY }).customerHash
    const external = externalUserIdHash({ siteId: SITE, externalUserId: value, key: KEY }).userId
    expect(customer).not.toBe(external)
    expect(customer).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is site-scoped: the same customer at two sites is two pseudonyms', () => {
    const here = revenueCustomerHash({ siteId: SITE, customerId: 'cus_1', key: KEY }).customerHash
    const there = revenueCustomerHash({
      siteId: OTHER_SITE,
      customerId: 'cus_1',
      key: KEY,
    }).customerHash
    expect(here).not.toBe(there)
  })

  it('does not rotate: two calls a day apart agree', () => {
    // Unlike the anonymous id (D-102), a customer relationship is stable by
    // nature. A rotating payer pseudonym would make "four purchases by one
    // customer" unanswerable across a midnight.
    const a = revenueCustomerHash({ siteId: SITE, customerId: 'cus_1', key: KEY }).customerHash
    const b = revenueCustomerHash({ siteId: SITE, customerId: 'cus_1', key: KEY }).customerHash
    expect(a).toBe(b)
  })

  it("writes external_user_hash as identify()'s derivation, byte for byte", () => {
    // The assertion CP4's join rests on. Not "looks like a hash" — the exact
    // value `externalUserIdHash` produces, which is what `events_raw.user_id`
    // holds for the same `identify()` call.
    const row = build({
      head: head({ normalized: normalized({ client_reference_id: 'user-42' }) }),
    })
    expect(row.external_user_hash).toBe(
      externalUserIdHash({ siteId: SITE, externalUserId: 'user-42', key: KEY }).userId,
    )
  })

  it('leaves both hashes empty rather than hashing nothing', () => {
    // An unmatched transaction is a first-class outcome (D6): it appears in
    // every total and simply has no journey. Hashing the empty string would
    // produce a real-looking pseudonym shared by every anonymous charge.
    const row = build({
      head: head({ normalized: normalized({ customer_id: '', client_reference_id: '' }) }),
    })
    expect(row.customer_hash).toBe('')
    expect(row.external_user_hash).toBe('')
  })

  it('never puts a raw identifier where a hash belongs', () => {
    const row = build({
      head: head({ normalized: normalized({ client_reference_id: 'user-42' }) }),
    })
    expect(row.customer_hash).not.toContain('cus_')
    expect(row.external_user_hash).not.toContain('user-42')
  })
})

describe('resolveRevenueExternalUserId', () => {
  it('prefers the head over the hint, and the metadata over both', () => {
    expect(
      resolveRevenueExternalUserId({
        externalIdMetadata: 'meta',
        clientReferenceId: 'head',
        hintClientReferenceId: 'hint',
      }),
    ).toBe('meta')
    expect(
      resolveRevenueExternalUserId({ clientReferenceId: 'head', hintClientReferenceId: 'hint' }),
    ).toBe('head')
    expect(resolveRevenueExternalUserId({ hintClientReferenceId: 'hint' })).toBe('hint')
  })

  it('treats blank as absent and returns the empty string when nothing is available', () => {
    expect(resolveRevenueExternalUserId({ clientReferenceId: '   ' })).toBe('')
    expect(resolveRevenueExternalUserId({})).toBe('')
  })
})

describe('buildRevenueEventRow — idempotence across a crash-retry', () => {
  it('builds an identical row and token when the two projections run at different times', () => {
    // **The blocker this test exists for.** The insert-then-mark ordering is
    // only safe if the replay after "insert succeeded, marker never landed"
    // rebuilds a byte-identical row: same bytes → same content-derived token →
    // ClickHouse drops it. That replay happens on a LATER TICK, so a builder
    // that read a clock would produce a different row, a different token, and a
    // duplicate fact at the same version.
    //
    // Building the same head twice in a row would not have caught that — it
    // passes even with a clock, as long as the two calls land in the same
    // millisecond. So the wall clock is moved between the two calls, which is
    // what a crash-retry actually looks like.
    const stable = head()

    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-07-31T09:00:00.000Z'))
      const first = build({ head: stable })

      // A day later: the worker restarted, the tick re-read the same head.
      vi.setSystemTime(new Date('2026-08-01T17:42:13.913Z'))
      const replay = build({ head: stable })

      expect(replay).toEqual(first)
      expect(revenueEventsToken([replay])).toBe(revenueEventsToken([first]))
    } finally {
      vi.useRealTimers()
    }
  })

  it('stamps ingested_at from the head, not from the projecting clock', () => {
    // The mechanism behind the assertion above, pinned directly so a future
    // refactor that reintroduces `new Date()` fails here with an obvious
    // message rather than only through the token equality.
    const stable = head({ updatedAt: new Date('2026-07-30T13:37:00.500Z') })
    expect(build({ head: stable }).ingested_at).toBe('2026-07-30 13:37:00.500')
  })

  it('produces a different token for a different version of the same object', () => {
    // The other half: a token that deduplicated too eagerly would lose a real
    // state change. A new version brings a new `updated_at` with it, which is
    // what makes the two rows differ even before the version column does.
    const v3 = build({
      head: head({ version: 3, updatedAt: new Date('2026-07-30T12:00:01.000Z') }),
    })
    const v4 = build({
      head: head({ version: 4, updatedAt: new Date('2026-07-30T14:00:00.000Z') }),
    })
    expect(revenueEventsToken([v4])).not.toBe(revenueEventsToken([v3]))
  })

  it('carries the Postgres-minted version through untouched', () => {
    expect(build({ head: head({ version: 17 }) }).version).toBe(17)
  })
})

describe('buildRevenueEventRow — amounts and conversion', () => {
  it('keeps the original currency and amounts untouched', () => {
    const row = build()
    expect(row.currency).toBe('usd')
    expect(row.gross_minor).toBe(10_000)
    expect(row.fee_minor).toBe(320)
    expect(row.net_minor).toBe(9_680)
  })

  it('passes amounts through unrounded when the currencies match', () => {
    const row = build()
    expect(row.conversion_source).toBe('none')
    expect(row.conversion_rate).toBe(1)
    expect(row.conversion_rate_date).toBe('1970-01-01')
    expect(row.reporting_gross_minor).toBe(10_000)
    expect(row.reporting_net_minor).toBe(9_680)
  })

  it('writes both currency columns in the same (lower) case', () => {
    // `currency` is the provider's own lowercase ISO-4217 and the site setting
    // is stored uppercase (its Postgres CHECK is `^[A-Z]{3}$`). If the row kept
    // them in different cases, `currency = reporting_currency` — the obvious
    // "was this converted?" predicate, and the one a rollup would reach for —
    // would be quietly false for every unconverted row.
    const row = build({ reportingCurrency: 'USD' })
    expect(row.currency).toBe('usd')
    expect(row.reporting_currency).toBe('usd')
    expect(row.currency === row.reporting_currency).toBe(true)
  })

  it('materializes the reporting amounts at the ECB rate', () => {
    const row = build({
      reportingCurrency: 'EUR',
      conversion: planCurrencyConversion({
        fromCurrency: 'USD',
        toCurrency: 'EUR',
        fromRate: USD_RATE,
        toRate: EUR_RATE,
      }),
    })
    expect(row.conversion_source).toBe('ecb')
    expect(row.reporting_currency).toBe('eur')
    expect(row.conversion_rate_date).toBe('2026-07-30')
    // $100.00 / 1.0850 = 92.1658… -> 9217; $96.80 / 1.0850 = 89.2165… -> 8922
    expect(row.reporting_gross_minor).toBe(9_217)
    expect(row.reporting_net_minor).toBe(8_922)
  })

  it('writes zeros beside the unavailable flag, with the original intact', () => {
    // The D2c honesty clause as a row shape. CP5's read layer MUST surface this
    // as an unconverted remainder in `currency`/`gross_minor` — folding the
    // zeros into a reporting total is the confident-zero failure the milestone
    // is named after.
    const row = build({
      reportingCurrency: 'USD',
      head: head({ normalized: normalized({ currency: 'xyz' }) }),
      conversion: planCurrencyConversion({
        fromCurrency: 'XYZ',
        toCurrency: 'USD',
        fromRate: null,
        toRate: USD_RATE,
      }),
    })
    expect(row.conversion_source).toBe('unavailable')
    expect(row.conversion_rate).toBe(0)
    expect(row.conversion_rate_date).toBe('1970-01-01')
    expect(row.reporting_gross_minor).toBe(0)
    expect(row.reporting_net_minor).toBe(0)
    // Untouched, which is what makes the remainder renderable at all.
    expect(row.currency).toBe('xyz')
    expect(row.gross_minor).toBe(10_000)
    expect(row.net_minor).toBe(9_680)
  })

  it('stores a refund as a magnitude, never a negative', () => {
    // D2d: the sign is a function of `object_kind` and is applied at rollup/read
    // time. A negative here would make `sum(gross_minor)` mean something
    // different per kind.
    const row = build({
      head: head({
        objectKind: 'refund',
        objectId: 're_1',
        normalized: normalized({
          object_kind: 'refund',
          gross_minor: 2_500,
          net_minor: 2_500,
          fee_minor: 0,
          parent_object_id: 'ch_1',
        }),
      }),
    })
    expect(row.object_kind).toBe('refund')
    expect(row.gross_minor).toBe(2_500)
    expect(row.parent_object_id).toBe('ch_1')
  })
})

describe('buildRevenueEventRow — checkout hints', () => {
  const hint = {
    checkoutSessionId: 'cs_1',
    orderId: 'pi_1',
    clientReferenceId: 'user-42',
    customerId: 'cus_hint',
    occurredAt: new Date('2026-07-30T11:59:00.000Z'),
  }

  it('fills the two fields the charge payload never carries', () => {
    // Stripe puts neither the session id nor the client reference on the charge,
    // so without the hint these stay empty forever and D6 signal 2 never fires.
    const row = build({ hint })
    expect(row.checkout_session_id).toBe('cs_1')
    expect(row.client_reference_id).toBe('user-42')
    expect(row.external_user_hash).toBe(
      externalUserIdHash({ siteId: SITE, externalUserId: 'user-42', key: KEY }).userId,
    )
  })

  it('never lets a hint override what the head already knows', () => {
    // The head is the money object's own truth. A hint is a side signal, and a
    // side signal that could overwrite the head would be the corruption channel
    // the separate table exists to close.
    const row = build({
      head: head({
        normalized: normalized({
          checkout_session_id: 'cs_head',
          client_reference_id: 'user-head',
        }),
      }),
      hint,
    })
    expect(row.checkout_session_id).toBe('cs_head')
    expect(row.client_reference_id).toBe('user-head')
  })

  it('falls back to the hint customer only when the charge names none', () => {
    const withCharge = build({ hint })
    expect(withCharge.customer_hash).toBe(
      revenueCustomerHash({ siteId: SITE, customerId: 'cus_1', key: KEY }).customerHash,
    )

    const withoutCharge = build({
      head: head({ normalized: normalized({ customer_id: '' }) }),
      hint,
    })
    expect(withoutCharge.customer_hash).toBe(
      revenueCustomerHash({ siteId: SITE, customerId: 'cus_hint', key: KEY }).customerHash,
    )
  })

  it('leaves a charge with no hint entirely unmatched rather than guessing', () => {
    const row = build({ hint: null })
    expect(row.checkout_session_id).toBe('')
    expect(row.client_reference_id).toBe('')
    expect(row.external_user_hash).toBe('')
  })
})

describe('buildRevenueEventRow — ClickHouse shapes', () => {
  it('renders instants as DateTime64(3) literals in UTC', () => {
    const row = build()
    expect(row.occurred_at).toBe('2026-07-30 12:00:00.000')
    expect(row.ingested_at).toBe('2026-07-30 12:00:01.000')
  })

  it('renders livemode as a UInt8', () => {
    expect(build().livemode).toBe(1)
    expect(build({ head: head({ normalized: normalized({ livemode: false }) }) }).livemode).toBe(0)
  })

  it('reports ingested_via from whether the head has ever been updated', () => {
    const firstSeen = new Date('2026-07-30T12:00:01.000Z')
    expect(
      build({ head: head({ firstSeenAt: firstSeen, updatedAt: firstSeen }) }).ingested_via,
    ).toBe('backfill')
    expect(
      build({
        head: head({ firstSeenAt: firstSeen, updatedAt: new Date('2026-07-30T13:00:00.000Z') }),
      }).ingested_via,
    ).toBe('webhook')
  })
})
