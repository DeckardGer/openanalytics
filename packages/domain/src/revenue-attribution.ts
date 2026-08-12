/**
 * Matching and attribution, v1 (ADR-0033, D2a/D2b/D6). Milestone 12 CP4.
 *
 * Pure. No I/O, no clock of its own, no secret: every input arrives as data and
 * every output is a value. That is the same split the session finalizer uses —
 * `sessionize` and `planSessionFacts` decide, the worker fetches and writes —
 * and it is what makes a model change (`model_version` >= 2) a recompute over
 * stored inputs rather than a re-ingest.
 *
 * ## Touchpoints are session entries
 *
 * D6 refuses a second `attribution_touchpoints` table. A visitor's touchpoints
 * ARE their `session_facts_versions` rows: versioned, retraction-aware, ordered
 * deterministically by `(session_start, session_id)`, and — since ClickHouse
 * migration 0017 — carrying the full 02 §13 source vocabulary including
 * `utm_content` and `utm_term`. This module consumes them as
 * `SessionTouchpoint`; it never reconstructs a session and never looks at a raw
 * event except the one conversion signal below.
 *
 * **This closes ADR-0028 §8.** `packages/domain/src/referrer.ts` deferred
 * "a referrer is attributed once, at session entry" to the M12 attribution
 * layer. That layer is this file: `ft_referrer_domain` is the entry referrer of
 * the visitor's first session inside the window, read from the session fact,
 * and the event-grain sources report is deliberately left alone.
 *
 * ## The signals, in confidence order — exact joins only
 *
 * 1. **`conversion` event carrying `order_id`** (D6 signal 1). The site fires
 *    `oa.conversion('purchase', { order_id })` on its success page, where
 *    `order_id` is the Checkout Session (`cs_…`), the PaymentIntent (`pi_…`) or
 *    the charge id — all three are accepted, because a site that read the recipe
 *    once should not have its journeys silently vanish for picking the id it had
 *    to hand. The event row carries the visitor, so the join is exact:
 *    `confidence = 'exact'`, `matched_via = 'conversion_event'`.
 * 2. **Checkout `client_reference_id`** (D6 signal 2), hashed with the
 *    `identify()` derivation and joined against `user_id`:
 *    `confidence = 'linked'`, `matched_via = 'client_reference'`.
 * 3. **Customer identity** (D6 signal 3) — `metadata.oa_external_id`, else the
 *    customer email — through the same derivation:
 *    `confidence = 'linked'`, `matched_via = 'customer_identity'`.
 *
 * The two hashes arrive already derived, because the derivation needs
 * `ANONYMOUS_IDENTITY_SECRET` and this package stays pure and secret-free. The
 * worker holds the key (ADR-0033 D6 amendment) and hashes on the way in.
 *
 * **Signal 3 is effectively empty in CP4 and that is recorded, not hidden.** CP3
 * documented why: `oa_external_id` lives on the Stripe *Customer*, which the
 * sync walk never lists, and an email is never at rest in any form (D-102 and
 * the api's lack of the secret between them make it unreachable). The input
 * field exists so a later checkpoint that fetches a Customer in flight supplies
 * it without a caller or a test changing shape.
 *
 * **Explicit non-goals** (D-102, stated so nobody "improves" this): no IP
 * matching, no time-proximity fuzzy matching, no cross-site identity. An
 * unmatched charge is a first-class outcome — `confidence = 'none'`,
 * `matched_via = 'none'`, no journey — and it still appears in every total,
 * because totals come from `revenue_events` and not from here.
 *
 * ## One journey per order (the (session, order) grain)
 *
 * Several charges can share one PaymentIntent: a declined attempt followed by a
 * successful retry is ordinary, and both are real money objects CP5 has to
 * render. If each of them claimed the session, one purchase would appear as two
 * or three journeys from the same visitor and every "sessions that converted"
 * number would be inflated by the customer's card trouble.
 *
 * So the charges of one order compete and exactly one wins, deterministically:
 *
 *   0. a `failed`/`canceled` charge is **not eligible at all** — see
 *      `canOwnJourney`, which also explains why that single rule is what keeps a
 *      rolling horizon from ever producing two journeys for one order;
 *   1. then highest **status rank** — money that moved (`succeeded`, `refunded`,
 *      `partially_refunded`) beats `pending`, which beats an unknown status;
 *   2. then the **latest** `occurred_at`, because the attempt that stuck is the
 *      last one;
 *   3. then the lexicographically smallest `object_id`, purely so the answer
 *      cannot depend on read order.
 *
 * The losers get `matched_via = 'none'` and `confidence = 'none'` with no
 * journey. The ADR's row shape is unchanged — there is no "reason" column and
 * none is invented — so a loser is indistinguishable from a genuinely unmatched
 * charge *on the row*, which is correct: neither has a journey to show. The
 * distinction is recoverable at read time from the shared `order_id` on the
 * fact, which is where a UI would want it anyway.
 *
 * A charge with an empty `order_id` competes with nobody and is its own group —
 * but rule 0 still applies to it, because "a failed charge earns no journey" is
 * about the charge and not about its siblings.
 *
 * ## The window (D2a) and the honesty flag
 *
 * Touchpoints are the visitor's session entries with `session_start` in
 * **`[occurred_at - 30d, occurred_at]`, both bounds inclusive**. The lower bound
 * is closed on purpose: a session that started exactly 30 days before the
 * purchase is inside a "30-day window" by any reading a customer would give the
 * phrase, and an open bound would make the answer depend on millisecond
 * arithmetic nobody can see. The upper bound is closed for the same reason —
 * the session in which the purchase happened starts at or before the charge.
 *
 * `identity_scope` is D2a's required honesty clause, and its two values mean
 * something narrower than "the window is real" — stated precisely because the UI
 * must never imply more than the flag allows:
 *
 * - **`identified`** — the visitor key is a stable `identify()` hash. The
 *   journey includes the sessions the visitor had **before** they identified,
 *   because `touchpointsFor` merges the conversion event's `anonymous_id`
 *   history into the user-id history (see its comment: without that merge, first
 *   touch would name the sign-in session rather than the ad click, for every
 *   identified buyer). But an anonymous id rotates at UTC midnight (D-102), so
 *   only the sessions sharing the visitor's *current* anonymous id are
 *   recoverable. The honest reading is therefore: **the journey runs from the
 *   last anonymous-id rotation before identification onward**, not necessarily
 *   the full 30 days. Once the visitor identifies, every later session across
 *   the window carries the stable hash and is fully recovered.
 * - **`anonymous_day`** — the key is a daily-rotating anonymous id and nothing
 *   else. The journey cannot span a UTC midnight at all, no matter what
 *   `window_days` says.
 *
 * The two hash-join signals (2 and 3) know only the hash, never an anonymous id,
 * so their journeys start at the visitor's first identified session. That is a
 * weaker answer than signal 1's and it is one more reason the precedence order
 * is what it is.
 */

/** v1 (D2b). A model change is a recompute under a higher value. */
export const REVENUE_ATTRIBUTION_MODEL_VERSION = 1

/** D2a. Stored on every row so a historical attribution stays readable. */
export const REVENUE_ATTRIBUTION_WINDOW_DAYS = 30

/**
 * The journey cap (ClickHouse migration 0017), keep-newest.
 *
 * An identified visitor on a busy site can accumulate hundreds of sessions in
 * thirty days, and `journey` is a String column in a wide row that CP5's API has
 * to promise a bounded response for. Keep-newest rather than keep-oldest because
 * the sessions adjacent to the purchase are what a journey view is read for —
 * and first touch survives truncation regardless, because it is computed into
 * its own `ft_` block before the cap is applied.
 */
export const REVENUE_JOURNEY_MAX_TOUCHPOINTS = 50

const MS_PER_DAY = 86_400_000

export type RevenueMatchedVia =
  'conversion_event' | 'client_reference' | 'customer_identity' | 'none'

export type RevenueMatchConfidence = 'exact' | 'linked' | 'none'

/** `identified` | `anonymous_day`, or the empty string when nothing matched. */
export type RevenueIdentityScope = 'identified' | 'anonymous_day' | ''

/**
 * A charge to attribute — the current `revenue_events` fact, narrowed.
 *
 * Only charges are attributed. A refund or a dispute belongs to the journey of
 * the charge it points at (`parent_object_id`), and D2d already puts its money
 * in its own time bucket; giving it a journey row of its own would double every
 * "converted sessions" count.
 */
export interface AttributableCharge {
  readonly objectId: string
  readonly provider: string
  /** Epoch ms. The row's partition key and the window's anchor. */
  readonly occurredAtMs: number
  /** Normalized charge status. Decides the one-journey-per-order tie-break. */
  readonly status: string
  /** The PaymentIntent. Empty when the provider gave none. */
  readonly orderId: string
  /** From the fact, or from a hint that landed after the fact was projected. */
  readonly checkoutSessionId: string
  /**
   * `externalUserIdHash(client_reference_id)` — D6 signal 2. Empty when the
   * charge carried no client reference and no hint supplied one.
   */
  readonly clientReferenceUserHash: string
  /**
   * `externalUserIdHash(metadata.oa_external_id | customer email)` — D6 signal
   * 3. Effectively always empty in CP4; see the module header.
   */
  readonly customerIdentityUserHash: string
}

/** A `conversion` event that named an order (D6 signal 1). */
export interface ConversionSignal {
  /** `properties.order_id`, raw and unnormalized apart from trimming. */
  readonly orderId: string
  readonly eventId: string
  readonly occurredAtMs: number
  /** The `identify()` hash, empty for an anonymous visitor. */
  readonly userId: string
  /** The daily-rotating anonymous id (D-102). */
  readonly anonymousId: string
}

/** One session entry — a touchpoint. The current `session_facts_versions` row. */
export interface SessionTouchpoint {
  readonly sessionId: string
  readonly sessionStartMs: number
  readonly userId: string
  readonly anonymousId: string
  readonly referrerDomain: string
  readonly utmSource: string
  readonly utmMedium: string
  readonly utmCampaign: string
  readonly utmContent: string
  readonly utmTerm: string
  readonly entryPagePath: string
}

/** One `ft_`/`lt_` block. */
export interface AttributionTouchBlock {
  readonly sessionId: string
  readonly sessionStartMs: number
  readonly referrerDomain: string
  readonly utmSource: string
  readonly utmMedium: string
  readonly utmCampaign: string
  readonly utmContent: string
  readonly utmTerm: string
  readonly entryPage: string
}

const EMPTY_TOUCH: AttributionTouchBlock = {
  sessionId: '',
  // Epoch, matching the `Date`/`DateTime64` zero the other absent-time columns
  // use. Never a negative or a sentinel year — a reader that sorts on it must
  // not be able to place an unmatched charge before the Unix epoch.
  sessionStartMs: 0,
  referrerDomain: '',
  utmSource: '',
  utmMedium: '',
  utmCampaign: '',
  utmContent: '',
  utmTerm: '',
  entryPage: '',
}

/**
 * Everything about an attribution that decides whether it is a NEW version.
 *
 * `version` and `computed_at` are deliberately absent: the first is the answer
 * this comparison produces and the second is a clock, and a clock in a
 * fingerprint makes every recompute a write.
 */
export interface RevenueAttributionFingerprint {
  readonly occurredAtMs: number
  readonly modelVersion: number
  readonly windowDays: number
  readonly matchedVia: RevenueMatchedVia
  readonly confidence: RevenueMatchConfidence
  readonly identityScope: RevenueIdentityScope
  readonly visitorId: string
  readonly userId: string
  readonly firstTouch: AttributionTouchBlock
  readonly lastTouch: AttributionTouchBlock
  readonly touchpointCount: number
  readonly journeyTruncated: boolean
  readonly journey: string
}

/** A computed attribution, ready for the worker to turn into a ClickHouse row. */
export interface ComputedRevenueAttribution extends RevenueAttributionFingerprint {
  readonly objectId: string
  readonly provider: string
  /** `max(stored version in the horizon) + 1`, shared by every row of one run. */
  readonly version: number
}

/** The current stored attribution of one charge, for change detection. */
export interface StoredRevenueAttribution extends RevenueAttributionFingerprint {
  readonly objectId: string
  readonly provider: string
  readonly version: number
}

export interface RevenueAttributionPlanInput {
  readonly charges: readonly AttributableCharge[]
  readonly conversions: readonly ConversionSignal[]
  readonly sessions: readonly SessionTouchpoint[]
  readonly stored: readonly StoredRevenueAttribution[]
  readonly windowDays?: number
  readonly maxTouchpoints?: number
}

export interface RevenueAttributionPlan {
  /** Only the attributions whose fingerprint moved. Empty on a clean re-run. */
  readonly attributions: readonly ComputedRevenueAttribution[]
  /** The version every row in this plan carries. */
  readonly version: number
  readonly changed: number
  /** `matched_via` histogram over ALL charges considered, changed or not. */
  readonly matchedVia: Readonly<Record<RevenueMatchedVia, number>>
}

/**
 * Status rank for the one-journey-per-order tie-break.
 *
 * Deliberately coarse and deliberately a total order over the three classes
 * rather than a list of statuses: an unknown status (a provider adds one, an
 * adapter widens) ranks 0 and therefore loses to anything known, which is the
 * safe direction — a charge whose meaning we do not understand should not take
 * a journey away from one we do.
 */
function statusRank(status: string): number {
  switch (status) {
    case 'succeeded':
    case 'refunded':
    case 'partially_refunded':
      return 3
    case 'pending':
      return 2
    case 'failed':
    case 'canceled':
      return 1
    default:
      return 0
  }
}

/**
 * A charge that failed outright never owns a journey, sibling or no sibling.
 *
 * Two independent reasons, and it is worth having both written down because the
 * second one is not obvious:
 *
 * 1. **On its own merits.** A `failed`/`canceled` charge moved no money and
 *    never will. A journey exists to explain revenue; attaching one to an
 *    attempt that produced none says a purchase happened where none did, and it
 *    would make "sessions that converted" count declined cards.
 * 2. **It closes the horizon-split hole.** The run's rolling floor advances a
 *    little on every pass, so an order whose charges straddle it can lose its
 *    older, succeeded charge from the charge set while keeping a later failed
 *    sibling. With ownership decided only among the charges present, that
 *    sibling would be promoted and get a journey — while the succeeded charge's
 *    stored row, now below the floor and never re-read, keeps its own. Two
 *    journey rows for one order, and no pass would ever correct it. Barring
 *    rank-1 charges from ownership removes the only realizable shape of that
 *    promotion.
 *
 * An **unknown** status (rank 0) may still own. Barring it would mean a provider
 * adding a status the adapter has not learned yet silently stops producing
 * journeys, which is the failure mode with no symptom; it still loses every
 * contest to a status we do understand, which is the safe half of the trade.
 *
 * Residual, accepted and stated rather than papered over: an order whose
 * succeeded charge drops below the floor while an **unknown-status** sibling
 * remains would still promote that sibling. It needs a provider status the
 * adapter does not map, on a retry of a PaymentIntent that already succeeded, on
 * exactly the pass where the floor crosses between the two — and the alternative
 * fix (widening the charge read to cover every charge of every order in the
 * horizon) costs an unbounded second scan on every pass of every site to prevent
 * it. `pending` is deliberately still allowed to own, because an async payment
 * method (SEPA, iDEAL) is `pending` for days and its journey has to exist before
 * it settles.
 */
function canOwnJourney(charge: AttributableCharge): boolean {
  return statusRank(charge.status) !== 1
}

/**
 * The charge of an order that owns the journey.
 *
 * See the module header for the rule. Returns a set of object ids — one per
 * order — so the per-charge loop is a lookup rather than a nested scan.
 */
function selectJourneyOwners(charges: readonly AttributableCharge[]): Set<string> {
  const byOrder = new Map<string, AttributableCharge>()
  const owners = new Set<string>()

  for (const charge of charges) {
    if (!canOwnJourney(charge)) continue
    if (charge.orderId === '') {
      // No order: competes with nobody.
      owners.add(charge.objectId)
      continue
    }
    const incumbent = byOrder.get(charge.orderId)
    if (incumbent === undefined || beats(charge, incumbent)) {
      byOrder.set(charge.orderId, charge)
    }
  }
  for (const winner of byOrder.values()) owners.add(winner.objectId)
  return owners
}

function beats(candidate: AttributableCharge, incumbent: AttributableCharge): boolean {
  const candidateRank = statusRank(candidate.status)
  const incumbentRank = statusRank(incumbent.status)
  if (candidateRank !== incumbentRank) return candidateRank > incumbentRank
  if (candidate.occurredAtMs !== incumbent.occurredAtMs) {
    return candidate.occurredAtMs > incumbent.occurredAtMs
  }
  return candidate.objectId < incumbent.objectId
}

/** The visitor a signal resolved to, and what kind of key it is. */
interface VisitorKey {
  readonly visitorId: string
  readonly userId: string
  readonly anonymousId: string
  readonly scope: Exclude<RevenueIdentityScope, ''>
}

function toTouchBlock(session: SessionTouchpoint): AttributionTouchBlock {
  return {
    sessionId: session.sessionId,
    sessionStartMs: session.sessionStartMs,
    referrerDomain: session.referrerDomain,
    utmSource: session.utmSource,
    utmMedium: session.utmMedium,
    utmCampaign: session.utmCampaign,
    utmContent: session.utmContent,
    utmTerm: session.utmTerm,
    entryPage: session.entryPagePath,
  }
}

/**
 * The bounded journey document.
 *
 * Long, explicit keys rather than a compact encoding: this string is served
 * almost verbatim by CP5's journey endpoint through the 03 §11 display
 * contract, and a schema whose meaning lives in a comment is a schema the
 * frontend will guess at. `session_start` is an ISO-8601 UTC instant for the
 * same reason — every other timestamp on the wire is.
 */
function journeyDocument(touchpoints: readonly SessionTouchpoint[]): string {
  return JSON.stringify(
    touchpoints.map((session) => ({
      session_id: session.sessionId,
      session_start: new Date(session.sessionStartMs).toISOString(),
      entry_page: session.entryPagePath,
      referrer_domain: session.referrerDomain,
      utm_source: session.utmSource,
      utm_medium: session.utmMedium,
      utm_campaign: session.utmCampaign,
      utm_content: session.utmContent,
      utm_term: session.utmTerm,
    })),
  )
}

/** Deterministic touchpoint order: `(session_start, session_id)` ascending. */
function compareTouchpoints(a: SessionTouchpoint, b: SessionTouchpoint): number {
  if (a.sessionStartMs !== b.sessionStartMs) return a.sessionStartMs - b.sessionStartMs
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0
}

const UNMATCHED = {
  matchedVia: 'none' as const,
  confidence: 'none' as const,
  identityScope: '' as const,
  visitorId: '',
  userId: '',
  firstTouch: EMPTY_TOUCH,
  lastTouch: EMPTY_TOUCH,
  touchpointCount: 0,
  journeyTruncated: false,
  journey: '[]',
}

/**
 * Match and attribute one horizon of charges. Pure.
 *
 * Returns only the attributions whose fingerprint differs from what is stored,
 * all carrying one version — `max(stored) + 1`, derived from stored state rather
 * than from a clock, so two runs cannot collide on a version through a timestamp
 * race. A re-run over unchanged inputs returns nothing, which is what makes the
 * job idempotent and what makes the periodic refresh sweep cheap.
 */
export function planRevenueAttributions(
  input: RevenueAttributionPlanInput,
): RevenueAttributionPlan {
  const windowDays = input.windowDays ?? REVENUE_ATTRIBUTION_WINDOW_DAYS
  const maxTouchpoints = input.maxTouchpoints ?? REVENUE_JOURNEY_MAX_TOUCHPOINTS
  const windowMs = windowDays * MS_PER_DAY

  const storedById = new Map<string, StoredRevenueAttribution>()
  let maxVersion = 0
  for (const stored of input.stored) {
    storedById.set(stored.objectId, stored)
    if (stored.version > maxVersion) maxVersion = stored.version
  }
  const version = maxVersion + 1

  // Conversion signals indexed by the order id they named. A site may fire the
  // same conversion twice (a reloaded success page); the earliest one wins, tied
  // on event id, so the choice never depends on read order.
  const conversionsByOrder = new Map<string, ConversionSignal>()
  for (const signal of input.conversions) {
    const key = signal.orderId.trim()
    if (key === '') continue
    const incumbent = conversionsByOrder.get(key)
    if (
      incumbent === undefined ||
      signal.occurredAtMs < incumbent.occurredAtMs ||
      (signal.occurredAtMs === incumbent.occurredAtMs && signal.eventId < incumbent.eventId)
    ) {
      conversionsByOrder.set(key, signal)
    }
  }

  // Sessions bucketed by both identity kinds. A session appears under its
  // `user_id` when it has one and always under its `anonymous_id`, because the
  // two lookups answer different questions: an identified match asks "which
  // sessions did this person have", an anonymous one asks "which sessions did
  // this browser-day have".
  const sessionsByUser = new Map<string, SessionTouchpoint[]>()
  const sessionsByAnonymous = new Map<string, SessionTouchpoint[]>()
  for (const session of input.sessions) {
    if (session.userId !== '') push(sessionsByUser, session.userId, session)
    if (session.anonymousId !== '') push(sessionsByAnonymous, session.anonymousId, session)
  }

  const journeyOwners = selectJourneyOwners(input.charges)

  const attributions: ComputedRevenueAttribution[] = []
  const matchedVia: Record<RevenueMatchedVia, number> = {
    conversion_event: 0,
    client_reference: 0,
    customer_identity: 0,
    none: 0,
  }

  for (const charge of input.charges) {
    const computed = attributeCharge({
      charge,
      ownsJourney: journeyOwners.has(charge.objectId),
      conversionsByOrder,
      sessionsByUser,
      sessionsByAnonymous,
      windowDays,
      windowMs,
      maxTouchpoints,
      version,
    })
    matchedVia[computed.matchedVia] += 1

    const stored = storedById.get(charge.objectId)
    if (stored !== undefined && fingerprintsEqual(stored, computed)) continue
    attributions.push(computed)
  }

  return {
    attributions,
    version,
    changed: attributions.length,
    matchedVia,
  }
}

function push(map: Map<string, SessionTouchpoint[]>, key: string, value: SessionTouchpoint): void {
  const list = map.get(key)
  if (list === undefined) map.set(key, [value])
  else list.push(value)
}

function attributeCharge(input: {
  charge: AttributableCharge
  ownsJourney: boolean
  conversionsByOrder: Map<string, ConversionSignal>
  sessionsByUser: Map<string, SessionTouchpoint[]>
  sessionsByAnonymous: Map<string, SessionTouchpoint[]>
  windowDays: number
  windowMs: number
  maxTouchpoints: number
  version: number
}): ComputedRevenueAttribution {
  const { charge } = input
  const base = {
    objectId: charge.objectId,
    provider: charge.provider,
    version: input.version,
    occurredAtMs: charge.occurredAtMs,
    modelVersion: REVENUE_ATTRIBUTION_MODEL_VERSION,
    windowDays: input.windowDays,
  }

  // A charge that lost its order's tie-break is unmatched by construction. The
  // signals are not even evaluated: the point is that the SESSION is claimed
  // once, so a second evaluation could only produce a second claimant.
  if (!input.ownsJourney) return { ...base, ...UNMATCHED }

  const windowFrom = charge.occurredAtMs - input.windowMs
  const inWindow = (session: SessionTouchpoint): boolean =>
    session.sessionStartMs >= windowFrom && session.sessionStartMs <= charge.occurredAtMs

  // --- Signal 1: the conversion event -------------------------------------
  //
  // All three ids the recipe allows are tried, in the order D6 lists them:
  // the PaymentIntent the site most likely has on its success page, then the
  // Checkout Session, then the charge id itself.
  for (const candidate of [charge.orderId, charge.checkoutSessionId, charge.objectId]) {
    if (candidate === '') continue
    const signal = input.conversionsByOrder.get(candidate)
    if (signal === undefined) continue

    const key: VisitorKey =
      signal.userId !== ''
        ? {
            visitorId: signal.userId,
            userId: signal.userId,
            anonymousId: signal.anonymousId,
            scope: 'identified',
          }
        : {
            visitorId: signal.anonymousId,
            userId: '',
            anonymousId: signal.anonymousId,
            scope: 'anonymous_day',
          }

    // The event itself is the proof, so the match stands even when no session
    // fact exists yet — the finalizer may not have run for the purchase's own
    // session. The journey is then empty and fills on a later pass, which is a
    // fingerprint change and therefore a new version. That is the late-data
    // path this whole design exists for, and it is why an empty journey beside
    // `confidence = 'exact'` is a legitimate state rather than a bug.
    const touchpoints = touchpointsFor(input, key).filter(inWindow)
    return {
      ...base,
      ...journeyOf(touchpoints, input.maxTouchpoints),
      matchedVia: 'conversion_event',
      confidence: 'exact',
      identityScope: key.scope,
      visitorId: key.visitorId,
      userId: key.userId,
    }
  }

  // --- Signals 2 and 3: the identity joins --------------------------------
  //
  // These have no event of their own: the hash IS the claim, and it is only a
  // claim if it lands on a visitor we actually saw. So an empty touchpoint set
  // means NO MATCH rather than a match with an empty journey — the opposite of
  // signal 1, and the difference is exactly that signal 1 carries independent
  // evidence that the visitor existed.
  for (const [hash, via] of [
    [charge.clientReferenceUserHash, 'client_reference'],
    [charge.customerIdentityUserHash, 'customer_identity'],
  ] as const) {
    if (hash === '') continue
    const touchpoints = touchpointsFor(input, {
      visitorId: hash,
      userId: hash,
      anonymousId: '',
      scope: 'identified',
    }).filter(inWindow)
    if (touchpoints.length === 0) continue

    return {
      ...base,
      ...journeyOf(touchpoints, input.maxTouchpoints),
      matchedVia: via,
      confidence: 'linked',
      identityScope: 'identified',
      visitorId: hash,
      userId: hash,
    }
  }

  return { ...base, ...UNMATCHED }
}

/**
 * Every session belonging to a visitor key, deduplicated and ordered.
 *
 * **An identified visitor's journey is NOT just their identified sessions.**
 * `identify()` is called somewhere in the middle of a visit — on sign-in, at
 * checkout — and every session before that call carries `user_id = ''` and lives
 * only under the visitor's `anonymous_id`. Looking the user id up alone would
 * make `ft_*` name the session in which the customer *identified themselves*
 * rather than the ad click that brought them, for **every identified buyer**.
 * First touch would silently become last touch, and the acquisition source of
 * every purchase would read as the checkout page.
 *
 * So an identified key merges both maps. The anonymous id comes from the
 * conversion event, which carries the visitor's `anonymous_id` beside their
 * `user_id`; the hash-join signals have no anonymous id at all (the hash is the
 * only thing known about the visitor), so for them this collapses back to the
 * user-id lookup.
 *
 * **The dedup is mandatory, not tidiness.** A session that was identified
 * mid-visit — the identity stitch — carries BOTH a `user_id` and an
 * `anonymous_id`, so it is in both maps and would otherwise appear twice: once
 * in the journey document, twice in `touchpoint_count`, and possibly as both
 * first and last touch of a one-session journey. Keyed by `session_id`, which is
 * the session's identity in `session_facts_versions`.
 */
function touchpointsFor(
  input: {
    sessionsByUser: Map<string, SessionTouchpoint[]>
    sessionsByAnonymous: Map<string, SessionTouchpoint[]>
  },
  key: VisitorKey,
): SessionTouchpoint[] {
  const bySessionId = new Map<string, SessionTouchpoint>()

  if (key.userId !== '') {
    for (const session of input.sessionsByUser.get(key.userId) ?? []) {
      bySessionId.set(session.sessionId, session)
    }
  }
  if (key.anonymousId !== '') {
    for (const session of input.sessionsByAnonymous.get(key.anonymousId) ?? []) {
      bySessionId.set(session.sessionId, session)
    }
  }

  return [...bySessionId.values()].sort(compareTouchpoints)
}

function journeyOf(
  touchpoints: readonly SessionTouchpoint[],
  maxTouchpoints: number,
): Pick<
  RevenueAttributionFingerprint,
  'firstTouch' | 'lastTouch' | 'touchpointCount' | 'journeyTruncated' | 'journey'
> {
  if (touchpoints.length === 0) {
    return {
      firstTouch: EMPTY_TOUCH,
      lastTouch: EMPTY_TOUCH,
      touchpointCount: 0,
      journeyTruncated: false,
      journey: '[]',
    }
  }

  // First touch is taken BEFORE the cap, so truncation never costs the model an
  // input it computes with.
  const first = touchpoints[0]!
  const last = touchpoints[touchpoints.length - 1]!
  const truncated = touchpoints.length > maxTouchpoints
  const kept = truncated ? touchpoints.slice(touchpoints.length - maxTouchpoints) : touchpoints

  return {
    firstTouch: toTouchBlock(first),
    lastTouch: toTouchBlock(last),
    // The TRUE count, never the truncated one, so a reader can always tell how
    // much journey exists behind what it was handed.
    touchpointCount: touchpoints.length,
    journeyTruncated: truncated,
    journey: journeyDocument(kept),
  }
}

function touchBlocksEqual(a: AttributionTouchBlock, b: AttributionTouchBlock): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.sessionStartMs === b.sessionStartMs &&
    a.referrerDomain === b.referrerDomain &&
    a.utmSource === b.utmSource &&
    a.utmMedium === b.utmMedium &&
    a.utmCampaign === b.utmCampaign &&
    a.utmContent === b.utmContent &&
    a.utmTerm === b.utmTerm &&
    a.entryPage === b.entryPage
  )
}

/**
 * Field-by-field rather than a hash of the two structures.
 *
 * A hash would be shorter and would silently start returning "changed" the day
 * somebody reorders a field or a JSON serializer changes its spacing. The
 * explicit comparison fails to compile when a field is added and not compared,
 * which is the failure mode worth having — the same argument `fingerprintsEqual`
 * makes in the session planner.
 */
export function fingerprintsEqual(
  a: RevenueAttributionFingerprint,
  b: RevenueAttributionFingerprint,
): boolean {
  return (
    a.occurredAtMs === b.occurredAtMs &&
    a.modelVersion === b.modelVersion &&
    a.windowDays === b.windowDays &&
    a.matchedVia === b.matchedVia &&
    a.confidence === b.confidence &&
    a.identityScope === b.identityScope &&
    a.visitorId === b.visitorId &&
    a.userId === b.userId &&
    a.touchpointCount === b.touchpointCount &&
    a.journeyTruncated === b.journeyTruncated &&
    a.journey === b.journey &&
    touchBlocksEqual(a.firstTouch, b.firstTouch) &&
    touchBlocksEqual(a.lastTouch, b.lastTouch)
  )
}
