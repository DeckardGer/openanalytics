import type { CanonicalSession } from '@openanalytics/domain'
import type {
  RollupBucketAggregate,
  SessionFactRow,
  SessionRollupRow,
  StoredRollupBucket,
  StoredSessionFact,
} from '@openanalytics/clickhouse'

/**
 * The finalizer's pure planning core (docs snapshot 02 §10, §15, 05 D-211).
 * Milestone 8 Checkpoint B.
 *
 * Given the sessions the pure sessionizer recomputed for a window and the facts
 * currently stored for that window, this decides — with no clock of its own and
 * no I/O — exactly which fact rows to write:
 *
 *   - a **new version** for every recomputed session that differs from its
 *     stored latest (a late second pageview that flipped a bounce to engaged is
 *     the motivating case, D-211), and for a session that had been retracted and
 *     has reappeared;
 *   - a **retraction tombstone** for every stored, non-retracted session id that
 *     the recompute no longer produces (a re-key by a late earlier event, or a
 *     bridge/stitch merge — migration 0013's tombstone contract);
 *   - **nothing at all** for a session whose recompute is byte-identical to what
 *     is stored, which is what makes a re-run over an unchanged range a no-op and
 *     acceptance criterion 2 hold.
 *
 * The version is `max(stored version in the window) + 1`, shared by every row the
 * run writes — monotonic, and derived from stored state rather than a clock, so
 * two runs can never collide on a version through a timestamp race. The finalized
 * flag is set from the caller's `nowMs` against the inactivity + lateness
 * horizon; a session past it can never change again.
 *
 * The watermark this returns is `min(horizon, earliest provisional session
 * start)`, pulled back to a fixpoint so that no recomputed session's span
 * straddles it. The naive `min(...)` is unsafe on its own: the next recompute
 * window reads by `>= watermark`, so a session that overlaps the watermark in
 * wall-clock time would be split — its tail re-sessionized under a new id while
 * the stored original stays invisible to the diff — and duplicated. The
 * pull-back re-includes any overlapping (typically already finalized) session in
 * the next window, where it recomputes byte-identical and writes nothing.
 */

const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000

/** A ClickHouse `DateTime64(3, 'UTC')` literal from epoch ms: `YYYY-MM-DD HH:MM:SS.mmm`. */
function chDateTime64(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '')
}

/** A ClickHouse `DateTime('UTC')` literal from epoch ms: `YYYY-MM-DD HH:MM:SS`. */
export function chDateTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '').slice(0, 19)
}

/** UTC start-of-hour, in epoch ms. Matches ClickHouse `toStartOfHour` on a UTC column. */
export function hourBucketMs(ms: number): number {
  return Math.floor(ms / MS_PER_HOUR) * MS_PER_HOUR
}

/** UTC start-of-day, in epoch ms. Matches ClickHouse `toStartOfDay` on a UTC column. */
export function dayBucketMs(ms: number): number {
  return Math.floor(ms / MS_PER_DAY) * MS_PER_DAY
}

/** The comparable payload of a fact — everything that decides whether a version is new. */
interface FactFingerprint {
  readonly startMs: number
  readonly endMs: number
  readonly visitorId: string
  readonly userId: string
  readonly anonymousId: string
  readonly sessionHint: string
  readonly midnightBridged: number
  readonly pageviews: number
  readonly engaged: number
  readonly activeDurationMs: number
  readonly sessionDurationMs: number
  readonly entryPagePath: string
  readonly exitPagePath: string
  readonly referrerDomain: string
  readonly utmSource: string
  readonly utmMedium: string
  readonly utmCampaign: string
  /**
   * ADR-0033 D6 / ClickHouse migration 0017, added in lockstep with the column.
   *
   * A fingerprint field that the table has but the comparison does not is a
   * column that never fills for a session that already exists: the recompute
   * would produce the real value, compare equal on everything the fingerprint
   * does look at, and write nothing.
   *
   * Adding them here does NOT re-version the world, and the reason is that the
   * ALTER's default and the sessionizer's absence sentinel are the same byte.
   * ClickHouse fills an added `LowCardinality(String)` with `''` in every part
   * written before the migration, and `sessionize` normalizes an absent utm to
   * `''` as well (the fact table has avoided `Nullable` since 0013). So a stored
   * pre-extension fact compares UNEQUAL to its recompute exactly when the
   * session genuinely carried a utm_content/utm_term — which is a row that is
   * genuinely missing data and should get a new version — and compares EQUAL
   * otherwise. Had the column been Nullable, every stored session would have
   * differed and the first pass after the migration would have rewritten the
   * whole table.
   */
  readonly utmContent: string
  readonly utmTerm: string
  readonly deviceType: string
  readonly browser: string
  readonly os: string
  readonly country: string
  readonly finalized: number
}

function fingerprintOfSession(session: CanonicalSession, finalized: number): FactFingerprint {
  return {
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
    utmContent: session.utmContent,
    utmTerm: session.utmTerm,
    deviceType: session.deviceType,
    browser: session.browser,
    os: session.os,
    country: session.country,
    finalized,
  }
}

function fingerprintOfStored(stored: StoredSessionFact): FactFingerprint {
  return {
    startMs: stored.startMs,
    endMs: stored.endMs,
    visitorId: stored.visitorId,
    userId: stored.userId,
    anonymousId: stored.anonymousId,
    sessionHint: stored.sessionHint,
    midnightBridged: stored.midnightBridged,
    pageviews: stored.pageviews,
    engaged: stored.engaged,
    activeDurationMs: stored.activeDurationMs,
    sessionDurationMs: stored.sessionDurationMs,
    entryPagePath: stored.entryPagePath,
    exitPagePath: stored.exitPagePath,
    referrerDomain: stored.referrerDomain,
    utmSource: stored.utmSource,
    utmMedium: stored.utmMedium,
    utmCampaign: stored.utmCampaign,
    utmContent: stored.utmContent,
    utmTerm: stored.utmTerm,
    deviceType: stored.deviceType,
    browser: stored.browser,
    os: stored.os,
    country: stored.country,
    finalized: stored.finalized,
  }
}

function fingerprintsEqual(a: FactFingerprint, b: FactFingerprint): boolean {
  return (
    a.startMs === b.startMs &&
    a.endMs === b.endMs &&
    a.visitorId === b.visitorId &&
    a.userId === b.userId &&
    a.anonymousId === b.anonymousId &&
    a.sessionHint === b.sessionHint &&
    a.midnightBridged === b.midnightBridged &&
    a.pageviews === b.pageviews &&
    a.engaged === b.engaged &&
    a.activeDurationMs === b.activeDurationMs &&
    a.sessionDurationMs === b.sessionDurationMs &&
    a.entryPagePath === b.entryPagePath &&
    a.exitPagePath === b.exitPagePath &&
    a.referrerDomain === b.referrerDomain &&
    a.utmSource === b.utmSource &&
    a.utmMedium === b.utmMedium &&
    a.utmCampaign === b.utmCampaign &&
    a.utmContent === b.utmContent &&
    a.utmTerm === b.utmTerm &&
    a.deviceType === b.deviceType &&
    a.browser === b.browser &&
    a.os === b.os &&
    a.country === b.country &&
    a.finalized === b.finalized
  )
}

function sessionToFactRow(
  siteId: string,
  session: CanonicalSession,
  fields: { version: number; finalized: number; computedAtMs: number },
): SessionFactRow {
  return {
    site_id: siteId,
    session_id: session.sessionId,
    version: fields.version,
    visitor_id: session.visitorId,
    user_id: session.userId,
    anonymous_id: session.anonymousId,
    session_hint: session.sessionHint,
    midnight_bridged: session.midnightBridged ? 1 : 0,
    session_start: chDateTime64(session.startMs),
    session_end: chDateTime64(session.endMs),
    pageviews: session.pageviews,
    engaged: session.engaged ? 1 : 0,
    active_duration_ms: session.activeDurationMs,
    session_duration_ms: session.sessionDurationMs,
    entry_page_path: session.entryPagePath,
    exit_page_path: session.exitPagePath,
    referrer_domain: session.referrerDomain,
    utm_source: session.utmSource,
    utm_medium: session.utmMedium,
    utm_campaign: session.utmCampaign,
    utm_content: session.utmContent,
    utm_term: session.utmTerm,
    device_type: session.deviceType,
    browser: session.browser,
    os: session.os,
    country: session.country,
    finalized: fields.finalized,
    retracted: 0,
    computed_at: chDateTime64(fields.computedAtMs),
  }
}

/**
 * A tombstone carries the vanished session's last-known dimensions, not zeros:
 * the read selects the latest version's fields with argMax and only then drops
 * `retracted = 1`, so a coherent set of fields keeps any diagnostic read of the
 * tombstone itself meaningful. The only load-bearing columns are `retracted = 1`
 * and the strictly-higher `version`.
 */
function storedToTombstoneRow(
  siteId: string,
  stored: StoredSessionFact,
  fields: { version: number; computedAtMs: number },
): SessionFactRow {
  return {
    site_id: siteId,
    session_id: stored.sessionId,
    version: fields.version,
    visitor_id: stored.visitorId,
    user_id: stored.userId,
    anonymous_id: stored.anonymousId,
    session_hint: stored.sessionHint,
    midnight_bridged: stored.midnightBridged,
    session_start: chDateTime64(stored.startMs),
    session_end: chDateTime64(stored.endMs),
    pageviews: stored.pageviews,
    engaged: stored.engaged,
    active_duration_ms: stored.activeDurationMs,
    session_duration_ms: stored.sessionDurationMs,
    entry_page_path: stored.entryPagePath,
    exit_page_path: stored.exitPagePath,
    referrer_domain: stored.referrerDomain,
    utm_source: stored.utmSource,
    utm_medium: stored.utmMedium,
    utm_campaign: stored.utmCampaign,
    utm_content: stored.utmContent,
    utm_term: stored.utmTerm,
    device_type: stored.deviceType,
    browser: stored.browser,
    os: stored.os,
    country: stored.country,
    finalized: stored.finalized,
    retracted: 1,
    computed_at: chDateTime64(fields.computedAtMs),
  }
}

export interface SessionFactsPlanInput {
  readonly siteId: string
  readonly recomputed: readonly CanonicalSession[]
  readonly stored: readonly StoredSessionFact[]
  readonly nowMs: number
  readonly inactivityMs: number
  readonly latenessMs: number
  /**
   * The session cap in ms (`SESSION_MAX_LENGTH_HOURS`, ADR-0018). A session can
   * never legally extend past the cap from its start — the sessionizer splits it
   * there — so a session whose start predates `cap + inactivity + lateness` is
   * closable by definition and must not hold the watermark provisional. This is
   * what bounds the recompute window against a never-ending stream (ADR-0012's
   * open item). Optional: omitted, the finalized decision falls back to the
   * end-vs-horizon test alone (the pre-ADR-0018 behaviour), used by the tests
   * that predate the cap.
   */
  readonly sessionMaxLengthMs?: number
}

export interface SessionFactsPlan {
  /** New versions and tombstones to insert. Empty when nothing changed. */
  readonly factRows: readonly SessionFactRow[]
  readonly version: number
  readonly changed: number
  readonly retracted: number
  /** UTC hour-bucket starts (epoch ms) touched by a written row. Sorted, unique. */
  readonly affectedHourBucketsMs: readonly number[]
  /** UTC day-bucket starts (epoch ms) touched by a written row. Sorted, unique. */
  readonly affectedDayBucketsMs: readonly number[]
  /**
   * The watermark this run may advance to: `min(horizon, earliest provisional
   * session start)`, then pulled back so that no recomputed session's span
   * straddles it (else the next `>= watermark` window would bisect an
   * overlapping finalized session and duplicate its tail). Everything before it
   * is finalized. Caller clamps it to be monotonic against the stored watermark.
   */
  readonly finalizedThroughMs: number
}

/**
 * Plan the fact writes for one recompute window. Pure.
 */
export function planSessionFacts(input: SessionFactsPlanInput): SessionFactsPlan {
  const horizonMs = input.nowMs - input.inactivityMs - input.latenessMs
  // A session capped at `SESSION_MAX_LENGTH_HOURS` (ADR-0018) has its end no later
  // than `start + cap`, so once its start predates this cap-horizon its end is
  // already ≤ horizonMs and it is finalized regardless of any late tail. Treating
  // it as finalized here (and thus keeping it out of `earliestProvisionalStart`)
  // is what makes the watermark bound hold: a never-ending stream is split into
  // ≤24h sessions, and every session older than the bound closes, so the earliest
  // still-provisional start can never fall below `now - (cap + inactivity +
  // lateness)` and the recompute window stays bounded — the stall ADR-0012
  // documented is impossible. Given a correctly-capped sessionizer this term never
  // changes a decision the end-vs-horizon test would not already make; it makes
  // the bound explicit and independent of trusting the sessionizer.
  const capHorizonMs =
    input.sessionMaxLengthMs === undefined
      ? Number.NEGATIVE_INFINITY
      : input.nowMs - input.sessionMaxLengthMs - input.inactivityMs - input.latenessMs
  const computedAtMs = input.nowMs

  const storedById = new Map<string, StoredSessionFact>()
  let windowMaxVersion = 0
  for (const fact of input.stored) {
    storedById.set(fact.sessionId, fact)
    if (fact.version > windowMaxVersion) windowMaxVersion = fact.version
  }
  const version = windowMaxVersion + 1

  const recomputedIds = new Set<string>()
  const factRows: SessionFactRow[] = []
  const hourBuckets = new Set<number>()
  const dayBuckets = new Set<number>()
  let changed = 0
  let retracted = 0

  // The watermark starts at the horizon and is pulled back to the earliest
  // still-provisional session so the next window fully re-reads every session
  // that could still change.
  let earliestProvisionalStart = Number.POSITIVE_INFINITY

  for (const session of input.recomputed) {
    recomputedIds.add(session.sessionId)
    const finalized = session.endMs <= horizonMs || session.startMs <= capHorizonMs ? 1 : 0
    if (finalized === 0 && session.startMs < earliestProvisionalStart) {
      earliestProvisionalStart = session.startMs
    }

    const stored = storedById.get(session.sessionId)
    const isNew =
      stored === undefined ||
      stored.retracted === 1 ||
      !fingerprintsEqual(fingerprintOfSession(session, finalized), fingerprintOfStored(stored))
    if (!isNew) continue

    factRows.push(sessionToFactRow(input.siteId, session, { version, finalized, computedAtMs }))
    hourBuckets.add(hourBucketMs(session.startMs))
    dayBuckets.add(dayBucketMs(session.startMs))
    changed += 1
  }

  for (const stored of input.stored) {
    if (stored.retracted === 1) continue
    if (recomputedIds.has(stored.sessionId)) continue
    factRows.push(storedToTombstoneRow(input.siteId, stored, { version, computedAtMs }))
    hourBuckets.add(hourBucketMs(stored.startMs))
    dayBuckets.add(dayBucketMs(stored.startMs))
    retracted += 1
  }

  // The watermark starts at min(horizon, earliest provisional start), but that is
  // not yet safe: the next window reads events and stored facts by
  // `>= watermark`, so a session whose SPAN straddles the watermark would be
  // bisected — its tail re-sessionized under a new id (a different first event),
  // with the stored original invisible to the diff (its session_start is below
  // the watermark), producing a spurious, un-tombstoned duplicate. So pull the
  // watermark back to a fixpoint where no recomputed session straddles it. This
  // catches an already-FINALIZED session that overlaps the earliest provisional
  // one in wall-clock time (ordinary — different visitors overlap). Re-reading
  // such a finalized session next run is harmless: it recomputes byte-identical
  // and the change detector writes nothing.
  //
  // `endMs >= wm` (not `>`): an event at exactly `occurred_at == wm` is included
  // by the next window's `>=` read, so a session ending exactly on the watermark
  // would still leak a one-event fragment. The loop terminates because the
  // watermark only ever moves to a session start, a finite set, and only
  // downward.
  let finalizedThroughMs = Math.min(
    horizonMs,
    earliestProvisionalStart === Number.POSITIVE_INFINITY ? horizonMs : earliestProvisionalStart,
  )
  for (let moved = true; moved;) {
    moved = false
    for (const session of input.recomputed) {
      if (session.startMs < finalizedThroughMs && session.endMs >= finalizedThroughMs) {
        finalizedThroughMs = session.startMs
        moved = true
      }
    }
  }

  return {
    factRows,
    version,
    changed,
    retracted,
    affectedHourBucketsMs: [...hourBuckets].sort((a, b) => a - b),
    affectedDayBucketsMs: [...dayBuckets].sort((a, b) => a - b),
    finalizedThroughMs,
  }
}

function aggregatesEqual(a: RollupBucketAggregate, b: RollupBucketAggregate): boolean {
  return (
    a.sessions === b.sessions &&
    a.engagedSessions === b.engagedSessions &&
    a.bouncedSessions === b.bouncedSessions &&
    a.pageviews === b.pageviews &&
    a.totalSessionDurationMs === b.totalSessionDurationMs &&
    a.totalActiveDurationMs === b.totalActiveDurationMs
  )
}

function zeroAggregate(bucketSeconds: number): RollupBucketAggregate {
  return {
    bucketSeconds,
    bucketStart: chDateTime(bucketSeconds * 1000),
    sessions: 0,
    engagedSessions: 0,
    bouncedSessions: 0,
    pageviews: 0,
    totalSessionDurationMs: 0,
    totalActiveDurationMs: 0,
  }
}

export interface RollupSwapPlanInput {
  readonly siteId: string
  /** Buckets recomputed from the current non-retracted facts. */
  readonly recomputed: readonly RollupBucketAggregate[]
  /** The current latest-generation rollup per bucket. */
  readonly stored: readonly StoredRollupBucket[]
  /** The bucket starts (epoch seconds) a fact write touched — only these are considered. */
  readonly affectedBucketSeconds: readonly number[]
  readonly computedAtMs: number
}

export interface RollupSwapPlan {
  readonly rows: readonly SessionRollupRow[]
  readonly generation: number
  readonly changed: number
}

/**
 * Plan the rollup swap for one unit (1h or 1d). Pure.
 *
 * Only the affected buckets are considered (bounded work, D-211). A bucket is
 * rewritten at `max(stored generation) + 1` when its recomputed aggregate
 * differs from the stored latest generation — including the case where every
 * session in the bucket was retracted, which recomputes to a zero row that must
 * overwrite the stale non-zero one. An unchanged bucket writes nothing, so a
 * re-run collapses to a no-op (acceptance criterion 2).
 */
export function planRollupSwap(input: RollupSwapPlanInput): RollupSwapPlan {
  const recomputedBySeconds = new Map<number, RollupBucketAggregate>()
  for (const bucket of input.recomputed) recomputedBySeconds.set(bucket.bucketSeconds, bucket)

  const storedBySeconds = new Map<number, StoredRollupBucket>()
  let maxGeneration = 0
  for (const bucket of input.stored) {
    storedBySeconds.set(bucket.bucketSeconds, bucket)
    if (bucket.generation > maxGeneration) maxGeneration = bucket.generation
  }
  const generation = maxGeneration + 1

  const rows: SessionRollupRow[] = []
  let changed = 0

  for (const bucketSeconds of input.affectedBucketSeconds) {
    const recomputed = recomputedBySeconds.get(bucketSeconds) ?? zeroAggregate(bucketSeconds)
    const stored = storedBySeconds.get(bucketSeconds)

    if (stored === undefined && recomputed.sessions === 0) continue
    if (stored !== undefined && aggregatesEqual(stored, recomputed)) continue

    rows.push({
      site_id: input.siteId,
      bucket_start: recomputed.bucketStart,
      generation,
      sessions: recomputed.sessions,
      engaged_sessions: recomputed.engagedSessions,
      bounced_sessions: recomputed.bouncedSessions,
      pageviews: recomputed.pageviews,
      total_session_duration_ms: recomputed.totalSessionDurationMs,
      total_active_duration_ms: recomputed.totalActiveDurationMs,
      computed_at: chDateTime64(input.computedAtMs),
    })
    changed += 1
  }

  return { rows, generation, changed }
}
