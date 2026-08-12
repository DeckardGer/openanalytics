import type { Resolution } from '@openanalytics/contracts'
import { z } from 'zod'
import { timezoneOffsetMinutes } from './analytics-query.ts'
import type { WidgetRange } from './widget.ts'

/**
 * The server's resolution of the dashboard's nine interval keys, and the widget
 * read's typed config (ADR-0045, D5, D10 and D12).
 *
 * Until this module existed the nine keys were a **frontend** vocabulary:
 * `apps/web/components/dashboard/interval-context.tsx` turned each one into a
 * `from`/`to` pair before it called, and the server had never seen the word
 * `7d`. A widget stores the key instead, because an embed is a living thing on
 * somebody's page and a frozen window that ages silently is worse than a report
 * that says its date — so something on this side has to resolve it.
 *
 * **The obligation this module carries is agreement.** "Last 7 days" on an embed
 * must be the same window as "Last 7 days" in the owner's dashboard, or one site
 * publishes two different numbers under one label. `resolveWidgetRange` is
 * therefore `rangeForInterval`'s arithmetic, key by key, and not a
 * reinterpretation of it.
 *
 * Two things it does **not** inherit from the frontend, both by ADR-0045 D10:
 *
 * - The zone is the **site's** (`sites.reporting_timezone`, `UTC` when unset)
 *   rather than the viewer's. A widget has no viewer to ask, and rendering
 *   "today" in a stranger's laptop clock would make one embed show two readers
 *   of the same page different numbers.
 * - `all` anchors at `first_event_at` alone, never at
 *   `min(created_at, first_event_at)`: ADR-0044 D7 keeps `created_at` off the
 *   public surface, and `meta.effective_range` would publish it.
 */

/* -------------------------------------------------------------------------- */
/* Calendar maths in an arbitrary IANA zone                                    */
/* -------------------------------------------------------------------------- */

/**
 * The zone's local calendar date at `instant`, as `[year, month, day]` with a
 * 1-based month.
 *
 * `en-CA` formats as `YYYY-MM-DD`, which is the one locale in wide use whose
 * default date order needs no part-by-part reassembly.
 */
function localDateParts(instant: Date, timezone: string): [number, number, number] {
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(instant)
    .split('-')
    .map(Number)
  return [year as number, month as number, day as number]
}

/**
 * The UTC instant at which the calendar day containing `base` — shifted by whole
 * years, months or days **on that zone's calendar** — starts in `timezone`.
 *
 * The shift is applied through `Date.UTC`, so it is calendar arithmetic rather
 * than millisecond arithmetic: `{ days: -6 }` is six calendar days back even
 * across a 23- or 25-hour local day, and `{ months: -6 }` lands on the same day
 * of the month rather than 182 days earlier.
 *
 * **Two offset passes, and the second one is load-bearing.** The first converts
 * the target local midnight using the offset in force at the *UTC* instant of
 * that wall time, which is the wrong offset whenever the zone changes between
 * the two; the second re-reads the offset at the instant the first pass produced
 * and converges. Without it, a local midnight on the far side of a DST
 * transition lands an hour out — the error that moves a chart's first bucket
 * into the previous day. `timezoneOffsetMinutes` is the repository's existing
 * reader of the runtime tz database (it powers the gateway's own alignment
 * classification), so this cannot drift from what the query side believes.
 */
function zonedDayStart(
  base: Date,
  timezone: string,
  shift: { years?: number; months?: number; days?: number } = {},
): Date {
  const [year, month, day] = localDateParts(base, timezone)
  const target = Date.UTC(
    year + (shift.years ?? 0),
    month - 1 + (shift.months ?? 0),
    day + (shift.days ?? 0),
  )
  const first = target - timezoneOffsetMinutes(new Date(target), timezone) * 60_000
  return new Date(target - timezoneOffsetMinutes(new Date(first), timezone) * 60_000)
}

/* -------------------------------------------------------------------------- */
/* The nine keys                                                               */
/* -------------------------------------------------------------------------- */

/** A resolved half-open `[from, to)` in ISO-8601 UTC, as the public reads take it. */
export interface ResolvedWidgetRange {
  readonly from: string
  readonly to: string
}

export interface WidgetRangeInput {
  readonly range: WidgetRange
  /** `sites.reporting_timezone`; the caller substitutes `UTC` when it is null. */
  readonly timezone: string
  readonly now: Date
  /** `sites.first_event_at`. Only `all` reads it; `null` is "never ingested". */
  readonly firstEventAt: Date | null
}

/**
 * The bucket grain each range is served at (ADR-0045, D10), and it applies to
 * `timeseries` alone — the one surface with a grain to choose.
 *
 * Named per range rather than chosen automatically, for the reason ADR-0039 D8
 * exists: automatic selection hands a 24-hour range `minute` grain, which is
 * ~1 440 points, and the client-side re-bucketing that hid it on the share board
 * over-counted `visitors` by 59 %. An embed has no interval picker and no
 * client-side re-bucketing to recover with, so the grain is decided here, once.
 *
 * It also removes an error mode that would only ever be visible on somebody
 * else's page: a stored `minute` grain against a range that grows past the
 * minute-rollup span cap is a `RESOLUTION_NOT_AVAILABLE` nobody sees until an
 * embed goes blank. Every value is on the public timeseries allowlist ADR-0039
 * D8 already ships.
 */
export const WIDGET_RANGE_GRAIN: Readonly<Record<WidgetRange, Resolution>> = {
  today: 'hour',
  yesterday: 'hour',
  '24h': 'hour',
  '7d': 'day',
  '30d': 'day',
  '90d': 'day',
  '6mo': 'week',
  '12mo': 'week',
  all: 'week',
}

/**
 * Resolves one stored range key against a site's clock.
 *
 * Pure and total: it reads no configuration, throws nothing, and the same
 * `(key, zone, now, anchor)` always produces the same pair — which is what lets
 * the gateway's epoch-keyed cache do its job and what makes the whole table
 * testable without a database.
 *
 * The shape of each answer, mirroring `rangeForInterval` exactly:
 *
 * - every key except `yesterday` and `24h` ends at **tomorrow's** local start,
 *   so the current day is included whole and the range never has to be re-cut as
 *   the day advances;
 * - the `Nd` keys count back `N - 1` whole days from today's start, so `7d` is
 *   seven calendar days *including today* rather than eight;
 * - `24h` is the one rolling window — measured from the request instant, not
 *   from a calendar boundary — so the zone cannot move it;
 * - `6mo`/`12mo` shift the calendar and add a day, which is what makes them
 *   "the last six months" rather than "the last 183 days".
 */
export function resolveWidgetRange(input: WidgetRangeInput): ResolvedWidgetRange {
  const { timezone, now } = input
  const day = (shift: Parameters<typeof zonedDayStart>[2]) => zonedDayStart(now, timezone, shift)
  const tomorrow = day({ days: 1 })

  const bounds: Record<WidgetRange, [Date, Date]> = {
    today: [day({}), tomorrow],
    yesterday: [day({ days: -1 }), day({})],
    '24h': [new Date(now.getTime() - 86_400_000), now],
    '7d': [day({ days: -6 }), tomorrow],
    '30d': [day({ days: -29 }), tomorrow],
    '90d': [day({ days: -89 }), tomorrow],
    '6mo': [day({ months: -6, days: 1 }), tomorrow],
    '12mo': [day({ years: -1, days: 1 }), tomorrow],
    all: [
      // ADR-0045 D10. The dashboard falls back to a trailing twelve months while
      // it waits for the anchor; a widget must not. A site that has never
      // ingested an event has no honest start, and a fallback range on somebody
      // else's page is a chart silently claiming a year of nothing — so the
      // window is zero-width and renders empty instead.
      input.firstEventAt === null ? tomorrow : zonedDayStart(input.firstEventAt, timezone),
      tomorrow,
    ],
  }

  const [from, to] = bounds[input.range]
  return { from: from.toISOString(), to: to.toISOString() }
}

/* -------------------------------------------------------------------------- */
/* Typed config                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The anonymous widget read's two config groups (ADR-0045, D5 and D12), in the
 * shape `publicDashboardConfigSchema` established and ADR-0042 D6 requires: a
 * typed value with a recorded default, never a literal in a route.
 *
 * Both are flagged for the launch rate-limit review rather than presented as
 * settled — ADR-0045 D5 does the arithmetic out loud, and the uncomfortable
 * number is realtime's: a badge polling every 15 s costs four requests a minute,
 * so one NAT exhausts the budget at about thirty simultaneously open tabs.
 */
export const widgetReadConfigSchema = z.object({
  /**
   * Per-(IP, widget id) request budget. **Deliberately the share surface's own
   * numbers** — `PUBLIC_READ_RATE_LIMIT_*` is 60 with a burst of 120, and the
   * limiter takes the larger of the two as the window cap, so the effective
   * budget is 120 per minute in both places. A second pair of values would
   * assert a difference nobody has measured.
   */
  WIDGET_READ_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(60),
  WIDGET_READ_RATE_LIMIT_BURST: z.coerce.number().int().min(1).max(100_000).default(120),

  /**
   * `Cache-Control: public, max-age=…` on the seven historical surfaces.
   *
   * The ADR-0022 form: a **stated staleness bound**, not an invalidation
   * promise. Revocation is immediate at the origin (the widget row is read on
   * every request that reaches us) and honoured within this many seconds at any
   * browser or shared cache — which is the number an owner is entitled to hear
   * when they click "disable".
   *
   * `0` is admitted, because "revalidate every time" is a real operator choice.
   * The ceiling is an hour: the direction this value must fail in is *long*, and
   * a widget cached for a day would outlive several revocations.
   */
  WIDGET_READ_CACHE_MAX_AGE_SECONDS: z.coerce.number().int().min(0).max(3_600).default(60),
  /** The same header on `realtime`, where a minute-old "now" is a wrong number
   * rather than a stale one. */
  WIDGET_REALTIME_CACHE_MAX_AGE_SECONDS: z.coerce.number().int().min(0).max(3_600).default(10),
})

export type WidgetReadConfig = z.infer<typeof widgetReadConfigSchema>

export class WidgetReadConfigError extends Error {
  readonly issues: readonly { path: string; message: string }[]

  constructor(error: z.ZodError) {
    const issues = error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    }))
    super(
      `Invalid widget read configuration:\n${issues
        .map((issue) => `  - ${issue.path}: ${issue.message}`)
        .join('\n')}`,
    )
    this.name = 'WidgetReadConfigError'
    this.issues = issues
  }
}

export function loadWidgetReadConfig(
  source: Record<string, string | undefined> = process.env,
): WidgetReadConfig {
  const result = widgetReadConfigSchema.safeParse(source)
  if (!result.success) throw new WidgetReadConfigError(result.error)
  return result.data
}
