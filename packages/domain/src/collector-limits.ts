import type { Policy } from './policy.ts'

/**
 * Collector rate limits, the per-site daily safety ceiling, the D-103 hard quota
 * and the limiter-outage ladder — all as pure decisions over counters the caller
 * has already read.
 *
 * Docs snapshot 05, G-005 (closed 22 July 2026) and D-103. The values live in
 * `Policy`; this module is only the arithmetic over them, so that changing a
 * limit is an edit in one file and enforcing it is an edit in none.
 *
 * Nothing here reads a clock or a store. The collector fetches the counters —
 * from the `realtime-cache` Valkey, never from Postgres in the hot path (D-103)
 * — and asks these functions what the counters mean. That split is what makes
 * the ceilings testable without infrastructure and what keeps a limiter outage
 * from changing the meaning of a limit, only whether it is checked.
 */

/** Counter scopes G-005 defines, tightest first. */
export const RATE_LIMIT_SCOPES = ['ip_site', 'identity', 'site'] as const
export type RateLimitScope = (typeof RATE_LIMIT_SCOPES)[number]

export interface RateLimitCounts {
  /** Events this IP has sent to this site in the current minute. */
  readonly ipSite: number
  /** Events this anonymous identity has sent in the current minute. */
  readonly identity: number
  /** Events this whole site has taken in the current minute. */
  readonly site: number
}

export type RateLimitDecision =
  | { readonly limited: false }
  | {
      readonly limited: true
      readonly scope: RateLimitScope
      /** Seconds until the window this scope counts in rolls over. */
      readonly retryAfterSeconds: number
    }

const NOT_LIMITED: RateLimitDecision = { limited: false }

/**
 * The counter windows are one minute wide, so a rejected caller waits at most
 * that long. Advising the full minute rather than the exact remainder avoids
 * handing out a schedule a client could synchronise a burst against.
 */
const RATE_LIMIT_WINDOW_SECONDS = 60

/**
 * Apply the three G-005 rate limits to one request.
 *
 * `cost` is the number of events in the request, not one per request. A batch
 * may carry up to 100 events (ADR-0008), so charging per request would make a
 * 120/minute cap mean 12,000 events a minute.
 *
 * The tightest scope is reported first so the metric names the actual cause: a
 * site tripping its infrastructure guard because one IP is flooding it is a
 * different incident from a site legitimately outgrowing the guard.
 */
export function decideRateLimit(input: {
  readonly counts: RateLimitCounts
  readonly cost: number
  readonly policy: Policy
}): RateLimitDecision {
  const { counts, cost, policy } = input

  // The fixed-window ceiling is the whole rule: ADR-0013 settled G-005's
  // "sustained 60 + burst 120" wording as this single 120/min cap.
  if (counts.ipSite + cost > policy.RATE_LIMIT_IP_SITE_BURST) {
    return { limited: true, scope: 'ip_site', retryAfterSeconds: RATE_LIMIT_WINDOW_SECONDS }
  }
  if (counts.identity + cost > policy.RATE_LIMIT_IDENTITY_PER_MINUTE) {
    return { limited: true, scope: 'identity', retryAfterSeconds: RATE_LIMIT_WINDOW_SECONDS }
  }
  if (counts.site + cost > policy.RATE_LIMIT_SITE_PER_MINUTE) {
    return { limited: true, scope: 'site', retryAfterSeconds: RATE_LIMIT_WINDOW_SECONDS }
  }

  return NOT_LIMITED
}

/**
 * Seconds from `now` to the next UTC midnight, never less than one.
 *
 * A `Retry-After: 0` is an invitation to hot-loop, and the last millisecond of a
 * day would otherwise produce exactly that.
 */
export function secondsUntilUtcMidnight(now: Date): number {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000))
}

export interface DailyCeilingDecision {
  readonly limited: boolean
  /** Seconds to UTC midnight, when the daily counter resets. 0 when not limited. */
  readonly retryAfterSeconds: number
  /** Third consecutive ceiling day (G-005). An alert, never an automatic block. */
  readonly alertOperator: boolean
}

/**
 * The per-site daily safety ceiling (G-005).
 *
 * Deliberately a throttle and not a block: an event over the ceiling gets
 * `429 + Retry-After`, the tracker retries, and nothing is lost. The counter
 * resets at UTC midnight. G-005 leaves the response to a persistently pathological
 * site with the operator — three consecutive ceiling days raise an internal
 * alert, and that is all the system does on its own.
 */
export function decideDailyCeiling(input: {
  readonly dailyCount: number
  readonly cost: number
  readonly now: Date
  readonly policy: Policy
  readonly consecutiveCeilingDays?: number
}): DailyCeilingDecision {
  const { dailyCount, cost, now, policy } = input
  const limited = dailyCount + cost > policy.SITE_DAILY_EVENT_CEILING
  const consecutive = input.consecutiveCeilingDays ?? 0

  return {
    limited,
    retryAfterSeconds: limited ? secondsUntilUtcMidnight(now) : 0,
    alertOperator: consecutive >= policy.SITE_CEILING_ALERT_CONSECUTIVE_DAYS,
  }
}

export const LIMITER_MODES = ['enforcing', 'fail_open', 'in_process_fallback'] as const
export type LimiterMode = (typeof LIMITER_MODES)[number]

export interface LimiterModeDecision {
  readonly mode: LimiterMode
  /** True whenever the limiter store is not answering; drives the metric. */
  readonly degraded: boolean
  /** The fallback's per-IP rate, present only in `in_process_fallback`. */
  readonly fallbackPerMinute: number | null
}

/**
 * What to do while the limiter store (`realtime-cache`) is unreachable (G-005).
 *
 * The ladder, and G-005's reason for it in one line: "losing data is worse than
 * not checking a limit." Schema, origin and entitlement checks continue in every
 * mode — only the rate limit is affected — and the outage is never silent.
 *
 * 1. `enforcing` — the store answers.
 * 2. `fail_open` — up to five minutes: accept without the rate-limit check and
 *    raise the degradation metric immediately.
 * 3. `in_process_fallback` — past that, a coarse per-IP limiter inside the
 *    collector process, so a long outage narrows the hole rather than leaving
 *    the collector undefended.
 *
 * An outage that appears to have started in the future is treated as having just
 * started: serverless instances do not share a clock, and reading a negative age
 * as an expired fail-open would drop straight to the fallback on a clock skew.
 */
export function decideLimiterMode(input: {
  readonly unavailableSince: Date | null
  readonly now: Date
  readonly policy: Policy
}): LimiterModeDecision {
  const { unavailableSince, now, policy } = input

  if (unavailableSince === null) {
    return { mode: 'enforcing', degraded: false, fallbackPerMinute: null }
  }

  const outageSeconds = Math.max(0, (now.getTime() - unavailableSince.getTime()) / 1000)

  if (outageSeconds < policy.LIMITER_FAIL_OPEN_MAX_SECONDS) {
    return { mode: 'fail_open', degraded: true, fallbackPerMinute: null }
  }

  return {
    mode: 'in_process_fallback',
    degraded: true,
    fallbackPerMinute: policy.LIMITER_FALLBACK_IP_PER_MINUTE,
  }
}
