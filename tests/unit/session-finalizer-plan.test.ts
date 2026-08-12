import { sessionize, type CanonicalSession, type SessionizerEvent } from '@openanalytics/domain'
import type { StoredRollupBucket, StoredSessionFact } from '@openanalytics/clickhouse'
import { describe, expect, it } from 'vitest'
import {
  hourBucketMs,
  planRollupSwap,
  planSessionFacts,
} from '../../apps/worker/src/sessions/plan.ts'

/**
 * The session finalizer's pure planning core (plan Milestone 8 items 2-4; docs
 * snapshot 05, D-211). Milestone 8 Checkpoint B.
 *
 * These prove the diff-and-version logic that the acceptance criteria rest on,
 * without any ClickHouse: given what the pure sessionizer recomputed and what is
 * stored, the plan writes a new version only for a genuine change, a tombstone
 * for a vanished id, and nothing at all for an unchanged range.
 */

const INACTIVITY_MS = 30 * 60_000
const LATENESS_MS = 24 * 60 * 60_000
const HORIZON_SLACK_MS = INACTIVITY_MS + LATENESS_MS

const SITE = '11111111-1111-1111-1111-111111111111'

/** A stored fact mirroring `readStoredFacts`, built from a canonical session. */
function storedFrom(
  session: CanonicalSession,
  version: number,
  /**
   * `preExtension` mirrors a row written BEFORE ClickHouse migration 0017 added
   * `utm_content`/`utm_term`: ClickHouse fills an added column with its type
   * default in older parts, so such a row reads back with both as `''`.
   */
  opts: { finalized?: boolean; retracted?: boolean; preExtension?: boolean } = {},
): StoredSessionFact {
  return {
    sessionId: session.sessionId,
    version,
    startMs: session.startMs,
    endMs: session.endMs,
    visitorId: session.visitorId,
    userId: session.userId,
    anonymousId: session.anonymousId,
    sessionHint: session.sessionHint,
    midnightBridged: session.midnightBridged ? 1 : 0,
    pageviews: session.pageviews,
    engaged: session.engaged ? 1 : 0,
    activeDurationMs: session.activeDurationMs,
    sessionDurationMs: session.sessionDurationMs,
    entryPagePath: session.entryPagePath,
    exitPagePath: session.exitPagePath,
    referrerDomain: session.referrerDomain,
    utmSource: session.utmSource,
    utmMedium: session.utmMedium,
    utmCampaign: session.utmCampaign,
    utmContent: opts.preExtension ? '' : session.utmContent,
    utmTerm: opts.preExtension ? '' : session.utmTerm,
    deviceType: session.deviceType,
    browser: session.browser,
    os: session.os,
    country: session.country,
    finalized: opts.finalized ? 1 : 0,
    retracted: opts.retracted ? 1 : 0,
  }
}

function pageView(id: string, iso: string): SessionizerEvent {
  return {
    eventId: id,
    type: 'page_view',
    occurredAt: iso,
    anonymousId: 'anonA',
    sessionHint: 'hintA',
    pagePath: '/',
  }
}

describe('planSessionFacts', () => {
  it('flips a provisional bounce to an engaged new version when a late pageview lands', () => {
    // Criterion 1: a single pageview is a provisional bounce; the second pageview
    // arriving later must produce a higher engaged version on the SAME id.
    const first = [pageView('e1', '2026-07-23T10:00:00.000Z')]
    const [provisional] = sessionize(SITE, first)
    expect(provisional!.bounced).toBe(true)
    const stored = [storedFrom(provisional!, 1, { finalized: false })]

    const withLate = [...first, pageView('e2', '2026-07-23T10:04:00.000Z')]
    const recomputed = sessionize(SITE, withLate)
    expect(recomputed[0]!.sessionId).toBe(provisional!.sessionId)
    expect(recomputed[0]!.engaged).toBe(true)

    // "now" long past the horizon so the flipped session finalizes in one shot.
    const nowMs = Date.parse('2026-07-25T11:00:00.000Z')
    const plan = planSessionFacts({
      siteId: SITE,
      recomputed,
      stored,
      nowMs,
      inactivityMs: INACTIVITY_MS,
      latenessMs: LATENESS_MS,
    })

    expect(plan.changed).toBe(1)
    expect(plan.retracted).toBe(0)
    expect(plan.version).toBe(2)
    const row = plan.factRows[0]!
    expect(row.session_id).toBe(provisional!.sessionId)
    expect(row.engaged).toBe(1)
    expect(row.pageviews).toBe(2)
    expect(row.finalized).toBe(1)
    expect(row.retracted).toBe(0)
    // The whole session is behind the horizon, so nothing is provisional.
    expect(plan.finalizedThroughMs).toBe(nowMs - HORIZON_SLACK_MS)
  })

  it('writes nothing when the recompute is byte-identical to what is stored', () => {
    // Criterion 2: a re-run over an unchanged range is a no-op.
    const events = [
      pageView('e1', '2026-07-23T10:00:00.000Z'),
      pageView('e2', '2026-07-23T10:04:00.000Z'),
    ]
    const recomputed = sessionize(SITE, events)
    const nowMs = Date.parse('2026-07-25T11:00:00.000Z')
    const finalized = recomputed[0]!.endMs <= nowMs - HORIZON_SLACK_MS
    const stored = [storedFrom(recomputed[0]!, 7, { finalized })]

    const plan = planSessionFacts({
      siteId: SITE,
      recomputed,
      stored,
      nowMs,
      inactivityMs: INACTIVITY_MS,
      latenessMs: LATENESS_MS,
    })

    expect(plan.factRows).toHaveLength(0)
    expect(plan.changed).toBe(0)
    expect(plan.retracted).toBe(0)
    expect(plan.affectedHourBucketsMs).toHaveLength(0)
  })

  it('emits a new finalized version when only the finalized flag flips', () => {
    // The engagement is unchanged but the horizon has now passed the session, so
    // finalized 0 -> 1 is itself a change worth a version.
    const events = [
      pageView('e1', '2026-07-23T10:00:00.000Z'),
      pageView('e2', '2026-07-23T10:04:00.000Z'),
    ]
    const recomputed = sessionize(SITE, events)
    const stored = [storedFrom(recomputed[0]!, 1, { finalized: false })]

    const nowMs = Date.parse('2026-07-25T11:00:00.000Z')
    const plan = planSessionFacts({
      siteId: SITE,
      recomputed,
      stored,
      nowMs,
      inactivityMs: INACTIVITY_MS,
      latenessMs: LATENESS_MS,
    })
    expect(plan.changed).toBe(1)
    expect(plan.factRows[0]!.finalized).toBe(1)
  })

  it('keeps a recent session provisional and caps the watermark at the horizon', () => {
    const events = [
      pageView('e1', '2026-07-24T10:00:00.000Z'),
      pageView('e2', '2026-07-24T10:04:00.000Z'),
    ]
    const recomputed = sessionize(SITE, events)
    // "now" only minutes after the session, well inside the 24h lateness window.
    const nowMs = Date.parse('2026-07-24T10:30:00.000Z')
    const plan = planSessionFacts({
      siteId: SITE,
      recomputed,
      stored: [],
      nowMs,
      inactivityMs: INACTIVITY_MS,
      latenessMs: LATENESS_MS,
    })
    expect(plan.factRows[0]!.finalized).toBe(0)
    // The session starts after the horizon, so the horizon caps the watermark.
    expect(plan.finalizedThroughMs).toBe(nowMs - HORIZON_SLACK_MS)
  })

  it('pulls the watermark back to a provisional session that straddles the horizon', () => {
    // A session whose start is before the horizon but whose end is after it is
    // still provisional; the next window must re-read from its start, so the
    // watermark is pulled back below the horizon.
    const events = [
      pageView('e1', '2026-07-23T10:20:00.000Z'),
      pageView('e2', '2026-07-23T10:45:00.000Z'),
    ]
    const recomputed = sessionize(SITE, events)
    const nowMs = Date.parse('2026-07-24T11:00:00.000Z')
    const horizonMs = nowMs - HORIZON_SLACK_MS // 2026-07-23T10:30:00Z
    expect(recomputed[0]!.startMs).toBeLessThan(horizonMs)
    expect(recomputed[0]!.endMs).toBeGreaterThan(horizonMs)

    const plan = planSessionFacts({
      siteId: SITE,
      recomputed,
      stored: [],
      nowMs,
      inactivityMs: INACTIVITY_MS,
      latenessMs: LATENESS_MS,
    })
    expect(plan.factRows[0]!.finalized).toBe(0)
    expect(plan.finalizedThroughMs).toBe(recomputed[0]!.startMs)
  })

  // The watermark must be pulled back so that no recomputed session's span
  // straddles it: the next `>= watermark` window would otherwise bisect an
  // overlapping session and duplicate its tail (audit finding).
  const oneSession = (anon: string, isos: readonly string[]): CanonicalSession => {
    const events: SessionizerEvent[] = isos.map((iso, i) => ({
      eventId: `${anon}-${i}`,
      type: 'page_view',
      occurredAt: iso,
      anonymousId: anon,
      sessionHint: anon,
      pagePath: '/',
    }))
    return sessionize(SITE, events)[0]!
  }

  // "now" a day later so the horizon is 2026-07-24T11:30:00Z.
  const NOW_MS = Date.parse('2026-07-25T12:00:00.000Z')

  it('pulls the watermark back past a finalized session overlapping the earliest provisional one', () => {
    // P is a long-lived provisional session straddling the horizon; its start is
    // the naive watermark candidate. F is an already-finalized session of a
    // DIFFERENT visitor whose span overlaps P.start — reading from P.start would
    // bisect F and duplicate its tail.
    const p = oneSession('botP', ['2026-07-24T11:10:00.000Z', '2026-07-24T11:35:00.000Z'])
    const f = oneSession('visitorF', ['2026-07-24T11:00:00.000Z', '2026-07-24T11:20:00.000Z'])
    const horizonMs = NOW_MS - HORIZON_SLACK_MS
    expect(p.endMs).toBeGreaterThan(horizonMs) // provisional
    expect(f.endMs).toBeLessThanOrEqual(horizonMs) // finalized
    expect(f.startMs).toBeLessThan(p.startMs)
    expect(f.endMs).toBeGreaterThanOrEqual(p.startMs) // overlaps P.start

    const plan = planSessionFacts({
      siteId: SITE,
      recomputed: [p, f],
      stored: [],
      nowMs: NOW_MS,
      inactivityMs: INACTIVITY_MS,
      latenessMs: LATENESS_MS,
    })
    // Not P.start (the naive candidate) — pulled back to F.start.
    expect(plan.finalizedThroughMs).toBe(f.startMs)
  })

  it('walks the pull-back to a fixpoint through a chain of overlapping sessions', () => {
    // F1 straddles P.start; F2 straddles F1.start. Only a fixpoint loop reaches
    // F2.start — a single pass keyed on the original candidate would stop at F1.
    const p = oneSession('botP', ['2026-07-24T11:10:00.000Z', '2026-07-24T11:35:00.000Z'])
    const f1 = oneSession('visitorF1', ['2026-07-24T11:00:00.000Z', '2026-07-24T11:20:00.000Z'])
    const f2 = oneSession('visitorF2', ['2026-07-24T10:50:00.000Z', '2026-07-24T11:05:00.000Z'])
    expect(f1.startMs).toBeLessThan(p.startMs)
    expect(f1.endMs).toBeGreaterThanOrEqual(p.startMs)
    expect(f2.startMs).toBeLessThan(f1.startMs)
    expect(f2.endMs).toBeGreaterThanOrEqual(f1.startMs)

    const plan = planSessionFacts({
      siteId: SITE,
      recomputed: [p, f1, f2],
      stored: [],
      nowMs: NOW_MS,
      inactivityMs: INACTIVITY_MS,
      latenessMs: LATENESS_MS,
    })
    expect(plan.finalizedThroughMs).toBe(f2.startMs)
  })

  it('pulls back for a session whose last event is exactly at the candidate watermark', () => {
    // F.end === P.start === the candidate watermark: an event at occurred_at == wm
    // is included by the next `>=` read, so this must pull back (the endMs >= wm
    // boundary, not >).
    const p = oneSession('botP', ['2026-07-24T11:10:00.000Z', '2026-07-24T11:35:00.000Z'])
    const f = oneSession('visitorF', ['2026-07-24T10:55:00.000Z', '2026-07-24T11:10:00.000Z'])
    expect(f.endMs).toBe(p.startMs) // ends exactly on the candidate watermark

    const plan = planSessionFacts({
      siteId: SITE,
      recomputed: [p, f],
      stored: [],
      nowMs: NOW_MS,
      inactivityMs: INACTIVITY_MS,
      latenessMs: LATENESS_MS,
    })
    expect(plan.finalizedThroughMs).toBe(f.startMs)
  })

  it('retracts a stored session that the recompute no longer produces', () => {
    // A stored, non-retracted session id absent from the recompute becomes a
    // tombstone at a higher version (migration 0013's contract).
    const goneEvents = [pageView('gone', '2026-07-23T09:00:00.000Z')]
    const [gone] = sessionize(SITE, goneEvents)
    const liveEvents = [pageView('live', '2026-07-23T10:00:00.000Z')]
    const recomputed = sessionize(SITE, liveEvents)

    const stored = [
      storedFrom(gone!, 3, { finalized: true }),
      storedFrom(recomputed[0]!, 3, { finalized: true }),
    ]

    const nowMs = Date.parse('2026-07-25T11:00:00.000Z')
    const plan = planSessionFacts({
      siteId: SITE,
      recomputed,
      stored,
      nowMs,
      inactivityMs: INACTIVITY_MS,
      latenessMs: LATENESS_MS,
    })

    expect(plan.retracted).toBe(1)
    const tombstone = plan.factRows.find((row) => row.session_id === gone!.sessionId)
    expect(tombstone).toBeDefined()
    expect(tombstone!.retracted).toBe(1)
    expect(tombstone!.version).toBe(4)
    // The vanished session's bucket is affected — the rollup must lose it.
    expect(plan.affectedHourBucketsMs).toContain(hourBucketMs(gone!.startMs))
  })

  it('resurrects a previously-retracted session that reappears in the recompute', () => {
    const events = [pageView('e1', '2026-07-23T10:00:00.000Z')]
    const recomputed = sessionize(SITE, events)
    // Stored latest is a tombstone; the session is back in the recompute.
    const stored = [storedFrom(recomputed[0]!, 5, { finalized: true, retracted: true })]

    const nowMs = Date.parse('2026-07-25T11:00:00.000Z')
    const plan = planSessionFacts({
      siteId: SITE,
      recomputed,
      stored,
      nowMs,
      inactivityMs: INACTIVITY_MS,
      latenessMs: LATENESS_MS,
    })
    expect(plan.changed).toBe(1)
    const row = plan.factRows[0]!
    expect(row.retracted).toBe(0)
    expect(row.version).toBe(6)
  })

  it('does not inflate active duration when a duration beacon is duplicated', () => {
    // Criterion 3, at the sessionizer the finalizer drives: two engagement
    // beacons with the SAME event id collapse to one active window.
    const base: SessionizerEvent = {
      eventId: 'pv',
      type: 'page_view',
      occurredAt: '2026-07-23T10:00:00.000Z',
      anonymousId: 'anonA',
      sessionHint: 'hintA',
      pagePath: '/',
    }
    const beacon: SessionizerEvent = {
      eventId: 'beacon',
      type: 'engagement',
      occurredAt: '2026-07-23T10:00:08.000Z',
      anonymousId: 'anonA',
      sessionHint: 'hintA',
      engagement: { activeMs: 8_000, visibleMs: 8_000 },
    }
    const once = sessionize(SITE, [base, beacon])
    const twice = sessionize(SITE, [base, beacon, { ...beacon }])
    expect(twice[0]!.activeDurationMs).toBe(once[0]!.activeDurationMs)
    expect(twice[0]!.activeDurationMs).toBe(8_000)
  })
})

describe('planRollupSwap', () => {
  const bucketSeconds = Date.parse('2026-07-23T10:00:00.000Z') / 1000
  const bucketStart = '2026-07-23 10:00:00'
  const computedAtMs = Date.parse('2026-07-25T11:00:00.000Z')

  const recomputedBucket = {
    bucketSeconds,
    bucketStart,
    sessions: 3,
    engagedSessions: 2,
    bouncedSessions: 1,
    pageviews: 6,
    totalSessionDurationMs: 90_000,
    totalActiveDurationMs: 36_000,
  }

  it('swaps a changed bucket at the next generation', () => {
    const stored: StoredRollupBucket[] = [
      { ...recomputedBucket, engagedSessions: 1, bouncedSessions: 2, generation: 4 },
    ]
    const plan = planRollupSwap({
      siteId: SITE,
      recomputed: [recomputedBucket],
      stored,
      affectedBucketSeconds: [bucketSeconds],
      computedAtMs,
    })
    expect(plan.changed).toBe(1)
    expect(plan.generation).toBe(5)
    expect(plan.rows[0]!.engaged_sessions).toBe(2)
    expect(plan.rows[0]!.bounced_sessions).toBe(1)
  })

  it('writes nothing when the recomputed bucket equals the stored generation', () => {
    const stored: StoredRollupBucket[] = [{ ...recomputedBucket, generation: 4 }]
    const plan = planRollupSwap({
      siteId: SITE,
      recomputed: [recomputedBucket],
      stored,
      affectedBucketSeconds: [bucketSeconds],
      computedAtMs,
    })
    expect(plan.rows).toHaveLength(0)
    expect(plan.changed).toBe(0)
  })

  it('overwrites a stale bucket with a zero row when every session was retracted', () => {
    // The recompute produced no aggregate for the affected bucket (all sessions
    // gone), so it must overwrite the stored non-zero row with zeros.
    const stored: StoredRollupBucket[] = [{ ...recomputedBucket, generation: 4 }]
    const plan = planRollupSwap({
      siteId: SITE,
      recomputed: [],
      stored,
      affectedBucketSeconds: [bucketSeconds],
      computedAtMs,
    })
    expect(plan.changed).toBe(1)
    expect(plan.rows[0]!.sessions).toBe(0)
    expect(plan.rows[0]!.bucket_start).toBe(bucketStart)
    expect(plan.generation).toBe(5)
  })

  it('skips an affected bucket that never existed and has no sessions', () => {
    const plan = planRollupSwap({
      siteId: SITE,
      recomputed: [],
      stored: [],
      affectedBucketSeconds: [bucketSeconds],
      computedAtMs,
    })
    expect(plan.rows).toHaveLength(0)
  })
})

/**
 * The 24-hour session cap (ADR-0018) makes the watermark stall ADR-0012
 * documented impossible: a never-ending activity stream is split into ≤24h
 * sessions, so every session older than `cap + inactivity + lateness` is closable
 * and the watermark advances instead of being pinned to the stream's start.
 */
describe('planSessionFacts — 24h cap keeps the watermark advancing (ADR-0018)', () => {
  const SESSION_MAX_LENGTH_MS = 24 * 60 * 60_000

  it('advances the watermark past a perpetually-active identity instead of stalling', () => {
    // One identity, active every 30 minutes for 50h (never idle → one partition,
    // split only by the cap). Without the cap this is one session whose end keeps
    // moving, so it stays provisional and the watermark never leaves its start.
    const startMs = Date.parse('2026-07-23T00:00:00.000Z')
    const nowMs = startMs + 50 * 60 * 60_000
    const events: SessionizerEvent[] = []
    for (let ms = startMs; ms <= nowMs; ms += 30 * 60_000) {
      events.push({
        eventId: `e${String((ms - startMs) / 60_000).padStart(6, '0')}`,
        type: 'page_view',
        occurredAt: new Date(ms).toISOString(),
        anonymousId: 'kioskA',
        userId: 'kioskUser',
        sessionHint: 'kioskhint',
        pagePath: '/',
      })
    }
    const recomputed = sessionize(SITE, events)
    // Three ≤24h sessions: [0,24h), [24h,48h), [48h,50h].
    expect(recomputed).toHaveLength(3)
    for (const s of recomputed) expect(s.sessionDurationMs).toBeLessThan(SESSION_MAX_LENGTH_MS)

    const plan = planSessionFacts({
      siteId: SITE,
      recomputed,
      stored: [],
      nowMs,
      inactivityMs: INACTIVITY_MS,
      latenessMs: LATENESS_MS,
      sessionMaxLengthMs: SESSION_MAX_LENGTH_MS,
    })

    const firstStart = recomputed[0]!.startMs
    const earliestProvisionalStart = recomputed[1]!.startMs
    // The watermark advanced to the earliest still-open session — well past the
    // stream's start, where it would have stalled without the cap.
    expect(plan.finalizedThroughMs).toBe(earliestProvisionalStart)
    expect(plan.finalizedThroughMs).toBeGreaterThan(firstStart)
    // Bounded: never below now - (cap + inactivity + lateness).
    expect(plan.finalizedThroughMs).toBeGreaterThanOrEqual(
      nowMs - (SESSION_MAX_LENGTH_MS + INACTIVITY_MS + LATENESS_MS),
    )
  })

  it('marks a session older than the cap horizon as finalized even if its end is recent', () => {
    // Defence in depth for the plan itself: a session whose start predates
    // cap + inactivity + lateness is closable by definition (ADR-0018), so its
    // fact row is written finalized regardless of a still-recent end. A degenerate
    // over-cap session (start ≥ 48h ago) exercises the cap-horizon branch that a
    // correctly-capped sessionizer never reaches via the end-vs-horizon test.
    const base = sessionize(SITE, [pageView('p', '2026-07-23T00:00:00.000Z')])[0]!
    const longSession: CanonicalSession = {
      ...base,
      startMs: Date.parse('2026-07-23T00:00:00.000Z'),
      endMs: Date.parse('2026-07-25T00:00:00.000Z'),
    }
    const nowMs = Date.parse('2026-07-25T01:00:00.000Z')

    // No cap threaded: end is past the horizon → provisional (pre-ADR-0018).
    const uncapped = planSessionFacts({
      siteId: SITE,
      recomputed: [longSession],
      stored: [],
      nowMs,
      inactivityMs: INACTIVITY_MS,
      latenessMs: LATENESS_MS,
    })
    expect(uncapped.factRows[0]!.finalized).toBe(0)

    // Cap threaded: start predates cap+inactivity+lateness → closable → finalized.
    const capped = planSessionFacts({
      siteId: SITE,
      recomputed: [longSession],
      stored: [],
      nowMs,
      inactivityMs: INACTIVITY_MS,
      latenessMs: LATENESS_MS,
      sessionMaxLengthMs: SESSION_MAX_LENGTH_MS,
    })
    expect(capped.factRows[0]!.finalized).toBe(1)
  })
})

/**
 * The `utm_content` / `utm_term` extension (ADR-0033 D6, ClickHouse migration
 * 0017). Milestone 12 CP4.
 *
 * The migration adds two columns to a table with rows already in it, and the
 * question that decides whether it is safe is entirely about the fingerprint: a
 * comparison that treated every pre-extension row as different would make the
 * first finalizer pass after the deploy re-version every session in every live
 * window on every site at once. These three tests are that safety argument.
 */
describe('planSessionFacts — the migration 0017 session-fact widening', () => {
  function utmPageView(id: string, iso: string, utm: Partial<SessionizerEvent>): SessionizerEvent {
    return { ...pageView(id, iso), ...utm }
  }

  it('writes nothing for a pre-extension row whose session carried no utm_content/term', () => {
    // The whole point. ClickHouse fills an added `LowCardinality(String)` with
    // `''` in parts written before the ALTER, and `sessionize` normalizes an
    // absent utm to `''` — the two spellings of absence are the same byte, so
    // the recompute compares EQUAL and the pass is a no-op.
    const events = [pageView('e1', '2026-07-23T10:00:00.000Z')]
    const [session] = sessionize(SITE, events)
    expect(session!.utmContent).toBe('')

    const plan = planSessionFacts({
      siteId: SITE,
      recomputed: [session!],
      stored: [storedFrom(session!, 1, { finalized: true, preExtension: true })],
      nowMs: Date.parse('2026-07-25T11:00:00.000Z'),
      inactivityMs: INACTIVITY_MS,
      latenessMs: LATENESS_MS,
    })

    expect(plan.changed).toBe(0)
    expect(plan.retracted).toBe(0)
    expect(plan.factRows).toHaveLength(0)
  })

  it('re-versions a pre-extension row whose session DID carry one', () => {
    // The other half: this row is genuinely missing data, so a new version is
    // correct rather than churn. The blast radius is the live recompute window —
    // sessions below the site's watermark are never re-read at all.
    const events = [
      utmPageView('e1', '2026-07-23T10:00:00.000Z', {
        utmSource: 'google',
        utmContent: 'banner-a',
        utmTerm: 'analytics',
      }),
    ]
    const [session] = sessionize(SITE, events)
    expect(session!.utmContent).toBe('banner-a')

    const plan = planSessionFacts({
      siteId: SITE,
      recomputed: [session!],
      stored: [storedFrom(session!, 1, { finalized: true, preExtension: true })],
      nowMs: Date.parse('2026-07-25T11:00:00.000Z'),
      inactivityMs: INACTIVITY_MS,
      latenessMs: LATENESS_MS,
    })

    expect(plan.changed).toBe(1)
    expect(plan.version).toBe(2)
    expect(plan.factRows[0]!.utm_content).toBe('banner-a')
    expect(plan.factRows[0]!.utm_term).toBe('analytics')
  })

  it('carries both columns into fact rows and into a retraction tombstone', () => {
    // A tombstone carries the vanished session's last-known dimensions rather
    // than zeros (migration 0013's contract), so the two new columns have to
    // travel with it — a diagnostic read of the tombstone is otherwise missing
    // exactly the fields the attribution layer reads.
    const events = [
      utmPageView('e1', '2026-07-23T10:00:00.000Z', {
        utmContent: 'banner-a',
        utmTerm: 'analytics',
      }),
    ]
    const [session] = sessionize(SITE, events)

    const plan = planSessionFacts({
      siteId: SITE,
      // The session vanished from the recompute (a late earlier event re-keyed it).
      recomputed: [],
      stored: [storedFrom(session!, 3, { finalized: true })],
      nowMs: Date.parse('2026-07-25T11:00:00.000Z'),
      inactivityMs: INACTIVITY_MS,
      latenessMs: LATENESS_MS,
    })

    expect(plan.retracted).toBe(1)
    const tombstone = plan.factRows[0]!
    expect(tombstone.retracted).toBe(1)
    expect(tombstone.utm_content).toBe('banner-a')
    expect(tombstone.utm_term).toBe('analytics')
  })
})
