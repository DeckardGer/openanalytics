import { ecbRatesWithBase, parseEcbDailyRates } from '@openanalytics/domain'
import type { Logger, Metrics } from '@openanalytics/observability'
import {
  readLatestCurrencyRateDate,
  upsertCurrencyRates,
  type Database,
} from '@openanalytics/postgres'
import { WORKER_METRICS } from '../ingest/metrics.ts'

/**
 * The ECB reference-rate loop (ADR-0033, D2c).
 *
 * Fetch `eurofxref-daily.xml`, parse it, upsert it. That is the whole job, and
 * everything interesting about it is what it refuses to do:
 *
 * - **It never crashes the worker.** A failed fetch, an unreachable ECB, a
 *   document whose shape changed — each is a log line, a metric and a return.
 *   This loop shares a process with batch ingest and email delivery, and a
 *   European bank's web server having a bad afternoon must not stop either.
 * - **It never invents a rate.** A currency the ECB does not list gets no row,
 *   and CP3 renders it `conversion_source = 'unavailable'` — visible, never
 *   dropped, never silently zero (D2c). The one row this loop adds that the ECB
 *   did not publish is `EUR = 1`, which is exact by definition rather than by
 *   measurement, and it exists so a reporting currency of EUR is found by the
 *   same `WHERE currency = $1` as every other.
 * - **It does not care about weekends.** The ECB republishes the last banking
 *   day's file on Saturdays, Sundays and holidays, and the upsert is keyed on
 *   the ECB's own `rate_date` — so those ticks cost one request and write
 *   nothing new. There is no calendar in this file, and there should not be:
 *   a holiday table is a second source of truth about which days the ECB
 *   publishes, and the ECB already tells us in the document.
 *
 * Staleness is deliberately **not** an error here. Whether a rate is too old to
 * convert with is a question about a transaction, and CP3 answers it per
 * transaction in the conversion metadata; this loop's job is to keep the table
 * as current as the source allows and to say loudly when it cannot.
 */

export const ECB_DAILY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'

/** Generous: this is a public web server, nothing waits on the answer, and the
 * next tick is hours away. Still bounded — a hung socket in a `setInterval`
 * callback is a leak that compounds. */
const FETCH_TIMEOUT_MS = 20_000

const DEFAULT_INTERVAL_MS = 6 * 3_600_000

export interface CurrencyRatesDeps {
  readonly db: Database
  readonly logger: Logger
  readonly metrics: Metrics
  readonly fetchImpl?: typeof fetch
  readonly url?: string
  readonly intervalMs?: number
}

export type CurrencyRatesResult =
  | { readonly status: 'ok'; readonly rateDate: string; readonly written: number }
  | { readonly status: 'unavailable'; readonly detail: string }
  | { readonly status: 'unparseable'; readonly detail: string }

/** One refresh. Extracted so tests drive it directly rather than through a timer. */
export async function refreshCurrencyRatesOnce(
  deps: CurrencyRatesDeps,
): Promise<CurrencyRatesResult> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const url = deps.url ?? ECB_DAILY_URL

  let body: string
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) {
      return fail(deps, {
        status: 'unavailable',
        detail: `ecb responded ${String(response.status)}`,
      })
    }
    body = await response.text()
  } catch {
    // DNS, TLS, a reset socket or our own deadline. Categorized identically
    // because the remedy is identical: wait for the next tick.
    return fail(deps, { status: 'unavailable', detail: 'ecb request did not complete' })
  }

  const parsed = parseEcbDailyRates(body)
  if (!parsed.ok) {
    // Worth its own category and its own alarm. `unavailable` is the ECB having
    // a bad day; `unparseable` is a document whose *shape* changed under a
    // parser that would otherwise keep reporting stale rates as fine.
    return fail(deps, { status: 'unparseable', detail: parsed.reason })
  }

  const rates = ecbRatesWithBase(parsed.rates)
  const written = await upsertCurrencyRates(deps.db, { rates })

  deps.metrics.increment(WORKER_METRICS.revenueCurrencyFetch, { status: 'ok' })
  deps.metrics.gauge(WORKER_METRICS.revenueCurrencyRates, written.written, {})
  deps.logger.info('currency_rates_refreshed', {
    rate_date: rates.rateDate,
    currencies: written.written,
  })
  return { status: 'ok', rateDate: rates.rateDate, written: written.written }
}

function fail(
  deps: CurrencyRatesDeps,
  result: Exclude<CurrencyRatesResult, { status: 'ok' }>,
): CurrencyRatesResult {
  deps.metrics.increment(WORKER_METRICS.revenueCurrencyFetch, { status: result.status })
  deps.logger.warn('currency_rates_refresh_failed', {
    status: result.status,
    detail: result.detail,
    // Retryable in every case: the next tick tries again, and the table keeps
    // serving whatever it already holds. A stale rate is CP3's `conversion`
    // metadata problem, not a reason to stop.
    retryable: true,
  })
  return result
}

export interface CurrencyRatesLoop {
  stop(): Promise<void>
}

/**
 * The daily loop, in the `email-drain.ts` shape.
 *
 * It fires **once at startup** as well as on the interval, and that is not
 * cosmetic: the interval is measured in hours, so a worker that restarted would
 * otherwise run with whatever the table held for up to a full period — and a
 * fresh deployment against an empty table would have no rates at all until the
 * first tick, which is exactly when somebody is watching to see whether revenue
 * works.
 */
export function startCurrencyRates(deps: CurrencyRatesDeps): CurrencyRatesLoop {
  let running = false
  let stopped = false

  const tick = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      await refreshCurrencyRatesOnce(deps)
    } catch (err) {
      deps.logger.error('currency_rates_tick_failed', { err, retryable: true })
    } finally {
      running = false
    }
  }

  // Startup pass, deferred off the boot path so a slow ECB cannot delay the
  // health endpoint binding.
  setImmediate(() => void primeThenTick(deps, tick))

  const timer = setInterval(() => void tick(), deps.intervalMs ?? DEFAULT_INTERVAL_MS)
  timer.unref()

  return {
    async stop() {
      stopped = true
      clearInterval(timer)
      while (running) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    },
  }
}

/**
 * Report what the table already holds, then refresh.
 *
 * The log line before the fetch is the operationally useful half: it is how an
 * operator restarting the worker learns whether the rate table was already
 * current, which is otherwise only discoverable by querying Postgres by hand at
 * the moment somebody is debugging a conversion.
 */
async function primeThenTick(deps: CurrencyRatesDeps, tick: () => Promise<void>): Promise<void> {
  try {
    const latest = await readLatestCurrencyRateDate(deps.db)
    deps.logger.info('currency_rates_started', { latest_rate_date: latest })
  } catch (err) {
    deps.logger.warn('currency_rates_state_unreadable', { err, retryable: true })
  }
  await tick()
}
