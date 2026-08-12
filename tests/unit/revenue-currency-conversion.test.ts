import {
  CURRENCY_RATE_LOOKBACK_DAYS,
  conversionDateOf,
  convertMinorAmount,
  divideRoundHalfEven,
  isRateWithinLookback,
  minorUnitExponent,
  parseDecimalRate,
  planCurrencyConversion,
  shiftUtcDate,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * Reporting-currency conversion (ADR-0033, D2c). Milestone 12 CP3.
 *
 * The suite is a table of exact answers, because the failure mode this module
 * exists to prevent is not a crash — it is a number that is wrong by a cent, or
 * by a factor of a hundred, and looks entirely plausible for the rest of its
 * life. Every expectation below is computed by hand from the rate strings, never
 * from the implementation.
 *
 * Four properties carry the weight:
 *
 *  1. **No float multiplication.** A rate like `1.1005` is not exactly
 *     representable in binary floating point, so the whole conversion runs over
 *     BigInts parsed from the decimal string. The tie cases prove it: a value
 *     that lands exactly on `.5` after a float multiply usually does not land
 *     there at all.
 *  2. **Half-to-even, not half-up.** The neutral rule for a value that will be
 *     summed thousands of times.
 *  3. **Zero-decimal currencies both directions.** JPY has exponent 0, so a
 *     conversion into it divides by a hundred relative to a two-decimal
 *     currency and out of it multiplies by one. Getting the exponent wrong is a
 *     hundredfold error.
 *  4. **`unavailable` is not zero.** A missing or stale rate yields no converted
 *     amount at all, so a caller cannot mistake "we could not convert" for
 *     "nothing was earned".
 */

/** Rates as the ECB publishes them: units per one euro. */
const USD = { ratePerEur: '1.0850', rateDate: '2026-07-30' }
const JPY = { ratePerEur: '168.42', rateDate: '2026-07-30' }
const GBP = { ratePerEur: '0.84250', rateDate: '2026-07-30' }
const EUR = { ratePerEur: '1', rateDate: '2026-07-30' }

describe('parseDecimalRate', () => {
  it('keeps the exact decimal, never a float', () => {
    expect(parseDecimalRate('1.1005')).toEqual({ numerator: 11005n, scale: 4 })
    expect(parseDecimalRate('1')).toEqual({ numerator: 1n, scale: 0 })
    expect(parseDecimalRate('0.0000123')).toEqual({ numerator: 123n, scale: 7 })
    expect(parseDecimalRate('  1.50  ')).toEqual({ numerator: 150n, scale: 2 })
    expect(parseDecimalRate('+2.5')).toEqual({ numerator: 25n, scale: 1 })
  })

  it('refuses everything numeric never renders', () => {
    // Exponent notation, signs, empty, and a value that would make the rational
    // undefined. A rate we cannot read must become `unavailable` — which is
    // visible — rather than a guess.
    for (const bad of ['1e3', '-1.5', '', 'abc', '1.', '.5', '0', '0.000']) {
      expect(parseDecimalRate(bad), bad).toBeNull()
    }
  })

  it('refuses a pathologically long decimal rather than exponentiating on it', () => {
    expect(parseDecimalRate(`1.${'0'.repeat(60)}1`)).toBeNull()
  })
})

describe('divideRoundHalfEven', () => {
  it('rounds a tie to the even neighbour', () => {
    // 5/2 = 2.5 -> 2 (even), 7/2 = 3.5 -> 4 (even). Half-up would give 3 and 4.
    expect(divideRoundHalfEven(5n, 2n)).toBe(2n)
    expect(divideRoundHalfEven(7n, 2n)).toBe(4n)
    expect(divideRoundHalfEven(1n, 2n)).toBe(0n)
    expect(divideRoundHalfEven(3n, 2n)).toBe(2n)
  })

  it('rounds a non-tie the ordinary way', () => {
    expect(divideRoundHalfEven(5n, 3n)).toBe(2n) // 1.66…
    expect(divideRoundHalfEven(4n, 3n)).toBe(1n) // 1.33…
    expect(divideRoundHalfEven(6n, 3n)).toBe(2n) // exact
  })

  it('refuses inputs the money model cannot produce', () => {
    expect(() => divideRoundHalfEven(1n, 0n)).toThrow()
    expect(() => divideRoundHalfEven(-1n, 2n)).toThrow()
  })
})

describe('minorUnitExponent', () => {
  it('knows the zero- and multi-decimal cases and defaults the rest to two', () => {
    expect(minorUnitExponent('JPY')).toBe(0)
    expect(minorUnitExponent('jpy')).toBe(0)
    expect(minorUnitExponent('KRW')).toBe(0)
    expect(minorUnitExponent('BHD')).toBe(3)
    expect(minorUnitExponent('CLF')).toBe(4)
    expect(minorUnitExponent('USD')).toBe(2)
    expect(minorUnitExponent('EUR')).toBe(2)
    // A currency added tomorrow: two is what every major currency uses, and it
    // is a better guess than throwing inside a projection loop.
    expect(minorUnitExponent('ZZZ')).toBe(2)
  })

  it('follows the PROVIDER, not ISO-4217, where the two disagree', () => {
    // Three currencies where ISO-4217 and Stripe disagree, and every one of them
    // is a factor of a hundred. The table this pins is documented as
    // "provider-reported (Stripe convention)" for exactly this reason: the
    // exponent is a property of the integer the provider sent, not of the
    // currency in the abstract.

    // ISK — zero-decimal in ISO-4217. Stripe's currency documentation lists it
    // among the currencies that must be provided with TWO decimal places, for
    // backward compatibility, so `amount: 500` is 5 ISK and not 500.
    expect(minorUnitExponent('ISK')).toBe(2)

    // UGX — the same story, with Stripe's added rule that the amount must be
    // evenly divisible by 100. Two decimals, so `amount: 500` is 5 UGX.
    expect(minorUnitExponent('UGX')).toBe(2)

    // MGA — the disagreement in the other direction. Stripe lists it among its
    // zero-decimal currencies, so `amount: 500` is 500 ariary; ISO-4217 gives it
    // exponent 2 over a 1/5 subunit (the iraimbilanja) that nothing prices in.
    expect(minorUnitExponent('MGA')).toBe(0)
  })

  it('converts an ISK amount as two-decimal end to end', () => {
    // The regression this is really guarding. With the old zero-decimal entry a
    // 5,000 ISK charge (`amount: 500000`) converted to a hundred times its true
    // value — and a hundredfold revenue number on a dashboard looks like a good
    // month, not like a bug.
    const isk = { ratePerEur: '150.00', rateDate: '2026-07-30' }
    const eur = { ratePerEur: '1', rateDate: '2026-07-30' }
    const converted = convertMinorAmount({
      amountMinor: 500_000, // 5,000.00 ISK
      fromCurrency: 'ISK',
      toCurrency: 'EUR',
      conversion: planCurrencyConversion({
        fromCurrency: 'ISK',
        toCurrency: 'EUR',
        fromRate: isk,
        toRate: eur,
      }),
    })
    // 5,000 ISK / 150 = 33.33… EUR -> 3333 cents. Under the old table it would
    // have been 333_333.
    expect(converted).toBe(3_333)
  })
})

describe('planCurrencyConversion', () => {
  it('short-circuits an identical currency with no arithmetic at all', () => {
    const plan = planCurrencyConversion({
      fromCurrency: 'usd',
      toCurrency: 'USD',
      fromRate: USD,
      toRate: USD,
    })
    expect(plan.source).toBe('none')
    expect(plan.rate).toBe(1)
    expect(plan.rateDate).toBeNull()
    // And the amount passes through byte for byte — no rounding can enter.
    expect(
      convertMinorAmount({
        amountMinor: 12_345,
        fromCurrency: 'USD',
        toCurrency: 'USD',
        conversion: plan,
      }),
    ).toBe(12_345)
  })

  it('reports the OLDER of the two rate dates', () => {
    // A conversion is only as fresh as its staler half. Reporting the newer date
    // would overstate how current the number is, which is precisely the kind of
    // small lie the rate metadata exists to prevent.
    const plan = planCurrencyConversion({
      fromCurrency: 'GBP',
      toCurrency: 'USD',
      fromRate: { ratePerEur: '0.84250', rateDate: '2026-07-24' },
      toRate: USD,
    })
    expect(plan.source).toBe('ecb')
    expect(plan.rateDate).toBe('2026-07-24')
  })

  it('is unavailable when either side has no rate, and says which', () => {
    const noSource = planCurrencyConversion({
      fromCurrency: 'XYZ',
      toCurrency: 'USD',
      fromRate: null,
      toRate: USD,
    })
    expect(noSource).toMatchObject({
      source: 'unavailable',
      reason: 'source_rate_missing',
      rate: 0,
    })

    const noReporting = planCurrencyConversion({
      fromCurrency: 'USD',
      toCurrency: 'XYZ',
      fromRate: USD,
      toRate: null,
    })
    expect(noReporting).toMatchObject({
      source: 'unavailable',
      reason: 'reporting_rate_missing',
    })
  })

  it('is unavailable when a rate string cannot be read exactly', () => {
    const plan = planCurrencyConversion({
      fromCurrency: 'USD',
      toCurrency: 'GBP',
      fromRate: { ratePerEur: '1e3', rateDate: '2026-07-30' },
      toRate: GBP,
    })
    expect(plan).toMatchObject({ source: 'unavailable', reason: 'rate_unparseable' })
  })
})

describe('convertMinorAmount', () => {
  const convert = (
    amountMinor: number,
    from: string,
    to: string,
    fromRate: { ratePerEur: string; rateDate: string } | null,
    toRate: { ratePerEur: string; rateDate: string } | null,
  ): number | null =>
    convertMinorAmount({
      amountMinor,
      fromCurrency: from,
      toCurrency: to,
      conversion: planCurrencyConversion({
        fromCurrency: from,
        toCurrency: to,
        fromRate,
        toRate,
      }),
    })

  it('converts two-decimal to two-decimal exactly', () => {
    // $10.00 -> GBP. EUR = 10 / 1.0850 = 9.21659…, GBP = 9.21659… * 0.84250
    //   = 7.76498… -> 776 pence.
    // Exact: 1000 * 84250 * 10^(4+2) / (10850 * 10^(5+2))
    //      = 84_250_000_000_000 / 108_500_000_000 = 776.4977…  -> 776
    expect(convert(1000, 'USD', 'GBP', USD, GBP)).toBe(776)

    // 100.00 USD -> EUR: 10000 / 1.0850 = 9216.58…  -> 9217 (92.17 EUR)
    expect(convert(10_000, 'USD', 'EUR', USD, EUR)).toBe(9217)

    // 100.00 EUR -> USD: 10000 * 1.0850 = 10850 exactly.
    expect(convert(10_000, 'EUR', 'USD', EUR, USD)).toBe(10_850)
  })

  it('converts JPY (zero-decimal) into USD without losing a factor of a hundred', () => {
    // 10,000 JPY (amount_minor = 10000, exponent 0 -> ten thousand yen).
    //   EUR = 10000 / 168.42 = 59.3754…
    //   USD = 59.3754… * 1.0850 = 64.4223…  -> 6442 minor units = $64.42
    // Exact: 10000 * 10850 * 10^(2+2) / (16842 * 10^(4+0))
    //      = 10000 * 10850 / 16842 = 108_500_000 / 16_842 = 6442.23…  -> 6442
    expect(convert(10_000, 'JPY', 'USD', JPY, USD)).toBe(6442)
  })

  it('converts USD into JPY, dropping to zero decimals', () => {
    // $100.00 -> EUR 92.1658… -> JPY 15,523.3…  -> 15523 yen (minor == major).
    // Exact: 10000 * 16842 * 10^(4+0) / (10850 * 10^(2+2))
    //      = 10000 * 16842 / 10850 = 168_420_000 / 10_850 = 15522.58…  -> 15523
    expect(convert(10_000, 'USD', 'JPY', USD, JPY)).toBe(15_523)
  })

  it('converts GBP into JPY across two different exponents', () => {
    // The shape that breaks a naive implementation twice over: the source has a
    // five-decimal rate and two minor-unit decimals, the target has a
    // two-decimal rate and none.
    //   £50.00 -> EUR 50 / 0.84250 = 59.34718…
    //           -> JPY 59.34718… * 168.42 = 9,995.25…  -> 9995 yen
    // Exact: 5000 * 16842 * 10^(5+0) / (84250 * 10^(2+2))
    //      = 8_421_000_000_000 / 842_500_000 = 9_995.2522…  -> 9995
    expect(convert(5000, 'GBP', 'JPY', GBP, JPY)).toBe(9995)
  })

  it('rounds an exact tie to the even neighbour', () => {
    // Constructed so the rational lands exactly on .5:
    //   amount 5 minor of AAA (exp 2), rate_AAA = 2, rate_BBB = 1, BBB exp 2
    //   -> 5 * 1 * 10^(0+2) / (2 * 10^(0+2)) = 500/200 = 2.5 -> 2 (even)
    expect(
      convert(
        5,
        'AAA',
        'BBB',
        { ratePerEur: '2', rateDate: '2026-07-30' },
        { ratePerEur: '1', rateDate: '2026-07-30' },
      ),
    ).toBe(2)
    //   -> 7 * 1 * 100 / (2 * 100) = 3.5 -> 4 (even)
    expect(
      convert(
        7,
        'AAA',
        'BBB',
        { ratePerEur: '2', rateDate: '2026-07-30' },
        { ratePerEur: '1', rateDate: '2026-07-30' },
      ),
    ).toBe(4)
  })

  it('returns null — never zero — when there is no usable rate', () => {
    // The whole D2c honesty clause in one assertion. A caller that treated null
    // as 0 would be the confident-zero bug; the projection writes the zeros
    // itself, beside the flag that says what they mean.
    expect(convert(12_345, 'XYZ', 'USD', null, USD)).toBeNull()
    expect(convert(12_345, 'USD', 'XYZ', USD, null)).toBeNull()
  })

  it('passes zero through without touching the rate', () => {
    expect(convert(0, 'USD', 'JPY', USD, JPY)).toBe(0)
  })
})

describe('the 7-day lookback boundary', () => {
  it('accepts a rate up to seven days before the transaction and refuses the eighth', () => {
    expect(CURRENCY_RATE_LOOKBACK_DAYS).toBe(7)
    // A Monday transaction. The ECB published on the previous Friday, and over a
    // long holiday the last publication can be several days earlier still.
    expect(isRateWithinLookback('2026-07-30', '2026-07-30')).toBe(true)
    expect(isRateWithinLookback('2026-07-24', '2026-07-30')).toBe(true)
    expect(isRateWithinLookback('2026-07-23', '2026-07-30')).toBe(true)
    // Exactly eight days: out.
    expect(isRateWithinLookback('2026-07-22', '2026-07-30')).toBe(false)
  })

  it('refuses a rate published AFTER the transaction', () => {
    // A rate from the future would silently restate a June charge at July's
    // euro, which is exactly what "convert at the transaction's own date" exists
    // to prevent — and it is reachable, because the repository's lookup is
    // `<= date` and a clock-skewed row could sit above it.
    expect(isRateWithinLookback('2026-07-31', '2026-07-30')).toBe(false)
  })

  it('crosses a month and a year boundary correctly', () => {
    expect(shiftUtcDate('2026-08-03', -7)).toBe('2026-07-27')
    expect(shiftUtcDate('2026-01-03', -7)).toBe('2025-12-27')
    expect(isRateWithinLookback('2025-12-27', '2026-01-03')).toBe(true)
    expect(isRateWithinLookback('2025-12-26', '2026-01-03')).toBe(false)
  })
})

describe('conversionDateOf', () => {
  it('anchors on the transaction UTC date, not on a local one', () => {
    // A site's display timezone groups dashboards only (D-102). Letting it pick
    // the rate date would make two sites convert the same charge differently.
    expect(conversionDateOf('2026-07-30T23:59:59.999Z')).toBe('2026-07-30')
    expect(conversionDateOf('2026-07-31T00:00:00.000Z')).toBe('2026-07-31')
    expect(conversionDateOf(new Date('2026-07-30T12:00:00Z'))).toBe('2026-07-30')
  })
})
