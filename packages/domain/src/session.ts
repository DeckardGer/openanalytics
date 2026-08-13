import { createHash } from 'node:crypto'
import { z } from 'zod'

/**
 * The canonical analytics sessionizer and its metric definitions
 * (docs snapshot 02 §10 "Visitor, session and metric rules"; 04 Milestone 8
 * items 1 and 5; docs snapshot 05, D-211 and D-102).
 *
 * This is the reference implementation the finalizer (Checkpoint B) recomputes
 * from and the read layer (Checkpoint C) reports from. It is **pure and
 * deterministic**: the same set of persisted events, in any arrival order,
 * produces byte-identical sessions. That property is itself an acceptance
 * criterion (plan Milestone 8 item 4: "deterministic tie-break") and a test.
 *
 * Why a pure re-sessionizer and not an incremental materialized view: D-211. An
 * incremental view sees each inserted block once and cannot un-record a bounce
 * when a second pageview arrives late. Recomputing the session from the full
 * event set is the only thing that can flip a provisional bounce back to
 * engaged, so the whole layer is built as a re-runnable function of the events,
 * versioned in `session_facts_versions` (migration 0013).
 *
 * ## What is a session
 *
 * §10, stated precisely:
 *
 *   - A session is the activity of one visitor with no meaningful gap longer
 *     than 30 minutes. A gap over 30 minutes splits; the client's session hint
 *     can never make a session outlast that rule.
 *   - An SPA route change is a new pageview inside the same session, never a new
 *     session — which falls out naturally here because consecutive pageviews
 *     under the gap rule stay in one session regardless of URL.
 *
 * ### Session identity key (the grouping decision)
 *
 * §10 builds a canonical session from "site + scoped client-session / resolved
 * identity + event ordering". The resolved identity is the M7 expression
 * `if(user_id != '', user_id, anonymous_id)` (ADR-0011), so events are first
 * partitioned by **(site, resolved identity)** — the same visitor key every
 * additive rollup already uses. Within a partition the 30-minute rule splits.
 *
 * The client session hint (`session_id`, the site-scoped HMAC of the tracker's
 * `client_session_id`) is deliberately **not** the partition key, because it is
 * only a hint and must not be able to over- or under-merge:
 *
 *   - **A hint change alone does not split.** Two browser contexts (tabs) of the
 *     same anonymous visitor carry different hints but the same anonymous id and
 *     the same 30-minute continuity, so they stay one session. Partitioning by
 *     hint would have split them; partitioning by identity does not.
 *   - **A shared hint does not merge two unrelated visitors.** The hint is per
 *     tab (`sessionStorage`) and randomly minted, so two people cannot arrive
 *     carrying the same one. What a shared hint under two anonymous ids means is
 *     the opposite: one visitor whose *network* identity moved under them. Two
 *     genuinely different people — two devices behind one NAT, say — carry
 *     different hints and are never merged.
 *
 * ### Identity rotation (D-102)
 *
 * The anonymous id is `HMAC(ip/ua-class, site, UTC-date, key-version)`, so it
 * **rotates at UTC midnight and whenever the IP moves** — a VPN hop, a mobile
 * carrier's CGNAT, an IPv6 temporary address. Either way an un-identified
 * visitor arrives under two anonymous ids — two partitions — carrying the same
 * client session hint. The hint exists precisely for this continuity, so after
 * the per-identity split an **identity bridge** re-joins two adjacent
 * non-identified sessions when, and only when, they
 *
 *   1. are both anonymous (an identified visitor keeps one `user_id` across a
 *      rotation and never needs bridging),
 *   2. share a non-empty client session hint,
 *   3. are within the 30-minute inactivity window, and
 *   4. do not carry the merged span to or past the session cap (ADR-0018).
 *
 * When the rotation is a midnight one the dates must also be *adjacent*, which
 * the inactivity window already implies and which is kept explicit so the
 * cross-day bound is stated in the code that enforces it. The bridge is applied
 * iteratively, so a visit crossing several rotations chains correctly.
 *
 * **Why same-day merging was not always allowed.** It was refused on the
 * assumption that a same-day pair with different anonymous ids is two visitors.
 * Production disproved it: on the dogfood site 24 of 26 split identities over
 * seven days were same-day, one of them reappearing 3 seconds later from the
 * same city — one person, counted twice. The refusal was costing accuracy and
 * buying no privacy.
 *
 * **Privacy consequence, stated openly.** Merging two ids *inside* one UTC day
 * links nothing the daily rotation was protecting: both ids belong to the same
 * day, and the published commitment is about not linking *across* days. The
 * cross-day case is unchanged — still one 30-minute window straddling one UTC
 * midnight, still requiring a matching hint, so it cannot reconstruct long-term
 * cross-day tracking (D-102 keeps that out of core). A session bridged *across a
 * date* is flagged (`midnightBridged`) so that linkage stays visible in the
 * facts; a same-day merge is not flagged, because there is no cross-rotation
 * linkage to disclose. A future persistent-identity mode would need its own
 * privacy ADR; this bridge does not open that door.
 *
 * ### Identity stitch (mid-visit `identify`)
 *
 * Every persisted event carries an anonymous id, and `user_id` exists on the
 * `identify` event **alone** (ADR-0036: the collector never stamps it onto
 * later events), so a visitor who logs in mid-visit produces anonymous events
 * (partition `anonymous_id`) plus the identify row(s) (partition `user_id`) —
 * the identified partition overlapping the anonymous span rather than
 * following it. Partitioning by resolved identity alone would split that one
 * visit into two sessions and stamp a false bounce on the identified sliver —
 * and the sites that call `identify` are exactly the ones this hits. §10's key ("site + scoped client-session /
 * resolved identity + event ordering") wants continuity here, so after the
 * bridge a **stitch** re-joins an all-anonymous session onto the adjacent
 * identified session when
 *
 *   1. the anonymous session precedes the identified one within the inactivity
 *      window (same or an adjacent UTC date), and
 *   2. the identified session's own events carry an anonymous id the anonymous
 *      session also carries — the `identify` event carries *both* ids, so the
 *      linkage is proven by the events themselves.
 *
 * Because the linkage is in the data already, the stitch creates no new privacy
 * linkage (unlike the midnight bridge) and needs no hint. Two different logged-in
 * users on one shared device never share a `user_id`, so they never stitch to
 * each other — an anonymous span joins only the identified session that actually
 * continues it. A stitched session's resolved identity is the `user_id` (the
 * visitor *is* that user for the whole visit) and it is flagged `identityStitched`.
 *
 * ### `session_id` stability, and why the finalizer needs retraction
 *
 * The canonical `session_id` is a hash of `(site, earliest event id)` — stable
 * against a *late later* event (the earliest event does not change), which is
 * what keeps a late pageview flipping a bounce on the *same* id. It is **not**
 * stable in two cases the finalizer must handle, not the sessionizer: (a) a late
 * *earlier* event (an offline flush older than the current first) changes the
 * earliest event and mints a new id; (b) the bridge or stitch merges two spans a
 * prior finalizer run already wrote under two ids, so one id survives and the
 * other must disappear. In both, a stale id's last version would otherwise linger
 * as "current" and double-count a finalized range. `session_facts_versions`
 * carries a `retracted` flag for exactly this: the finalizer writes a
 * higher-version `retracted = 1` tombstone for any stored id absent from the
 * recompute, and readers filter `retracted = 0` *after* the latest-version
 * selection (migration 0013 documents the read pattern and its trap). The pure
 * sessionizer only produces the current session set; retraction is Checkpoint B.
 *
 * ### Meaningful activity
 *
 * Only these event types are **activity** — they reset the 30-minute timer and
 * bound the session:
 *
 *   - `page_view` — the primary signal.
 *   - `custom_event`, `conversion` — deliberate interactions.
 *   - `engagement` — the active-time beacon; it is where the "≥10s active"
 *     engaged signal comes from, so it must count as activity.
 *   - `identify` — a real client action (a login); it keeps a session alive but
 *     is not on its own an "engaged" signal.
 *
 * `web_vital` and `interaction` are **passive** and excluded from sessionization
 * entirely: a web vital fires automatically (not a visitor action) and a heatmap
 * interaction is *sampled* (`interaction_sampling`), so letting either move a
 * session boundary would make sessions depend on automation or on a sampling
 * fraction. They still feed their own rollups from `events_raw`; they do not
 * anchor a session here. `heartbeat` never reaches this layer at all — it is
 * realtime-only and is never persisted (contract `REALTIME_EVENT_TYPES`).
 */

/** Event types that count as meaningful activity (reset the gap, bound the session). */
export const SESSION_ACTIVITY_TYPES = [
  'page_view',
  'custom_event',
  'conversion',
  'engagement',
  'identify',
] as const

/** Event types attached to a page/site but never anchoring a session. */
export const SESSION_PASSIVE_TYPES = ['web_vital', 'interaction'] as const

export type SessionActivityType = (typeof SESSION_ACTIVITY_TYPES)[number]

function isActivityType(type: string): type is SessionActivityType {
  return (SESSION_ACTIVITY_TYPES as readonly string[]).includes(type)
}

const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000

/**
 * Canonical session constants (docs snapshot 02 §10). None of these is a `GATE`
 * value in docs snapshot 05 — §10 fixes them directly — so they are ordinary
 * typed config with recorded invariants, mirroring `analytics-query.ts` and
 * `policy.ts` rather than being scattered literals (docs snapshot 02 §5).
 */
export const sessionConfigSchema = z
  .object({
    /** Meaningful inactivity that ends a session (§10: 30 minutes). */
    SESSION_INACTIVITY_MINUTES: z.coerce.number().int().min(1).max(1_440).default(30),
    /**
     * A session lasts at most this many hours from its first event (ADR-0018,
     * closed product decision 2026-07-25). Mirrors `policy.SESSION_MAX_LENGTH_HOURS`
     * — the sessionizer reads it from here the same way it reads the inactivity
     * window. It is the bound that keeps the finalizer watermark advancing past a
     * never-ending activity stream (ADR-0012's documented open item); it never
     * affects a real sub-24h session.
     */
    SESSION_MAX_LENGTH_HOURS: z.coerce.number().int().min(1).max(48).default(24),
    /** Active-time floor for an engaged session (§10: ≥10 seconds). */
    ENGAGED_MIN_ACTIVE_MS: z.coerce.number().int().min(0).max(3_600_000).default(10_000),
    /** Pageview floor for an engaged session (§10: 2+ pageviews). */
    ENGAGED_MIN_PAGEVIEWS: z.coerce.number().int().min(1).max(1_000).default(2),
    /** Whether the D-102 midnight bridge is applied. Off only for isolation in tests. */
    MIDNIGHT_BRIDGE_ENABLED: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .transform((value) => value === true || value === 'true')
      .default(true),
  })
  // Not `.strict()`: `loadSessionConfig` parses the whole `process.env`, which
  // always carries unrelated keys (FLY_*, PATH, the service's own secrets).
  // Unknown keys are stripped, the same contract the service env schemas keep.
  .strip()

export type SessionConfig = z.infer<typeof sessionConfigSchema>

export class SessionConfigError extends Error {
  readonly issues: readonly { path: string; message: string }[]

  constructor(error: z.ZodError) {
    const issues = error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    }))
    super(
      `Invalid session configuration:\n${issues
        .map((issue) => `  - ${issue.path}: ${issue.message}`)
        .join('\n')}`,
    )
    this.name = 'SessionConfigError'
    this.issues = issues
  }
}

export function loadSessionConfig(
  source: Record<string, string | undefined> = process.env,
): SessionConfig {
  const result = sessionConfigSchema.safeParse(source)
  if (!result.success) {
    throw new SessionConfigError(result.error)
  }
  return result.data
}

/** Defaults resolved once; the §10 canonical values. */
export const DEFAULT_SESSION_CONFIG: SessionConfig = sessionConfigSchema.parse({})

/**
 * The projection of a persisted event the sessionizer consumes (contract
 * `persistedEventSchema`). Only session-relevant fields; a caller maps a
 * `PersistedEvent` or an `events_raw` row into this shape. Time is `occurred_at`
 * (D-015), never `accepted_at`.
 */
export interface SessionizerEvent {
  readonly eventId: string
  readonly type: string
  /** Validated `occurred_at`, as an ISO-8601 UTC instant, epoch-ms or `Date`. */
  readonly occurredAt: string | number | Date
  readonly anonymousId: string
  readonly userId?: string | null
  /** Persisted `session_id`: the site-scoped HMAC of the client hint. */
  readonly sessionHint?: string | null
  readonly name?: string | null
  readonly pagePath?: string | null
  readonly referrerDomain?: string | null
  readonly utmSource?: string | null
  readonly utmMedium?: string | null
  readonly utmCampaign?: string | null
  /**
   * ADR-0033 D6 (ClickHouse migration 0017). `events_raw` has carried both
   * since 0001; the session fact gained them in CP4 so that a journey
   * touchpoint reports the full 02 §13 source vocabulary rather than three
   * fifths of it. Absent is the empty string, like every other dimension here.
   */
  readonly utmContent?: string | null
  readonly utmTerm?: string | null
  readonly deviceType?: string | null
  readonly browser?: string | null
  readonly os?: string | null
  readonly country?: string | null
  /** Active-time beacon payload; present only on `engagement` events. */
  readonly engagement?: { readonly activeMs: number; readonly visibleMs: number } | null
}

/** One canonical session — the shape a `session_facts_versions` row carries. */
export interface CanonicalSession {
  /** Deterministic, stable id: a hash of site + the session's earliest event id. */
  readonly sessionId: string
  readonly siteId: string
  /** `if(user_id != '', user_id, anonymous_id)` — the M7 resolved identity. */
  readonly visitorId: string
  /** Empty string when the visitor is anonymous (CH `String`, never Nullable). */
  readonly userId: string
  /** The entry event's anonymous id (a bridged session keeps its first one). */
  readonly anonymousId: string
  readonly sessionHint: string
  /** True when the D-102 midnight bridge joined two rotating anonymous streams. */
  readonly midnightBridged: boolean
  /**
   * True when the identity stitch joined an all-anonymous prefix to this
   * identified session (a mid-visit `identify`). Distinct from `midnightBridged`
   * because the linkage is proven by the events themselves and creates no new
   * cross-day privacy linkage.
   */
  readonly identityStitched: boolean
  readonly startMs: number
  readonly endMs: number
  readonly startIso: string
  readonly endIso: string
  readonly pageviews: number
  readonly engaged: boolean
  readonly bounced: boolean
  readonly activeDurationMs: number
  readonly sessionDurationMs: number
  readonly entryPagePath: string
  readonly exitPagePath: string
  readonly referrerDomain: string
  readonly utmSource: string
  readonly utmMedium: string
  readonly utmCampaign: string
  /** ADR-0033 D6 / migration 0017. The entry event's value, empty when absent. */
  readonly utmContent: string
  readonly utmTerm: string
  readonly deviceType: string
  readonly browser: string
  readonly os: string
  readonly country: string
  /** The activity event ids in this session, ordered — for traceability/audit. */
  readonly eventIds: readonly string[]
}

interface NormalizedEvent {
  readonly eventId: string
  readonly type: SessionActivityType
  readonly occurredMs: number
  readonly anonymousId: string
  readonly userId: string
  readonly resolvedIdentity: string
  readonly sessionHint: string
  readonly utcDate: string
  readonly pagePath: string
  readonly referrerDomain: string
  readonly utmSource: string
  readonly utmMedium: string
  readonly utmCampaign: string
  readonly utmContent: string
  readonly utmTerm: string
  readonly deviceType: string
  readonly browser: string
  readonly os: string
  readonly country: string
  readonly activeMs: number | null
}

function toMs(value: string | number | Date): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  return Date.parse(value)
}

function str(value: string | null | undefined): string {
  return value == null ? '' : value
}

/** The UTC calendar date (`YYYY-MM-DD`) an instant belongs to. */
function utcDateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** True when `later` is exactly one UTC calendar day after `earlier`. */
function isAdjacentUtcDate(earlier: string, later: string): boolean {
  const earlierMs = Date.parse(`${earlier}T00:00:00.000Z`)
  const laterMs = Date.parse(`${later}T00:00:00.000Z`)
  if (Number.isNaN(earlierMs) || Number.isNaN(laterMs)) return false
  return laterMs - earlierMs === MS_PER_DAY
}

/**
 * Merged active-time in milliseconds (docs snapshot 02 §10 "Page duration":
 * deduped visible+active time, not open time; plan Milestone 8 acceptance
 * criterion 3: a duration-update retry must not inflate it).
 *
 * Two independent dedup guards, because a tracker can double-report in two ways:
 *
 *   1. **Retry by `event_id`.** A re-sent beacon carries the same id and is
 *      counted once — the same idempotency `event_id` gives everywhere else.
 *   2. **Overlapping intervals.** Each beacon is modelled as the active interval
 *      `[occurred_at − active_ms, occurred_at]`; the intervals are merged and
 *      the merged lengths summed. Two overlapping or cumulative beacons collapse
 *      into their union instead of summing, so neither a retry nor a
 *      cumulative-vs-delta reporting mistake can push active time past real
 *      wall-clock. Distinct, non-overlapping active windows still add up.
 *
 * This is "deduped active time", not "open time": a page left open in a
 * background tab produces no engagement beacon and adds nothing.
 */
export function mergedActiveDurationMs(
  events: readonly { eventId: string; occurredMs: number; activeMs: number | null }[],
): number {
  const seen = new Set<string>()
  const intervals: { start: number; end: number }[] = []
  for (const event of events) {
    if (event.activeMs == null) continue
    if (seen.has(event.eventId)) continue
    seen.add(event.eventId)
    const end = event.occurredMs
    const start = end - Math.max(0, event.activeMs)
    intervals.push({ start, end })
  }
  if (intervals.length === 0) return 0

  intervals.sort((a, b) => a.start - b.start || a.end - b.end)
  let total = 0
  let curStart = intervals[0]!.start
  let curEnd = intervals[0]!.end
  for (let i = 1; i < intervals.length; i += 1) {
    const interval = intervals[i]!
    if (interval.start <= curEnd) {
      if (interval.end > curEnd) curEnd = interval.end
    } else {
      total += curEnd - curStart
      curStart = interval.start
      curEnd = interval.end
    }
  }
  total += curEnd - curStart
  return total
}

/**
 * Whether a session is engaged (docs snapshot 02 §10): at least 10 seconds of
 * active time, OR a meaningful custom event / conversion, OR two or more
 * pageviews. Bounce is exactly the negation.
 *
 * "Meaningful custom event/conversion" is taken here as any `custom_event` or
 * `conversion`; distinguishing dashboard-defined "meaningful" events from
 * incidental ones is a later refinement tied to the M13 event registry, and the
 * §10 definition names the type, not a per-event flag.
 */
export function isEngaged(
  input: {
    readonly pageviews: number
    readonly activeDurationMs: number
    readonly hasMeaningfulCustomOrConversion: boolean
  },
  config: SessionConfig = DEFAULT_SESSION_CONFIG,
): boolean {
  return (
    input.activeDurationMs >= config.ENGAGED_MIN_ACTIVE_MS ||
    input.hasMeaningfulCustomOrConversion ||
    input.pageviews >= config.ENGAGED_MIN_PAGEVIEWS
  )
}

function resolvedIdentityOf(userId: string, anonymousId: string): string {
  return userId !== '' ? userId : anonymousId
}

function normalize(event: SessionizerEvent): NormalizedEvent | null {
  if (!isActivityType(event.type)) return null
  const occurredMs = toMs(event.occurredAt)
  if (!Number.isFinite(occurredMs)) return null
  const userId = str(event.userId)
  const anonymousId = str(event.anonymousId)
  const activeMs =
    event.type === 'engagement' && event.engagement != null
      ? Math.max(0, event.engagement.activeMs)
      : null
  return {
    eventId: event.eventId,
    type: event.type,
    occurredMs,
    anonymousId,
    userId,
    resolvedIdentity: resolvedIdentityOf(userId, anonymousId),
    sessionHint: str(event.sessionHint),
    utcDate: utcDateOf(occurredMs),
    pagePath: str(event.pagePath),
    referrerDomain: str(event.referrerDomain),
    utmSource: str(event.utmSource),
    utmMedium: str(event.utmMedium),
    utmCampaign: str(event.utmCampaign),
    utmContent: str(event.utmContent),
    utmTerm: str(event.utmTerm),
    deviceType: str(event.deviceType),
    browser: str(event.browser),
    os: str(event.os),
    country: str(event.country),
    activeMs,
  }
}

/** Deterministic ordering: by occurred time, then by event id as the tie-break. */
function compareEvents(a: NormalizedEvent, b: NormalizedEvent): number {
  if (a.occurredMs !== b.occurredMs) return a.occurredMs - b.occurredMs
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0
}

interface RawSession {
  readonly events: NormalizedEvent[]
  readonly anonymousIds: Set<string>
  readonly hints: Set<string>
  identified: boolean
  /** A UTC-midnight anonymous rotation was joined into this session (D-102). */
  midnightBridged: boolean
  /** An all-anonymous prefix was joined to this identified session by the stitch. */
  identityStitched: boolean
  startMs: number
  endMs: number
}

function hashSessionId(siteId: string, firstEventId: string): string {
  return createHash('sha256').update(`${siteId}\n${firstEventId}`).digest('hex').slice(0, 32)
}

function finalizeSession(
  siteId: string,
  session: RawSession,
  config: SessionConfig,
): CanonicalSession {
  // Events arrive already sorted (the whole input is sorted once up front and
  // never reordered), so entry is the first and exit is the last.
  const events = session.events
  const entry = events[0]!
  // Resolved identity is per-session, not per-entry-event: a session that
  // identified partway through (the identity stitch below) belongs to that user
  // for its whole span, so the user id wins over the entry anonymous id even
  // though the entry event was anonymous. Falls back to the entry anonymous id
  // for a never-identified session — the M7 if(user_id, user_id, anonymous_id).
  const sessionUserId = events.find((event) => event.userId !== '')?.userId ?? ''
  const pageEvents = events.filter((event) => event.type === 'page_view')
  const pageviews = pageEvents.length
  const activeDurationMs = mergedActiveDurationMs(events)
  const startMs = events[0]!.occurredMs
  const endMs = events[events.length - 1]!.occurredMs
  const hasMeaningfulCustomOrConversion = events.some(
    (event) => event.type === 'custom_event' || event.type === 'conversion',
  )
  const engaged = isEngaged(
    { pageviews, activeDurationMs, hasMeaningfulCustomOrConversion },
    config,
  )
  const entryPage = pageEvents[0]
  const exitPage = pageEvents[pageEvents.length - 1]

  return {
    sessionId: hashSessionId(siteId, entry.eventId),
    siteId,
    visitorId: resolvedIdentityOf(sessionUserId, entry.anonymousId),
    userId: sessionUserId,
    anonymousId: entry.anonymousId,
    sessionHint: entry.sessionHint,
    midnightBridged: session.midnightBridged,
    identityStitched: session.identityStitched,
    startMs,
    endMs,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
    pageviews,
    engaged,
    bounced: !engaged,
    activeDurationMs,
    sessionDurationMs: endMs - startMs,
    entryPagePath: entryPage ? entryPage.pagePath : '',
    exitPagePath: exitPage ? exitPage.pagePath : '',
    referrerDomain: entry.referrerDomain,
    utmSource: entry.utmSource,
    utmMedium: entry.utmMedium,
    utmCampaign: entry.utmCampaign,
    utmContent: entry.utmContent,
    utmTerm: entry.utmTerm,
    deviceType: entry.deviceType,
    browser: entry.browser,
    os: entry.os,
    country: entry.country,
    eventIds: events.map((event) => event.eventId),
  }
}

function newRawSession(event: NormalizedEvent): RawSession {
  return {
    events: [event],
    anonymousIds: new Set([event.anonymousId]),
    hints: event.sessionHint !== '' ? new Set([event.sessionHint]) : new Set(),
    identified: event.userId !== '',
    midnightBridged: false,
    identityStitched: false,
    startMs: event.occurredMs,
    endMs: event.occurredMs,
  }
}

function pushEvent(session: RawSession, event: NormalizedEvent): void {
  session.events.push(event)
  session.anonymousIds.add(event.anonymousId)
  if (event.sessionHint !== '') session.hints.add(event.sessionHint)
  if (event.userId !== '') session.identified = true
  session.endMs = event.occurredMs
}

function sharesHint(a: RawSession, b: RawSession): boolean {
  for (const hint of a.hints) {
    if (b.hints.has(hint)) return true
  }
  return false
}

/**
 * The canonical sessionizer (plan Milestone 8 item 1).
 *
 * Pure and total: it never throws and never reads a clock. The same event set,
 * in any order, yields identical sessions — the input is sorted once by
 * `(occurred_at, event_id)` and everything after is a deterministic fold.
 *
 * Returns sessions ordered by `(startMs, sessionId)`.
 */
export function sessionize(
  siteId: string,
  events: readonly SessionizerEvent[],
  config: SessionConfig = DEFAULT_SESSION_CONFIG,
): CanonicalSession[] {
  const inactivityMs = config.SESSION_INACTIVITY_MINUTES * MS_PER_MINUTE
  // A session spans at most the cap from its first event (ADR-0018). Measured in
  // ms so it can be compared against `occurred_at` deltas directly.
  const capMs = config.SESSION_MAX_LENGTH_HOURS * MS_PER_HOUR

  // 1. Normalize (dropping passive/unknown types) and order deterministically.
  const normalized = events
    .map(normalize)
    .filter((event): event is NormalizedEvent => event !== null)
    .sort(compareEvents)

  // 2. Partition by (resolved identity) and split each partition on the
  //    30-minute meaningful-inactivity gap. Insertion order into the map follows
  //    the global sort, so iteration below is deterministic.
  const byIdentity = new Map<string, RawSession[]>()
  for (const event of normalized) {
    const key = event.resolvedIdentity
    const partition = byIdentity.get(key)
    if (partition === undefined) {
      byIdentity.set(key, [newRawSession(event)])
      continue
    }
    const current = partition[partition.length - 1]!
    // Split on a meaningful-inactivity gap OR at the 24h cap (ADR-0018): the first
    // event at or beyond `session_start + cap` begins a new session, exactly like
    // an inactivity split at that boundary and under the same sorted
    // `(occurred_at, event_id)` order. The cap never fires for a real sub-24h
    // session; it bounds only a never-ending stream so the finalizer watermark
    // can advance (ADR-0012's open item).
    if (
      event.occurredMs - current.endMs > inactivityMs ||
      event.occurredMs - current.startMs >= capMs
    ) {
      partition.push(newRawSession(event))
    } else {
      pushEvent(current, event)
    }
  }

  const rawSessions: RawSession[] = []
  for (const partition of byIdentity.values()) {
    rawSessions.push(...partition)
  }
  // Order by start so the midnight bridge and the output are deterministic.
  rawSessions.sort((a, b) => a.startMs - b.startMs || compareEvents(a.events[0]!, b.events[0]!))

  // 3. Midnight bridge (D-102): re-join two adjacent anonymous sessions that a
  //    UTC-midnight anonymous-id rotation split, when they share a hint and are
  //    within the inactivity window across exactly one calendar boundary. Folded
  //    left so a session crossing several midnights chains.
  const bridged = new Set<RawSession>()
  if (config.MIDNIGHT_BRIDGE_ENABLED) {
    for (let i = 0; i < rawSessions.length; i += 1) {
      const head = rawSessions[i]!
      if (head.identified || bridged.has(head)) continue
      for (let j = i + 1; j < rawSessions.length; j += 1) {
        const next = rawSessions[j]!
        if (next.identified) continue
        if (next.startMs - head.endMs > inactivityMs) break // sorted: nothing later is closer
        if (bridged.has(next)) continue
        // The cap bounds a bridged session too (ADR-0018). Refuse to bridge a
        // rotation whose events would carry this session's span to or past the
        // cap from its first event. For a real cross-midnight visitor the bridged
        // span is minutes, so this never fires; it stops only a persistent
        // anonymous stream (a kiosk with a sticky hint) from chaining day after
        // day into a session that never closes and stalls the watermark.
        if (next.endMs - head.startMs >= capMs) continue
        // Different network identity, joined only when a shared hint vouches for
        // the continuity — and, when the rotation is a midnight one, only across
        // a single calendar boundary.
        const differentAnon = ![...next.anonymousIds].every((id) => head.anonymousIds.has(id))
        if (!differentAnon) continue
        const headDate = utcDateOf(head.endMs)
        const nextDate = utcDateOf(next.startMs)
        const crossesMidnight = headDate !== nextDate
        if (crossesMidnight && !isAdjacentUtcDate(headDate, nextDate)) continue
        if (!sharesHint(head, next)) continue
        // Merge next into head and keep folding.
        for (const event of next.events) pushEvent(head, event)
        head.events.sort(compareEvents)
        head.endMs = head.events[head.events.length - 1]!.occurredMs
        // Only a rotation that actually crossed a UTC date is a *midnight*
        // bridge. A same-day merge stays unflagged: the flag's job is to make
        // linkage across the daily rotation visible, and there is none here.
        if (crossesMidnight) head.midnightBridged = true
        bridged.add(next)
      }
    }
  }

  // 4. Identity stitch: merge an all-anonymous session into the adjacent
  //    identified session it continues (a mid-visit identify). The identified
  //    session's own events carry the anonymous id — the identify event carries
  //    both ids — so the linkage is proven by the events and needs no hint and
  //    creates no new privacy linkage (unlike the midnight bridge). Run after the
  //    bridge so a session that both spans midnight and then identifies stitches
  //    the already-bridged anonymous span onto the identified one. Deterministic
  //    and iterative: each identified session, in start order, absorbs the
  //    nearest preceding linked anonymous session to a fixpoint.
  const stitched = new Set<RawSession>()
  for (const idSession of rawSessions) {
    if (!idSession.identified || bridged.has(idSession)) continue
    let absorbedAny = true
    while (absorbedAny) {
      absorbedAny = false
      for (const anon of rawSessions) {
        if (anon.identified || bridged.has(anon) || stitched.has(anon)) continue
        // The anonymous span must precede this identified session and sit inside
        // the inactivity window of its (possibly already-extended) start.
        if (anon.startMs > idSession.startMs) continue
        if (idSession.startMs - anon.endMs > inactivityMs) continue
        // The cap bounds a stitched session too (ADR-0018): do not absorb an
        // anonymous prefix that would carry the identified session's span to or
        // past the cap from the prefix's first event. Real login flows stitch a
        // short anonymous prefix; this only refuses a pathological span.
        if (idSession.endMs - anon.startMs >= capMs) continue
        // Sanity bound: the join stays within one calendar boundary (the window
        // already guarantees it, but this makes the intent explicit).
        const anonDate = utcDateOf(anon.endMs)
        const idDate = utcDateOf(idSession.startMs)
        if (anonDate !== idDate && !isAdjacentUtcDate(anonDate, idDate)) continue
        // Linkage proven by a shared anonymous id — two different identified users
        // on one device never share a user id, so they never stitch to each other.
        const linked = [...idSession.anonymousIds].some((id) => anon.anonymousIds.has(id))
        if (!linked) continue
        for (const event of anon.events) pushEvent(idSession, event)
        idSession.events.sort(compareEvents)
        idSession.startMs = idSession.events[0]!.occurredMs
        idSession.endMs = idSession.events[idSession.events.length - 1]!.occurredMs
        idSession.identityStitched = true
        stitched.add(anon)
        absorbedAny = true
      }
    }
  }

  const finalized = rawSessions
    .filter((session) => !bridged.has(session) && !stitched.has(session))
    .map((session) => finalizeSession(siteId, session, config))

  finalized.sort((a, b) => a.startMs - b.startMs || (a.sessionId < b.sessionId ? -1 : 1))
  return finalized
}
