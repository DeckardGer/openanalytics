import { z } from 'zod'

/**
 * Public-dashboard read policy (docs snapshot 02 §20 "Public dashboard and
 * public globe"; plan Milestone 7 item 8).
 *
 * The public surface is a separate, narrower read path than the authenticated
 * dashboard: no session, a share slug instead of an internal `site_id`, an
 * allowlist of operations and fields, a rate limit, and — the part this module
 * owns — a city-privacy coarsening applied at read time.
 *
 * ### The city-privacy threshold (G-008 — closed)
 *
 * Geography is stored at full city granularity on purpose (the private dashboard
 * shows it). While G-008 was open, this value had no default and the mechanism
 * failed closed (every city suppressed). **The gate closed on 2026-07-25
 * (ADR-0017): there is no minimum — a city is named whenever it appears.** The
 * default of `1` expresses exactly that (a returned city row has at least one
 * visitor by construction), while the threshold machinery is kept: a deployment
 * — ours after a future privacy review, or a self-hosting fork with stricter
 * requirements — can still set a higher value from the environment.
 */

export const publicDashboardConfigSchema = z.object({
  /**
   * Minimum unique visitors a city must have on the public surface before it is
   * named. G-008 closed 2026-07-25 (ADR-0017): no minimum — the default `1`
   * names every city that appears. Raise it from the environment to coarsen.
   */
  PUBLIC_CITY_MIN_VISITORS: z.coerce.number().int().min(1).default(1),

  /**
   * Per-(IP, share slug) request budget for the unauthenticated public read
   * surface. §20 requires public routes to carry a rate limit; this is an
   * infrastructure guard on an anonymous surface, not one of the G-005 collector
   * abuse ceilings (those are per-site ingest limits, closed separately). Kept as
   * a typed engineering value with a recorded default rather than a scattered
   * literal, mirroring the query gateway's own limits. Flagged for confirmation
   * against the launch rate-limit review.
   */
  PUBLIC_READ_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(60),
  PUBLIC_READ_RATE_LIMIT_BURST: z.coerce.number().int().min(1).max(100_000).default(120),
})

export type PublicDashboardConfig = z.infer<typeof publicDashboardConfigSchema>

export class PublicDashboardConfigError extends Error {
  readonly issues: readonly { path: string; message: string }[]

  constructor(error: z.ZodError) {
    const issues = error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    }))
    super(
      `Invalid public-dashboard configuration:\n${issues
        .map((issue) => `  - ${issue.path}: ${issue.message}`)
        .join('\n')}`,
    )
    this.name = 'PublicDashboardConfigError'
    this.issues = issues
  }
}

export function loadPublicDashboardConfig(
  source: Record<string, string | undefined> = process.env,
): PublicDashboardConfig {
  const result = publicDashboardConfigSchema.safeParse(source)
  if (!result.success) throw new PublicDashboardConfigError(result.error)
  return result.data
}

/** A geography row as it comes back from the gateway (one city within a country). */
export interface GeographyRow {
  readonly country: string
  readonly city: string
  readonly views: number
  readonly visitors: number
}

/** A geography row after public coarsening: a city may have been folded away. */
export interface PublicGeographyRow {
  readonly country: string
  /** `null` when the city was suppressed for privacy; the country row survives. */
  readonly city: string | null
  readonly views: number
  readonly visitors: number
  /** True when this row's city was withheld under the privacy threshold. */
  readonly city_suppressed: boolean
}

/**
 * Applies the city-privacy policy to geography rows for the public surface.
 *
 * A city is named only when its unique visitor count is at or above the
 * threshold (default 1 since ADR-0017 — every city qualifies). Below it, the
 * city label is dropped and the row's counts are folded into a single
 * country-level "other cities" bucket, so the country total the public page
 * shows still adds up while no small city is individually identifiable.
 *
 * `threshold === undefined` is kept as the defensive fail-closed branch
 * (suppress everything) for callers that lost their config. Applied at read
 * time, after authorization — never as a query filter a public parameter could
 * bypass (§20: "applied before the authorization query").
 */
export function coarsenPublicGeography(
  rows: readonly GeographyRow[],
  threshold: number | undefined,
): PublicGeographyRow[] {
  const named: PublicGeographyRow[] = []
  const suppressedByCountry = new Map<string, { views: number; visitors: number }>()

  for (const row of rows) {
    const cityAllowed = threshold !== undefined && row.city.length > 0 && row.visitors >= threshold
    if (cityAllowed) {
      named.push({
        country: row.country,
        city: row.city,
        views: row.views,
        visitors: row.visitors,
        city_suppressed: false,
      })
      continue
    }
    const bucket = suppressedByCountry.get(row.country) ?? { views: 0, visitors: 0 }
    bucket.views += row.views
    // Visitor counts are unique-state merges upstream, so summing suppressed
    // cities' visitors here can over-count a visitor seen in two small cities.
    // That is acceptable for a coarsened "other cities" bucket and never
    // under-reports; the private dashboard keeps the exact uniq-merged figure.
    bucket.visitors += row.visitors
    suppressedByCountry.set(row.country, bucket)
  }

  const coarsened: PublicGeographyRow[] = [...named]
  for (const [country, bucket] of suppressedByCountry) {
    coarsened.push({
      country,
      city: null,
      views: bucket.views,
      visitors: bucket.visitors,
      city_suppressed: true,
    })
  }
  // Stable, deterministic order: most-viewed first, country then city as tie-break.
  coarsened.sort(
    (a, b) =>
      b.views - a.views ||
      a.country.localeCompare(b.country) ||
      (a.city ?? '').localeCompare(b.city ?? ''),
  )
  return coarsened
}
