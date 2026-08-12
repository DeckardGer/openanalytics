import { z } from 'zod'

/**
 * Time and date ranges.
 *
 * Docs snapshot 02 §18 and 03 §6.3: every wire timestamp is ISO-8601 UTC, every
 * range is half-open `[from, to)`, and timezone is an IANA identifier used only
 * for grouping — never a string spliced into SQL.
 */

/** UTC instant. The `Z` suffix is required; a local-time string is rejected. */
export const utcInstantSchema = z.iso
  .datetime({ offset: false })
  .refine((value) => value.endsWith('Z'), 'timestamp must be UTC and end with Z')

export type UtcInstant = z.infer<typeof utcInstantSchema>

/**
 * The identifier shape an IANA zone name has: a leading letter, then dot,
 * underscore, plus, minus and digits, in slash-separated segments. It is a
 * literal copy of the CHECK constraint on `users.timezone` (migration 0023), and
 * it is here for two reasons.
 *
 * The first is that wire and column constraints must agree. `Intl` is more
 * permissive than that CHECK, so a value it accepted but the constraint refused
 * would pass validation and then fail as an unhandled database error — a 500 for
 * what is a caller mistake. Keeping the same pattern on both sides makes the wire
 * validator a strict subset of the column's, and the CHECK a genuine floor under
 * it rather than a second, disagreeing opinion.
 *
 * The second is offsets. `Intl` accepts `+05:00`, `-08:00` and `+0500` as time
 * zones; this product does not (ADR-0026 alternatives). An offset is a timezone
 * evaluated at one instant, it goes wrong at every DST transition, and on the
 * analytics surface it reached ClickHouse and errored there anyway. A leading
 * letter is what separates a zone name from an offset, so requiring it turns all
 * three into a clean `400` before anything downstream sees them.
 *
 * The shape alone is not enough — `Not/AZone` matches it and is not a zone — so
 * this is an addition to the runtime check below, never a replacement for it.
 */
const TIMEZONE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9._+-]*(\/[A-Za-z0-9._+-]+)*$/

/**
 * IANA timezone.
 *
 * Validated against the runtime's own timezone database rather than a regex, so
 * an unknown-but-well-formed identifier cannot reach a query builder — plus the
 * identifier shape above, so an offset zone cannot either.
 */
export const timezoneSchema = z.string().min(1).max(64).refine(isValidTimezone, {
  message: 'timezone must be a valid IANA identifier',
})

export function isValidTimezone(value: string): boolean {
  if (!TIMEZONE_IDENTIFIER.test(value)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

/**
 * Half-open UTC range.
 *
 * `to` is exclusive: an event at exactly `to` belongs to the next range. This is
 * the same rule usage windows use (docs snapshot 05 D-014), so range maths is
 * identical between analytics and quota.
 */
export const dateRangeSchema = z
  .object({
    from: utcInstantSchema,
    to: utcInstantSchema,
  })
  .refine((range) => Date.parse(range.from) < Date.parse(range.to), {
    message: 'range must be half-open with from < to',
  })

export type DateRange = z.infer<typeof dateRangeSchema>

/**
 * Bucket grains an analytics answer can be served at, mirroring the OpenAPI
 * `Resolution` enum.
 *
 * `minute`/`hour`/`day` name a rollup family. `week` does not: there is no week
 * rollup, and there deliberately is not one — an ISO week starts on the request
 * timezone's Monday, so a stored UTC-week bucket would be wrong for every zone
 * but UTC. It is grouped at read time over the day or hour rollup instead, which
 * also keeps unique visitors honest (a week's `uniqMerge` over its days, never a
 * sum of daily uniques).
 */
export const RESOLUTIONS = ['minute', 'hour', 'day', 'week'] as const
export type Resolution = (typeof RESOLUTIONS)[number]
export const resolutionSchema = z.enum(RESOLUTIONS)

/**
 * Freshness and finalization metadata attached to analytics responses.
 *
 * Docs snapshot 03 §6.2: an empty array must be distinguishable from "not ready
 * yet" and from "provider failed". `provisional_through` and `finalized_through`
 * exist because session-derived metrics stay revisable for the 24h lateness
 * window (docs snapshot 05 D-211).
 */
export const freshnessSchema = z.object({
  as_of: utcInstantSchema,
  resolution: resolutionSchema,
  provisional_through: utcInstantSchema.nullable(),
  finalized_through: utcInstantSchema.nullable(),
})

export type Freshness = z.infer<typeof freshnessSchema>

/** Marks whether a number is exact or provider/estimate derived. */
export const ACCURACIES = ['exact', 'estimated', 'provider_defined'] as const
export type Accuracy = (typeof ACCURACIES)[number]
export const accuracySchema = z.enum(ACCURACIES)

export function isHalfOpenContained(range: DateRange, instant: string): boolean {
  const at = Date.parse(instant)
  return at >= Date.parse(range.from) && at < Date.parse(range.to)
}
