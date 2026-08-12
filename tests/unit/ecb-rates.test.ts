import {
  ECB_BASE_CURRENCY,
  ECB_MAX_DOCUMENT_BYTES,
  ecbRatesWithBase,
  parseEcbDailyRates,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'
import { ecbDocument } from '../support/revenue-fixtures.ts'

/**
 * The ECB daily reference-rate parser (ADR-0033, D2c).
 *
 * The parser is a bounded regex over a fixed document rather than an XML
 * dependency, so the tests carry the burden the dependency would have: they
 * prove the bounds are real, that a malformed document is a typed failure rather
 * than a partial read, and — the one that actually protects money — that a rate
 * never becomes a JavaScript number on the way to the database.
 */

const REAL_SHAPE = ecbDocument('2026-07-31', [
  ['USD', '1.0876'],
  ['JPY', '163.24'],
  ['GBP', '0.84355'],
  ['TRY', '44.9812'],
])

describe('parseEcbDailyRates — the published document', () => {
  it('reads the banking day and every listed rate', () => {
    const outcome = parseEcbDailyRates(REAL_SHAPE)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.rates.rateDate).toBe('2026-07-31')
    expect(outcome.rates.rates).toEqual([
      { currency: 'USD', ratePerEur: '1.0876' },
      { currency: 'JPY', ratePerEur: '163.24' },
      { currency: 'GBP', ratePerEur: '0.84355' },
      { currency: 'TRY', ratePerEur: '44.9812' },
    ])
  })

  it('keeps the rate as an exact decimal STRING', () => {
    // The whole reason this matters: a rate is one multiplication away from
    // money, `0.84355` has no exact float representation, and CP3 converts in
    // integer minor units against the value this parser hands over. A parser
    // that returned a number would lose the guarantee here, silently, and every
    // downstream test would still pass.
    const outcome = parseEcbDailyRates(REAL_SHAPE)
    expect(outcome.ok && typeof outcome.rates.rates[2]?.ratePerEur).toBe('string')
    expect(outcome.ok && outcome.rates.rates[2]?.ratePerEur).toBe('0.84355')
  })

  it('accepts double-quoted attributes as well as the ECB’s single quotes', () => {
    const doubled = REAL_SHAPE.replace(/'/gu, '"')
    const outcome = parseEcbDailyRates(doubled)
    expect(outcome.ok && outcome.rates.rates).toHaveLength(4)
  })

  it('is not stateful across calls', () => {
    // The rate pattern is `g`-flagged and lives at module scope; a `while (exec)`
    // loop would leak `lastIndex` between calls and make every second parse
    // return a partial document — a bug that only shows up on the second day.
    const first = parseEcbDailyRates(REAL_SHAPE)
    const second = parseEcbDailyRates(REAL_SHAPE)
    expect(first).toEqual(second)
  })
})

describe('parseEcbDailyRates — malformed input', () => {
  it('reports a missing date rather than inventing today', () => {
    // Stamping our own date on somebody else's rates would make a stale document
    // look fresh forever, which is precisely the lie D2c's `conversion_source`
    // metadata exists to prevent.
    const noDate = REAL_SHAPE.replace(/<Cube time='[^']+'>/u, '<Cube>')
    expect(parseEcbDailyRates(noDate)).toEqual({ ok: false, reason: 'no_date' })
  })

  it('rejects a date that is well-formed but not a real day', () => {
    expect(parseEcbDailyRates(ecbDocument('2026-02-30', [['USD', '1.1']]))).toEqual({
      ok: false,
      reason: 'no_date',
    })
  })

  it('reports an empty rate list rather than upserting nothing quietly', () => {
    expect(parseEcbDailyRates(ecbDocument('2026-07-31', []))).toEqual({
      ok: false,
      reason: 'no_rates',
    })
  })

  it('drops individual malformed rows and keeps the good ones', () => {
    const mixed = ecbDocument('2026-07-31', [
      ['USD', '1.0876'],
      // Not three letters.
      ['US', '1.0'],
      // Not a plain positive decimal — an exponent, a sign, a word.
      ['CHF', '1e3'],
      ['NOK', '-11.4'],
      ['SEK', 'n/a'],
      // Zero would convert every amount in that currency to nothing.
      ['DKK', '0'],
      ['PLN', '4.2851'],
    ])
    const outcome = parseEcbDailyRates(mixed)
    expect(outcome.ok && outcome.rates.rates.map((rate) => rate.currency)).toEqual(['USD', 'PLN'])
  })

  it('keeps the first of a duplicated currency, so corruption position does not decide', () => {
    const duplicated = ecbDocument('2026-07-31', [
      ['USD', '1.0876'],
      ['USD', '9.9999'],
    ])
    const outcome = parseEcbDailyRates(duplicated)
    expect(outcome.ok && outcome.rates.rates).toEqual([{ currency: 'USD', ratePerEur: '1.0876' }])
  })

  it('refuses a document past the size cap before matching anything', () => {
    const huge = `<Cube time='2026-07-31'>${'x'.repeat(ECB_MAX_DOCUMENT_BYTES)}`
    expect(parseEcbDailyRates(huge)).toEqual({ ok: false, reason: 'too_large' })
  })

  it('caps the number of accepted rows', () => {
    const many = ecbDocument(
      '2026-07-31',
      Array.from(
        { length: 300 },
        (_, index) =>
          [
            // Distinct three-letter codes, so the duplicate rule does not do the
            // capping for us and the cap itself is what is under test.
            `${String.fromCharCode(65 + (index % 26))}${String.fromCharCode(65 + (Math.floor(index / 26) % 26))}${String.fromCharCode(65 + (Math.floor(index / 676) % 26))}`,
            '1.5',
          ] as const,
      ),
    )
    const outcome = parseEcbDailyRates(many)
    expect(outcome.ok && outcome.rates.rates.length).toBeLessThanOrEqual(64)
  })

  it('returns a failure, never throws, on arbitrary rubbish', () => {
    for (const rubbish of ['', '<html><body>503</body></html>', '{"json":true}', '<Cube']) {
      expect(() => parseEcbDailyRates(rubbish)).not.toThrow()
      expect(parseEcbDailyRates(rubbish).ok).toBe(false)
    }
  })
})

describe('ecbRatesWithBase', () => {
  it('prepends EUR = 1 so a EUR reporting currency needs no special case', () => {
    const parsed = parseEcbDailyRates(REAL_SHAPE)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const withBase = ecbRatesWithBase(parsed.rates)
    expect(withBase.rates[0]).toEqual({ currency: ECB_BASE_CURRENCY, ratePerEur: '1' })
    expect(withBase.rates).toHaveLength(parsed.rates.rates.length + 1)
    expect(withBase.rateDate).toBe(parsed.rates.rateDate)
  })

  it('does not duplicate EUR if the source ever starts publishing it', () => {
    const outcome = parseEcbDailyRates(
      ecbDocument('2026-07-31', [
        ['EUR', '1'],
        ['USD', '1.1'],
      ]),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(ecbRatesWithBase(outcome.rates).rates).toHaveLength(2)
  })
})
