import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SESSION_CONFIG,
  isEngaged,
  loadSessionConfig,
  mergedActiveDurationMs,
  sessionize,
  type SessionizerEvent,
} from '@openanalytics/domain'

/**
 * The canonical sessionizer and its metric definitions (docs snapshot 02 §10;
 * 04 Milestone 8 items 1, 5 and 8; docs snapshot 05, D-211 and D-102).
 *
 * These are the invariants the whole session layer is built to make provable —
 * written before the finalizer (Checkpoint B) and read layer (Checkpoint C) so
 * both inherit a single reference:
 *
 *   1. A late second pageview flips a bounced session to engaged (D-211).
 *   2. A late engagement beacon flips a bounced session to engaged (D-211).
 *   3. A duplicate/overlapping duration message does not inflate active time.
 *   4. Out-of-order SPA pageviews produce the same sessions as in-order — the
 *      pure function is order-insensitive with a deterministic tie-break.
 */

const SITE = '11111111-1111-1111-1111-111111111111'

function pageView(over: Partial<SessionizerEvent> & { eventId: string }): SessionizerEvent {
  return {
    type: 'page_view',
    occurredAt: '2026-07-23T10:00:00.000Z',
    anonymousId: 'anonA',
    sessionHint: 'hintA',
    pagePath: '/',
    ...over,
  }
}

function at(iso: string): string {
  return iso
}

describe('loadSessionConfig', () => {
  it('tolerates a real process env full of unrelated keys', () => {
    // The worker calls loadSessionConfig() over the whole process.env; a strict
    // schema rejected FLY_*/PATH/etc. and crashed the worker at startup.
    const config = loadSessionConfig({
      PATH: '/usr/bin',
      FLY_APP_NAME: 'openanalytics-worker',
      DATABASE_URL: 'postgres://example',
      SESSION_INACTIVITY_MINUTES: '45',
    })
    expect(config.SESSION_INACTIVITY_MINUTES).toBe(45)
    expect(config.ENGAGED_MIN_PAGEVIEWS).toBe(DEFAULT_SESSION_CONFIG.ENGAGED_MIN_PAGEVIEWS)
  })
})

describe('mergedActiveDurationMs', () => {
  it('sums distinct non-overlapping active windows', () => {
    expect(
      mergedActiveDurationMs([
        { eventId: 'e1', occurredMs: 5_000, activeMs: 5_000 },
        { eventId: 'e2', occurredMs: 20_000, activeMs: 5_000 },
      ]),
    ).toBe(10_000)
  })

  it('deduplicates a retried beacon by event_id (acceptance criterion 3)', () => {
    // The same beacon sent twice must count once, not twice.
    expect(
      mergedActiveDurationMs([
        { eventId: 'e1', occurredMs: 8_000, activeMs: 8_000 },
        { eventId: 'e1', occurredMs: 8_000, activeMs: 8_000 },
      ]),
    ).toBe(8_000)
  })

  it('merges overlapping intervals instead of summing them', () => {
    // [0,5000] and [3000,8000] overlap → union [0,8000] = 8000, not 10000.
    expect(
      mergedActiveDurationMs([
        { eventId: 'e1', occurredMs: 5_000, activeMs: 5_000 },
        { eventId: 'e2', occurredMs: 8_000, activeMs: 5_000 },
      ]),
    ).toBe(8_000)
  })

  it('ignores events without an active-time payload', () => {
    expect(mergedActiveDurationMs([{ eventId: 'e1', occurredMs: 5_000, activeMs: null }])).toBe(0)
  })
})

describe('isEngaged', () => {
  it('engages on ≥10s active time, a custom/conversion, or 2+ pageviews', () => {
    expect(
      isEngaged({ pageviews: 1, activeDurationMs: 10_000, hasMeaningfulCustomOrConversion: false }),
    ).toBe(true)
    expect(
      isEngaged({ pageviews: 1, activeDurationMs: 0, hasMeaningfulCustomOrConversion: true }),
    ).toBe(true)
    expect(
      isEngaged({ pageviews: 2, activeDurationMs: 0, hasMeaningfulCustomOrConversion: false }),
    ).toBe(true)
  })

  it('bounces a single pageview with under 10s and no meaningful event', () => {
    expect(
      isEngaged({ pageviews: 1, activeDurationMs: 9_999, hasMeaningfulCustomOrConversion: false }),
    ).toBe(false)
  })
})

describe('sessionize — session boundaries', () => {
  it('keeps pageviews under 30 minutes in one session and splits past it', () => {
    const sessions = sessionize(SITE, [
      pageView({ eventId: 'e1', occurredAt: at('2026-07-23T10:00:00.000Z') }),
      pageView({ eventId: 'e2', occurredAt: at('2026-07-23T10:20:00.000Z') }),
      // 31 minutes after e2 → a new session.
      pageView({ eventId: 'e3', occurredAt: at('2026-07-23T10:51:00.000Z') }),
    ])
    expect(sessions).toHaveLength(2)
    expect(sessions[0]!.pageviews).toBe(2)
    expect(sessions[1]!.pageviews).toBe(1)
  })

  it('treats an SPA route change as a pageview in the same session, not a new one', () => {
    const sessions = sessionize(SITE, [
      pageView({ eventId: 'e1', occurredAt: at('2026-07-23T10:00:00.000Z'), pagePath: '/' }),
      pageView({ eventId: 'e2', occurredAt: at('2026-07-23T10:00:05.000Z'), pagePath: '/pricing' }),
      pageView({ eventId: 'e3', occurredAt: at('2026-07-23T10:00:09.000Z'), pagePath: '/docs' }),
    ])
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.pageviews).toBe(3)
    expect(sessions[0]!.entryPagePath).toBe('/')
    expect(sessions[0]!.exitPagePath).toBe('/docs')
  })

  it('does not split on a hint change alone when identity and continuity hold', () => {
    // Same anonymous visitor, a second browser tab with a different hint, 2 min
    // apart. §10: a hint change alone does not split.
    const sessions = sessionize(SITE, [
      pageView({ eventId: 'e1', occurredAt: at('2026-07-23T10:00:00.000Z'), sessionHint: 'tab1' }),
      pageView({ eventId: 'e2', occurredAt: at('2026-07-23T10:02:00.000Z'), sessionHint: 'tab2' }),
    ])
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.pageviews).toBe(2)
  })

  it('merges a same-day identity rotation that shares a hint, without flagging a midnight bridge', () => {
    // Different anonymous ids on the same UTC day, same hint: one visitor whose
    // IP moved mid-visit (VPN, mobile CGNAT, an IPv6 temporary address), not two
    // people. The hint lives in per-tab `sessionStorage`, so two people cannot
    // produce the same one — measured in production: a shared hint reappearing
    // under a second id 3 seconds later from the same city.
    //
    // `midnightBridged` stays false: the flag exists to make linkage *across the
    // daily rotation* visible, and this merge does not cross a UTC date.
    const sessions = sessionize(SITE, [
      pageView({ eventId: 'e1', anonymousId: 'anonA', sessionHint: 'shared' }),
      pageView({
        eventId: 'e2',
        anonymousId: 'anonB',
        sessionHint: 'shared',
        occurredAt: at('2026-07-23T10:01:00.000Z'),
      }),
    ])
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.pageviews).toBe(2)
    expect(sessions[0]!.midnightBridged).toBe(false)
  })

  it('does not merge two same-day identities that do not share a hint', () => {
    // The guard that carries the whole rule: without a shared hint there is no
    // evidence of continuity, so a different network identity is a different
    // visitor. Two people behind one NAT land here.
    const sessions = sessionize(SITE, [
      pageView({ eventId: 'e1', anonymousId: 'anonA', sessionHint: 'hintX' }),
      pageView({
        eventId: 'e2',
        anonymousId: 'anonB',
        sessionHint: 'hintY',
        occurredAt: at('2026-07-23T10:01:00.000Z'),
      }),
    ])
    expect(sessions).toHaveLength(2)
  })

  it('does not merge a same-day identity rotation beyond the inactivity window', () => {
    // The inactivity window bounds the same-day merge exactly as it bounds the
    // midnight bridge — a sticky hint cannot chain a day into one session.
    const sessions = sessionize(SITE, [
      pageView({ eventId: 'e1', anonymousId: 'anonA', sessionHint: 'shared' }),
      pageView({
        eventId: 'e2',
        anonymousId: 'anonB',
        sessionHint: 'shared',
        occurredAt: at('2026-07-23T10:31:00.000Z'),
      }),
    ])
    expect(sessions).toHaveLength(2)
  })
})

describe('sessionize — D-102 midnight bridge', () => {
  it('bridges one anonymous visitor across the UTC-midnight rotation via the hint', () => {
    // Same client hint, two rotating anonymous ids on adjacent UTC dates, 10 min
    // apart across midnight → one session, flagged as bridged.
    const sessions = sessionize(SITE, [
      pageView({
        eventId: 'e1',
        anonymousId: 'anon-2026-07-23',
        sessionHint: 'sticky',
        occurredAt: at('2026-07-23T23:55:00.000Z'),
      }),
      pageView({
        eventId: 'e2',
        anonymousId: 'anon-2026-07-24',
        sessionHint: 'sticky',
        occurredAt: at('2026-07-24T00:05:00.000Z'),
      }),
    ])
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.pageviews).toBe(2)
    expect(sessions[0]!.midnightBridged).toBe(true)
    // Two pageviews → engaged, so the midnight split does not manufacture a bounce.
    expect(sessions[0]!.engaged).toBe(true)
  })

  it('does not bridge across midnight without a shared hint', () => {
    const sessions = sessionize(SITE, [
      pageView({
        eventId: 'e1',
        anonymousId: 'anon-2026-07-23',
        sessionHint: 'hintX',
        occurredAt: at('2026-07-23T23:55:00.000Z'),
      }),
      pageView({
        eventId: 'e2',
        anonymousId: 'anon-2026-07-24',
        sessionHint: 'hintY',
        occurredAt: at('2026-07-24T00:05:00.000Z'),
      }),
    ])
    expect(sessions).toHaveLength(2)
  })

  it('does not bridge across midnight when the gap exceeds 30 minutes', () => {
    const sessions = sessionize(SITE, [
      pageView({
        eventId: 'e1',
        anonymousId: 'anon-2026-07-23',
        sessionHint: 'sticky',
        occurredAt: at('2026-07-23T23:40:00.000Z'),
      }),
      pageView({
        eventId: 'e2',
        anonymousId: 'anon-2026-07-24',
        sessionHint: 'sticky',
        occurredAt: at('2026-07-24T00:20:00.000Z'),
      }),
    ])
    expect(sessions).toHaveLength(2)
  })
})

describe('sessionize — identity stitch (mid-visit identify)', () => {
  it('stitches an anonymous prefix onto the identified continuation, without a false bounce', () => {
    // A visitor views one page anonymously (a standalone bounce on its own),
    // then logs in and views a second page. Every event carries the anonymous id
    // anonA; the identify and post-identify events also carry the user id.
    const sessions = sessionize(SITE, [
      pageView({ eventId: 'e1', anonymousId: 'anonA', occurredAt: at('2026-07-23T10:00:00.000Z') }),
      {
        eventId: 'e2',
        type: 'identify',
        occurredAt: at('2026-07-23T10:00:05.000Z'),
        anonymousId: 'anonA',
        userId: 'userU',
        sessionHint: 'hintA',
      },
      pageView({
        eventId: 'e3',
        anonymousId: 'anonA',
        userId: 'userU',
        occurredAt: at('2026-07-23T10:00:09.000Z'),
        pagePath: '/account',
      }),
    ])
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.pageviews).toBe(2)
    expect(sessions[0]!.engaged).toBe(true) // not the false bounce a split would produce
    expect(sessions[0]!.bounced).toBe(false)
    expect(sessions[0]!.identityStitched).toBe(true)
    expect(sessions[0]!.visitorId).toBe('userU')
    expect(sessions[0]!.userId).toBe('userU')
    // The session starts at the anonymous pageview and its entry is that page.
    expect(sessions[0]!.entryPagePath).toBe('/')
  })

  it('does not stitch when the identity session carries a different device anonymous id', () => {
    // Anonymous prefix on device A, identified events on device B (anonB). No
    // shared anonymous id → the linkage is not proven → two sessions.
    const sessions = sessionize(SITE, [
      pageView({ eventId: 'e1', anonymousId: 'anonA', occurredAt: at('2026-07-23T10:00:00.000Z') }),
      pageView({
        eventId: 'e2',
        anonymousId: 'anonB',
        userId: 'userU',
        occurredAt: at('2026-07-23T10:00:05.000Z'),
      }),
    ])
    expect(sessions).toHaveLength(2)
    expect(sessions.every((s) => !s.identityStitched)).toBe(true)
  })

  it('needs no stitch when the visitor is identified from the session start', () => {
    const sessions = sessionize(SITE, [
      {
        eventId: 'e1',
        type: 'identify',
        occurredAt: at('2026-07-23T10:00:00.000Z'),
        anonymousId: 'anonA',
        userId: 'userU',
        sessionHint: 'hintA',
      },
      pageView({
        eventId: 'e2',
        anonymousId: 'anonA',
        userId: 'userU',
        occurredAt: at('2026-07-23T10:00:03.000Z'),
      }),
    ])
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.identityStitched).toBe(false)
    expect(sessions[0]!.visitorId).toBe('userU')
  })

  it('does not merge two different users sharing one device on the same day', () => {
    // Same anonymous id anonA, two different logged-in users. Identified sessions
    // never stitch to each other, so they stay two distinct sessions.
    const sessions = sessionize(SITE, [
      pageView({
        eventId: 'e1',
        anonymousId: 'anonA',
        userId: 'userA',
        occurredAt: at('2026-07-23T10:00:00.000Z'),
      }),
      pageView({
        eventId: 'e2',
        anonymousId: 'anonA',
        userId: 'userB',
        occurredAt: at('2026-07-23T10:05:00.000Z'),
      }),
    ])
    expect(sessions).toHaveLength(2)
    expect(new Set(sessions.map((s) => s.visitorId))).toEqual(new Set(['userA', 'userB']))
    expect(sessions.every((s) => !s.identityStitched)).toBe(true)
  })
})

describe('sessionize — engagement and bounce (D-211 late arrivals)', () => {
  it('a lone pageview is a bounce, and a late second pageview flips it to engaged', () => {
    const first = sessionize(SITE, [pageView({ eventId: 'e1' })])
    expect(first).toHaveLength(1)
    expect(first[0]!.bounced).toBe(true)
    expect(first[0]!.engaged).toBe(false)

    // The same event set plus a late second pageview — re-sessionized.
    const withLate = sessionize(SITE, [
      pageView({ eventId: 'e1' }),
      pageView({ eventId: 'e2', occurredAt: at('2026-07-23T10:03:00.000Z'), pagePath: '/next' }),
    ])
    expect(withLate).toHaveLength(1)
    expect(withLate[0]!.pageviews).toBe(2)
    expect(withLate[0]!.bounced).toBe(false)
    expect(withLate[0]!.engaged).toBe(true)
    // The session id is stable: it hashes the earliest event, which did not change.
    expect(withLate[0]!.sessionId).toBe(first[0]!.sessionId)
  })

  it('a late engagement beacon of ≥10s flips a bounce to engaged', () => {
    const withEngagement = sessionize(SITE, [
      pageView({ eventId: 'e1' }),
      {
        eventId: 'e2',
        type: 'engagement',
        occurredAt: at('2026-07-23T10:00:12.000Z'),
        anonymousId: 'anonA',
        sessionHint: 'hintA',
        engagement: { activeMs: 12_000, visibleMs: 12_000 },
      },
    ])
    expect(withEngagement).toHaveLength(1)
    expect(withEngagement[0]!.activeDurationMs).toBe(12_000)
    expect(withEngagement[0]!.engaged).toBe(true)
  })

  it('does not inflate active time on a duplicate engagement beacon (acceptance criterion 3)', () => {
    const sessions = sessionize(SITE, [
      pageView({ eventId: 'e1' }),
      {
        eventId: 'eng',
        type: 'engagement',
        occurredAt: at('2026-07-23T10:00:08.000Z'),
        anonymousId: 'anonA',
        sessionHint: 'hintA',
        engagement: { activeMs: 8_000, visibleMs: 8_000 },
      },
      {
        eventId: 'eng', // same id — a retry
        type: 'engagement',
        occurredAt: at('2026-07-23T10:00:08.000Z'),
        anonymousId: 'anonA',
        sessionHint: 'hintA',
        engagement: { activeMs: 8_000, visibleMs: 8_000 },
      },
    ])
    expect(sessions).toHaveLength(1)
    // 8s once, not 16s — and 8s < 10s so this one pageview is still a bounce.
    expect(sessions[0]!.activeDurationMs).toBe(8_000)
    expect(sessions[0]!.bounced).toBe(true)
  })

  it('engages on a meaningful custom event even with one pageview and no active time', () => {
    const sessions = sessionize(SITE, [
      pageView({ eventId: 'e1' }),
      {
        eventId: 'e2',
        type: 'custom_event',
        name: 'signup_started',
        occurredAt: at('2026-07-23T10:00:03.000Z'),
        anonymousId: 'anonA',
        sessionHint: 'hintA',
      },
    ])
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.engaged).toBe(true)
  })
})

describe('sessionize — determinism (acceptance criterion 4)', () => {
  const events: SessionizerEvent[] = [
    pageView({ eventId: 'e1', occurredAt: at('2026-07-23T10:00:00.000Z'), pagePath: '/' }),
    pageView({ eventId: 'e2', occurredAt: at('2026-07-23T10:00:05.000Z'), pagePath: '/pricing' }),
    pageView({ eventId: 'e3', occurredAt: at('2026-07-23T10:00:09.000Z'), pagePath: '/docs' }),
    pageView({ eventId: 'e4', occurredAt: at('2026-07-23T11:00:00.000Z'), pagePath: '/blog' }),
  ]

  it('produces the same sessions for out-of-order delivery as for in-order', () => {
    const inOrder = sessionize(SITE, events)
    const shuffled = sessionize(SITE, [events[2]!, events[0]!, events[3]!, events[1]!])
    expect(shuffled).toEqual(inOrder)
    // Two sessions: three SPA pageviews, then one an hour later.
    expect(inOrder).toHaveLength(2)
    expect(inOrder[0]!.entryPagePath).toBe('/')
    expect(inOrder[0]!.exitPagePath).toBe('/docs')
    expect(inOrder[1]!.pageviews).toBe(1)
  })

  it('breaks a same-millisecond tie deterministically by event_id', () => {
    const sameMs: SessionizerEvent[] = [
      pageView({ eventId: 'ebbb', occurredAt: at('2026-07-23T10:00:00.000Z'), pagePath: '/b' }),
      pageView({ eventId: 'eaaa', occurredAt: at('2026-07-23T10:00:00.000Z'), pagePath: '/a' }),
    ]
    const forward = sessionize(SITE, sameMs)
    const reversed = sessionize(SITE, [sameMs[1]!, sameMs[0]!])
    expect(forward).toEqual(reversed)
    // eaaa sorts before ebbb, so /a is the entry regardless of arrival order.
    expect(forward[0]!.entryPagePath).toBe('/a')
    expect(forward[0]!.exitPagePath).toBe('/b')
  })
})

describe('sessionize — identity and passive events', () => {
  it('resolves an identified visitor across rotating anonymous ids into one session', () => {
    const sessions = sessionize(SITE, [
      pageView({ eventId: 'e1', anonymousId: 'anon-day1', userId: 'user-7' }),
      pageView({
        eventId: 'e2',
        anonymousId: 'anon-day2',
        userId: 'user-7',
        occurredAt: at('2026-07-23T10:10:00.000Z'),
      }),
    ])
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.visitorId).toBe('user-7')
    expect(sessions[0]!.userId).toBe('user-7')
    // Identified rotation is not a "midnight bridge".
    expect(sessions[0]!.midnightBridged).toBe(false)
  })

  it('excludes passive web_vital and interaction events from sessionization', () => {
    const sessions = sessionize(SITE, [
      pageView({ eventId: 'e1' }),
      {
        eventId: 'wv',
        type: 'web_vital',
        occurredAt: at('2026-07-23T11:30:00.000Z'), // 90 min later, would have split
        anonymousId: 'anonA',
        sessionHint: 'hintA',
      },
      {
        eventId: 'ix',
        type: 'interaction',
        occurredAt: at('2026-07-23T11:31:00.000Z'),
        anonymousId: 'anonA',
        sessionHint: 'hintA',
      },
    ])
    // Only the pageview anchors a session; the passive events neither extend nor
    // start one.
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.pageviews).toBe(1)
    expect(sessions[0]!.eventIds).toEqual(['e1'])
  })

  it('uses the §10 default configuration constants', () => {
    expect(DEFAULT_SESSION_CONFIG.SESSION_INACTIVITY_MINUTES).toBe(30)
    expect(DEFAULT_SESSION_CONFIG.ENGAGED_MIN_ACTIVE_MS).toBe(10_000)
    expect(DEFAULT_SESSION_CONFIG.ENGAGED_MIN_PAGEVIEWS).toBe(2)
    // ADR-0018: a session lasts at most 24 hours from its first event.
    expect(DEFAULT_SESSION_CONFIG.SESSION_MAX_LENGTH_HOURS).toBe(24)
  })
})

/**
 * The 24-hour session cap (closed product decision 2026-07-25, ADR-0018). A
 * never-ending activity stream (a kiosk, a script past the bot filter) otherwise
 * produces a session that never closes, stalling the finalizer watermark and
 * growing the recompute window without bound (ADR-0012's documented open item).
 * The cap splits such a stream at `session_start + 24h`; it must never touch a
 * real sub-24h session, and the midnight bridge stays as-is under the cap.
 */
describe('sessionize — 24h session cap (ADR-0018)', () => {
  const MS_PER_HOUR = 3_600_000

  /** A continuous single-visitor stream: an event every `stepMin` minutes. */
  function stream(opts: {
    startIso: string
    minutes: number
    stepMin?: number
    anonymousId?: string
    userId?: string
    sessionHint?: string
  }): SessionizerEvent[] {
    const step = opts.stepMin ?? 1
    const startMs = Date.parse(opts.startIso)
    const events: SessionizerEvent[] = []
    for (let m = 0; m <= opts.minutes; m += step) {
      const ms = startMs + m * 60_000
      events.push({
        eventId: `e${String(m).padStart(6, '0')}`,
        type: 'page_view',
        occurredAt: new Date(ms).toISOString(),
        anonymousId: opts.anonymousId ?? 'kiosk',
        sessionHint: opts.sessionHint ?? 'kioskhint',
        pagePath: '/',
        ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
      })
    }
    return events
  }

  it('splits a 30h continuous stream into two sessions exactly at the 24h boundary', () => {
    // Events every minute for 30h. The first event at or beyond start+24h begins a
    // new session — a clean cap split, not a bridge or stitch.
    const events = stream({ startIso: '2026-07-23T00:00:00.000Z', minutes: 1800 })
    const sessions = sessionize(SITE, events)
    expect(sessions).toHaveLength(2)
    expect(sessions[0]!.startIso).toBe('2026-07-23T00:00:00.000Z')
    expect(sessions[0]!.pageviews).toBe(1440) // minutes 0..1439, all < start+24h
    expect(sessions[1]!.startIso).toBe('2026-07-24T00:00:00.000Z') // exactly start+24h
    expect(sessions[1]!.pageviews).toBe(361) // minutes 1440..1800
    expect(sessions.every((s) => !s.midnightBridged && !s.identityStitched)).toBe(true)
    for (const s of sessions) expect(s.sessionDurationMs).toBeLessThan(24 * MS_PER_HOUR)
  })

  it('keeps a 23h59m continuous stream as a single session (cap not reached)', () => {
    const events = stream({ startIso: '2026-07-23T00:00:00.000Z', minutes: 1439 })
    const sessions = sessionize(SITE, events)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.pageviews).toBe(1440) // minutes 0..1439
    expect(sessions[0]!.sessionDurationMs).toBeLessThan(24 * MS_PER_HOUR)
  })

  it('still bridges a sub-cap session across UTC midnight with the cap in force', () => {
    // The midnight bridge is unchanged for sessions under the cap (ADR-0018).
    const sessions = sessionize(SITE, [
      pageView({
        eventId: 'e1',
        anonymousId: 'anon-2026-07-23',
        sessionHint: 'sticky',
        occurredAt: at('2026-07-23T23:55:00.000Z'),
      }),
      pageView({
        eventId: 'e2',
        anonymousId: 'anon-2026-07-24',
        sessionHint: 'sticky',
        occurredAt: at('2026-07-24T00:05:00.000Z'),
      }),
    ])
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.midnightBridged).toBe(true)
    expect(sessions[0]!.sessionDurationMs).toBeLessThan(24 * MS_PER_HOUR)
  })

  it('refuses to bridge a persistent anonymous stream past the cap', () => {
    // A kiosk with a sticky hint whose anonymous id rotates at UTC midnight.
    // Bridging it day-on-day would build the never-closing session ADR-0012
    // documented; the cap refuses the bridge, so each day stays bounded.
    const startMs = Date.parse('2026-07-23T00:00:00.000Z')
    const events: SessionizerEvent[] = []
    for (let m = 0; m <= 1800; m += 1) {
      const ms = startMs + m * 60_000
      events.push({
        eventId: `e${String(m).padStart(6, '0')}`,
        type: 'page_view',
        occurredAt: new Date(ms).toISOString(),
        anonymousId: `anon-${new Date(ms).toISOString().slice(0, 10)}`,
        sessionHint: 'sticky',
        pagePath: '/',
      })
    }
    const sessions = sessionize(SITE, events)
    expect(sessions.length).toBeGreaterThanOrEqual(2)
    for (const s of sessions) expect(s.sessionDurationMs).toBeLessThan(24 * MS_PER_HOUR)
  })

  it('recomputes a 30h stream to byte-identical sessions (determinism under the cap)', () => {
    // ADR-0012's recompute/idempotency invariant must keep holding — the versioned
    // facts swap depends on it. Same input, any order, identical sessions.
    const events = stream({ startIso: '2026-07-23T00:00:00.000Z', minutes: 1800 })
    const once = sessionize(SITE, events)
    const twice = sessionize(SITE, events)
    const shuffled = sessionize(SITE, [...events].reverse())
    expect(twice).toEqual(once)
    expect(shuffled).toEqual(once)
  })

  it('breaks a tie at the cap boundary by (occurred_at, event_id)', () => {
    // Two events at exactly start+24h with different ids: the smaller id sorts
    // first and becomes session 2's entry, deterministically, in any input order.
    const base = stream({ startIso: '2026-07-23T00:00:00.000Z', minutes: 1420, stepMin: 20 })
    const boundary = '2026-07-24T00:00:00.000Z' // start + 24h
    const bZ = pageView({
      eventId: 'zzz',
      occurredAt: boundary,
      anonymousId: 'kiosk',
      sessionHint: 'kioskhint',
      pagePath: '/z',
    })
    const bA = pageView({
      eventId: 'aaa',
      occurredAt: boundary,
      anonymousId: 'kiosk',
      sessionHint: 'kioskhint',
      pagePath: '/a',
    })
    const forward = sessionize(SITE, [...base, bZ, bA])
    const reversed = sessionize(SITE, [bA, bZ, ...[...base].reverse()])
    expect(forward).toEqual(reversed)
    expect(forward).toHaveLength(2)
    // 'aaa' < 'zzz', so it is session 2's first event and entry page.
    expect(forward[1]!.eventIds[0]).toBe('aaa')
    expect(forward[1]!.entryPagePath).toBe('/a')
  })
})
