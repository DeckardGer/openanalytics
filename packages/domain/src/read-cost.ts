import { z } from 'zod'

/**
 * The two halves of the expensive-query gate (ADR-0043 D7).
 *
 * Plan item 4 asks for "quota/cache for expensive/all-time queries". The phrase
 * contains a trap and D7 named it before anything was built: **M16 adds no range
 * feature and does not open the public "All time"**. ADR-0039 D9 closed that
 * deliberately and closed it on shape — the anchor is
 * `min(created_at, first_event_at)`, exposing it publicly needs a public
 * site-identity read with its own privacy argument, and that is a decision, not a
 * chore. "All-time" here means *expensive*, not *a new interval*. A private
 * caller asking for a wide range is asking for a range it could already ask for
 * as a dashboard user.
 *
 * What the query gateway makes possible bounds what can be built. It reports
 * elapsed time and no ClickHouse row or byte counts, so cost is knowable **after**
 * a query and only guessable **before** it. Hence two mechanisms rather than one
 * pretend cost model:
 *
 * - **Before — a declared-range ceiling.** The span between `from` and `to`, in
 *   the request and free to judge. Over it is `RANGE_TOO_LARGE`, a refusal a
 *   caller can act on by narrowing.
 * - **After — a measured budget.** Wall-clock milliseconds charged per credential
 *   per rolling day. Over budget is `RATE_LIMITED` with `Retry-After`, the status
 *   a caller already handles, rather than a new error class for the same recovery.
 *
 * **No new cache.** The query gateway's `cache_epoch` already keys every read,
 * and a second cache in front of a surface that reuses the dashboard's exact
 * service calls would be a second thing to invalidate on a `config_version` bump.
 * Plan item 4's "cache" is read as the cache that already exists.
 */

export const readCostConfigSchema = z.object({
  /**
   * The widest span a single `/v1/read` request may declare, in days.
   *
   * **Provisional until CP-tools measures**, exactly like the OAuth rate limit
   * beside it: the number that belongs here is the one where a real query starts
   * costing real time, and that is an observation rather than a preference. 400
   * days is set as a ceiling wide enough to be no constraint on any ordinary
   * question — a year plus a comparison period — while still refusing the
   * accidental `from=1970`, which is the request this gate exists for.
   */
  READ_MAX_RANGE_DAYS: z.coerce.number().int().min(1).max(3650).default(400),
  /**
   * The measured budget, in milliseconds of query time per credential per
   * rolling day.
   *
   * Also provisional. It is deliberately generous relative to the range ceiling:
   * the ceiling is the fence a mistake hits, and this is the one a *pattern*
   * hits — a client looping wide queries all day rather than asking one wide
   * question once. Set to zero to disable the ledger entirely, which is what a
   * deployment with no ClickHouse pressure should do rather than setting a number
   * it has not measured.
   */
  READ_DAILY_COST_BUDGET_MS: z.coerce.number().int().min(0).max(86_400_000).default(600_000),
})

export type ReadCostConfig = z.infer<typeof readCostConfigSchema>

export function loadReadCostConfig(
  source: Record<string, string | undefined> = process.env,
): ReadCostConfig {
  return readCostConfigSchema.parse(source)
}

/** Milliseconds in a day, for the range arithmetic below. */
const DAY_MS = 24 * 60 * 60 * 1000

export interface RangeVerdict {
  readonly allowed: boolean
  /** The span asked for, in whole days rounded up — what the refusal reports. */
  readonly requestedDays: number
  readonly maxDays: number
}

/**
 * Is this declared range within the ceiling?
 *
 * Judged on `to - from` and nothing else. It costs one subtraction, it happens
 * before any query, and it is the only thing about a request's cost that can
 * honestly be known in advance — which is why the *other* half of this gate
 * measures rather than predicts.
 *
 * An inverted or empty range is **not** this function's refusal: `parseRange`
 * already rejects those with `VALIDATION_FAILED`, and answering
 * `RANGE_TOO_LARGE` to `to < from` would name the wrong problem. A zero-length
 * span is therefore allowed here and refused there.
 */
export function checkDeclaredRange(input: {
  readonly from: Date
  readonly to: Date
  readonly maxDays: number
}): RangeVerdict {
  const spanMs = Math.max(0, input.to.getTime() - input.from.getTime())
  const requestedDays = Math.ceil(spanMs / DAY_MS)
  return {
    allowed: requestedDays <= input.maxDays,
    requestedDays,
    maxDays: input.maxDays,
  }
}

/**
 * How long a caller over budget should wait, in seconds.
 *
 * The ledger is a rolling 24-hour window over hourly buckets, so the earliest
 * moment any budget frees up is when the oldest bucket in the window ages out —
 * at most one hour away, and usually less. Reporting the *whole* window would be
 * true only if every millisecond had been spent in one instant, and telling a
 * client to come back tomorrow when it could resume in twenty minutes is the
 * kind of over-honest refusal that makes people write retry loops that ignore
 * `Retry-After`.
 */
export function costRetryAfterSeconds(now: Date): number {
  const msIntoHour = now.getTime() % (60 * 60 * 1000)
  return Math.max(1, Math.ceil((60 * 60 * 1000 - msIntoHour) / 1000))
}
