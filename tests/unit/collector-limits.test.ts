import {
  decideDailyCeiling,
  decideLimiterMode,
  decideRateLimit,
  loadPolicy,
  secondsUntilUtcMidnight,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * Collector rate limits, the per-site daily safety ceiling and the limiter-outage
 * ladder — as pure decisions.
 *
 * The D-103 window quota and the rapid-burn notice were here too until the
 * open-core split; both are about a *plan's* limit, so they are in
 * `tests/unit/cloud/collector-limits.test.ts` now.
 *
 * Every number comes from `loadPolicy`, never from a literal in this file. A
 * test that restated a limit would pass while production enforced a different
 * one, which is precisely the failure G-005's "typed config, no scattered
 * numbers" rule exists to prevent.
 */

const POLICY = loadPolicy({})
const NOW = new Date('2026-07-23T12:00:00.000Z')

describe('rate limits (G-005)', () => {
  it('allows traffic under every limit', () => {
    const decision = decideRateLimit({
      counts: { ipSite: 1, identity: 1, site: 1 },
      cost: 1,
      policy: POLICY,
    })
    expect(decision.limited).toBe(false)
  })

  it('lets an IP burst above the sustained rate but not above the burst ceiling', () => {
    // G-005: IP→site 60/min with a burst of 120. The sustained rate is what a
    // page's worth of tracking should stay under; the burst is what a genuine
    // multi-tab visitor is allowed before it counts as abuse.
    const under = decideRateLimit({
      counts: { ipSite: POLICY.RATE_LIMIT_IP_SITE_BURST - 1, identity: 0, site: 0 },
      cost: 1,
      policy: POLICY,
    })
    expect(under.limited).toBe(false)

    const over = decideRateLimit({
      counts: { ipSite: POLICY.RATE_LIMIT_IP_SITE_BURST, identity: 0, site: 0 },
      cost: 1,
      policy: POLICY,
    })
    expect(over.limited).toBe(true)
    expect(over.limited && over.scope).toBe('ip_site')
  })

  it('limits an anonymous identity at its own rate', () => {
    const decision = decideRateLimit({
      counts: { ipSite: 0, identity: POLICY.RATE_LIMIT_IDENTITY_PER_MINUTE, site: 0 },
      cost: 1,
      policy: POLICY,
    })
    expect(decision.limited).toBe(true)
    expect(decision.limited && decision.scope).toBe('identity')
  })

  it('limits a whole site at the infrastructure guard', () => {
    const decision = decideRateLimit({
      counts: { ipSite: 0, identity: 0, site: POLICY.RATE_LIMIT_SITE_PER_MINUTE },
      cost: 1,
      policy: POLICY,
    })
    expect(decision.limited).toBe(true)
    expect(decision.limited && decision.scope).toBe('site')
  })

  it('counts a batch by its event count, not as one request', () => {
    // A batch may carry up to 100 events (ADR-0008). Charging one unit per
    // request would make the per-minute limits meaningless: a client could send
    // 60 batches of 100 and stay "under" a 60/min rule.
    const decision = decideRateLimit({
      counts: { ipSite: POLICY.RATE_LIMIT_IP_SITE_BURST - 10, identity: 0, site: 0 },
      cost: 100,
      policy: POLICY,
    })
    expect(decision.limited).toBe(true)
  })

  it('reports the tightest scope first, so the metric names the real cause', () => {
    const decision = decideRateLimit({
      counts: {
        ipSite: POLICY.RATE_LIMIT_IP_SITE_BURST,
        identity: POLICY.RATE_LIMIT_IDENTITY_PER_MINUTE,
        site: POLICY.RATE_LIMIT_SITE_PER_MINUTE,
      },
      cost: 1,
      policy: POLICY,
    })
    expect(decision.limited && decision.scope).toBe('ip_site')
  })

  it('always carries a retry hint, because a 429 here is a delay and not a loss', () => {
    const decision = decideRateLimit({
      counts: { ipSite: POLICY.RATE_LIMIT_IP_SITE_BURST, identity: 0, site: 0 },
      cost: 1,
      policy: POLICY,
    })
    expect(decision.limited && decision.retryAfterSeconds).toBeGreaterThan(0)
    expect(decision.limited && decision.retryAfterSeconds).toBeLessThanOrEqual(60)
  })
})

describe('per-site daily safety ceiling (G-005)', () => {
  it('admits a site under the ceiling', () => {
    const decision = decideDailyCeiling({
      dailyCount: POLICY.SITE_DAILY_EVENT_CEILING - 1,
      cost: 1,
      now: NOW,
      policy: POLICY,
    })
    expect(decision.limited).toBe(false)
  })

  it('throttles rather than blocks once the ceiling is reached', () => {
    const decision = decideDailyCeiling({
      dailyCount: POLICY.SITE_DAILY_EVENT_CEILING,
      cost: 1,
      now: NOW,
      policy: POLICY,
    })

    // G-005: "throttle — a further event gets 429 + Retry-After (the tracker
    // retries, nothing is lost)". There is no automatic block; three consecutive
    // days at the ceiling raise an alert and the decision after that is the
    // operator's.
    expect(decision.limited).toBe(true)
    expect(decision.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('points the retry at UTC midnight, which is when the counter resets', () => {
    const decision = decideDailyCeiling({
      dailyCount: POLICY.SITE_DAILY_EVENT_CEILING,
      cost: 1,
      now: NOW,
      policy: POLICY,
    })
    expect(decision.limited && decision.retryAfterSeconds).toBe(12 * 60 * 60)
  })

  it('never advises a retry of zero seconds at the very end of a day', () => {
    // A Retry-After of 0 is an invitation to hot-loop. The last millisecond of a
    // UTC day must still round up to at least a second.
    const endOfDay = new Date('2026-07-23T23:59:59.999Z')
    expect(secondsUntilUtcMidnight(endOfDay)).toBeGreaterThanOrEqual(1)
  })

  it('raises the operator alert only after the third consecutive ceiling day', () => {
    const policy = POLICY
    const at = (days: number) =>
      decideDailyCeiling({
        dailyCount: policy.SITE_DAILY_EVENT_CEILING,
        cost: 1,
        now: NOW,
        policy,
        consecutiveCeilingDays: days,
      })

    expect(at(1).limited && at(1).alertOperator).toBe(false)
    expect(at(2).limited && at(2).alertOperator).toBe(false)
    expect(at(policy.SITE_CEILING_ALERT_CONSECUTIVE_DAYS).alertOperator).toBe(true)
  })
})

describe('limiter outage ladder (G-005)', () => {
  const outageStart = new Date('2026-07-23T12:00:00.000Z')

  it('runs normally while the limiter store answers', () => {
    const mode = decideLimiterMode({ unavailableSince: null, now: NOW, policy: POLICY })
    expect(mode.mode).toBe('enforcing')
    expect(mode.degraded).toBe(false)
  })

  it('fails open for the first five minutes, with a degradation signal', () => {
    // G-005 in one line: "Losing data is worse than not checking a limit." Schema,
    // origin and entitlement checks continue regardless — only the rate limit
    // is skipped, and the outage is never silent.
    const mode = decideLimiterMode({
      unavailableSince: outageStart,
      now: new Date(outageStart.getTime() + 60_000),
      policy: POLICY,
    })
    expect(mode.mode).toBe('fail_open')
    expect(mode.degraded).toBe(true)
  })

  it('falls back to the in-process limiter once fail-open expires', () => {
    const mode = decideLimiterMode({
      unavailableSince: outageStart,
      now: new Date(outageStart.getTime() + POLICY.LIMITER_FAIL_OPEN_MAX_SECONDS * 1000),
      policy: POLICY,
    })

    // "the system is never wholly undefended" — a long outage narrows to a
    // coarse per-IP limit rather than leaving the collector wide open.
    expect(mode.mode).toBe('in_process_fallback')
    expect(mode.degraded).toBe(true)
    expect(mode.fallbackPerMinute).toBe(POLICY.LIMITER_FALLBACK_IP_PER_MINUTE)
  })

  it('recovers as soon as the store answers again', () => {
    expect(decideLimiterMode({ unavailableSince: null, now: NOW, policy: POLICY }).mode).toBe(
      'enforcing',
    )
  })

  it('treats a clock that moved backwards as the start of the outage', () => {
    // Serverless instances do not share a clock. A negative age must not be read
    // as "fail-open expired long ago" and drop straight to the fallback.
    const mode = decideLimiterMode({
      unavailableSince: outageStart,
      now: new Date(outageStart.getTime() - 60_000),
      policy: POLICY,
    })
    expect(mode.mode).toBe('fail_open')
  })
})
