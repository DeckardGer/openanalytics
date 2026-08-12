/**
 * Reporting-currency conversion, in exact integer arithmetic (ADR-0033, D2c).
 *
 * This module converts an amount in minor units from one ISO-4217 currency to
 * another through the ECB's EUR-based daily reference rates, and every choice in
 * it exists to keep a float away from money.
 *
 * ## The arithmetic, and why it is one division rather than two
 *
 * The ECB publishes `rate_per_eur`: how many units of a currency one euro buys.
 * Converting C → R is therefore "C to EUR, then EUR to R", which reads as two
 * steps and must not be *computed* as two: rounding to minor units in the middle
 * would throw away the fractional euro, and rounding to a fixed number of
 * decimals in the middle would be an invented precision nobody decided.
 *
 * So it is one exact rational, evaluated with BigInt and rounded once at the
 * end. With `A` the source amount in minor units, `e(X)` a currency's minor-unit
 * exponent, and a rate string parsed as `n / 10^d`:
 *
 *     minorR = A · (nR / 10^dR) · 10^e(R)
 *              ────────────────────────────
 *              (nC / 10^dC) · 10^e(C)
 *
 *            = A · nR · 10^(dC + e(R))
 *              ───────────────────────
 *              nC · 10^(dR + e(C))
 *
 * Both halves are exact BigInts. The single rounding is banker's rounding
 * (half-to-even), which is the neutral choice for a value that will be summed:
 * half-up biases every tied conversion in the same direction, and a report is a
 * sum of thousands of them.
 *
 * ## The exponent table is the provider's, not ISO-4217's
 *
 * `minorUnitExponent` answers "how many decimals does the integer the provider
 * gave us carry", which is a fact about the payload rather than about the
 * currency. Stripe and ISO-4217 disagree on ISK, UGX and MGA, and each
 * disagreement is a factor of a hundred. The table below says which is which.
 *
 * ## Rate strings are never `Number(...)`
 *
 * `currency_rates.rate_per_eur` is a `numeric` column read back as a decimal
 * string, and `parseDecimalRate` keeps it a string all the way into the BigInt.
 * `1.1005` is not exactly representable in binary floating point, and a rate is
 * one multiplication away from money — `packages/contracts/src/money.ts` has
 * forbidden float money since M0 and 03 §6.5 restates it.
 *
 * ## `unavailable` is a first-class outcome, and it is not zero
 *
 * A currency the ECB does not list, or one whose most recent rate is older than
 * the lookback window, produces `{ source: 'unavailable' }` with **no converted
 * amount at all**. The caller writes zeros into the fact's reporting columns to
 * keep them non-nullable, and the `conversion_source` flag is what carries the
 * meaning. Every read surface must render such a row as an explicit unconverted
 * remainder in its original currency — summing the zeros into a reporting total
 * is precisely the confident-zero failure this milestone exists to prevent
 * (docs snapshot 01 §12.3).
 */

/**
 * How many days back a rate may be taken from.
 *
 * The ECB publishes on banking days only, so a transaction on a Sunday has no
 * Sunday rate and the correct behaviour — the ECB's own guidance — is to use the
 * last published day. Seven days covers a weekend plus the longest ordinary
 * European holiday run (Christmas/New Year, Easter) without ever reaching back
 * into a genuinely different rate regime.
 *
 * It is a bound rather than "use whatever is newest", because an unbounded
 * fallback would silently convert a transaction from last March at a rate the
 * table happens to still hold, and report it as fresh.
 */
export const CURRENCY_RATE_LOOKBACK_DAYS = 7

/**
 * **Provider-reported** minor-unit exponents that are not 2 — the Stripe
 * convention, deliberately not ISO-4217.
 *
 * This table answers one question: *given an integer `amount` as the provider
 * reported it, how many decimal places does it carry?* That is not always what
 * ISO-4217 says, and the two places they disagree are exactly the two that would
 * be off by a factor of a hundred:
 *
 * - **ISK** is zero-decimal in ISO-4217. Stripe reports it with **two** decimals
 *   for backward compatibility — its currency documentation lists ISK under the
 *   currencies that "must be provided with two decimal places", so `amount: 500`
 *   is 5 ISK, not 500. It is therefore **absent from this table** and falls to
 *   the default of 2.
 * - **UGX** is likewise zero-decimal in ISO-4217 and two-decimal at Stripe (the
 *   same backward-compatibility note, with the added rule that amounts must be
 *   evenly divisible by 100). Also absent, also 2.
 * - **MGA** is listed by Stripe among its zero-decimal currencies, so `amount:
 *   500` is 500 ariary. ISO-4217 gives it exponent 2 over a 1/5 subunit that
 *   nothing prices in. Stripe wins here, because Stripe is what produced the
 *   integer.
 *
 * When a second provider lands (D1's adapter framework), a provider that reports
 * differently needs its own table rather than an edit to this one — the exponent
 * is a property of the *payload*, not of the currency, which is the whole reason
 * this comment is here instead of a link to ISO-4217.
 *
 * Listed as exceptions rather than as a full table because two is the
 * overwhelming default, and an unknown code correctly gets 2. The zero-exponent
 * entries are what matter in practice: JPY is a top-five traded currency, and
 * reading `amount_minor: 1000` as ten yen rather than a thousand is a
 * hundredfold error that looks entirely plausible on a dashboard.
 */
const MINOR_UNIT_EXPONENTS: Readonly<Record<string, number>> = {
  // Zero-decimal per Stripe's own list. ISK and UGX are NOT here — see above.
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  MGA: 0,
  PYG: 0,
  RWF: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  // Three-decimal (ISO-4217; no provider disagreement known).
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  // Four-decimal units of account. Neither is a settlement currency and neither
  // is expected from a payment provider; kept so an amount that somehow arrives
  // in one is not silently read as cents.
  CLF: 4,
  UYW: 4,
}

/**
 * The minor-unit exponent for a currency code as a provider reports it.
 * Unknown codes get 2, which is what every major currency uses.
 */
export function minorUnitExponent(currency: string): number {
  return MINOR_UNIT_EXPONENTS[currency.trim().toUpperCase()] ?? 2
}

/** A rate as an exact rational `numerator / 10^scale`. */
export interface DecimalRate {
  readonly numerator: bigint
  readonly scale: number
}

/**
 * Parse an exact decimal string into a BigInt rational.
 *
 * Accepts what Postgres `numeric` renders — `1`, `1.1005`, `0.0000123`, and a
 * leading `+`. Rejects anything else, including exponent notation: `numeric`
 * never renders it, and accepting a form we have not seen would mean guessing
 * what the provider meant.
 *
 * Returns null rather than throwing, because the caller's answer to an
 * unparseable rate is the same as its answer to a missing one — `unavailable`,
 * which is visible — and a throw inside a projection loop would be an outage.
 */
export function parseDecimalRate(value: string): DecimalRate | null {
  const trimmed = value.trim()
  const match = /^\+?(\d+)(?:\.(\d+))?$/.exec(trimmed)
  if (!match) return null
  const whole = match[1] ?? ''
  const fraction = match[2] ?? ''
  const digits = `${whole}${fraction}`
  // Guard against a pathological `numeric` with thousands of digits: it cannot
  // come from the ECB, and unbounded BigInt exponentiation on a hostile value is
  // the one way this pure module could become slow.
  if (digits.length > 40) return null
  const numerator = BigInt(digits)
  if (numerator === 0n) return null
  return { numerator, scale: fraction.length }
}

/**
 * Round a rational `numerator / denominator` half-to-even, exactly.
 *
 * Exported because the rounding rule is the part of this module a test has to be
 * able to pin directly: the ties are what separate half-even from half-up, and
 * they are rare enough in random data that only a targeted test finds a
 * regression.
 *
 * Both arguments must be positive; amounts in this codebase are magnitudes
 * (D5 stores the sign as a function of `object_kind`), and a negative branch
 * would be untested code guarding an input that cannot occur.
 */
export function divideRoundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('denominator must be positive')
  if (numerator < 0n) throw new Error('numerator must be non-negative')

  const quotient = numerator / denominator
  const remainder = numerator - quotient * denominator
  if (remainder === 0n) return quotient

  const twice = remainder * 2n
  if (twice > denominator) return quotient + 1n
  if (twice < denominator) return quotient
  // Exactly half: round to the even neighbour.
  return quotient % 2n === 0n ? quotient : quotient + 1n
}

export type ConversionSource = 'ecb' | 'none' | 'unavailable'

export interface CurrencyConversionInput {
  /** Lowercase or uppercase ISO-4217 — compared case-insensitively. */
  readonly fromCurrency: string
  readonly toCurrency: string
  /** The rate for the source currency, or null when the table has none in the
   * lookback window. Ignored when the two currencies are equal. */
  readonly fromRate: RateAtDate | null
  readonly toRate: RateAtDate | null
}

export interface RateAtDate {
  /** The exact decimal string from `currency_rates.rate_per_eur`. */
  readonly ratePerEur: string
  /** The ECB banking day it was published for, `YYYY-MM-DD`. */
  readonly rateDate: string
}

export type CurrencyConversionPlan =
  | {
      readonly source: 'none'
      /** Exactly 1. Recorded so the fact's `conversion_rate` column is never a
       * placeholder a reader has to interpret. */
      readonly rate: number
      readonly rateDate: null
    }
  | {
      readonly source: 'ecb'
      /** Reporting units per one source unit. **Diagnostic only** — the
       * conversion itself is done in integers and nothing may recompute an
       * amount from this. */
      readonly rate: number
      /** The older of the two rates' dates: a conversion is only as fresh as its
       * staler half, and reporting the newer one would overstate it. */
      readonly rateDate: string
      readonly fromRate: DecimalRate
      readonly toRate: DecimalRate
    }
  | {
      readonly source: 'unavailable'
      readonly rate: 0
      readonly rateDate: null
      /** Which side could not be resolved. Categorized so the metric that counts
       * these can say whether one currency is missing everywhere or the whole
       * rate table has gone stale. */
      readonly reason: 'source_rate_missing' | 'reporting_rate_missing' | 'rate_unparseable'
    }

/**
 * Decide how a conversion should be performed, without performing it.
 *
 * Split from `convertMinorAmount` because a fact carries several amounts
 * (`gross`, `net`) that must all be converted under **the same rate** — deciding
 * once and applying twice is what guarantees that, whereas two independent
 * conversions could in principle disagree if the rate table moved between them.
 */
export function planCurrencyConversion(input: CurrencyConversionInput): CurrencyConversionPlan {
  const from = input.fromCurrency.trim().toUpperCase()
  const to = input.toCurrency.trim().toUpperCase()

  if (from === to) {
    // No arithmetic at all, not "multiply by 1.0". The reporting amounts are the
    // originals, byte for byte, and no rounding can enter.
    return { source: 'none', rate: 1, rateDate: null }
  }

  if (!input.fromRate) {
    return { source: 'unavailable', rate: 0, rateDate: null, reason: 'source_rate_missing' }
  }
  if (!input.toRate) {
    return { source: 'unavailable', rate: 0, rateDate: null, reason: 'reporting_rate_missing' }
  }

  const fromRate = parseDecimalRate(input.fromRate.ratePerEur)
  const toRate = parseDecimalRate(input.toRate.ratePerEur)
  if (!fromRate || !toRate) {
    return { source: 'unavailable', rate: 0, rateDate: null, reason: 'rate_unparseable' }
  }

  return {
    source: 'ecb',
    // Float, once, for the audit column only. Computed from the strings rather
    // than from the BigInts so it is the obvious value a human would expect to
    // see, and never read back by anything.
    rate: Number(input.toRate.ratePerEur) / Number(input.fromRate.ratePerEur),
    rateDate:
      input.fromRate.rateDate < input.toRate.rateDate
        ? input.fromRate.rateDate
        : input.toRate.rateDate,
    fromRate,
    toRate,
  }
}

/**
 * Apply a planned conversion to one integer minor-unit amount.
 *
 * Returns null exactly when the plan is `unavailable`, so a caller cannot
 * accidentally treat "we could not convert" as "zero" — it has to write the
 * zeros itself, beside the flag that says what they mean.
 */
export function convertMinorAmount(input: {
  readonly amountMinor: number
  readonly fromCurrency: string
  readonly toCurrency: string
  readonly conversion: CurrencyConversionPlan
}): number | null {
  if (input.conversion.source === 'unavailable') return null
  if (input.conversion.source === 'none') return input.amountMinor
  if (input.amountMinor === 0) return 0

  const amount = BigInt(input.amountMinor)
  const negative = amount < 0n
  const magnitude = negative ? -amount : amount

  const fromExponent = minorUnitExponent(input.fromCurrency)
  const toExponent = minorUnitExponent(input.toCurrency)
  const { fromRate, toRate } = input.conversion

  //   A · nR · 10^(dC + e(R))
  //   ───────────────────────
  //   nC · 10^(dR + e(C))
  const numerator = magnitude * toRate.numerator * 10n ** BigInt(fromRate.scale + toExponent)
  const denominator = fromRate.numerator * 10n ** BigInt(toRate.scale + fromExponent)

  const converted = divideRoundHalfEven(numerator, denominator)
  const signed = negative ? -converted : converted
  return Number(signed)
}

/**
 * Is a rate fresh enough to convert a transaction on `occurredDate`?
 *
 * Both arguments are `YYYY-MM-DD`. String comparison rather than `Date` maths
 * for the bound's *ordering*, and a real day count for its *width*: the ECB's
 * `rate_date` is a calendar day with no time and no zone, and turning it into an
 * instant to subtract from would introduce a timezone question that does not
 * exist in the data.
 */
export function isRateWithinLookback(
  rateDate: string,
  occurredDate: string,
  lookbackDays: number = CURRENCY_RATE_LOOKBACK_DAYS,
): boolean {
  if (rateDate > occurredDate) return false
  const earliest = shiftUtcDate(occurredDate, -lookbackDays)
  return rateDate >= earliest
}

/** `YYYY-MM-DD` shifted by whole days, in UTC. */
export function shiftUtcDate(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00.000Z`)
  at.setUTCDate(at.getUTCDate() + days)
  return at.toISOString().slice(0, 10)
}

/** The UTC calendar date of an instant, `YYYY-MM-DD` — the date a rate lookup
 * is anchored on. The transaction's own `occurred_at`, in UTC, because
 * `currency_rates.rate_date` is a UTC banking day and a site's display timezone
 * must not decide which rate a fact was converted at. */
export function conversionDateOf(occurredAt: Date | string): string {
  const at = occurredAt instanceof Date ? occurredAt : new Date(occurredAt)
  return at.toISOString().slice(0, 10)
}
