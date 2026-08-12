import {
  checkDeclaredRange,
  costRetryAfterSeconds,
  readCostConfigSchema,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * The declared-range half of the expensive-query gate (ADR-0043 D7).
 *
 * It is the half that can be tested without a database because it is the half
 * that costs nothing to evaluate — which is also the reason it exists: the query
 * gateway reports elapsed time and no ClickHouse row or byte counts, so a
 * request's cost is knowable *after* and merely guessable *before*, and the
 * declared span is the only honest thing to judge in advance.
 */

const DAY = 24 * 60 * 60 * 1000
const T0 = new Date('2026-08-06T00:00:00.000Z')
const after = (days: number): Date => new Date(T0.getTime() + days * DAY)

describe('checkDeclaredRange', () => {
  it('admits a span at the ceiling and refuses the one past it', () => {
    expect(checkDeclaredRange({ from: T0, to: after(30), maxDays: 30 }).allowed).toBe(true)
    expect(checkDeclaredRange({ from: T0, to: after(31), maxDays: 30 }).allowed).toBe(false)
  })

  it('rounds a partial day up, so 30 days and one second is 31', () => {
    // Rounding down would make the ceiling mean "30 days, or 31 if you ask
    // carefully", which is the kind of boundary nobody documents and everybody
    // discovers.
    const to = new Date(after(30).getTime() + 1000)
    const verdict = checkDeclaredRange({ from: T0, to, maxDays: 30 })
    expect(verdict.requestedDays).toBe(31)
    expect(verdict.allowed).toBe(false)
  })

  it('reports what was asked for and what is allowed, so the refusal is actionable', () => {
    const verdict = checkDeclaredRange({ from: T0, to: after(900), maxDays: 400 })
    expect(verdict).toEqual({ allowed: false, requestedDays: 900, maxDays: 400 })
  })

  it('leaves an inverted range to the parser rather than calling it too wide', () => {
    // `parseRange` already refuses `to < from` with VALIDATION_FAILED, naming
    // the field. Answering RANGE_TOO_LARGE here would name the wrong problem and
    // send an integrator looking for a width they do not have.
    const verdict = checkDeclaredRange({ from: after(5), to: T0, maxDays: 1 })
    expect(verdict.allowed).toBe(true)
    expect(verdict.requestedDays).toBe(0)
  })

  it('admits a zero-length span', () => {
    expect(checkDeclaredRange({ from: T0, to: T0, maxDays: 1 }).allowed).toBe(true)
  })
})

describe('costRetryAfterSeconds', () => {
  it('points at the end of the current hour, when the oldest bucket ages out', () => {
    // The window is 24 rolling hourly buckets, so budget frees up within the
    // hour — never at some arbitrary midnight. Telling a client to come back
    // tomorrow when it could resume in twenty minutes is how retry loops learn
    // to ignore `Retry-After`.
    expect(costRetryAfterSeconds(new Date('2026-08-06T10:00:00.000Z'))).toBe(3600)
    expect(costRetryAfterSeconds(new Date('2026-08-06T10:30:00.000Z'))).toBe(1800)
    expect(costRetryAfterSeconds(new Date('2026-08-06T10:59:59.000Z'))).toBe(1)
  })

  it('never returns zero, which a client would read as "immediately"', () => {
    expect(costRetryAfterSeconds(new Date('2026-08-06T10:59:59.999Z'))).toBeGreaterThan(0)
  })
})

describe('the configuration', () => {
  it('defaults to a ceiling and a budget rather than to no limit', () => {
    const config = readCostConfigSchema.parse({})
    expect(config.READ_MAX_RANGE_DAYS).toBeGreaterThan(0)
    expect(config.READ_DAILY_COST_BUDGET_MS).toBeGreaterThan(0)
  })

  it('admits zero as "no budget", which is the only honest way to disable it', () => {
    // A deployment with no ClickHouse pressure should turn the ledger off
    // explicitly rather than set a number it has not measured.
    expect(
      readCostConfigSchema.parse({ READ_DAILY_COST_BUDGET_MS: '0' }).READ_DAILY_COST_BUDGET_MS,
    ).toBe(0)
    // But a range ceiling of zero would refuse every request, so it is not
    // admitted at all.
    expect(() => readCostConfigSchema.parse({ READ_MAX_RANGE_DAYS: '0' })).toThrow()
  })
})
