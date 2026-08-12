import {
  REVENUE_ATTRIBUTION_MODEL_VERSION,
  REVENUE_ATTRIBUTION_WINDOW_DAYS,
  REVENUE_JOURNEY_MAX_TOUCHPOINTS,
  planRevenueAttributions,
  type AttributableCharge,
  type ComputedRevenueAttribution,
  type ConversionSignal,
  type SessionTouchpoint,
  type StoredRevenueAttribution,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * The pure matcher (ADR-0033, D2a/D2b/D6). Milestone 12 CP4.
 *
 * Everything asserted here is a rule that only exists in this module, and every
 * one of them has a failure mode nothing else would catch:
 *
 * 1. **Signal precedence.** A charge that carries all three signals must be
 *    `exact`/`conversion_event`, not whichever branch happened to be written
 *    first. Getting this wrong downgrades a proven match to an inferred one.
 * 2. **One journey per order.** Two charges on one PaymentIntent must not both
 *    claim the session, or a customer's declined card doubles every
 *    converted-session number.
 * 3. **The window boundary**, pinned rather than left to arithmetic.
 * 4. **`identity_scope`**, the D2a honesty flag — a journey attributed to a
 *    daily-rotating anonymous id must SAY so.
 * 5. **Journey ordering, cap and truncation flag**, including that first touch
 *    survives the cap.
 * 6. **Fingerprint stability.** An identical recompute must write nothing, or
 *    the periodic refresh sweep rewrites every attribution every 15 minutes.
 * 7. **The late flip.** A conversion event arriving after the charge was
 *    attributed `none` must produce a NEW version — this is the single behaviour
 *    the rolling horizon exists to make possible.
 */

const DAY = 86_400_000
const CHARGE_AT = Date.parse('2026-07-30T12:00:00.000Z')

const USER = 'user-hash-aaaa'
const ANON = 'anon-hash-bbbb'

function charge(overrides: Partial<AttributableCharge> = {}): AttributableCharge {
  return {
    objectId: 'ch_1',
    provider: 'stripe',
    occurredAtMs: CHARGE_AT,
    status: 'succeeded',
    orderId: 'pi_1',
    checkoutSessionId: '',
    clientReferenceUserHash: '',
    customerIdentityUserHash: '',
    ...overrides,
  }
}

function conversion(overrides: Partial<ConversionSignal> = {}): ConversionSignal {
  return {
    orderId: 'pi_1',
    eventId: 'ev_1',
    occurredAtMs: CHARGE_AT - 1_000,
    userId: USER,
    anonymousId: ANON,
    ...overrides,
  }
}

function session(overrides: Partial<SessionTouchpoint> = {}): SessionTouchpoint {
  return {
    sessionId: 'sess_1',
    sessionStartMs: CHARGE_AT - DAY,
    userId: USER,
    anonymousId: ANON,
    referrerDomain: 'google.com',
    utmSource: 'google',
    utmMedium: 'cpc',
    utmCampaign: 'summer',
    utmContent: 'banner-a',
    utmTerm: 'analytics',
    entryPagePath: '/pricing',
    ...overrides,
  }
}

/** The stored form of a computed attribution — what a previous run left behind. */
function storedFrom(
  computed: ComputedRevenueAttribution,
  version = computed.version,
): StoredRevenueAttribution {
  return { ...computed, version }
}

function only(plan: { attributions: readonly ComputedRevenueAttribution[] }) {
  expect(plan.attributions).toHaveLength(1)
  return plan.attributions[0]!
}

describe('signal precedence (D6)', () => {
  it('prefers the conversion event over both identity joins', () => {
    // Every signal present at once. Only the strongest may decide.
    const plan = planRevenueAttributions({
      charges: [
        charge({
          clientReferenceUserHash: USER,
          customerIdentityUserHash: USER,
        }),
      ],
      conversions: [conversion()],
      sessions: [session()],
      stored: [],
    })

    const attribution = only(plan)
    expect(attribution.matchedVia).toBe('conversion_event')
    expect(attribution.confidence).toBe('exact')
    expect(attribution.modelVersion).toBe(REVENUE_ATTRIBUTION_MODEL_VERSION)
    expect(attribution.windowDays).toBe(REVENUE_ATTRIBUTION_WINDOW_DAYS)
  })

  it('prefers the client reference over the customer identity', () => {
    const plan = planRevenueAttributions({
      charges: [
        charge({ clientReferenceUserHash: USER, customerIdentityUserHash: 'user-hash-other' }),
      ],
      conversions: [],
      sessions: [session()],
      stored: [],
    })

    const attribution = only(plan)
    expect(attribution.matchedVia).toBe('client_reference')
    expect(attribution.confidence).toBe('linked')
    expect(attribution.userId).toBe(USER)
  })

  it('falls back to the customer identity when no client reference exists', () => {
    const plan = planRevenueAttributions({
      charges: [charge({ customerIdentityUserHash: USER })],
      conversions: [],
      sessions: [session()],
      stored: [],
    })

    expect(only(plan).matchedVia).toBe('customer_identity')
  })

  it('is `none` — a first-class outcome — when nothing joins', () => {
    const plan = planRevenueAttributions({
      charges: [charge()],
      conversions: [],
      sessions: [session()],
      stored: [],
    })

    const attribution = only(plan)
    expect(attribution.matchedVia).toBe('none')
    expect(attribution.confidence).toBe('none')
    expect(attribution.identityScope).toBe('')
    expect(attribution.visitorId).toBe('')
    expect(attribution.touchpointCount).toBe(0)
    expect(attribution.journey).toBe('[]')
    expect(plan.matchedVia.none).toBe(1)
  })

  it('refuses an identity join that lands on no visitor we ever saw', () => {
    // The hash IS the claim for signals 2 and 3, so a hash with no sessions
    // behind it is not a match. Signal 1 is different — see the next test — and
    // the difference is that the conversion event is independent evidence the
    // visitor existed.
    const plan = planRevenueAttributions({
      charges: [charge({ clientReferenceUserHash: 'user-hash-nobody' })],
      conversions: [],
      sessions: [session()],
      stored: [],
    })

    expect(only(plan).matchedVia).toBe('none')
  })

  it('keeps an exact match with an empty journey when no session is finalized yet', () => {
    // The purchase's own session has not been finalized. The match still holds —
    // the event proves the visitor — and the journey fills on a later pass,
    // which is a fingerprint change and therefore a new version.
    const plan = planRevenueAttributions({
      charges: [charge()],
      conversions: [conversion()],
      sessions: [],
      stored: [],
    })

    const attribution = only(plan)
    expect(attribution.confidence).toBe('exact')
    expect(attribution.touchpointCount).toBe(0)
    expect(attribution.journey).toBe('[]')
  })

  it('accepts the checkout session id and the charge id as `order_id` too', () => {
    // The documented recipe allows all three, so a site that sent `cs_…` is not
    // silently unmatchable.
    for (const [named, subject] of [
      ['cs_1', charge({ checkoutSessionId: 'cs_1' })],
      ['ch_1', charge()],
    ] as const) {
      const plan = planRevenueAttributions({
        charges: [subject],
        conversions: [conversion({ orderId: named })],
        sessions: [session()],
        stored: [],
      })
      expect(only(plan).matchedVia, named).toBe('conversion_event')
    }
  })
})

describe('REAL-LENGTH provider ids (M12 CP7 defect 1)', () => {
  /**
   * Every fixture in this file used a 4-character synthetic id (`pi_1`), and
   * that is precisely why CI never saw the production defect: the collector's
   * generic opaque-token rule only fires at 24 characters and above, so a short
   * id sailed through sanitization while every real one was stored as
   * `[redacted]` and matched nothing. 7/7 live charges attributed `none` against
   * a synthetic id that matched `exact` in 62 seconds.
   *
   * The sanitizer's own exemption is pinned in `event-sanitize.test.ts`. What
   * these cases pin is the OTHER half: that the matcher itself is length-blind,
   * so a real id flows end to end once it survives ingest. Both halves have to
   * hold, and neither is evidence for the other.
   */
  const REAL_IDS = [
    'pi_3RtZ8kQ2mNvXpL4aB7cD9eF0',
    'ch_3RtZ8kQ2mNvXpL4aB7cD9eF0',
    'cs_test_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6',
  ] as const

  it('matches a conversion event on a real PaymentIntent id', () => {
    for (const orderId of REAL_IDS) {
      expect(orderId.length, orderId).toBeGreaterThanOrEqual(24)
      const plan = planRevenueAttributions({
        charges: [charge({ orderId })],
        conversions: [conversion({ orderId })],
        sessions: [session()],
        stored: [],
        windowDays: 30,
      })
      const [attribution] = plan.attributions
      expect(attribution?.matchedVia, orderId).toBe('conversion_event')
      expect(attribution?.confidence, orderId).toBe('exact')
      expect(attribution?.firstTouch.sessionId, orderId).toBe('sess_1')
    }
  })

  it('matches on the checkout session id at its real length', () => {
    const checkoutSessionId = 'cs_test_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6'
    const plan = planRevenueAttributions({
      charges: [charge({ orderId: 'pi_3RtZ8kQ2mNvXpL4aB7cD9eF0', checkoutSessionId })],
      conversions: [conversion({ orderId: checkoutSessionId })],
      sessions: [session()],
      stored: [],
      windowDays: 30,
    })
    expect(plan.attributions[0]?.matchedVia).toBe('conversion_event')
  })

  it('matches on the charge id itself at its real length', () => {
    // The third id `oa.conversion` may carry, per the documented recipe.
    const objectId = 'ch_3RtZ8kQ2mNvXpL4aB7cD9eF0'
    const plan = planRevenueAttributions({
      charges: [charge({ objectId, orderId: '' })],
      conversions: [conversion({ orderId: objectId })],
      sessions: [session()],
      stored: [],
      windowDays: 30,
    })
    expect(plan.attributions[0]?.matchedVia).toBe('conversion_event')
  })

  it('reproduces the production failure when the id arrives redacted', () => {
    // What the live proof actually saw: the event carried `[redacted]`, so the
    // join had nothing to join on and the charge was a first-class `none`.
    const plan = planRevenueAttributions({
      charges: [charge({ orderId: 'pi_3RtZ8kQ2mNvXpL4aB7cD9eF0' })],
      conversions: [conversion({ orderId: '[redacted]' })],
      sessions: [session()],
      stored: [],
      windowDays: 30,
    })
    expect(plan.attributions[0]?.matchedVia).toBe('none')
    expect(plan.attributions[0]?.confidence).toBe('none')
  })
})

describe('one journey per order (the (session, order) grain)', () => {
  it('gives the succeeded charge the journey and leaves the failed retry unmatched', () => {
    const failed = charge({
      objectId: 'ch_failed',
      status: 'failed',
      occurredAtMs: CHARGE_AT - 60_000,
    })
    const succeeded = charge({ objectId: 'ch_ok', status: 'succeeded' })

    const plan = planRevenueAttributions({
      // Deliberately in the "wrong" order, so a rule that depended on read order
      // would fail here.
      charges: [succeeded, failed],
      conversions: [conversion()],
      sessions: [session()],
      stored: [],
    })

    const byId = new Map(plan.attributions.map((a) => [a.objectId, a]))
    expect(byId.get('ch_ok')?.matchedVia).toBe('conversion_event')
    expect(byId.get('ch_ok')?.touchpointCount).toBe(1)
    expect(byId.get('ch_failed')?.matchedVia).toBe('none')
    expect(byId.get('ch_failed')?.touchpointCount).toBe(0)
    // Both rows exist: a losing charge is still a real money object CP5 renders.
    expect(plan.attributions).toHaveLength(2)
  })

  it('breaks a same-status tie on the later occurrence, then on the object id', () => {
    const early = charge({ objectId: 'ch_b', status: 'pending', occurredAtMs: CHARGE_AT - 10_000 })
    const late = charge({ objectId: 'ch_a', status: 'pending', occurredAtMs: CHARGE_AT })

    const plan = planRevenueAttributions({
      charges: [early, late],
      conversions: [conversion()],
      sessions: [session()],
      stored: [],
    })
    const byId = new Map(plan.attributions.map((a) => [a.objectId, a]))
    expect(byId.get('ch_a')?.matchedVia).toBe('conversion_event')
    expect(byId.get('ch_b')?.matchedVia).toBe('none')

    // Identical timestamps: the lexicographically smaller id wins.
    const tied = planRevenueAttributions({
      charges: [
        charge({ objectId: 'ch_z', status: 'pending' }),
        charge({ objectId: 'ch_a', status: 'pending' }),
      ],
      conversions: [conversion()],
      sessions: [session()],
      stored: [],
    })
    const tiedById = new Map(tied.attributions.map((a) => [a.objectId, a]))
    expect(tiedById.get('ch_a')?.matchedVia).toBe('conversion_event')
    expect(tiedById.get('ch_z')?.matchedVia).toBe('none')
  })

  it('lets a refunded charge keep its journey — money did move', () => {
    const plan = planRevenueAttributions({
      charges: [
        charge({ objectId: 'ch_refunded', status: 'refunded' }),
        charge({ objectId: 'ch_failed', status: 'failed' }),
      ],
      conversions: [conversion()],
      sessions: [session()],
      stored: [],
    })
    const byId = new Map(plan.attributions.map((a) => [a.objectId, a]))
    expect(byId.get('ch_refunded')?.matchedVia).toBe('conversion_event')
  })

  it('gives a failed charge no journey even when it is alone and matched', () => {
    // Rule 0, and it stands on its own merits before it stands as a horizon
    // guard: a declined card moved no money, and a journey on it would make
    // "sessions that converted" count failures.
    const plan = planRevenueAttributions({
      charges: [charge({ objectId: 'ch_only', status: 'failed', orderId: '' })],
      conversions: [conversion({ orderId: 'ch_only' })],
      sessions: [session()],
      stored: [],
    })

    const attribution = only(plan)
    expect(attribution.matchedVia).toBe('none')
    expect(attribution.touchpointCount).toBe(0)
  })

  it('does not promote a failed sibling when the succeeded charge falls out of the horizon', () => {
    // The horizon-split hole, reproduced exactly: the rolling floor advanced past
    // the succeeded charge, so this pass sees only the later failed retry. With
    // rank-1 charges barred from ownership the retry stays `none`, and the
    // succeeded charge's stored row — below the floor and never re-read — remains
    // the order's only journey. Without the bar, both would carry one and no
    // later pass could ever correct it.
    const plan = planRevenueAttributions({
      charges: [charge({ objectId: 'ch_retry', status: 'failed', orderId: 'pi_1' })],
      conversions: [conversion()],
      sessions: [session()],
      stored: [],
    })

    expect(only(plan).matchedVia).toBe('none')
  })

  it('still lets a pending charge own a journey, for async payment methods', () => {
    // SEPA and iDEAL sit `pending` for days. Their journey has to exist before
    // settlement, so `pending` is deliberately NOT barred.
    const plan = planRevenueAttributions({
      charges: [charge({ status: 'pending' })],
      conversions: [conversion()],
      sessions: [session()],
      stored: [],
    })

    expect(only(plan).matchedVia).toBe('conversion_event')
  })

  it('does not make charges with no order id compete', () => {
    const plan = planRevenueAttributions({
      charges: [
        charge({ objectId: 'ch_1', orderId: '' }),
        charge({ objectId: 'ch_2', orderId: '' }),
      ],
      conversions: [
        conversion({ orderId: 'ch_1' }),
        conversion({ eventId: 'ev_2', orderId: 'ch_2' }),
      ],
      sessions: [session()],
      stored: [],
    })
    expect(plan.attributions.every((a) => a.matchedVia === 'conversion_event')).toBe(true)
  })
})

describe('the attribution window (D2a)', () => {
  it('includes a session starting exactly 30 days before the charge', () => {
    // The bound is CLOSED, and this test is what pins it: an open bound would
    // make the answer depend on millisecond arithmetic nobody can see.
    const plan = planRevenueAttributions({
      charges: [charge()],
      conversions: [conversion()],
      sessions: [session({ sessionStartMs: CHARGE_AT - REVENUE_ATTRIBUTION_WINDOW_DAYS * DAY })],
      stored: [],
    })
    expect(only(plan).touchpointCount).toBe(1)
  })

  it('excludes a session one millisecond older than the window', () => {
    const plan = planRevenueAttributions({
      charges: [charge()],
      conversions: [conversion()],
      sessions: [
        session({ sessionStartMs: CHARGE_AT - REVENUE_ATTRIBUTION_WINDOW_DAYS * DAY - 1 }),
      ],
      stored: [],
    })
    expect(only(plan).touchpointCount).toBe(0)
  })

  it('includes a session starting exactly at the charge and excludes one after it', () => {
    const at = planRevenueAttributions({
      charges: [charge()],
      conversions: [conversion()],
      sessions: [session({ sessionStartMs: CHARGE_AT })],
      stored: [],
    })
    expect(only(at).touchpointCount).toBe(1)

    const after = planRevenueAttributions({
      charges: [charge()],
      conversions: [conversion()],
      sessions: [session({ sessionStartMs: CHARGE_AT + 1 })],
      stored: [],
    })
    expect(only(after).touchpointCount).toBe(0)
  })
})

describe('identity scope (the D-102 honesty flag)', () => {
  it('is `identified` when the conversion event carried a user id', () => {
    const plan = planRevenueAttributions({
      charges: [charge()],
      conversions: [conversion()],
      sessions: [session()],
      stored: [],
    })
    const attribution = only(plan)
    expect(attribution.identityScope).toBe('identified')
    expect(attribution.visitorId).toBe(USER)
    expect(attribution.userId).toBe(USER)
  })

  it('is `anonymous_day` when the visitor was never identified', () => {
    const plan = planRevenueAttributions({
      charges: [charge()],
      conversions: [conversion({ userId: '' })],
      sessions: [session({ userId: '' })],
      stored: [],
    })
    const attribution = only(plan)
    expect(attribution.identityScope).toBe('anonymous_day')
    expect(attribution.visitorId).toBe(ANON)
    // No stable id: the row must not pretend to have one.
    expect(attribution.userId).toBe('')
    expect(attribution.touchpointCount).toBe(1)
  })

  it('is always `identified` for the two hash joins', () => {
    const plan = planRevenueAttributions({
      charges: [charge({ clientReferenceUserHash: USER })],
      conversions: [],
      sessions: [session()],
      stored: [],
    })
    expect(only(plan).identityScope).toBe('identified')
  })
})

describe('an identified visitor keeps their pre-identify history', () => {
  it('includes sessions from before `identify()` and makes the earliest of them first touch', () => {
    // THE headline case. `identify()` is called at checkout, so the ad click
    // that brought the customer is a session with `user_id = ''` living only
    // under their anonymous id. A user-id-only lookup would make `ft_*` name the
    // checkout session — first touch would silently become last touch, and every
    // purchase's acquisition source would read as the checkout page.
    const preIdentify = session({
      sessionId: 'sess_ad_click',
      sessionStartMs: CHARGE_AT - 5 * DAY,
      userId: '',
      anonymousId: ANON,
      referrerDomain: 'google.com',
      utmSource: 'google',
      utmCampaign: 'spring-ads',
      entryPagePath: '/landing',
    })
    const identified = session({
      sessionId: 'sess_checkout',
      sessionStartMs: CHARGE_AT - 60_000,
      userId: USER,
      anonymousId: ANON,
      referrerDomain: '',
      utmSource: '',
      utmCampaign: '',
      entryPagePath: '/checkout',
    })

    const plan = planRevenueAttributions({
      charges: [charge()],
      conversions: [conversion()],
      sessions: [identified, preIdentify],
      stored: [],
    })

    const attribution = only(plan)
    expect(attribution.identityScope).toBe('identified')
    expect(attribution.touchpointCount).toBe(2)
    expect(attribution.firstTouch.sessionId).toBe('sess_ad_click')
    expect(attribution.firstTouch.utmCampaign).toBe('spring-ads')
    expect(attribution.lastTouch.sessionId).toBe('sess_checkout')

    const journey = JSON.parse(attribution.journey) as { session_id: string }[]
    expect(journey.map((entry) => entry.session_id)).toEqual(['sess_ad_click', 'sess_checkout'])
  })

  it('does not count a stitched session twice when it is in both identity maps', () => {
    // The identity stitch gives one session BOTH a user id and an anonymous id,
    // so it appears under both lookups. Without the `session_id` dedup it would
    // be one journey entry twice, `touchpoint_count` 2 for one session, and both
    // first and last touch of a one-session journey.
    const stitched = session({
      sessionId: 'sess_stitched',
      sessionStartMs: CHARGE_AT - DAY,
      userId: USER,
      anonymousId: ANON,
    })

    const plan = planRevenueAttributions({
      charges: [charge()],
      conversions: [conversion()],
      sessions: [stitched],
      stored: [],
    })

    const attribution = only(plan)
    expect(attribution.touchpointCount).toBe(1)
    expect(JSON.parse(attribution.journey)).toHaveLength(1)
    expect(attribution.firstTouch.sessionId).toBe('sess_stitched')
    expect(attribution.lastTouch.sessionId).toBe('sess_stitched')
  })

  it('cannot recover pre-identify history from before the anonymous id rotated', () => {
    // The honest limit of `identified`, and the reason the module header words
    // the scope as "from the last anonymous-id rotation before identification
    // onward" rather than "the full 30 days". An anonymous id rotates at UTC
    // midnight (D-102), so a session two days earlier carries a DIFFERENT
    // anonymous id and there is no key that reaches it. Nothing in this design
    // may pretend otherwise — that is exactly what the honesty flag is for.
    const yesterdaysBrowser = session({
      sessionId: 'sess_older_rotation',
      sessionStartMs: CHARGE_AT - 3 * DAY,
      userId: '',
      anonymousId: 'anon-hash-from-another-day',
    })

    const plan = planRevenueAttributions({
      charges: [charge()],
      conversions: [conversion()],
      sessions: [yesterdaysBrowser, session({ sessionId: 'sess_today' })],
      stored: [],
    })

    const attribution = only(plan)
    expect(attribution.touchpointCount).toBe(1)
    expect(attribution.firstTouch.sessionId).toBe('sess_today')
  })

  it('leaves a hash-join journey starting at the first identified session', () => {
    // Signals 2 and 3 know only the hash, never an anonymous id, so they cannot
    // reach a pre-identify session at all. A weaker answer than signal 1's, and
    // one more reason the precedence order is what it is.
    const plan = planRevenueAttributions({
      charges: [charge({ clientReferenceUserHash: USER })],
      conversions: [],
      sessions: [
        session({ sessionId: 'sess_anon', sessionStartMs: CHARGE_AT - 5 * DAY, userId: '' }),
        session({ sessionId: 'sess_known', sessionStartMs: CHARGE_AT - DAY, userId: USER }),
      ],
      stored: [],
    })

    const attribution = only(plan)
    expect(attribution.touchpointCount).toBe(1)
    expect(attribution.firstTouch.sessionId).toBe('sess_known')
  })
})

describe('the journey document', () => {
  it('orders touchpoints by (session_start, session_id) and fills both touch blocks', () => {
    const plan = planRevenueAttributions({
      charges: [charge()],
      conversions: [conversion()],
      sessions: [
        session({
          sessionId: 'sess_late',
          sessionStartMs: CHARGE_AT - DAY,
          entryPagePath: '/checkout',
        }),
        session({
          sessionId: 'sess_early',
          sessionStartMs: CHARGE_AT - 10 * DAY,
          referrerDomain: 'news.ycombinator.com',
          utmSource: '',
          utmMedium: '',
          utmCampaign: '',
          utmContent: '',
          utmTerm: '',
          entryPagePath: '/',
        }),
        // Same start as `sess_late`: the id decides, deterministically.
        session({ sessionId: 'sess_a', sessionStartMs: CHARGE_AT - DAY }),
      ],
      stored: [],
    })

    const attribution = only(plan)
    expect(attribution.touchpointCount).toBe(3)
    expect(attribution.firstTouch.sessionId).toBe('sess_early')
    expect(attribution.firstTouch.referrerDomain).toBe('news.ycombinator.com')
    expect(attribution.lastTouch.sessionId).toBe('sess_late')
    expect(attribution.lastTouch.entryPage).toBe('/checkout')

    const journey = JSON.parse(attribution.journey) as { session_id: string }[]
    expect(journey.map((entry) => entry.session_id)).toEqual(['sess_early', 'sess_a', 'sess_late'])
  })

  it('carries utm_content and utm_term — the columns migration 0017 added', () => {
    const plan = planRevenueAttributions({
      charges: [charge()],
      conversions: [conversion()],
      sessions: [session()],
      stored: [],
    })
    const attribution = only(plan)
    expect(attribution.firstTouch.utmContent).toBe('banner-a')
    expect(attribution.firstTouch.utmTerm).toBe('analytics')

    const [entry] = JSON.parse(attribution.journey) as { utm_content: string; utm_term: string }[]
    expect(entry?.utm_content).toBe('banner-a')
    expect(entry?.utm_term).toBe('analytics')
  })

  it('caps the journey keep-newest, flags the truncation and keeps the true count', () => {
    const total = REVENUE_JOURNEY_MAX_TOUCHPOINTS + 7
    const sessions = Array.from({ length: total }, (_, index) =>
      session({
        sessionId: `sess_${String(index).padStart(3, '0')}`,
        sessionStartMs: CHARGE_AT - (total - index) * 60_000,
      }),
    )

    const plan = planRevenueAttributions({
      charges: [charge()],
      conversions: [conversion()],
      sessions,
      stored: [],
    })

    const attribution = only(plan)
    expect(attribution.touchpointCount).toBe(total)
    expect(attribution.journeyTruncated).toBe(true)

    const journey = JSON.parse(attribution.journey) as { session_id: string }[]
    expect(journey).toHaveLength(REVENUE_JOURNEY_MAX_TOUCHPOINTS)
    // Keep-newest: the LAST touchpoint survives...
    expect(journey.at(-1)?.session_id).toBe(`sess_${String(total - 1).padStart(3, '0')}`)
    // ...the first ones are dropped from the document...
    expect(journey[0]?.session_id).toBe('sess_007')
    // ...but first touch is computed BEFORE the cap and is intact.
    expect(attribution.firstTouch.sessionId).toBe('sess_000')
    expect(attribution.lastTouch.sessionId).toBe(`sess_${String(total - 1).padStart(3, '0')}`)
  })

  it('does not flag truncation at exactly the cap', () => {
    const sessions = Array.from({ length: REVENUE_JOURNEY_MAX_TOUCHPOINTS }, (_, index) =>
      session({
        sessionId: `sess_${String(index).padStart(3, '0')}`,
        sessionStartMs: CHARGE_AT - (index + 1) * 60_000,
      }),
    )
    const plan = planRevenueAttributions({
      charges: [charge()],
      conversions: [conversion()],
      sessions,
      stored: [],
    })
    expect(only(plan).journeyTruncated).toBe(false)
  })
})

describe('versioning and the late flip', () => {
  it('writes nothing when an identical recompute produces an identical answer', () => {
    const first = planRevenueAttributions({
      charges: [charge()],
      conversions: [conversion()],
      sessions: [session()],
      stored: [],
    })
    const attribution = only(first)

    const second = planRevenueAttributions({
      charges: [charge()],
      conversions: [conversion()],
      sessions: [session()],
      stored: [storedFrom(attribution)],
    })

    expect(second.attributions).toHaveLength(0)
    expect(second.changed).toBe(0)
    // The histogram still counts every charge considered — it is a match-rate
    // gauge, not a write counter.
    expect(second.matchedVia.conversion_event).toBe(1)
  })

  it('flips `none` to `exact` on a late conversion event, at a higher version', () => {
    // Pass 1: the charge arrived before its conversion event was ingested.
    const first = planRevenueAttributions({
      charges: [charge()],
      conversions: [],
      sessions: [session()],
      stored: [],
    })
    const unmatched = only(first)
    expect(unmatched.matchedVia).toBe('none')
    expect(unmatched.version).toBe(1)

    // Pass 2: the event landed. The rolling horizon re-read the same charge.
    const second = planRevenueAttributions({
      charges: [charge()],
      conversions: [conversion()],
      sessions: [session()],
      stored: [storedFrom(unmatched)],
    })
    const matched = only(second)
    expect(matched.matchedVia).toBe('conversion_event')
    expect(matched.confidence).toBe('exact')
    // Strictly higher, so `argMax(col, version)` returns the new answer without
    // any merge having run.
    expect(matched.version).toBe(2)
  })

  it('flips again when a late-finalized session adds a touchpoint', () => {
    const first = planRevenueAttributions({
      charges: [charge()],
      conversions: [conversion()],
      sessions: [],
      stored: [],
    })
    const empty = only(first)
    expect(empty.touchpointCount).toBe(0)

    const second = planRevenueAttributions({
      charges: [charge()],
      conversions: [conversion()],
      sessions: [session()],
      stored: [storedFrom(empty)],
    })
    const filled = only(second)
    expect(filled.touchpointCount).toBe(1)
    expect(filled.version).toBe(2)
  })

  it('mints one version per run from the highest stored version in the horizon', () => {
    const plan = planRevenueAttributions({
      charges: [
        charge({ objectId: 'ch_1', orderId: 'pi_1' }),
        charge({ objectId: 'ch_2', orderId: 'pi_2' }),
      ],
      conversions: [conversion({ orderId: 'pi_1' })],
      sessions: [session()],
      stored: [
        {
          ...only(
            planRevenueAttributions({
              charges: [charge({ objectId: 'ch_9', orderId: 'pi_9' })],
              conversions: [],
              sessions: [],
              stored: [],
            }),
          ),
          version: 7,
        },
      ],
    })

    expect(plan.version).toBe(8)
    expect(plan.attributions.every((a) => a.version === 8)).toBe(true)
  })
})
