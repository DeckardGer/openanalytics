/**
 * Reading a published import beside live data (ADR-0032, D2b/D4/D5).
 *
 * Everything here is pure: which bound values a read carries, whether a range
 * touches imported days, how two breakdown lists become one, and what the
 * response is allowed to claim about its own accuracy. It lives in the domain
 * package because three places have to agree on it — the api's analytics service,
 * the gateway operation registry (through the values it binds) and the tests that
 * pin the acceptance criteria — and because the accuracy rule is the kind of
 * thing that is only ever wrong once, quietly, in a customer's favour.
 */

/** The half of `AnalyticsMeta` that says where a number came from (D5). */
export type AnalyticsDataSource = 'live' | 'imported'
export type AnalyticsAccuracy = 'exact' | 'estimated' | 'provider_defined'
/** The bucket grains an analytics read is served at. Mirrors the contract's
 * `Resolution`; restated here so the pure package does not have to reach for the
 * generated client to express its own rule. */
export type AnalyticsGrain = 'minute' | 'hour' | 'day' | 'week'

/** The site's published import, as a read needs it: which run, and where it
 * stops. Null for a site with no published import. */
export interface ImportPointer {
  readonly runId: string
  readonly cutoverDate: string
}

/**
 * What a read binds when the site has no published import.
 *
 * A **value**, never an omission: the operations declare both parameters
 * required, so there is no shape of request in which the cutover partition is
 * accidentally not applied. The nil UUID matches no staged row, which is what
 * empties the imported branch.
 */
export const NIL_IMPORT_RUN_ID = '00000000-0000-0000-0000-000000000000'

/**
 * The cutover a site with no import binds — `1970-01-02`, not `1970-01-01`.
 *
 * The live branch compares `bucket_start` against the cutover date rendered at
 * midnight *in the request's timezone*, and ClickHouse's `DateTime` starts at the
 * epoch: a zone up to 14 hours east of UTC would push `1970-01-01` below the
 * type's floor and rely on saturation for correctness. One day of headroom costs
 * nothing (no site has buckets on 1970-01-01, and the nil run matches no imported
 * row either way) and removes the dependency entirely.
 */
export const EPOCH_IMPORT_CUTOVER = '1970-01-02'

/** The two parameters every import-aware operation binds. */
export function importQueryParams(pointer: ImportPointer | null): {
  readonly import_run_id: string
  readonly import_cutover: string
} {
  return {
    import_run_id: pointer?.runId ?? NIL_IMPORT_RUN_ID,
    import_cutover: pointer?.cutoverDate ?? EPOCH_IMPORT_CUTOVER,
  }
}

// --- Where a range sits relative to the cutover ------------------------------

export type ImportedRangeClass = 'live_only' | 'blended' | 'imported_only'

/**
 * The instant a calendar date starts at in an IANA zone.
 *
 * This is the TypeScript half of the boundary ClickHouse computes as
 * `toDateTime(date, tz)`, and the two **must** agree: the SQL decides which rows
 * a range contains and this decides what the response claims about them. When
 * this was computed in UTC while the SQL used the request's zone, a range the
 * api called `imported_only` could contain live rows for any viewer west of UTC
 * — a response asserting `provider_defined` over numbers that were partly ours.
 *
 * Implemented by asking `Intl` what the zone's offset is at the date's UTC
 * midnight and subtracting it. A zone whose offset changes *at* local midnight
 * on the cutover date would be off by the DST step; no IANA zone transitions at
 * midnight local, and a wrong answer there would move the label by an hour, not
 * the rows.
 */
export function zonedDateStart(date: string, timeZone: string): number {
  const utcMidnight = Date.parse(`${date}T00:00:00.000Z`)
  if (Number.isNaN(utcMidnight)) return Number.NaN
  return utcMidnight - zoneOffsetMs(utcMidnight, timeZone)
}

function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant))
  const at = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00'
  const asUtc = Date.parse(
    `${at('year')}-${at('month')}-${at('day')}T${at('hour')}:${at('minute')}:${at('second')}.000Z`,
  )
  return Number.isNaN(asUtc) ? 0 : asUtc - instant
}

/**
 * Which side (or sides) of the cutover a half-open range falls on.
 *
 * The boundary is the cutover date's start **in the request's timezone**, which
 * is exactly the instant the operations' live branch opens at and the instant
 * a provider day is placed at. That identity is the point: `imported_only` has
 * to mean "the live branch of this query returns nothing", and it only does if
 * both sides compute the same boundary.
 */
export function classifyImportedRange(
  range: { readonly from: string; readonly to: string },
  pointer: ImportPointer | null,
  timeZone: string,
): ImportedRangeClass {
  if (pointer === null) return 'live_only'
  const cutover = zonedDateStart(pointer.cutoverDate, timeZone)
  const from = Date.parse(range.from)
  const to = Date.parse(range.to)
  if (Number.isNaN(cutover) || Number.isNaN(from) || Number.isNaN(to)) return 'live_only'
  if (from >= cutover) return 'live_only'
  if (to <= cutover) return 'imported_only'
  return 'blended'
}

/**
 * Whether a range covers exactly one provider day (D5, amended).
 *
 * The rule `provider_defined` really wants is "every number in this response is a
 * provider row, unmodified". A single provider day satisfies it on **any**
 * surface — a total over one day is that day's row, a breakdown over one day is
 * that day's rows — while two days already means summing dailies the provider
 * refuses to add. Measured against the same zoned day boundaries the SQL filters
 * on, so "one day" is one day for the viewer asking.
 */
export function spansOneProviderDay(
  range: { readonly from: string; readonly to: string },
  timeZone: string,
): boolean {
  const from = Date.parse(range.from)
  const to = Date.parse(range.to)
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return false
  const firstDay = zonedDayOf(from, timeZone)
  // Half-open: a range ending exactly at the next local midnight covers one day.
  const lastInstant = to - 1
  return firstDay === zonedDayOf(lastInstant, timeZone)
}

function zonedDayOf(instant: number, timeZone: string): string {
  return new Date(instant + zoneOffsetMs(instant, timeZone)).toISOString().slice(0, 10)
}

// --- The meta rule (D5) ------------------------------------------------------

/**
 * What a surface does about the import.
 *
 * Three values rather than two booleans, because only three of the four
 * combinations are legal and the illegal one — "no cutover filter but an imported
 * branch" — is a read that double-counts the seam.
 *
 * - `imported` — reads staged rows (day/week charts, range totals, breakdowns).
 * - `partitioned_live` — applies D4's cutover but has no imported branch: the
 *   minute and hour charts, which an aggregate-only export cannot fill at all.
 *   They answer a *knowable subset* of the range, which is why they are
 *   `estimated` rather than `exact` when the range reaches past the cutover.
 * - `live` — untouched by the import in either direction: web vitals, sessions,
 *   funnels, the visitor surfaces. Their numbers are complete, so `exact` is the
 *   honest answer and claiming otherwise would be noise.
 */
export type ImportedSurface = 'imported' | 'partitioned_live' | 'live'

export interface AnalyticsSourceInput {
  /** The ranges this response actually answers over: the primary first, then the
   * comparison when one was computed. A response reports the **union** of their
   * sources and the **worst** of their accuracies — one flag, honest for both. */
  readonly ranges: readonly { readonly from: string; readonly to: string }[]
  readonly pointer: ImportPointer | null
  /** The request's timezone — the zone the cutover boundary is rendered in, both
   * here and in the SQL. */
  readonly timezone: string
  readonly surface: ImportedSurface
  /**
   * Whether a *fully* imported range is answered with the provider's own numbers
   * unmodified (D5, amended 2026-07-29).
   *
   * The caller computes it, because only the caller knows both the shape of its
   * own response and the range it answered over: a day-resolution timeseries is
   * one bucket per provider day at any length, and every other import-readable
   * surface qualifies only when its effective range is exactly one provider day.
   * `spansOneProviderDay` is the shared half of that computation.
   */
  readonly providerDefinedWhenFullyImported: boolean
}

export interface AnalyticsSourceVerdict {
  readonly dataSources: readonly AnalyticsDataSource[]
  readonly accuracy: AnalyticsAccuracy
}

/** Worst-first, so `Math.max` over the ranks is "the worst of the two". */
const ACCURACY_RANK: Readonly<Record<AnalyticsAccuracy, number>> = {
  exact: 0,
  provider_defined: 1,
  estimated: 2,
}
const ACCURACY_BY_RANK: readonly AnalyticsAccuracy[] = ['exact', 'provider_defined', 'estimated']

/**
 * The whole of D5's rule, in one place.
 *
 * - a range entirely in live data → `live`, `exact` — byte-for-byte the answer
 *   this API gave before imports existed;
 * - a range touching imported days → `imported` joins the list, and the accuracy
 *   is `provider_defined` only when the range is *entirely* imported **and** the
 *   caller can say every number it is about to return is a provider row
 *   unmodified. Everything blended, seam-touching, or aggregated across provider
 *   days is `estimated`.
 *
 * The acceptance criterion "event-level and aggregate-only never mix as exact"
 * falls out structurally: `exact` is only ever produced by a branch that adds no
 * `imported` source.
 */
export function resolveAnalyticsSources(input: AnalyticsSourceInput): AnalyticsSourceVerdict {
  if (input.surface === 'live' || input.pointer === null || input.ranges.length === 0) {
    return { dataSources: ['live'], accuracy: 'exact' }
  }

  const touchesImported = input.ranges.some(
    (range) => classifyImportedRange(range, input.pointer, input.timezone) !== 'live_only',
  )

  if (input.surface === 'partitioned_live') {
    // No imported branch, but the cutover *is* applied — so a range reaching past
    // it is answered with the part of itself this surface can know. `['live']`
    // because no staged row was read, `estimated` because the window the caller
    // asked for is not the window that answered.
    return { dataSources: ['live'], accuracy: touchesImported ? 'estimated' : 'exact' }
  }

  let live = false
  let imported = false
  let rank = 0

  for (const range of input.ranges) {
    const verdict = classifyImportedRange(range, input.pointer, input.timezone)
    if (verdict === 'live_only') {
      live = true
      continue
    }
    imported = true
    if (verdict === 'blended') live = true
    const providerDefined = verdict === 'imported_only' && input.providerDefinedWhenFullyImported
    rank = Math.max(rank, ACCURACY_RANK[providerDefined ? 'provider_defined' : 'estimated'])
  }

  const dataSources: AnalyticsDataSource[] = []
  if (live) dataSources.push('live')
  if (imported) dataSources.push('imported')
  // A response over no range at all still came from somewhere.
  if (dataSources.length === 0) dataSources.push('live')

  return { dataSources, accuracy: ACCURACY_BY_RANK[rank] as AnalyticsAccuracy }
}

// --- Breakdown merge (D2b) ---------------------------------------------------

export interface MergeImportedRowsOptions<T> {
  /** The identity two rows are summed on. Must be the *live report's* key, so a
   * merged row is indistinguishable from a live one. */
  readonly keyOf: (row: T) => string
  /**
   * Sums the counts of two rows with the same key.
   *
   * **`T` must already be the response shape, with every count a `number`.**
   * ClickHouse serializes a 64-bit integer as a JSON *string* or a JSON number
   * depending on `output_format_json_quote_64bit_integers`, a server profile
   * setting — so a raw gateway row can carry `'4'` where another carries `4`, and
   * `'4' + 4` is `'44'`. Every caller therefore maps both lists through the same
   * mapper (which coerces with `num()`) *before* handing them here, and the
   * merged list is indistinguishable from a live one by construction. The
   * coercion is not repeated inside this function because it cannot be: the
   * fields are the caller's.
   */
  readonly add: (live: T, imported: T) => T
  /** The measure the report is ranked by, so the merged list is re-cut on the
   * same axis the gateway ordered each side by. */
  readonly rank: (row: T) => number
  readonly limit: number
}

/**
 * One top-N list out of a live one and an imported one.
 *
 * **An empty imported list returns the live array untouched** — same object, same
 * order, no re-sort and no re-cut. That is the byte-identical guarantee for every
 * site and every range that does not reach an import, and it is expressed as an
 * early return rather than as an arithmetic coincidence so that no later change
 * to the sort can quietly break it.
 *
 * Both sides arrive already cut to the top N by their own operation, so the merge
 * is approximate in exactly one way: a key just below the cut on both sides could
 * outrank a key that made one of them. That is inherent to merging two
 * independently ranked top-N lists, it is bounded by the limit the caller asked
 * for, and every response it can affect is already `estimated`.
 */
export function mergeImportedRows<T>(
  live: readonly T[],
  imported: readonly T[],
  options: MergeImportedRowsOptions<T>,
): readonly T[] {
  if (imported.length === 0) return live

  const byKey = new Map<string, T>()
  const order: string[] = []
  for (const row of live) {
    const key = options.keyOf(row)
    if (!byKey.has(key)) order.push(key)
    const existing = byKey.get(key)
    byKey.set(key, existing === undefined ? row : options.add(existing, row))
  }
  for (const row of imported) {
    const key = options.keyOf(row)
    const existing = byKey.get(key)
    if (existing === undefined) {
      order.push(key)
      byKey.set(key, row)
      continue
    }
    byKey.set(key, options.add(existing, row))
  }

  const merged = order.map((key) => byKey.get(key) as T)
  // Ties break on the key so two rows with equal counts come out in a stable
  // order rather than in whichever list happened to be walked first.
  merged.sort((a, b) => {
    const difference = options.rank(b) - options.rank(a)
    if (difference !== 0) return difference
    const left = options.keyOf(a)
    const right = options.keyOf(b)
    return left < right ? -1 : left > right ? 1 : 0
  })
  return merged.slice(0, options.limit)
}
