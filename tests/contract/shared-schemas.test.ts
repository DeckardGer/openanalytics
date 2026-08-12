import {
  addMoney,
  buildCursorPage,
  dateRangeSchema,
  freshnessSchema,
  isHalfOpenContained,
  isValidTimezone,
  money,
  moneySchema,
  timezoneSchema,
  utcInstantSchema,
} from '@openanalytics/contracts'
import { describe, expect, it } from 'vitest'

describe('time contract', () => {
  it('requires UTC instants', () => {
    expect(utcInstantSchema.safeParse('2026-07-20T10:30:00.000Z').success).toBe(true)
    // A local-time or offset timestamp would make range maths ambiguous.
    expect(utcInstantSchema.safeParse('2026-07-20T10:30:00+04:00').success).toBe(false)
    expect(utcInstantSchema.safeParse('2026-07-20').success).toBe(false)
  })

  it('validates timezones against the runtime database, not only a regex', () => {
    expect(timezoneSchema.safeParse('Asia/Baku').success).toBe(true)
    expect(timezoneSchema.safeParse('UTC').success).toBe(true)
    // Real identifiers a careless pattern refuses: a `+` inside the name, a
    // hyphen, and three segments.
    expect(timezoneSchema.safeParse('Etc/GMT+5').success).toBe(true)
    expect(timezoneSchema.safeParse('America/Port-au-Prince').success).toBe(true)
    expect(timezoneSchema.safeParse('America/Argentina/Buenos_Aires').success).toBe(true)
    // Identifier-shaped but not a zone — which is why the runtime database is
    // asked at all. Legacy interpolated the timezone into SQL after a shallow
    // sanitize (docs snapshot 01 §7.9).
    expect(timezoneSchema.safeParse('Not/AZone').success).toBe(false)
    expect(timezoneSchema.safeParse("'; DROP TABLE events; --").success).toBe(false)
  })

  it('refuses a UTC offset, which the runtime database would accept', () => {
    // `Intl` treats `+05:00` as a time zone. Nothing else here does: the column
    // CHECK on `users.timezone` refuses it (migration 0023), and ClickHouse
    // refuses it on the analytics path — so without the identifier-shape half of
    // the validator both surfaces answer 500 to what is a caller mistake
    // (ADR-0026 decision 6). An offset is also simply wrong: it is a timezone
    // evaluated at one instant and breaks at every DST transition.
    for (const offset of ['+05:00', '-08:00', '+0500', '-0800']) {
      expect(isValidTimezone(offset), offset).toBe(false)
      expect(timezoneSchema.safeParse(offset).success, offset).toBe(false)
    }
  })

  it('requires a half-open range', () => {
    const valid = { from: '2026-07-13T00:00:00.000Z', to: '2026-07-20T00:00:00.000Z' }
    expect(dateRangeSchema.safeParse(valid).success).toBe(true)

    // An empty or inverted range is a caller bug, not an empty result set.
    expect(dateRangeSchema.safeParse({ from: valid.to, to: valid.from }).success).toBe(false)
    expect(dateRangeSchema.safeParse({ from: valid.from, to: valid.from }).success).toBe(false)
  })

  it('excludes the upper bound', () => {
    // Docs snapshot 05, D-014: an event at exactly `to` belongs to the next
    // window. Getting this wrong double-counts on every boundary.
    const range = { from: '2026-07-13T00:00:00.000Z', to: '2026-07-20T00:00:00.000Z' }

    expect(isHalfOpenContained(range, '2026-07-13T00:00:00.000Z')).toBe(true)
    expect(isHalfOpenContained(range, '2026-07-19T23:59:59.999Z')).toBe(true)
    expect(isHalfOpenContained(range, '2026-07-20T00:00:00.000Z')).toBe(false)
  })

  it('carries provisional and finalized watermarks', () => {
    // Docs snapshot 03 §6.2: the client must be able to tell a true zero from
    // data that has not settled yet.
    const parsed = freshnessSchema.parse({
      as_of: '2026-07-20T10:30:02.000Z',
      resolution: 'hour',
      provisional_through: '2026-07-20T10:30:00.000Z',
      finalized_through: '2026-07-19T10:30:00.000Z',
    })

    expect(parsed.finalized_through).toBe('2026-07-19T10:30:00.000Z')
    expect(freshnessSchema.safeParse({ ...parsed, finalized_through: null }).success).toBe(true)
  })
})

describe('money contract', () => {
  it('accepts minor-unit integers only', () => {
    expect(moneySchema.safeParse({ amount_minor: 4900, currency: 'USD' }).success).toBe(true)
    // 49.00 as a float is exactly what this contract exists to prevent.
    expect(
      moneySchema.safeParse({ amount_minor: (49.0).toFixed(2), currency: 'USD' }).success,
    ).toBe(false)
    expect(moneySchema.safeParse({ amount_minor: 49.5, currency: 'USD' }).success).toBe(false)
  })

  it('requires an uppercase ISO-4217 code', () => {
    expect(moneySchema.safeParse({ amount_minor: 1, currency: 'usd' }).success).toBe(false)
    expect(moneySchema.safeParse({ amount_minor: 1, currency: 'DOLLAR' }).success).toBe(false)
  })

  it('allows negative amounts for refunds', () => {
    expect(money(-1500, 'USD').amount_minor).toBe(-1500)
  })

  it('refuses to add mixed currencies silently', () => {
    expect(() => addMoney(money(100, 'USD'), money(100, 'EUR'))).toThrow(
      /without an explicit conversion/,
    )
  })
})

describe('cursor pagination', () => {
  it('reports has_more exactly on the final page', () => {
    // The server over-fetches one row, so the last page is not a guess.
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

    const full = buildCursorPage(rows, 2, (row) => row.id)
    expect(full.items).toHaveLength(2)
    expect(full.has_more).toBe(true)
    expect(full.next_cursor).toBe('b')

    const last = buildCursorPage(rows.slice(0, 2), 2, (row) => row.id)
    expect(last.has_more).toBe(false)
    expect(last.next_cursor).toBeNull()
  })

  it('handles an empty result', () => {
    const page = buildCursorPage([], 50, () => 'unused')
    expect(page).toEqual({ items: [], next_cursor: null, has_more: false })
  })
})
