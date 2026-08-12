import type * as PostgresModule from '@openanalytics/postgres'
import type { Database } from '@openanalytics/postgres'
import { NOOP_METRICS } from '@openanalytics/observability'
import { createCapturedLogger } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ecbDocument } from '../support/revenue-fixtures.ts'

/**
 * The ECB rate loop (ADR-0033, D2c).
 *
 * The parser has its own suite; what lives only here is the loop's **failure
 * categorization**, which is the operational half. Three outcomes have to stay
 * distinguishable, because the operator's next action differs for each:
 *
 * - `ok` — rates written, `rate_date` from the ECB's own stamp;
 * - `unavailable` — the ECB had a bad day. Wait for the next tick;
 * - `unparseable` — the *document's shape changed* under a parser that would
 *   otherwise keep reporting stale rates as fine. That is a code change, not a
 *   wait, and folding it into `unavailable` would hide it behind an outage
 *   alert that resolves on its own.
 *
 * And the loop must never throw: it shares a process with batch ingest and email
 * delivery, and a European bank's web server must not be able to stop either.
 */

const written: { rateDate: string; currencies: string[] }[] = []
/** Every rate row as it reached the repository, so the 'never a float' assertion
 * can be made at the boundary the loop actually crosses. */
const rawRates: { currency: string; ratePerEur: unknown }[] = []

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    upsertCurrencyRates: async (
      _db: unknown,
      input: { rates: { rateDate: string; rates: { currency: string; ratePerEur: unknown }[] } },
    ) => {
      written.push({
        rateDate: input.rates.rateDate,
        currencies: input.rates.rates.map((rate) => rate.currency),
      })
      rawRates.push(...input.rates.rates)
      return { written: input.rates.rates.length }
    },
    readLatestCurrencyRateDate: async () => '2026-07-30',
  }
})

const { refreshCurrencyRatesOnce } = await import('../../apps/worker/src/revenue/currency-rates.ts')

const db = {} as Database

function deps(fetchImpl: typeof fetch) {
  const captured = createCapturedLogger()
  return {
    deps: { db, logger: captured.logger, metrics: NOOP_METRICS, fetchImpl },
    captured,
  }
}

const DOCUMENT = ecbDocument('2026-07-31', [
  ['USD', '1.0876'],
  ['GBP', '0.84355'],
])

beforeEach(() => {
  written.length = 0
  rawRates.length = 0
})

describe('refreshCurrencyRatesOnce', () => {
  it('writes the published rates plus the EUR identity row', async () => {
    // EUR = 1 is added by us so a EUR reporting currency is found by the same
    // lookup as every other, rather than by a `CASE` every future reader has to
    // remember.
    const { deps: d } = deps(async () => new Response(DOCUMENT, { status: 200 }))
    const result = await refreshCurrencyRatesOnce(d)

    expect(result).toMatchObject({ status: 'ok', rateDate: '2026-07-31', written: 3 })
    expect(written[0]?.currencies).toEqual(['EUR', 'USD', 'GBP'])
  })

  it('uses the ECB’s own rate_date rather than today', async () => {
    // Stamping our own date on somebody else's rates would make a stale document
    // look fresh forever.
    const { deps: d } = deps(
      async () => new Response(ecbDocument('2026-07-24', [['USD', '1.1']]), { status: 200 }),
    )
    const result = await refreshCurrencyRatesOnce(d)
    expect(result).toMatchObject({ status: 'ok', rateDate: '2026-07-24' })
  })

  it('categorizes a non-200 as unavailable and writes nothing', async () => {
    const { deps: d, captured } = deps(async () => new Response('nope', { status: 503 }))
    const result = await refreshCurrencyRatesOnce(d)
    expect(result).toMatchObject({ status: 'unavailable' })
    expect(written).toHaveLength(0)
    expect(captured.find('currency_rates_refresh_failed')[0]).toMatchObject({
      status: 'unavailable',
      retryable: true,
    })
  })

  it('categorizes a dead socket or a timeout as unavailable, never a throw', async () => {
    const { deps: d } = deps(async () => {
      await Promise.resolve()
      throw new DOMException('The operation was aborted.', 'TimeoutError')
    })
    await expect(refreshCurrencyRatesOnce(d)).resolves.toMatchObject({ status: 'unavailable' })
  })

  it('separates a changed document shape from an outage', async () => {
    // The alarm that matters: a parser that silently stopped matching would
    // otherwise look exactly like a bank with a slow afternoon, while the rate
    // table quietly went stale.
    const { deps: d, captured } = deps(
      async () => new Response('<html><body>maintenance</body></html>', { status: 200 }),
    )
    const result = await refreshCurrencyRatesOnce(d)
    expect(result).toMatchObject({ status: 'unparseable' })
    expect(written).toHaveLength(0)
    expect(captured.find('currency_rates_refresh_failed')[0]).toMatchObject({
      status: 'unparseable',
    })
  })

  it('treats a weekend republication as an ordinary idempotent write', async () => {
    // The ECB republishes the last banking day over a weekend. The upsert is
    // keyed on its `rate_date`, so those ticks cost one request and write
    // nothing new — there is deliberately no calendar in the loop.
    const { deps: d } = deps(async () => new Response(DOCUMENT, { status: 200 }))
    await refreshCurrencyRatesOnce(d)
    await refreshCurrencyRatesOnce(d)
    expect(written.map((entry) => entry.rateDate)).toEqual(['2026-07-31', '2026-07-31'])
  })

  it('hands the repository exact decimal strings, never numbers', async () => {
    // A rate is one multiplication away from money, and `0.84355` has no exact
    // float representation. The value that reaches `upsertCurrencyRates` is the
    // string the ECB published; this asserts it at the boundary the loop
    // actually crosses rather than inside the parser, which has its own suite.
    const { deps: d } = deps(async () => new Response(DOCUMENT, { status: 200 }))
    const original = await refreshCurrencyRatesOnce(d)
    expect(original.status).toBe('ok')
    expect(rawRates.every((rate) => typeof rate.ratePerEur === 'string')).toBe(true)
    expect(rawRates.map((rate) => rate.ratePerEur)).toContain('0.84355')
  })
})
