import {
  MAX_EVENT_AGE_MS,
  MAX_FUTURE_SKEW_MS,
  resolveEventTime,
  utcCalendarDate,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

const ACCEPTED_AT = new Date('2026-07-20T10:30:00.000Z')
const at = (offsetMs: number) => new Date(ACCEPTED_AT.getTime() + offsetMs)

/**
 * Docs snapshot 05, D-016 and 02 §7.1 item 7. Both halves are acceptance
 * criteria for Milestone 4: an event older than 24 hours is rejected without
 * creating usage or a queue row, and a future clock is clamped deterministically.
 */
describe('event time boundaries', () => {
  it('accepts an ordinary recent event unchanged', () => {
    const decision = resolveEventTime({ occurredAt: at(-1_500), acceptedAt: ACCEPTED_AT })

    expect(decision.accepted).toBe(true)
    if (!decision.accepted) return
    expect(decision.occurredAt.toISOString()).toBe(at(-1_500).toISOString())
    expect(decision.clockSkewed).toBe(false)
  })

  it('rejects an event older than 24 hours', () => {
    const decision = resolveEventTime({
      occurredAt: at(-MAX_EVENT_AGE_MS - 1),
      acceptedAt: ACCEPTED_AT,
    })

    expect(decision).toEqual({ accepted: false, reason: 'too_old' })
  })

  it('accepts an event exactly 24 hours old', () => {
    // The rule is `occurred_at < accepted_at - 24h`. An off-by-one here would
    // drop the last event of a compliant tracker's bounded retry queue.
    const decision = resolveEventTime({
      occurredAt: at(-MAX_EVENT_AGE_MS),
      acceptedAt: ACCEPTED_AT,
    })

    expect(decision.accepted).toBe(true)
    if (!decision.accepted) return
    expect(decision.clockSkewed).toBe(false)
  })

  it('clamps a clock more than five minutes ahead', () => {
    const decision = resolveEventTime({
      occurredAt: at(MAX_FUTURE_SKEW_MS + 1),
      acceptedAt: ACCEPTED_AT,
    })

    expect(decision.accepted).toBe(true)
    if (!decision.accepted) return
    expect(decision.occurredAt.toISOString()).toBe(ACCEPTED_AT.toISOString())
    expect(decision.clockSkewed).toBe(true)
  })

  it('leaves a clock exactly five minutes ahead alone', () => {
    const decision = resolveEventTime({
      occurredAt: at(MAX_FUTURE_SKEW_MS),
      acceptedAt: ACCEPTED_AT,
    })

    expect(decision.accepted).toBe(true)
    if (!decision.accepted) return
    expect(decision.clockSkewed).toBe(false)
  })

  it('clamps a wildly wrong clock rather than rejecting it', () => {
    // A visitor's machine set to next year still produced a real pageview; the
    // event is kept, at the server's time, and marked skewed.
    const decision = resolveEventTime({
      occurredAt: '2027-01-01T00:00:00.000Z',
      acceptedAt: ACCEPTED_AT,
    })

    expect(decision.accepted).toBe(true)
    if (!decision.accepted) return
    expect(decision.occurredAt.toISOString()).toBe(ACCEPTED_AT.toISOString())
    expect(decision.clockSkewed).toBe(true)
  })

  it('is deterministic: the same pair always decides the same way', () => {
    // The collector, a worker replaying a manifest and this test must agree, so
    // the rule reads no wall clock and no configuration.
    const inputs = [-MAX_EVENT_AGE_MS - 1, -MAX_EVENT_AGE_MS, 0, MAX_FUTURE_SKEW_MS + 1]

    for (const offset of inputs) {
      const first = resolveEventTime({ occurredAt: at(offset), acceptedAt: ACCEPTED_AT })
      const second = resolveEventTime({ occurredAt: at(offset), acceptedAt: ACCEPTED_AT })
      expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    }
  })

  it('rejects an unparseable timestamp instead of coercing it', () => {
    expect(resolveEventTime({ occurredAt: 'yesterday', acceptedAt: ACCEPTED_AT })).toEqual({
      accepted: false,
      reason: 'invalid_timestamp',
    })
  })

  it('accepts strings and Dates identically', () => {
    const asString = resolveEventTime({
      occurredAt: at(-1_000).toISOString(),
      acceptedAt: ACCEPTED_AT.toISOString(),
    })
    const asDate = resolveEventTime({ occurredAt: at(-1_000), acceptedAt: ACCEPTED_AT })

    expect(JSON.stringify(asString)).toBe(JSON.stringify(asDate))
  })
})

describe('UTC calendar date', () => {
  it('uses UTC, not a local or site timezone', () => {
    // D-102: the identity rotation day is the UTC date. A site timezone only
    // groups dashboards; letting it reach the identity bucket would make the
    // same visitor two people at midnight.
    expect(utcCalendarDate('2026-07-20T23:59:59.999Z')).toBe('2026-07-20')
    expect(utcCalendarDate('2026-07-21T00:00:00.000Z')).toBe('2026-07-21')
  })
})
