import {
  decideDailyCeiling,
  decideLimiterMode,
  decideRateLimit,
  type Policy,
  type RateLimitScope,
} from '@openanalytics/domain'
import type { Metrics } from '@openanalytics/observability'
import type { ChargedRateLimits, RealtimeCache } from '@openanalytics/redis'
import type { FallbackLimiter } from './fallback-limiter.ts'
import { COLLECTOR_METRICS } from './metrics.ts'

/**
 * G-005's limiter, including what it does when its store is gone.
 *
 * The decisions themselves are pure functions in `@openanalytics/domain`; this
 * is the part that talks to `realtime-cache` and decides what an *outage of that
 * store* means. G-005 answers that in one line — "losing data is worse than not
 * checking a limit" — and gives a three-rung ladder:
 *
 * 1. the store answers → enforce;
 * 2. the store is down, under five minutes → accept without the rate check,
 *    metric immediately;
 * 3. longer than that → a coarse in-process per-IP limiter, so the collector is
 *    never wholly undefended.
 *
 * Schema, origin, entitlement and quota checks are unaffected in every rung.
 * Only the rate limit is skipped, and only ever in the direction of accepting an
 * event the collector could durably store.
 */

export type LimitedScope = RateLimitScope | 'daily_ceiling' | 'fallback'

export type LimiterDecision =
  | {
      readonly limited: false
      /** Null when the store did not answer; the caller then has no counters. */
      readonly charged: ChargedRateLimits | null
      readonly degraded: boolean
    }
  | {
      readonly limited: true
      readonly scope: LimitedScope
      readonly retryAfterSeconds: number
      readonly degraded: boolean
    }

export interface IngestLimiterOptions {
  readonly realtime: RealtimeCache
  readonly policy: Policy
  readonly metrics: Metrics
  readonly fallback: FallbackLimiter
}

export interface IngestLimiter {
  check(input: {
    readonly siteId: string
    readonly ipHash: string
    readonly identityHash: string
    readonly cost: number
    readonly at: Date
  }): Promise<LimiterDecision>
}

export function createIngestLimiter(options: IngestLimiterOptions): IngestLimiter {
  const { realtime, policy, metrics, fallback } = options

  /**
   * When the store first stopped answering, or null while it is healthy.
   *
   * Per process, which is the only place a serverless collector can keep it. A
   * fresh instance restarts the fail-open clock, so the effective window is at
   * most five minutes *per instance* rather than globally — the ladder still
   * ends at the fallback for any instance that stays warm through an outage,
   * which is the case that matters, because a cold instance has no traffic.
   */
  let unavailableSince: Date | null = null

  return {
    async check(input): Promise<LimiterDecision> {
      let charged: ChargedRateLimits
      try {
        charged = await realtime.chargeRateLimits({
          siteId: input.siteId,
          ipHash: input.ipHash,
          identityHash: input.identityHash,
          at: input.at,
          cost: input.cost,
        })
        unavailableSince = null
      } catch {
        unavailableSince ??= input.at
        const mode = decideLimiterMode({ unavailableSince, now: input.at, policy })

        if (mode.mode === 'fail_open') {
          metrics.increment(COLLECTOR_METRICS.limiterFailOpen, { site_id: input.siteId })
          return { limited: false, charged: null, degraded: true }
        }

        metrics.increment(COLLECTOR_METRICS.limiterFallback, { site_id: input.siteId })
        if (fallback.isLimited(input.ipHash, input.cost, input.at)) {
          metrics.increment(COLLECTOR_METRICS.limiterFallbackLimited, { site_id: input.siteId })
          return {
            limited: true,
            scope: 'fallback',
            // One minute: the fallback's window is a minute wide, and a longer
            // hint during an outage would keep traffic away past recovery.
            retryAfterSeconds: 60,
            degraded: true,
          }
        }
        return { limited: false, charged: null, degraded: true }
      }

      const rate = decideRateLimit({
        counts: {
          ipSite: charged.ipSite - input.cost,
          identity: charged.identity - input.cost,
          site: charged.site - input.cost,
        },
        cost: input.cost,
        policy,
      })
      if (rate.limited) {
        metrics.increment(COLLECTOR_METRICS.rateLimited, {
          site_id: input.siteId,
          scope: rate.scope,
        })
        return {
          limited: true,
          scope: rate.scope,
          retryAfterSeconds: rate.retryAfterSeconds,
          degraded: false,
        }
      }

      // The consecutive-days streak alert is the worker's (ADR-0010, ADR-0013):
      // only it can afford the cross-day read the streak needs.
      const ceiling = decideDailyCeiling({
        dailyCount: charged.siteDaily - input.cost,
        cost: input.cost,
        now: input.at,
        policy,
      })
      if (ceiling.limited) {
        metrics.increment(COLLECTOR_METRICS.dailyCeilingReached, { site_id: input.siteId })
        return {
          limited: true,
          scope: 'daily_ceiling',
          retryAfterSeconds: ceiling.retryAfterSeconds,
          degraded: false,
        }
      }

      return { limited: false, charged, degraded: false }
    },
  }
}
