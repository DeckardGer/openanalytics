/**
 * The ECB daily reference rates parser (ADR-0033, D2c).
 *
 * `https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml` — about
 * thirty-one currencies, EUR base, published free with no API key and no terms
 * that need a contract. D2c chose it over a paid FX source on coverage grounds
 * that are stated honestly rather than hidden: a currency the ECB does not list
 * keeps its original amounts and gets `conversion_source = 'unavailable'`,
 * which is visible in the read surface and never a silent zero.
 *
 * ## Why a regex and not a parser dependency
 *
 * The document is a flat list of self-closing elements with two attributes:
 *
 * ```xml
 * <Cube>
 *   <Cube time='2026-07-31'>
 *     <Cube currency='USD' rate='1.0876'/>
 *     <Cube currency='JPY' rate='163.24'/>
 * ```
 *
 * Adding an XML dependency to `packages/domain` — the package the boundary rules
 * keep free of runtime dependencies — to read two attributes off a fixed
 * document would be a poor trade, and a general XML parser brings an entity-
 * expansion surface this input does not need. What makes the regex safe here is
 * that it is *bounded on every axis*: the input is size-capped before matching,
 * the number of accepted rows is capped, the currency must be exactly three
 * uppercase letters, and the rate must be a plain positive decimal. Anything
 * else is dropped, and a document that yields no rows is a failure the caller
 * reports rather than an empty upsert.
 *
 * ## Why rates stay strings
 *
 * `rate_per_eur` is `numeric` in Postgres and the value never becomes a
 * JavaScript `number` on the way there. Money is not float arithmetic (03 §6.5,
 * `money.ts` since M0), and a rate is one multiplication away from money — the
 * string goes to the database, the database stores exact decimal, and CP3 does
 * the conversion in integer minor units.
 */

/** One published rate. `ratePerEur` is the exact decimal string as published. */
export interface EcbRate {
  /** ISO-4217, uppercase. */
  readonly currency: string
  /** Units of `currency` per 1 EUR, as an exact decimal string. */
  readonly ratePerEur: string
}

export interface EcbDailyRates {
  /** The banking day the ECB stamped, `YYYY-MM-DD`. */
  readonly rateDate: string
  readonly rates: readonly EcbRate[]
}

export type EcbParseFailure = 'too_large' | 'no_date' | 'no_rates'

export type EcbParseOutcome =
  | { readonly ok: true; readonly rates: EcbDailyRates }
  | { readonly ok: false; readonly reason: EcbParseFailure }

/**
 * The document is ~4 KiB. A megabyte is three orders of magnitude of headroom
 * and still bounds the regex work to something a worker tick can absorb.
 */
export const ECB_MAX_DOCUMENT_BYTES = 1_048_576

/** The ECB publishes about 31 currencies. Sixty-four bounds a malformed or
 * hostile document without ever being reached by a real one. */
export const ECB_MAX_RATES = 64

const DATE_PATTERN = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/u
const RATE_PATTERN = /<Cube\s+currency=['"]([A-Za-z]{3})['"]\s+rate=['"]([^'"]{1,32})['"]/gu
const CURRENCY_PATTERN = /^[A-Z]{3}$/u
/** A plain positive decimal: no sign, no exponent, at least one digit. `0` and
 * anything that reads as zero are rejected — a zero rate would silently convert
 * every amount in that currency to nothing, which is the D2c failure mode. */
const RATE_VALUE_PATTERN = /^(?:\d{1,12})(?:\.\d{1,10})?$/u

/**
 * The EUR row.
 *
 * Stored explicitly rather than special-cased in every lookup: a reporting
 * currency of EUR must find a row like any other, and a `WHERE currency = $1`
 * that has to be a `CASE` for one value is a branch every future reader has to
 * remember. The rate is exact by definition, not by measurement.
 */
export const ECB_BASE_CURRENCY = 'EUR'
export const ECB_BASE_RATE = '1'

/**
 * Parse the daily file. Never throws — a malformed document is an outcome the
 * loop logs and retries next tick, not a crash in a worker that also delivers
 * email and ingests events.
 */
export function parseEcbDailyRates(xml: string): EcbParseOutcome {
  if (xml.length > ECB_MAX_DOCUMENT_BYTES) return { ok: false, reason: 'too_large' }

  const date = DATE_PATTERN.exec(xml)
  const rateDate = date?.[1]
  if (rateDate === undefined || !isCalendarDate(rateDate)) return { ok: false, reason: 'no_date' }

  const rates: EcbRate[] = []
  const seen = new Set<string>()
  // `matchAll` rather than a `while (exec)` loop: the pattern is `g`-flagged and
  // module-level, so a stateful `lastIndex` would leak between calls.
  for (const match of xml.matchAll(RATE_PATTERN)) {
    if (rates.length >= ECB_MAX_RATES) break
    const currency = (match[1] ?? '').toUpperCase()
    const value = (match[2] ?? '').trim()
    if (!CURRENCY_PATTERN.test(currency)) continue
    if (!RATE_VALUE_PATTERN.test(value)) continue
    if (Number(value) <= 0) continue
    // A duplicate currency in one document is a malformed document; the first
    // occurrence wins rather than the last, so the result does not depend on
    // where in the file the corruption is.
    if (seen.has(currency)) continue
    seen.add(currency)
    rates.push({ currency, ratePerEur: value })
  }

  if (rates.length === 0) return { ok: false, reason: 'no_rates' }
  return { ok: true, rates: { rateDate, rates } }
}

/**
 * The published rates plus the EUR identity row, ready to upsert.
 *
 * Separate from the parser so the parser stays a faithful reading of what the
 * ECB actually published — a test that asserts "the file contained these
 * currencies" should not have to know about a row we add ourselves.
 */
export function ecbRatesWithBase(parsed: EcbDailyRates): EcbDailyRates {
  if (parsed.rates.some((rate) => rate.currency === ECB_BASE_CURRENCY)) return parsed
  return {
    rateDate: parsed.rateDate,
    rates: [{ currency: ECB_BASE_CURRENCY, ratePerEur: ECB_BASE_RATE }, ...parsed.rates],
  }
}

/** `YYYY-MM-DD` that names a real day — a regex alone accepts `2026-13-40`. */
function isCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}
