/**
 * The session read model: how a `[from, to)` range is split into a finalized and
 * a provisional layer, and how the additive session totals become bounce rate
 * and average durations (docs snapshot 02 §10, §15; 04 Milestone 8 items 6-7;
 * docs snapshot 05, D-211).
 *
 * This module is pure and deterministic, the same discipline `session.ts` and
 * `analytics-query.ts` keep, so the API read service and its tests reach the same
 * split from the same inputs. It contains no SQL and no clock.
 *
 * ## The two-layer read (§15)
 *
 * §15 is explicit: a long range reads the finalized `session_rollups_*`, and the
 * recent window past the site's `finalized_through` reads the provisional layer
 * straight from `session_facts_versions`. The danger is double-counting a session
 * that both sits in a finalized rollup bucket and is re-read from the provisional
 * facts. {@link splitSessionRange} makes the split **provably non-overlapping** by
 * cutting at a UTC bucket boundary derived from `finalized_through`:
 *
 *   - Let `B = floor(finalized_through)` to the source rollup's UTC bucket unit
 *     (hour for the 1h-sourced reads, day for the 1d-sourced read). `B` is
 *     bucket-aligned and `B <= finalized_through`.
 *   - **Finalized layer** reads rollup buckets with `bucket_start < B`. Every
 *     session in such a bucket has `session_start < B <= finalized_through`, so it
 *     is finalized and its rollup row will never change again (acceptance
 *     criterion 2). These buckets are read from `session_rollups_*`.
 *   - **Provisional layer** reads facts with `session_start >= B` — current truth
 *     via argMax-over-version-then-`retracted = 0` (migration 0013).
 *
 * A session with `session_start < B` lands only in the finalized read (its bucket
 * is `< B`); a session with `session_start >= B` lands only in the provisional
 * read (its bucket is `>= B`, excluded from the finalized read). The two layers
 * partition the sessions by `session_start` at the same aligned instant `B`, so no
 * session is counted twice and none is dropped. Checkpoint B's finalizer keeps
 * `finalized_through` pulled back so that no recomputed session's span straddles
 * it, which is what lets `session_start` alone decide the layer.
 *
 * When `finalized_through` is null (a site the finalizer has never run) `B`
 * collapses to `effectiveFrom`, so the whole range is provisional — the honest
 * answer for a site with no finalized rollups yet.
 */

const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000

/** The UTC bucket unit a session read is aligned and split on. */
export type SessionSplitUnit = 'hour' | 'day'

/** Floors an ISO instant to the start of its UTC hour or day. */
export function floorUtcTo(iso: string, unit: SessionSplitUnit): string {
  const ms = Date.parse(iso)
  const size = unit === 'hour' ? MS_PER_HOUR : MS_PER_DAY
  return new Date(Math.floor(ms / size) * size).toISOString()
}

/** A half-open UTC sub-range, or `null` when the layer reads nothing. */
export interface SessionSubRange {
  readonly from: string
  readonly to: string
}

export interface SessionRangeSplit {
  /** Rollup buckets to read from the finalized layer, or null when empty. */
  readonly finalized: SessionSubRange | null
  /** Facts (`session_start` filter) to read from the provisional layer, or null. */
  readonly provisional: SessionSubRange | null
  /** The aligned split boundary `B`, surfaced for tests and traceability. */
  readonly boundary: string
}

/**
 * Splits a bucket-aligned `[effectiveFrom, effectiveTo)` range into a finalized
 * and a provisional sub-range at the aligned boundary derived from
 * `finalizedThrough` (see the module comment). `effectiveFrom`/`effectiveTo` must
 * already be snapped to the source rollup's UTC boundary; the split boundary is
 * snapped here.
 *
 * Pure and total: an inverted or malformed input yields two null layers rather
 * than throwing.
 */
export function splitSessionRange(input: {
  readonly effectiveFrom: string
  readonly effectiveTo: string
  readonly finalizedThrough: string | null
  readonly splitUnit: SessionSplitUnit
}): SessionRangeSplit {
  const fromMs = Date.parse(input.effectiveFrom)
  const toMs = Date.parse(input.effectiveTo)

  // A null (or unparseable) watermark means nothing is finalized: the boundary
  // sits at the range start and the whole range is provisional.
  const rawBoundary =
    input.finalizedThrough === null || Number.isNaN(Date.parse(input.finalizedThrough))
      ? input.effectiveFrom
      : floorUtcTo(input.finalizedThrough, input.splitUnit)
  const boundaryMs = Date.parse(rawBoundary)

  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs <= fromMs) {
    return { finalized: null, provisional: null, boundary: rawBoundary }
  }

  // Finalized layer: [effectiveFrom, min(effectiveTo, B)).
  const finalizedToMs = Math.min(toMs, boundaryMs)
  const finalized: SessionSubRange | null =
    finalizedToMs > fromMs
      ? { from: input.effectiveFrom, to: new Date(finalizedToMs).toISOString() }
      : null

  // Provisional layer: [max(effectiveFrom, B), effectiveTo).
  const provisionalFromMs = Math.max(fromMs, boundaryMs)
  const provisional: SessionSubRange | null =
    provisionalFromMs < toMs
      ? { from: new Date(provisionalFromMs).toISOString(), to: input.effectiveTo }
      : null

  return { finalized, provisional, boundary: rawBoundary }
}

/** The additive session measures a rollup bucket or a fact aggregate carries. */
export interface SessionMeasures {
  readonly sessions: number
  readonly engagedSessions: number
  readonly bouncedSessions: number
  readonly pageviews: number
  readonly totalSessionDurationMs: number
  readonly totalActiveDurationMs: number
}

/** The read-derived session metrics for a bucket or a range total. */
export interface SessionMetrics extends SessionMeasures {
  /** bounced / sessions, in `[0, 1]`; 0 when there are no sessions. */
  readonly bounceRate: number
  /** total_session_duration_ms / sessions; 0 when there are no sessions. */
  readonly avgSessionDurationMs: number
  /** total_active_duration_ms / sessions; 0 when there are no sessions. */
  readonly avgActiveDurationMs: number
}

const ZERO_MEASURES: SessionMeasures = {
  sessions: 0,
  engagedSessions: 0,
  bouncedSessions: 0,
  pageviews: 0,
  totalSessionDurationMs: 0,
  totalActiveDurationMs: 0,
}

/** Sums two additive measure sets — the finalized/provisional layer merge (§15). */
export function addSessionMeasures(a: SessionMeasures, b: SessionMeasures): SessionMeasures {
  return {
    sessions: a.sessions + b.sessions,
    engagedSessions: a.engagedSessions + b.engagedSessions,
    bouncedSessions: a.bouncedSessions + b.bouncedSessions,
    pageviews: a.pageviews + b.pageviews,
    totalSessionDurationMs: a.totalSessionDurationMs + b.totalSessionDurationMs,
    totalActiveDurationMs: a.totalActiveDurationMs + b.totalActiveDurationMs,
  }
}

/**
 * Derives bounce rate and the average durations from additive totals, at read
 * time (docs snapshot 02 §10). Averages are `total / sessions` and bounce rate is
 * `bounced / sessions` — never a stored average and never a mean of means, so
 * merging two buckets stays a plain sum before this final division.
 */
export function deriveSessionMetrics(measures: SessionMeasures): SessionMetrics {
  const { sessions } = measures
  const safe = sessions > 0 ? sessions : 0
  return {
    ...measures,
    bounceRate: safe > 0 ? measures.bouncedSessions / safe : 0,
    avgSessionDurationMs: safe > 0 ? measures.totalSessionDurationMs / safe : 0,
    avgActiveDurationMs: safe > 0 ? measures.totalActiveDurationMs / safe : 0,
  }
}

/**
 * Merges the finalized and provisional layer bucket rows into one series and a
 * range total, deriving the read metrics after the additive merge.
 *
 * Buckets are keyed by their ISO instant; because the split is non-overlapping a
 * given bucket comes from a single layer, but the merge sums defensively so a
 * boundary bucket that legitimately draws from both layers (a composed local day
 * whose UTC hours straddle `B`) is still a plain sum.
 */
export function mergeSessionLayers(
  finalized: readonly (SessionMeasures & { bucket: string })[],
  provisional: readonly (SessionMeasures & { bucket: string })[],
): { series: (SessionMetrics & { bucket: string })[]; totals: SessionMetrics } {
  const byBucket = new Map<string, SessionMeasures>()
  let total = ZERO_MEASURES
  for (const row of [...finalized, ...provisional]) {
    const prev = byBucket.get(row.bucket) ?? ZERO_MEASURES
    byBucket.set(row.bucket, addSessionMeasures(prev, row))
    total = addSessionMeasures(total, row)
  }
  const series = [...byBucket.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([bucket, measures]) => ({ bucket, ...deriveSessionMetrics(measures) }))
  return { series, totals: deriveSessionMetrics(total) }
}
