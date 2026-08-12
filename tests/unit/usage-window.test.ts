import { usageWindowFor } from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * Usage window generation and anchor lifecycle (docs snapshot 05, D-014; 02 §9).
 * All instants are UTC and every window is half-open [startsAt, endsAt).
 */

const iso = (d: Date) => d.toISOString()

describe('usageWindowFor', () => {
  it('brackets an instant in a half-open monthly window carrying the anchor time', () => {
    const anchor = new Date('2026-03-15T10:30:00.000Z')
    const w = usageWindowFor(anchor, new Date('2026-03-20T00:00:00.000Z'))
    expect(iso(w.startsAt)).toBe('2026-03-15T10:30:00.000Z')
    expect(iso(w.endsAt)).toBe('2026-04-15T10:30:00.000Z')
  })

  it('is half-open: an instant exactly on the boundary belongs to the next window', () => {
    const anchor = new Date('2026-03-15T10:30:00.000Z')
    const boundary = new Date('2026-04-15T10:30:00.000Z')
    const w = usageWindowFor(anchor, boundary)
    expect(iso(w.startsAt)).toBe('2026-04-15T10:30:00.000Z')
    expect(iso(w.endsAt)).toBe('2026-05-15T10:30:00.000Z')
  })

  it('clamps a 31st anchor across 28/30/31-day months', () => {
    const anchor = new Date('2026-01-31T00:00:00.000Z')
    // Jan→Feb: Feb 2026 has 28 days.
    expect(iso(usageWindowFor(anchor, new Date('2026-02-10T00:00:00.000Z')).startsAt)).toBe(
      '2026-01-31T00:00:00.000Z',
    )
    expect(iso(usageWindowFor(anchor, new Date('2026-02-10T00:00:00.000Z')).endsAt)).toBe(
      '2026-02-28T00:00:00.000Z',
    )
    // Feb→Mar: back to the 31st.
    expect(iso(usageWindowFor(anchor, new Date('2026-03-10T00:00:00.000Z')).startsAt)).toBe(
      '2026-02-28T00:00:00.000Z',
    )
    expect(iso(usageWindowFor(anchor, new Date('2026-03-10T00:00:00.000Z')).endsAt)).toBe(
      '2026-03-31T00:00:00.000Z',
    )
    // Mar→Apr: April has 30 days.
    expect(iso(usageWindowFor(anchor, new Date('2026-04-10T00:00:00.000Z')).endsAt)).toBe(
      '2026-04-30T00:00:00.000Z',
    )
  })

  it('clamps a 29th anchor to Feb 29 in a leap year and Feb 28 otherwise', () => {
    const leapAnchor = new Date('2024-01-29T00:00:00.000Z')
    expect(iso(usageWindowFor(leapAnchor, new Date('2024-02-29T00:00:00.000Z')).startsAt)).toBe(
      '2024-02-29T00:00:00.000Z',
    )
    const nonLeapAnchor = new Date('2023-01-29T00:00:00.000Z')
    expect(iso(usageWindowFor(nonLeapAnchor, new Date('2023-02-15T00:00:00.000Z')).endsAt)).toBe(
      '2023-02-28T00:00:00.000Z',
    )
  })

  it('walks many months forward without drifting', () => {
    const anchor = new Date('2026-01-31T12:00:00.000Z')
    // 13 months later, the anniversary is again the 28th (Feb 2027, non-leap).
    const w = usageWindowFor(anchor, new Date('2027-02-15T00:00:00.000Z'))
    expect(iso(w.startsAt)).toBe('2027-01-31T12:00:00.000Z')
    expect(iso(w.endsAt)).toBe('2027-02-28T12:00:00.000Z')
  })

  it('is stable: the same anchor and instant always yield the same window (no reset)', () => {
    // An upgrade or renewal does not change the anchor, so the window generator
    // returns identical boundaries — usage is not reset (D-014).
    const anchor = new Date('2026-05-10T08:00:00.000Z')
    const at = new Date('2026-05-25T00:00:00.000Z')
    expect(usageWindowFor(anchor, at)).toEqual(usageWindowFor(anchor, at))
  })
})
