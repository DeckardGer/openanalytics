import { ApiError } from '@openanalytics/contracts'
import type { components } from '@openanalytics/contracts'
import {
  WIDGET_LIMIT_DEFAULT,
  WIDGET_RANGE_GRAIN,
  resolveWidgetRange,
  type WidgetRange,
} from '@openanalytics/domain'
import type { ImportPointer } from '@openanalytics/domain'
import {
  getFinalizerState,
  resolvePublicWidget,
  type Database,
  type ResolvedPublicWidget,
} from '@openanalytics/postgres'
import type { RealtimeCache } from '@openanalytics/redis'
import type { RequestContextVariables } from '@openanalytics/observability/hono'
import { Hono } from 'hono'
import type { AnalyticsService } from '../analytics/service.ts'
import type { RateLimiter } from './rate-limit.ts'

/**
 * The anonymous widget read: `GET /v1/widget/{widget_id}` (ADR-0045, CP2).
 *
 * A sibling of the public share reads, not a parameter on them — a share slug
 * addresses a *board* with per-surface flags, a widget id addresses *one
 * answer* — and underneath it is **the same read pipeline**: the same `public*`
 * service methods, the same gateway operations, the same `PublicAnalyticsMeta`,
 * the same rollups (ADR-0043 D10's rule that a second surface must be the
 * routes themselves rather than something that resembles them). No new query
 * path, no second copy of the range logic, no new response *rows*.
 *
 * What is genuinely new here is four things, and each one has its own comment
 * below:
 *
 * 1. **The request carries nothing.** Surface, range, row cap and timezone are
 *    all stored configuration, so there is nothing to validate and no `400` on
 *    this route. That is §20's "read widgets can see only an explicit public
 *    metric and date range" in its strongest available form — not an
 *    allowlist checked per request, but a request with no room to carry
 *    anything.
 * 2. **The range is resolved server-side**, in the site's own reporting zone,
 *    by `resolveWidgetRange` (ADR-0045 D10).
 * 3. **`realtime` does not go through the query gateway.** It is the one widget
 *    read served from the presence cache, as a cacheable snapshot poll rather
 *    than an SSE connection held open from a stranger's page.
 * 4. **A second, per-object CORS allowlist** beside `credentialedCors`'s
 *    app-origin one. They are kept apart deliberately: one exists to let our own
 *    dashboard carry a session cookie, the other to let a stranger's page render
 *    a public number without one — so this middleware never learns about
 *    `AUTH_TRUSTED_ORIGINS` and never sets `Access-Control-Allow-Credentials`.
 *
 * No session, no membership, no capability, and no per-surface board flag: a
 * widget is its own opt-in surface (ADR-0045 D11), gated on its own row plus
 * `sites.status === 'active'` and nothing else. It deliberately does **not**
 * read `site_public_dashboard_settings` — requiring an owner to publish a whole
 * board before they may embed one number would be more disclosure to get less.
 */

type Schemas = components['schemas']
type Env = { Variables: RequestContextVariables }

export interface WidgetPublicDeps {
  readonly db: Database
  /**
   * The analytics service, present only when a query gateway is configured.
   *
   * Absent, the seven historical surfaces answer `SERVICE_UNAVAILABLE` — the
   * read-key surface's precedent (ADR-0043) and for the same reason: this route
   * mounts unconditionally, because an unmounted path under `/v1` falls through
   * to the business subtree's blanket session guard and answers `401`, which
   * would both break D7's single answer and tell an anonymous caller something
   * about the deployment.
   */
  readonly service?: AnalyticsService | undefined
  /** The realtime presence cache, present only when its URL is configured.
   * Absent, `realtime` widgets answer `SERVICE_UNAVAILABLE` for the same
   * reason. */
  readonly realtimeCache?: RealtimeCache | undefined
  readonly rateLimiter: RateLimiter
  /** The G-008-gated city-visitor threshold; `undefined` suppresses all cities. */
  readonly cityMinVisitors: number | undefined
  /** `Cache-Control: public, max-age=…` on the seven historical surfaces. */
  readonly cacheMaxAgeSeconds: number
  /** The same, on `realtime`. */
  readonly realtimeCacheMaxAgeSeconds: number
}

/** The widget door's one refusal (ADR-0045, D7).
 *
 * Byte for byte identical — apart from `request_id`, which every error envelope
 * carries — for an invented id, a widget that was deleted, `enabled: false`, and
 * a site that is `suspended`, `deleting` or `deleted`. A widget id sits in
 * the HTML of a page anyone can view, so a distinguishable "this site stopped
 * paying" would publish a customer's billing state to their own readers.
 *
 * The message is deliberately not the share surface's `No such public
 * dashboard`: the identity class is *within* this door, and nothing about a
 * widget's `404` should be comparable with a share's, because they resolve
 * different things. */
function notFound(): never {
  throw new ApiError('NOT_FOUND', 'No such widget')
}

/** Best-effort client IP for the anonymous rate-limit key. The share reads'
 * own extraction, reused rather than re-derived. */
function clientIp(headerValue: string | undefined): string {
  if (!headerValue) return 'unknown'
  // X-Forwarded-For is a comma list; the left-most is the original client.
  return headerValue.split(',')[0]?.trim() || 'unknown'
}

/**
 * The (IP, widget id) budget key (ADR-0045, D5).
 *
 * Exported because the widget has **two** doors — this JSON read and CP3's embed
 * document — and §20 puts a rate limit on the endpoints, plural. They charge one
 * limiter instance through this one function rather than each building a key that
 * looks the same: two keys that agree by inspection are two keys that can drift,
 * and a drift here would silently double what a spray is allowed to cost.
 */
export function widgetBudgetKey(
  widgetId: string,
  forwardedFor: string | undefined,
  realIp: string | undefined,
): string {
  return `${clientIp(forwardedFor ?? realIp)}:${widgetId}`
}

/** The site's published import, from the row the resolution already read
 * (ADR-0032, D2b): an embed of a migrated site shows the same history its owner
 * sees, rather than a chart that starts the day the tracker was installed. */
function importPointerOf(widget: ResolvedPublicWidget): ImportPointer | null {
  return widget.publishedImportRunId !== null && widget.importCutoverDate !== null
    ? { runId: widget.publishedImportRunId, cutoverDate: widget.importCutoverDate }
    : null
}

/**
 * Whether this request's `Origin` may render this widget, and what to echo.
 *
 * Exact serialized origins compared as **whole strings**, never by prefix or
 * suffix — `cors.ts`'s own argument, restated because a second allowlist is a
 * second place to get it wrong: `app.getopen.so` and `evil-app.getopen.so` are
 * different origins and a suffix test accepts both.
 *
 * `["*"]` matches every origin and still echoes the **request's** origin rather
 * than the literal star. A `*` response value would defeat the `Vary: Origin`
 * that keeps a shared cache from handing one origin's header to another, and
 * the contract states the property explicitly.
 *
 * A request with no `Origin` — a `curl`, a server-side renderer — gets nothing
 * to echo and needs nothing: CORS is a browser's rule, and the capability here
 * is the id.
 */
function allowedOrigin(
  widget: ResolvedPublicWidget,
  requestOrigin: string | undefined,
): string | null {
  if (requestOrigin === undefined) return null
  const list = widget.allowedOrigins
  if (list.length === 1 && list[0] === '*') return requestOrigin
  return list.includes(requestOrigin) ? requestOrigin : null
}

export function createWidgetPublicRoutes(deps: WidgetPublicDeps): Hono<Env> {
  const { db, rateLimiter, cityMinVisitors } = deps
  const app = new Hono<Env>()

  /**
   * The budget, charged before any database work (ADR-0045, D5).
   *
   * Keyed per **(IP, widget id)**, following the share limiter: the caller is a
   * browser with an unstable address and no credential, so per-widget-only would
   * let one popular embed's traffic close it for everybody, and per-IP-only
   * would let one noisy site starve an unrelated one behind the same proxy.
   * The numbers are the share surface's own — a second pair would assert a
   * difference nobody has measured.
   */
  app.use('/widget/:widget_id', async (c, next) => {
    const id = c.req.param('widget_id')
    const decision = rateLimiter.check(
      widgetBudgetKey(id, c.req.header('x-forwarded-for'), c.req.header('x-real-ip')),
    )
    if (!decision.allowed) {
      c.header('Retry-After', String(decision.retryAfterSeconds))
      throw new ApiError('RATE_LIMITED', 'Too many requests', {
        details: { retry_after_seconds: decision.retryAfterSeconds },
      })
    }
    await next()
  })

  /** The configured service, or the honest refusal. */
  const service = (): AnalyticsService => {
    if (!deps.service) {
      throw new ApiError('SERVICE_UNAVAILABLE', 'Analytics is temporarily unavailable')
    }
    return deps.service
  }

  /**
   * The one answer a widget publishes.
   *
   * **No `OPTIONS` handler, and that is not an omission.** This is a `GET` with
   * no custom request headers and no credentials — a CORS *simple* request,
   * which a browser sends without a preflight. The only `OPTIONS` this api
   * answers is `credentialedCors`'s, which is there for the dashboard's
   * cookie-carrying `PATCH`/`DELETE` calls; a widget has neither. Adding one
   * here would advertise a negotiation this route does not have.
   */
  app.get('/widget/:widget_id', async (c) => {
    const widget = await resolvePublicWidget(db, c.req.param('widget_id'))
    // The gate, in one place: the widget's own switch and the site's lifecycle.
    // Every failure is the same 404 — see `notFound`. No board flag is consulted
    // (ADR-0045, D11): a widget is its own act of publication.
    if (!widget || !widget.enabled || widget.siteStatus !== 'active') notFound()

    const data =
      widget.surface === 'realtime' ? await realtimeSnapshot(widget) : await historical(widget)

    // Set after the read, so a refusal thrown above carries neither header. A
    // 404 that echoed an origin would be an oracle for "this origin is on some
    // widget's list", and a cacheable refusal is a refusal cached.
    c.header(
      'Cache-Control',
      `public, max-age=${widget.surface === 'realtime' ? deps.realtimeCacheMaxAgeSeconds : deps.cacheMaxAgeSeconds}`,
    )
    // Always, matched or not: what keeps a shared cache from mixing two origins'
    // answers is the presence of `Vary`, not the presence of the allow header.
    c.header('Vary', 'Origin')
    const echo = allowedOrigin(widget, c.req.header('origin'))
    // Never `Access-Control-Allow-Credentials`: there is no credential to send,
    // and a wildcard-with-credentials pair is invalid anyway.
    if (echo !== null) c.header('Access-Control-Allow-Origin', echo)

    return c.json({
      // Built field by field, so a column added to the widget row later cannot
      // reach an anonymous caller by inheritance (ADR-0039 D10's pattern). No
      // id (the caller already has it), no origins (a list of the owner's other
      // pages is not the reader's business), no `enabled` (a disabled widget
      // answers 404), no timestamps.
      widget: {
        surface: widget.surface,
        title: widget.title,
        range: widget.range,
        limit: widget.limit,
      },
      data,
    })
  })

  /**
   * `realtime`, the one widget read that does not go through the query gateway
   * (ADR-0045, D2).
   *
   * It answers `PublicRealtimeSnapshot` — the ADR-0024 D7 payload byte for byte
   * — from the presence cache, on an ordinary cacheable `GET`. §20's "dashboards
   * never `GROUP BY` raw events" is satisfied by construction: nothing here
   * reads `events_raw`.
   *
   * **`maxVisitors: 0` is deliberate, not a bug.** `activeVisitors` is the
   * `ZCOUNT` over the *whole* presence set and stays authoritative whatever this
   * bound is; the bound governs only how many members the snapshot then reads
   * metadata for, and this surface publishes one integer. Asking for zero gets
   * the same count the realtime gateway's snapshot computes — the same function,
   * over the same key, filtered by the same `VISITOR_PRESENCE_WINDOW_MS`, which
   * is a store format two services must encode identically and is therefore
   * never restated here — without doing a pipelined `HGETALL` per visitor whose
   * result would be discarded.
   */
  async function realtimeSnapshot(
    widget: ResolvedPublicWidget,
  ): Promise<Schemas['PublicRealtimeSnapshot']> {
    if (!deps.realtimeCache) {
      // Not a 404. The widget exists and is enabled; telling its owner's readers
      // "no such widget" because an operator has not configured the presence
      // store would be a lie about the customer's configuration.
      throw new ApiError('SERVICE_UNAVAILABLE', 'Realtime is temporarily unavailable')
    }
    const generatedAt = new Date()
    const presence = await deps.realtimeCache.readPresenceSnapshot({
      siteId: widget.siteId,
      at: generatedAt,
      maxVisitors: 0,
    })
    return {
      type: 'snapshot',
      generated_at: generatedAt.toISOString(),
      active_visitors: presence.activeVisitors,
    }
  }

  /**
   * The seven historical surfaces, each calling the same `public*` method the
   * share route calls, with the same `cacheEpoch`, the same import pointer and
   * — on sessions — the same finalizer watermark.
   *
   * The only differences from the share handlers, all of them consequences of
   * D10 rather than of this route:
   *
   * - `from`/`to`/`timezone` come from the stored range, never from a query
   *   parameter. The zone is the **site's** (`UTC` when unset): a widget has no
   *   viewer to ask, and rendering "today" in a stranger's laptop clock would
   *   make one embed show two readers of the same page different numbers.
   * - `timeseries` is served at the grain its range fixes, so an embed with no
   *   interval picker never meets the ~1 440-bucket default ADR-0039 D8 closed.
   * - `sessions` passes **no** resolution, exactly as the share does: no
   *   sessions read anywhere takes one, and imposing the week grain there would
   *   mean widening the sessions query surface.
   * - the breakdowns' cap is the stored `limit` **or ten**. A breakdown widget
   *   can legitimately hold a null `row_limit`, and the public reads' own
   *   default is 100 with a ceiling of 500 — five hundred rows in a sidebar on
   *   a stranger's page is bytes nobody asked for.
   */
  async function historical(widget: ResolvedPublicWidget): Promise<unknown> {
    const timezone = widget.reportingTimezone ?? 'UTC'
    // `range` is non-null on every surface but `realtime`, enforced by the
    // create/patch validator and by a column CHECK; the fallback keeps this
    // total rather than trusting two layers to have agreed.
    const key = (widget.range ?? '7d') as WidgetRange
    const { from, to } = resolveWidgetRange({
      range: key,
      timezone,
      now: new Date(),
      firstEventAt: widget.firstEventAt,
    })
    const base = {
      siteId: widget.siteId,
      // The public surface caches through the same gateway, so it needs the same
      // key generation (ADR-0030, decision 6). The resolution already joined
      // `sites`, so this costs no extra read.
      cacheEpoch: widget.configVersion,
      importPointer: importPointerOf(widget),
      from,
      to,
      timezone,
    }
    const limit = widget.limit ?? WIDGET_LIMIT_DEFAULT

    switch (widget.surface) {
      case 'overview':
        return service().publicOverview({ ...base, compare: false })
      case 'timeseries':
        return service().publicTimeseries({
          ...base,
          compare: false,
          resolution: WIDGET_RANGE_GRAIN[key],
        })
      case 'sessions': {
        const state = await getFinalizerState(db, widget.siteId)
        return service().publicSessions({
          ...base,
          finalizedThrough: state ? state.finalizedThrough : null,
        })
      }
      case 'pages':
        return service().publicPages({ ...base, limit })
      case 'sources':
        return service().publicSources({ ...base, limit })
      case 'devices':
        return service().publicDevices({ ...base, limit })
      case 'geography':
        return service().publicGeography({ ...base, limit }, cityMinVisitors)
      default:
        // Unreachable: `realtime` is handled before this function is called and
        // the surface column is closed by a CHECK. A row written by some future
        // migration this build does not know about resolves to nothing rather
        // than to a half-answer.
        return notFound()
    }
  }

  return app
}
