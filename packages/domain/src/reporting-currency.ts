/**
 * The site reporting-currency vocabulary (ADR-0033, D2c). Milestone 12
 * Checkpoint 5.
 *
 * `sites.reporting_currency` has existed since CP1 (Postgres 0033) with a CHECK
 * of `^[A-Z]{3}$` and a default of `USD`, and until CP5 nothing could write it.
 * A regexp is the right database constraint and the wrong API contract: `ZZZ`
 * passes it, and a site set to `ZZZ` gets `conversion_source = 'unavailable'` on
 * **every single transaction** — an entirely empty revenue dashboard produced by
 * a typo, with no error anywhere to explain it.
 *
 * So the writer validates against a list. Two tiers, because they mean different
 * things:
 *
 * - **`ECB_REFERENCE_CURRENCIES`** — what the daily ECB reference feed actually
 *   publishes (D2c's chosen source, EUR base, no API key). A site reporting in
 *   one of these can have every foreign transaction converted.
 * - **`ADDITIONAL_REPORTING_CURRENCIES`** — settlement currencies a provider
 *   commonly pays out in that the ECB does not publish. They are accepted
 *   because refusing a customer their own settlement currency would be worse
 *   than the consequence, but the consequence is real and named: every
 *   transaction in a *different* currency is an unconverted remainder until D2c's
 *   paid-FX follow-up lands. `isEcbConvertibleCurrency` is what lets the API say
 *   so at the moment of the change rather than leaving it to be discovered from
 *   an empty chart.
 *
 * Deliberately not the full ISO-4217 register. A closed list is the point: an
 * unknown code is a typo far more often than it is a currency this product is
 * about to support, and adding one is a one-line change with a test beside it.
 */

/**
 * The ECB daily reference set, plus EUR itself (the base, which the feed does
 * not quote against itself).
 *
 * HRK and RUB are deliberately absent: the ECB stopped publishing both (Croatia
 * joined the euro area, and the Russian rate was suspended), so a site set to
 * either would convert nothing. Their absence here is why the list is written
 * out rather than derived from whatever the last fetch happened to contain — a
 * derived list would silently shrink under a site's feet.
 */
export const ECB_REFERENCE_CURRENCIES: readonly string[] = [
  'EUR',
  'AUD',
  'BGN',
  'BRL',
  'CAD',
  'CHF',
  'CNY',
  'CZK',
  'DKK',
  'GBP',
  'HKD',
  'HUF',
  'IDR',
  'ILS',
  'INR',
  'ISK',
  'JPY',
  'KRW',
  'MXN',
  'MYR',
  'NOK',
  'NZD',
  'PHP',
  'PLN',
  'RON',
  'SEK',
  'SGD',
  'THB',
  'TRY',
  'USD',
  'ZAR',
]

/**
 * Provider settlement currencies outside the ECB feed.
 *
 * Accepted as a reporting currency, with the honest consequence recorded above:
 * until a full-coverage FX source is justified (D2c's follow-up), a site
 * reporting in one of these converts nothing that is not already in it.
 */
export const ADDITIONAL_REPORTING_CURRENCIES: readonly string[] = [
  'AED',
  'ARS',
  'CLP',
  'COP',
  'CRC',
  'DOP',
  'EGP',
  'GTQ',
  'KES',
  'MAD',
  'NGN',
  'PEN',
  'PKR',
  'QAR',
  'SAR',
  'TWD',
  'UAH',
  'UYU',
  'VND',
]

/** Every code `PATCH /v1/sites/{id}` accepts for `reporting_currency`, sorted. */
export const SUPPORTED_REPORTING_CURRENCIES: readonly string[] = [
  ...ECB_REFERENCE_CURRENCIES,
  ...ADDITIONAL_REPORTING_CURRENCIES,
].sort()

const SUPPORTED = new Set(SUPPORTED_REPORTING_CURRENCIES)
const ECB = new Set(ECB_REFERENCE_CURRENCIES)

/**
 * Normalizes a candidate reporting currency, or null.
 *
 * Uppercases and trims, because a customer typing `usd` means USD and the
 * Postgres CHECK is uppercase-only — rejecting the lowercase form would be a
 * validation error about a value we understood perfectly. Everything else is
 * refused: the code must be exactly three letters and must be on the list.
 */
export function normalizeReportingCurrency(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(normalized)) return null
  return SUPPORTED.has(normalized) ? normalized : null
}

/** Whether the ECB publishes a daily reference rate for this currency. */
export function isEcbConvertibleCurrency(code: string): boolean {
  return ECB.has(code.trim().toUpperCase())
}
