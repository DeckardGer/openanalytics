import { describe, expect, it } from 'vitest'
import {
  addSessionMeasures,
  deriveSessionMetrics,
  floorUtcTo,
  mergeSessionLayers,
  splitSessionRange,
  type SessionMeasures,
} from '@openanalytics/domain'

/**
 * The session read model (docs snapshot 02 §10, §15; plan Milestone 8 items 6-7).
 *
 * The load-bearing property proved here is that the finalized/provisional split is
 * non-overlapping: a session lands in exactly one layer, decided by its
 * `session_start` against a UTC-bucket-aligned boundary derived from
 * `finalized_through`. The metric derivation proves averages and bounce rate are
 * `total / sessions` at read, so merging buckets is a plain sum (§10).
 */

const measures = (over: Partial<SessionMeasures> = {}): SessionMeasures => ({
  sessions: 0,
  engagedSessions: 0,
  bouncedSessions: 0,
  pageviews: 0,
  totalSessionDurationMs: 0,
  totalActiveDurationMs: 0,
  ...over,
})

describe('splitSessionRange', () => {
  const range = {
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    effectiveTo: '2026-07-08T00:00:00.000Z',
  }

  it('floors the boundary to the split unit and partitions the range at it', () => {
    // finalized_through mid-day → the split boundary is the start of its UTC day.
    const split = splitSessionRange({
      ...range,
      finalizedThrough: '2026-07-05T13:42:11.000Z',
      splitUnit: 'day',
    })
    expect(split.boundary).toBe('2026-07-05T00:00:00.000Z')
    expect(split.finalized).toEqual({ from: range.effectiveFrom, to: '2026-07-05T00:00:00.000Z' })
    expect(split.provisional).toEqual({ from: '2026-07-05T00:00:00.000Z', to: range.effectiveTo })
  })

  it('is provably non-overlapping: finalized.to === provisional.from', () => {
    const split = splitSessionRange({
      ...range,
      finalizedThrough: '2026-07-04T09:00:00.000Z',
      splitUnit: 'hour',
    })
    // The hour-floored boundary is shared: [from, B) and [B, to) never overlap.
    expect(split.finalized?.to).toBe(split.provisional?.from)
    expect(split.finalized?.to).toBe('2026-07-04T09:00:00.000Z')
  })

  it('reads the whole range as provisional when nothing is finalized', () => {
    const split = splitSessionRange({ ...range, finalizedThrough: null, splitUnit: 'hour' })
    expect(split.finalized).toBeNull()
    expect(split.provisional).toEqual({ from: range.effectiveFrom, to: range.effectiveTo })
  })

  it('reads the whole range as finalized when the watermark is past the range end', () => {
    const split = splitSessionRange({
      ...range,
      finalizedThrough: '2026-09-01T00:00:00.000Z',
      splitUnit: 'day',
    })
    expect(split.finalized).toEqual({ from: range.effectiveFrom, to: range.effectiveTo })
    expect(split.provisional).toBeNull()
  })

  it('reads the whole range as provisional when the watermark is before the range start', () => {
    const split = splitSessionRange({
      ...range,
      finalizedThrough: '2026-06-01T00:00:00.000Z',
      splitUnit: 'day',
    })
    expect(split.finalized).toBeNull()
    expect(split.provisional).toEqual({ from: range.effectiveFrom, to: range.effectiveTo })
  })
})

describe('floorUtcTo', () => {
  it('floors to the UTC hour and day', () => {
    expect(floorUtcTo('2026-07-05T13:42:11.500Z', 'hour')).toBe('2026-07-05T13:00:00.000Z')
    expect(floorUtcTo('2026-07-05T13:42:11.500Z', 'day')).toBe('2026-07-05T00:00:00.000Z')
  })
})

describe('deriveSessionMetrics', () => {
  it('derives bounce rate and averages as total / sessions', () => {
    const m = deriveSessionMetrics(
      measures({
        sessions: 4,
        bouncedSessions: 1,
        engagedSessions: 3,
        totalSessionDurationMs: 400_000,
        totalActiveDurationMs: 120_000,
      }),
    )
    expect(m.bounceRate).toBe(0.25)
    expect(m.avgSessionDurationMs).toBe(100_000)
    expect(m.avgActiveDurationMs).toBe(30_000)
  })

  it('is zero, never NaN, when there are no sessions', () => {
    const m = deriveSessionMetrics(measures())
    expect(m.bounceRate).toBe(0)
    expect(m.avgSessionDurationMs).toBe(0)
    expect(m.avgActiveDurationMs).toBe(0)
  })
})

describe('mergeSessionLayers', () => {
  it('sums additive measures across the two layers, then derives once at the end', () => {
    // A bucket present in both layers (a composed local day straddling B) is a
    // plain sum, then divided — never a mean of means.
    const finalized = [
      {
        bucket: '2026-07-05T00:00:00.000Z',
        ...measures({ sessions: 2, bouncedSessions: 1, totalSessionDurationMs: 100_000 }),
      },
    ]
    const provisional = [
      {
        bucket: '2026-07-05T00:00:00.000Z',
        ...measures({ sessions: 2, bouncedSessions: 0, totalSessionDurationMs: 300_000 }),
      },
      {
        bucket: '2026-07-06T00:00:00.000Z',
        ...measures({ sessions: 1, bouncedSessions: 1, totalSessionDurationMs: 50_000 }),
      },
    ]
    const { series, totals } = mergeSessionLayers(finalized, provisional)

    const merged = series.find((s) => s.bucket === '2026-07-05T00:00:00.000Z')!
    expect(merged.sessions).toBe(4)
    expect(merged.bounceRate).toBe(0.25) // 1 bounced of 4, from the additive sum
    expect(merged.avgSessionDurationMs).toBe(100_000) // 400_000 / 4

    expect(series.map((s) => s.bucket)).toEqual([
      '2026-07-05T00:00:00.000Z',
      '2026-07-06T00:00:00.000Z',
    ])
    expect(totals.sessions).toBe(5)
    expect(totals.bouncedSessions).toBe(2)
    expect(totals.bounceRate).toBe(0.4)
  })
})

describe('addSessionMeasures', () => {
  it('adds field by field', () => {
    const sum = addSessionMeasures(
      measures({ sessions: 1, pageviews: 3 }),
      measures({ sessions: 2, pageviews: 4 }),
    )
    expect(sum.sessions).toBe(3)
    expect(sum.pageviews).toBe(7)
  })
})
