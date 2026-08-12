import {
  WIDGET_RANGES,
  WIDGET_RANGE_GRAIN,
  loadWidgetReadConfig,
  resolveWidgetRange,
  widgetReadConfigSchema,
  type WidgetRange,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * The server's first resolution of the dashboard's nine interval keys
 * (ADR-0045, D10).
 *
 * Until this module existed the keys were a **frontend** vocabulary:
 * `apps/web/components/dashboard/interval-context.tsx` turned each one into a
 * `from`/`to` pair before it called, and the server had never seen the word
 * `7d`. A widget has no client to do that — it stores the key and the read
 * resolves it — so the one thing every assertion here is really pinning is that
 * **the two resolutions agree**: "Last 7 days" on an embed must be the same
 * window as "Last 7 days" in the owner's dashboard, or the same site publishes
 * two different numbers under one label.
 *
 * The expectations are therefore written as literal instants computed from
 * `rangeForInterval`'s own rules, not by calling a shared helper — a shared
 * helper would make this test agree with itself rather than with the dashboard.
 *
 * Three properties beyond the nine keys:
 *
 * - **Calendar boundaries are cut in the zone, not in UTC.** `today` in
 *   `Asia/Baku` is a different pair of instants from `today` in `UTC`, which is
 *   the whole reason `sites.reporting_timezone` reaches this function.
 * - **DST is honoured rather than approximated.** A local day that contains a
 *   transition is 23 or 25 hours long, and naive `±86_400_000` arithmetic gets
 *   it wrong in exactly the way that moves a chart's first bucket.
 * - **`all` anchors at `first_event_at` and never invents a start** (ADR-0044
 *   D7 keeps `created_at` off the public surface).
 */

/** A fixed "now" well away from any transition, so the ordinary cases are read
 * without having to hold a DST rule in mind. 18:30 in Baku, 14:30 UTC. */
const NOW = new Date('2026-08-07T14:30:00.000Z')

const range = (key: WidgetRange, timezone: string, firstEventAt: Date | null = null) =>
  resolveWidgetRange({ range: key, timezone, now: NOW, firstEventAt })

describe('the nine range keys, resolved in UTC', () => {
  /**
   * Every expectation is `rangeForInterval`'s own arithmetic written out:
   * `tomorrow` is the exclusive end of everything except `yesterday` and `24h`,
   * the `Nd` keys count back `N-1` whole days from today's start, and `6mo`/
   * `12mo` shift the calendar and then add a day.
   */
  const CASES: [WidgetRange, string, string][] = [
    ['today', '2026-08-07T00:00:00.000Z', '2026-08-08T00:00:00.000Z'],
    ['yesterday', '2026-08-06T00:00:00.000Z', '2026-08-07T00:00:00.000Z'],
    // The one rolling window: a trailing 24 hours from the request instant,
    // never a calendar day. It is the key whose `to` is `now`.
    ['24h', '2026-08-06T14:30:00.000Z', '2026-08-07T14:30:00.000Z'],
    ['7d', '2026-08-01T00:00:00.000Z', '2026-08-08T00:00:00.000Z'],
    ['30d', '2026-07-09T00:00:00.000Z', '2026-08-08T00:00:00.000Z'],
    ['90d', '2026-05-10T00:00:00.000Z', '2026-08-08T00:00:00.000Z'],
    ['6mo', '2026-02-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z'],
    ['12mo', '2025-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z'],
  ]

  it.each(CASES)('%s', (key, from, to) => {
    expect(range(key, 'UTC')).toEqual({ from, to })
  })

  it('resolves every key in the vocabulary, so none can be added without one', () => {
    for (const key of WIDGET_RANGES) {
      const resolved = range(key, 'UTC', new Date('2026-06-02T08:14:09.221Z'))
      expect(Date.parse(resolved.from), key).not.toBeNaN()
      expect(Date.parse(resolved.to), key).not.toBeNaN()
      expect(Date.parse(resolved.from), key).toBeLessThan(Date.parse(resolved.to))
    }
  })
})

describe('the zone is the site’s, and it changes the answer', () => {
  it('today in Asia/Baku is not today in UTC', () => {
    // Baku is UTC+4 all year. Its calendar day therefore starts four hours
    // before UTC's, and a widget that cut in UTC would show the owner's "today"
    // shifted by a third of a working day.
    expect(range('today', 'Asia/Baku')).toEqual({
      from: '2026-08-06T20:00:00.000Z',
      to: '2026-08-07T20:00:00.000Z',
    })
    expect(range('today', 'Asia/Baku')).not.toEqual(range('today', 'UTC'))
  })

  it('shifts every calendar-cut key, and leaves the rolling one alone', () => {
    // `24h` is measured from the instant, so the zone cannot move it. Every
    // other key is a calendar boundary and must move.
    expect(range('24h', 'Asia/Baku')).toEqual(range('24h', 'UTC'))
    for (const key of ['today', 'yesterday', '7d', '30d', '90d', '6mo', '12mo'] as const) {
      expect(range(key, 'Asia/Baku'), key).not.toEqual(range(key, 'UTC'))
    }
  })
})

describe('a zone that shifts under the range (DST)', () => {
  /**
   * Europe/Berlin leaves summer time at 03:00 local on 2026-10-25, so that
   * local day is **25 hours** long. A resolver doing `start - 86_400_000` would
   * put `yesterday`'s boundary an hour out and hand the gateway a range whose
   * first bucket belongs to the wrong day.
   */
  const DST_NOW = new Date('2026-10-25T12:00:00.000Z')
  const berlin = (key: WidgetRange) =>
    resolveWidgetRange({ range: key, timezone: 'Europe/Berlin', now: DST_NOW, firstEventAt: null })

  it('cuts the 25-hour day at its real local boundaries', () => {
    const today = berlin('today')
    expect(today).toEqual({
      // 00:00 local while still CEST (+02:00) …
      from: '2026-10-24T22:00:00.000Z',
      // … and the next midnight already on CET (+01:00).
      to: '2026-10-25T23:00:00.000Z',
    })
    expect(Date.parse(today.to) - Date.parse(today.from)).toBe(25 * 3_600_000)
  })

  it('keeps the preceding day at its own 24 hours', () => {
    const yesterday = berlin('yesterday')
    expect(yesterday.to).toBe('2026-10-24T22:00:00.000Z')
    expect(Date.parse(yesterday.to) - Date.parse(yesterday.from)).toBe(24 * 3_600_000)
  })

  it('spans a week across the transition without losing the hour', () => {
    // Six days back from a 25-hour day: the span is 7 days plus the repeated
    // hour, which is what a zone-aware cut produces and a naive one does not.
    const week = berlin('7d')
    expect(Date.parse(week.to) - Date.parse(week.from)).toBe(7 * 86_400_000 + 3_600_000)
  })

  /**
   * **A zone whose transition falls inside its own UTC offset window**, which is
   * the only case that needs the resolver's *second* offset pass — and the only
   * case that proves it exists.
   *
   * Berlin above does not: its transitions are at 01:00 UTC, comfortably outside
   * the two hours between local midnight and the UTC instant that names it, so a
   * single-pass resolver gets Berlin exactly right. New Zealand ends daylight
   * time at 14:00 UTC on the 5th, so at 2025-04-06T00:00Z — the UTC instant of
   * the wall time "2025-04-06 00:00" — the zone is already on `+12`, while local
   * midnight itself happened an hour earlier on `+13`. One pass subtracts the
   * wrong offset and lands at 01:00 local; the second re-reads the offset at the
   * instant the first produced and converges on midnight.
   *
   * Verified by breaking it: with the second pass removed, every other test in
   * this file still passed and this one failed.
   */
  it('converges on local midnight in a zone that shifts across it', () => {
    const resolved = resolveWidgetRange({
      range: 'today',
      timezone: 'Pacific/Auckland',
      // Midday on 6 April 2025 in Auckland — the 25-hour day.
      now: new Date('2025-04-06T00:00:00.000Z'),
      firstEventAt: null,
    })
    expect(resolved).toEqual({
      // 00:00 on the 6th, still on NZDT (+13).
      from: '2025-04-05T11:00:00.000Z',
      // 00:00 on the 7th, on NZST (+12).
      to: '2025-04-06T12:00:00.000Z',
    })
    expect(Date.parse(resolved.to) - Date.parse(resolved.from)).toBe(25 * 3_600_000)
  })
})

describe('all anchors at the first event, never at a creation date', () => {
  it('starts at the local day the first event fell in', () => {
    const first = new Date('2026-06-02T08:14:09.221Z')
    expect(range('all', 'UTC', first)).toEqual({
      from: '2026-06-02T00:00:00.000Z',
      to: '2026-08-08T00:00:00.000Z',
    })
  })

  it('anchors that day in the site’s zone, not in UTC', () => {
    // 00:30 UTC on 2 June is 04:30 on 2 June in Baku, so both zones name the
    // same calendar day — and the *instant* the day starts at differs.
    const first = new Date('2026-06-02T00:30:00.000Z')
    expect(range('all', 'Asia/Baku', first).from).toBe('2026-06-01T20:00:00.000Z')
  })

  it('a site with no first event gets a zero-width window, not an invented start', () => {
    // ADR-0045 D10. The dashboard falls back to a trailing twelve months while
    // it waits for the anchor; a widget must not, because a fallback range on
    // somebody else's page is a chart that silently claims a year of nothing.
    const resolved = range('all', 'UTC', null)
    expect(resolved.from).toBe(resolved.to)
    expect(resolved).not.toEqual(range('12mo', 'UTC'))
  })
})

describe('the grain is a function of the range (ADR-0045, D10)', () => {
  it('is hour for the three short keys, day for the three day keys, week beyond', () => {
    expect(WIDGET_RANGE_GRAIN).toEqual({
      today: 'hour',
      yesterday: 'hour',
      '24h': 'hour',
      '7d': 'day',
      '30d': 'day',
      '90d': 'day',
      '6mo': 'week',
      '12mo': 'week',
      all: 'week',
    })
  })

  it('names a grain for every key, and never `minute`', () => {
    // `minute` is the grain ADR-0039 D8 exists because of: a 24-hour range at
    // minute grain is ~1 440 buckets, and an embed has no interval picker and
    // no client-side re-bucketing to recover from it.
    for (const key of WIDGET_RANGES) {
      expect(WIDGET_RANGE_GRAIN[key], key).toBeDefined()
      expect(WIDGET_RANGE_GRAIN[key], key).not.toBe('minute')
    }
  })
})

describe('the widget read’s typed config (ADR-0045, D5 and D12)', () => {
  it('carries the share surface’s own budget, deliberately', () => {
    const config = loadWidgetReadConfig({})
    // ADR-0045 D5: the same numbers as `PUBLIC_READ_RATE_LIMIT_*`, because a
    // second pair of values would assert a difference nobody has measured.
    expect(config.WIDGET_READ_RATE_LIMIT_PER_MINUTE).toBe(60)
    expect(config.WIDGET_READ_RATE_LIMIT_BURST).toBe(120)
  })

  it('states the staleness bound rather than promising invalidation', () => {
    const config = loadWidgetReadConfig({})
    expect(config.WIDGET_READ_CACHE_MAX_AGE_SECONDS).toBe(60)
    // Ten seconds on realtime: a minute-old "now" is a wrong number rather
    // than a stale one.
    expect(config.WIDGET_REALTIME_CACHE_MAX_AGE_SECONDS).toBe(10)
  })

  it('reads every value from the environment', () => {
    const config = loadWidgetReadConfig({
      WIDGET_READ_RATE_LIMIT_PER_MINUTE: '10',
      WIDGET_READ_RATE_LIMIT_BURST: '20',
      WIDGET_READ_CACHE_MAX_AGE_SECONDS: '5',
      WIDGET_REALTIME_CACHE_MAX_AGE_SECONDS: '1',
    })
    expect(config).toEqual({
      WIDGET_READ_RATE_LIMIT_PER_MINUTE: 10,
      WIDGET_READ_RATE_LIMIT_BURST: 20,
      WIDGET_READ_CACHE_MAX_AGE_SECONDS: 5,
      WIDGET_REALTIME_CACHE_MAX_AGE_SECONDS: 1,
    })
  })

  it('admits zero (an operator turning the cache off) and refuses a nonsense age', () => {
    // `max-age=0` is a real choice — "revalidate every time" — and the direction
    // this bound must fail in is *long*, not short: a widget cached for a day
    // would outlive several revocations.
    expect(
      widgetReadConfigSchema.safeParse({ WIDGET_READ_CACHE_MAX_AGE_SECONDS: '0' }).success,
    ).toBe(true)
    expect(
      widgetReadConfigSchema.safeParse({ WIDGET_READ_CACHE_MAX_AGE_SECONDS: '-1' }).success,
    ).toBe(false)
    expect(
      widgetReadConfigSchema.safeParse({ WIDGET_READ_CACHE_MAX_AGE_SECONDS: '4000' }).success,
    ).toBe(false)
  })
})
