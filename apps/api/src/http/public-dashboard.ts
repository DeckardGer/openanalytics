import { ApiError, timezoneSchema, utcInstantSchema } from '@openanalytics/contracts'
import type { ImportPointer } from '@openanalytics/domain'
import {
  getFinalizerState,
  isSharePublishing,
  isSurfaceShared,
  readPublicSiteIdentity,
  resolvePublicShare,
  type Database,
  type PublicSurface,
  type ResolvedPublicShare,
} from '@openanalytics/postgres'
import type { RequestContextVariables } from '@openanalytics/observability/hono'
import { Hono } from 'hono'
import type { AnalyticsReportRequest, AnalyticsService } from '../analytics/service.ts'
import { PUBLIC_TIMESERIES_RESOLUTIONS, parseResolution } from './analytics.ts'
import type { RateLimiter } from './rate-limit.ts'

/**
 * The unauthenticated public-dashboard read surface (plan Milestone 7 item 8;
 * docs snapshot 02 §20).
 *
 * Eight reads: `overview` and `geography`, plus the five ADR-0039 ones
 * (`timeseries`, `sessions`, `pages`, `sources`, `devices`) and the ADR-0044
 * site-identity read (`site`), which is the only one that runs no query and
 * carries no `meta`. ADR-0024 D7 froze this surface at the first two; that
 * freeze was reversed for the five and then, by its own one-read-at-a-time rule
 * (ADR-0039 D1), for `site`. The claim D7 was actually defending is untouched
 * — individual visitors
 * (`recent-visitors`, `visitor`) remain unreadable from an anonymous slug, and a
 * contract test still asserts neither path appears under `/v1/public/`.
 *
 * A separate, narrower path from the authenticated surface:
 *
 * - addressed by an opaque share slug, never an internal `site_id`;
 * - per-surface opt-in — a surface answers only when the site enabled it AND the
 *   master switch is on AND the site is not `suspended` (all three checked
 *   server-side, so a query parameter cannot bypass any of them);
 * - rate-limited per (IP, slug);
 * - geography cities are coarsened under the G-008 privacy threshold, applied at
 *   read time after authorization (§20: "applied before the authorization
 *   query" — the privacy rule is not a filter the caller can turn off).
 *
 * No session, no membership, no capability: the share is the authorization, and a
 * revoked/rotated slug or a disabled surface simply fails to resolve.
 */

type Env = { Variables: RequestContextVariables }

export interface PublicDashboardDeps {
  readonly db: Database
  readonly service: AnalyticsService
  readonly rateLimiter: RateLimiter
  /** The G-008-gated city-visitor threshold; `undefined` suppresses all cities. */
  readonly cityMinVisitors: number | undefined
}

interface PublicRange {
  readonly from: string
  readonly to: string
  readonly timezone: string
  readonly limit: number
}

function parsePublicRange(query: Record<string, string | undefined>): PublicRange {
  const issues: { path: string; message: string }[] = []
  const from = utcInstantSchema.safeParse(query['from'])
  if (!from.success) issues.push({ path: 'from', message: 'from must be an ISO-8601 UTC instant' })
  const to = utcInstantSchema.safeParse(query['to'])
  if (!to.success) issues.push({ path: 'to', message: 'to must be an ISO-8601 UTC instant' })
  const timezone = timezoneSchema.safeParse(query['timezone'])
  if (!timezone.success) issues.push({ path: 'timezone', message: 'timezone must be valid IANA' })

  let limit = 100
  const rawLimit = query['limit']
  if (rawLimit !== undefined) {
    const n = Number(rawLimit)
    if (!Number.isInteger(n) || n < 1 || n > 500) {
      issues.push({ path: 'limit', message: 'limit must be an integer in [1, 500]' })
    } else {
      limit = n
    }
  }

  if (issues.length > 0) {
    throw new ApiError('VALIDATION_FAILED', 'Invalid public query parameters', {
      details: { issues },
    })
  }
  return {
    from: from.data as string,
    to: to.data as string,
    timezone: timezone.data as string,
    limit,
  }
}

/**
 * The site's published import, from the row `resolvePublicShare` already read
 * (ADR-0032, D2b).
 *
 * A shared dashboard shows the same history its owner sees: a site that migrated
 * from another provider and then shared its dashboard would otherwise present a
 * chart that starts on the day the tracker was installed, with no way for the
 * viewer to tell that from a site with no history.
 */
function importPointerOf(share: ResolvedPublicShare): ImportPointer | null {
  return share.publishedImportRunId !== null && share.importCutoverDate !== null
    ? { runId: share.publishedImportRunId, cutoverDate: share.importCutoverDate }
    : null
}

/** Best-effort client IP for the anonymous rate-limit key. */
function clientIp(headerValue: string | undefined): string {
  if (!headerValue) return 'unknown'
  // X-Forwarded-For is a comma list; the left-most is the original client.
  return headerValue.split(',')[0]?.trim() || 'unknown'
}

export function createPublicDashboardRoutes(deps: PublicDashboardDeps): Hono<Env> {
  const { db, service, rateLimiter, cityMinVisitors } = deps
  const app = new Hono<Env>()

  // Rate limit every public request before any database or gateway work.
  app.use('/public/:share_slug/*', async (c, next) => {
    const slug = c.req.param('share_slug')
    const ip = clientIp(c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'))
    const decision = rateLimiter.check(`${ip}:${slug}`)
    if (!decision.allowed) {
      c.header('Retry-After', String(decision.retryAfterSeconds))
      throw new ApiError('RATE_LIMITED', 'Too many requests', {
        details: { retry_after_seconds: decision.retryAfterSeconds },
      })
    }
    await next()
  })

  async function resolveShared(slug: string, surface: PublicSurface): Promise<ResolvedPublicShare> {
    const share = await resolvePublicShare(db, slug)
    // A missing slug, a disabled share, an un-opted-in surface and a
    // suspended site are all the same to an anonymous caller: NOT_FOUND,
    // so the surface never reveals which of those it is.
    if (!share || !isSurfaceShared(share, surface)) {
      throw new ApiError('NOT_FOUND', 'No such public dashboard')
    }
    return share
  }

  app.get('/public/:share_slug/overview', async (c) => {
    const share = await resolveShared(c.req.param('share_slug'), 'overview')
    const range = parsePublicRange(c.req.query())
    return c.json(
      // The narrow public shape (ADR-0039, decision 4 as amended 2026-08-04):
      // the billable-event count is a billing quantity and does not cross this
      // boundary. `publicOverview` declares the narrow return type and builds
      // its literal field by field, so this is structural rather than a promise.
      await service.publicOverview({
        siteId: share.siteId,
        // The public surface caches through the same gateway, so it needs the
        // same key generation (ADR-0030, decision 6). `resolvePublicShare`
        // already joins `sites`, so this costs no extra read either.
        cacheEpoch: share.configVersion,
        importPointer: importPointerOf(share),
        from: range.from,
        to: range.to,
        timezone: range.timezone,
        compare: false,
      }),
    )
  })

  app.get('/public/:share_slug/geography', async (c) => {
    const share = await resolveShared(c.req.param('share_slug'), 'geography')
    const range = parsePublicRange(c.req.query())
    return c.json(
      await service.publicGeography(
        {
          siteId: share.siteId,
          cacheEpoch: share.configVersion,
          importPointer: importPointerOf(share),
          from: range.from,
          to: range.to,
          timezone: range.timezone,
          limit: range.limit,
        },
        cityMinVisitors,
      ),
    )
  })

  /**
   * The traffic chart (ADR-0039, amended by D8).
   *
   * **`resolution` is accepted here and nowhere else on this surface.** Without
   * it a "Today" range — exactly 24 hours — came back at `minute` grain, because
   * `chooseResolution` takes `minute` for any span `<= MINUTE_GRAIN_MAX_HOURS`
   * and that default is 24, compared with `<=`. That is ~1 440 buckets on a
   * chart about 1 600 px wide, and the client-side re-bucketing it forced was
   * summing per-bucket `visitors`, which are not summable — so the public
   * visitor line read high. The private dashboard never met it because every
   * private view already sends `?resolution=hour`.
   *
   * Accepting the parameter exposes nothing new: these buckets were already
   * being served, at a grain the caller could not name. It also unlocks `week`,
   * which automatic selection never picks at any span, so a shared 12-month view
   * can finally match the owner's.
   *
   * The validation is `parseResolution` — the private endpoint's own function,
   * not a copy — so an unsupported *value* is `400 VALIDATION_FAILED` and a
   * supported grain this range or timezone cannot honestly serve is
   * `RESOLUTION_NOT_AVAILABLE` from the resolver. One implementation, so the two
   * surfaces cannot drift apart.
   *
   * `compare: false` still, and not a parameter: the public board draws no
   * deltas. This response keeps the shared shape's `comparison` field and it is
   * always `null` — it is the public *overview* that dropped the field outright
   * (the 2026-08-04 amendment), by getting its own narrower response type.
   */
  app.get('/public/:share_slug/timeseries', async (c) => {
    const share = await resolveShared(c.req.param('share_slug'), 'timeseries')
    const query = c.req.query()
    const range = parsePublicRange(query)
    return c.json(
      await service.publicTimeseries({
        siteId: share.siteId,
        cacheEpoch: share.configVersion,
        importPointer: importPointerOf(share),
        from: range.from,
        to: range.to,
        timezone: range.timezone,
        compare: false,
        resolution: parseResolution(query, PUBLIC_TIMESERIES_RESOLUTIONS),
      }),
    )
  })

  /**
   * Bounce rate and visit duration (ADR-0039).
   *
   * The finalizer watermark is read here for the same reason the private route
   * reads it — it splits the range into the finalized and provisional layers —
   * and then `publicSessions` drops the `layering` object that would report it.
   * The numbers are identical to the private surface's; only the statement about
   * our own batch job is withheld (ADR-0039, D4).
   */
  app.get('/public/:share_slug/sessions', async (c) => {
    const share = await resolveShared(c.req.param('share_slug'), 'sessions')
    const range = parsePublicRange(c.req.query())
    const state = await getFinalizerState(db, share.siteId)
    return c.json(
      await service.publicSessions({
        siteId: share.siteId,
        cacheEpoch: share.configVersion,
        importPointer: importPointerOf(share),
        from: range.from,
        to: range.to,
        timezone: range.timezone,
        finalizedThrough: state ? state.finalizedThrough : null,
      }),
    )
  })

  /**
   * The three breakdown surfaces (ADR-0039).
   *
   * Each reuses the private service method and every field of its **rows**:
   * a page, source or device row is entirely allowlisted public metrics and
   * dimensions, so there is nothing in the body for a narrowed shape to
   * withhold (ADR-0039, D4). Geography keeps its own method because its public
   * row genuinely differs — that is the exception, not the pattern.
   *
   * What they no longer reuse is the **envelope**: D10 gave every public read a
   * `PublicAnalyticsMeta` without `freshness`, so each calls a `public*` method
   * that rebuilds `meta` field by field. The rows were never the problem here;
   * the metadata wrapped around them was.
   *
   * None of the three coarsens low-count rows. ADR-0039 D3 records the reasoning
   * per surface; the short form is that a path, a referring domain and a browser
   * family are not locations, and the privacy instrument for a URL inventory is
   * the owner's per-surface opt-in rather than a threshold that would hide the
   * quiet paths and publish the busy ones.
   */
  const publicReport = <T>(
    surface: PublicSurface,
    handler: (s: AnalyticsService, req: AnalyticsReportRequest) => Promise<T>,
  ) => {
    app.get(`/public/:share_slug/${surface}`, async (c) => {
      const share = await resolveShared(c.req.param('share_slug'), surface)
      const range = parsePublicRange(c.req.query())
      return c.json(
        await handler(service, {
          siteId: share.siteId,
          cacheEpoch: share.configVersion,
          importPointer: importPointerOf(share),
          from: range.from,
          to: range.to,
          timezone: range.timezone,
          limit: range.limit,
        }),
      )
    })
  }

  publicReport('pages', (s, req) => s.publicPages(req))
  publicReport('sources', (s, req) => s.publicSources(req))
  publicReport('devices', (s, req) => s.publicDevices(req))

  /**
   * What a shared board needs to name and draw itself (ADR-0044).
   *
   * The one public read that is not an analytics read: no range, no timezone, no
   * limit, no gateway operation and no `meta`. ADR-0039 D9 refused to hang site
   * identity off `AnalyticsMeta` because that object describes the *query*; this
   * route describes the *site*, so it has no meta to hang anything off.
   *
   * **Two fields always, two only when opted in — and the condition is absence.**
   * `reporting_timezone` and `first_event_at` are rendering facts rather than
   * identity: without the first, two viewers in two zones cut different buckets
   * behind one link and neither sees the owner's, and without the second "All
   * time" has no anchor a visitor can reach. Both are needed by an anonymous
   * share exactly as much as by a named one, so neither rides `share_identity`.
   * `display_name` and `favicon_domain` do ride it, and when it is off the two
   * keys are **omitted from the object** rather than sent as `null` — a null name
   * says "this site has no name", which is false and is a different statement
   * from "you may not know" (the by-absence idiom of ADR-0036 CP7).
   *
   * **`isSharePublishing`, not `isSurfaceShared(share, 'identity')`, is the
   * gate** (ADR-0044 D2). Gating on the identity flag would make this the one
   * endpoint that confirms a slug whose board publishes nothing — the probe the
   * other seven reads are carefully built not to be. The predicate is composed
   * from `isSurfaceShared` over every surface *except* `identity`, so it inherits
   * the master switch and the `suspended` close and cannot drift from them,
   * and a share whose only open flag is `share_identity` is a 404 here.
   */
  app.get('/public/:share_slug/site', async (c) => {
    const share = await resolvePublicShare(db, c.req.param('share_slug'))
    if (!share || !isSharePublishing(share)) {
      throw new ApiError('NOT_FOUND', 'No such public dashboard')
    }
    const identity = await readPublicSiteIdentity(db, share.siteId)
    // `resolvePublicShare` inner-joins `sites`, so the row is there; the null
    // branch is the type's, not a state this route can reach.
    if (!identity) throw new ApiError('NOT_FOUND', 'No such public dashboard')

    return c.json({
      // Built field by field, and the identity pair spread in only when it is
      // published — so a field added to `PublicSiteIdentity` later cannot reach
      // an anonymous caller by inheritance (ADR-0039 D10's pattern).
      ...(isSurfaceShared(share, 'identity')
        ? { display_name: identity.displayName, favicon_domain: identity.faviconDomain }
        : {}),
      reporting_timezone: identity.reportingTimezone,
      first_event_at: identity.firstEventAt?.toISOString() ?? null,
    })
  })

  return app
}
