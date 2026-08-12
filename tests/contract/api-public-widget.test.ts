import { loadServiceEnv, WIDGET_LIMIT_DEFAULT } from '@openanalytics/domain'
import type { Auth } from '@openanalytics/auth'
import type { Database, ResolvedPublicWidget } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import type { RealtimeCache } from '@openanalytics/redis'
import type { AnalyticsGateway } from '../../apps/api/src/gateway-client.ts'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'

/**
 * The anonymous widget read, `GET /v1/widget/{widget_id}` (ADR-0045, CP2).
 *
 * The second door onto the public surface, and the first unauthenticated read
 * whose response is a *union*: one route, eight possible `data` shapes,
 * discriminated by a field the same response carries. Everything below the
 * envelope is the existing public read path (ADR-0043 D10), so what this suite
 * proves is the part that is genuinely new:
 *
 * - **One indistinguishable `404`** for an invented id, a disabled widget, a
 *   deleted one and a site that stopped paying (D7). A widget id sits in the
 *   HTML of a page anyone can view, so a distinguishable "this site is
 *   suspended" would publish a customer's billing state to their own
 *   readers. Compared byte for byte in the ADR-0039 D2 idiom.
 * - **The envelope carries exactly four owner-typed fields**, and `data` is a
 *   public share response unchanged — no `freshness`, no `layering`, no
 *   `billable_events` (ADR-0039 D4 and D10 paying off).
 * - **The route takes no query parameters at all.** Everything is stored
 *   configuration, which is §20's "read widgets can see only an explicit public
 *   metric and date range" in its strongest form.
 * - **An origin allowlist is a browser-enforced rendering policy, not an
 *   authentication boundary** (D4). An unlisted origin gets the data with no
 *   CORS header, never a `404` — this ADR refuses to claim a secrecy the
 *   mechanism does not have.
 * - **Revocation is immediate at the origin** (D12): the row is read on every
 *   request that reaches us, so there is no config cache in front of it.
 */

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const WIDGET = 'w3f9xk21qm70c4bd'
const OTHER_WIDGET = 'w7bq04mz1ke82ahd'
const UNKNOWN = 'wzzzzzzzzzzzzzzz'

/** The origin the widget names, and one that only looks like it. */
const ALLOWED_ORIGIN = 'https://shop.example.com'
const OTHER_ORIGIN = 'https://evil-shop.example.com'

/** The stored row every request here resolves, unless a test says otherwise. */
function widgetRow(overrides: Partial<ResolvedPublicWidget> = {}): ResolvedPublicWidget {
  return {
    id: WIDGET,
    siteId: SITE,
    surface: 'pages',
    title: 'Most read this week',
    range: '7d',
    limit: 5,
    allowedOrigins: [ALLOWED_ORIGIN],
    enabled: true,
    siteStatus: 'active',
    configVersion: 7,
    reportingTimezone: 'Europe/Istanbul',
    firstEventAt: new Date('2026-06-02T08:14:09.221Z'),
    publishedImportRunId: null,
    importCutoverDate: null,
    ...overrides,
  } as ResolvedPublicWidget
}

const stored = { value: widgetRow() as ResolvedPublicWidget | null }
/** Every id the route asked the repository for, so "the row is read on every
 * request" is provable rather than assumed (D12). */
const resolved: string[] = []

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    resolvePublicWidget: async (_db: unknown, id: string) => {
      resolved.push(id)
      return stored.value === null ? null : { ...stored.value, id }
    },
    // The sessions surface reads the finalizer watermark to split its range,
    // exactly as the share route does. It never reaches the response.
    getFinalizerState: async () => ({ finalizedThrough: new Date('2026-07-22T00:00:00.000Z') }),
  }
})

const { createApp } = await import('../../apps/api/src/app.ts')
const { AnalyticsService } = await import('../../apps/api/src/analytics/service.ts')
const { InProcessRateLimiter } = await import('../../apps/api/src/http/rate-limit.ts')

/** Every `(operation, params)` pair the gateway was asked for. */
const queries: {
  operation: string
  params: Record<string, unknown>
  options: Record<string, unknown> | undefined
}[] = []

function gateway(): AnalyticsGateway {
  return {
    query: <TRow = Record<string, unknown>>(
      operation: string,
      params: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => {
      queries.push({ operation, params, options })
      const rows = rowsFor(operation)
      return Promise.resolve({
        operation,
        rows: rows as unknown as readonly TRow[],
        meta: { row_count: rows.length, truncated: false, elapsed_ms: 1, cached: false },
      })
    },
  } as AnalyticsGateway
}

function rowsFor(operation: string): Record<string, unknown>[] {
  if (operation === 'analytics.freshness') {
    return [{ watermark: '2026-08-07 14:35:00.000', buckets: '5' }]
  }
  if (operation.startsWith('analytics.geography')) {
    return [{ country: 'US', city: 'New York', views: '500', visitors: '300' }]
  }
  if (operation.startsWith('analytics.timeseries')) {
    return [{ bucket: '2026-08-01 00:00:00.000', events: '12', pageviews: '9', visitors: '5' }]
  }
  if (operation.startsWith('analytics.sessions')) {
    return [
      {
        bucket: '2026-08-01 00:00:00.000',
        sessions: '20',
        engaged_sessions: '12',
        bounced_sessions: '8',
        pageviews: '44',
        total_session_duration_ms: '600000',
        total_active_duration_ms: '300000',
      },
    ]
  }
  if (operation.startsWith('analytics.pages')) {
    return [{ page_path: '/pricing', views: '120', visitors: '80' }]
  }
  if (operation.startsWith('analytics.sources')) {
    return [
      {
        referrer_domain: 'news.ycombinator.com',
        utm_source: '',
        utm_medium: '',
        utm_campaign: '',
        views: '90',
        visitors: '70',
      },
    ]
  }
  if (operation.startsWith('analytics.devices')) {
    return [{ device_type: 'desktop', browser: 'chrome', os: 'macos', views: '77', visitors: '60' }]
  }
  return [{ events: '10', pageviews: '8', visitors: '4', billable_events: '9' }]
}

/** The presence store, faked exactly as `api-realtime-token.test.ts` fakes it:
 * only the method the route calls, cast through `unknown`. */
const presence = { activeVisitors: 128, calls: [] as { siteId: string; maxVisitors: number }[] }
function fakeCache(): RealtimeCache {
  return {
    readPresenceSnapshot: async (input: { siteId: string; at: Date; maxVisitors: number }) => {
      presence.calls.push({ siteId: input.siteId, maxVisitors: input.maxVisitors })
      return { activeVisitors: presence.activeVisitors, truncated: false, present: [] }
    },
  } as unknown as RealtimeCache
}

const noAuth = {
  api: { getSession: async () => null },
  handler: async () => new Response(null),
} as unknown as Auth

interface AppOptions {
  readonly perMinute?: number
  /** Omit the query gateway, to prove the honest refusal rather than a 401. */
  readonly withoutAnalytics?: boolean
  /** Omit the presence store, likewise. */
  readonly withoutRealtime?: boolean
}

function buildApp(options: AppOptions = {}) {
  const { logger } = createCapturedLogger()
  const limit = options.perMinute ?? 500
  return createApp({
    service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
    logger,
    env: loadServiceEnv('api', testEnv()),
    auth: noAuth,
    db: {} as Database,
    ...(options.withoutAnalytics ? {} : { analytics: new AnalyticsService(gateway()) }),
    ...(options.withoutRealtime
      ? {}
      : {
          realtime: {
            cache: fakeCache(),
            rateLimiter: new InProcessRateLimiter({ requestsPerMinute: limit, burst: limit }),
          },
        }),
    widgetRead: {
      rateLimiter: new InProcessRateLimiter({ requestsPerMinute: limit, burst: limit }),
      cacheMaxAgeSeconds: 60,
      realtimeCacheMaxAgeSeconds: 10,
    },
  })
}

const url = (id = WIDGET) => `http://api.test/v1/widget/${id}`

/** One anonymous GET, optionally from an origin and an address. */
function get(
  app: ReturnType<typeof buildApp>,
  init: { id?: string; origin?: string; ip?: string } = {},
) {
  const headers: Record<string, string> = {}
  if (init.origin !== undefined) headers['origin'] = init.origin
  if (init.ip !== undefined) headers['x-forwarded-for'] = init.ip
  return app.fetch(new Request(url(init.id ?? WIDGET), { headers }))
}

/** An error envelope minus the per-request correlation id — the one field every
 * envelope carries and that says nothing about the widget. */
function withoutRequestId(body: unknown): unknown {
  const envelope = body as { error?: Record<string, unknown> }
  if (!envelope.error) return body
  const { request_id: _ignored, ...rest } = envelope.error
  return { ...envelope, error: rest }
}

beforeEach(() => {
  stored.value = widgetRow()
  resolved.length = 0
  queries.length = 0
  presence.calls.length = 0
  presence.activeVisitors = 128
})

describe('one indistinguishable 404 (ADR-0045, D7)', () => {
  it('answers the decided envelope, with the widget door’s own message', async () => {
    stored.value = null
    const res = await get(buildApp(), { id: UNKNOWN })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: Record<string, unknown> }
    expect(body.error['code']).toBe('NOT_FOUND')
    // Deliberately not the share surface's "No such public dashboard": the
    // identity class is *within* the widget door, and nothing about a widget's
    // 404 should be comparable with a share's.
    expect(body.error['message']).toBe('No such widget')
    expect(body.error['details']).toEqual({})
  })

  it('is byte-identical across all four facts', async () => {
    const app = buildApp()

    // 1. No such widget id.
    stored.value = null
    const unknown = await get(app, { id: UNKNOWN })
    // 2. The widget was deleted — the same absent row, reached by a real id.
    const deleted = await get(app)
    // 3. `enabled: false`.
    stored.value = widgetRow({ enabled: false })
    const disabled = await get(app)
    // 4. The site stopped paying. §20 is explicit that `suspended` closes
    //    the widget in the backend, and a public route may not pass the gate.
    stored.value = widgetRow({ siteStatus: 'suspended' })
    const blocked = await get(app)

    const reference = withoutRequestId(await unknown.json())
    for (const [label, res] of [
      ['deleted', deleted],
      ['disabled', disabled],
      ['suspended', blocked],
    ] as const) {
      expect(res.status, label).toBe(404)
      expect(res.headers.get('content-type'), label).toBe(unknown.headers.get('content-type'))
      expect(withoutRequestId(await res.json()), label).toEqual(reference)
    }
  })

  it('closes on every non-active lifecycle state', async () => {
    for (const status of ['suspended', 'deleting', 'deleted'] as const) {
      stored.value = widgetRow({ siteStatus: status })
      const res = await get(buildApp())
      expect(res.status, status).toBe(404)
    }
  })

  it('runs no query on any of them', async () => {
    stored.value = widgetRow({ enabled: false })
    await get(buildApp())
    expect(queries).toEqual([])
  })

  it('carries no CORS header, even from an allowlisted origin', async () => {
    // The 404 must not become an oracle for "this origin is on some widget's
    // list", and an unresolved widget has no list to consult in the first place.
    stored.value = null
    const res = await get(buildApp(), { origin: ALLOWED_ORIGIN })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('revocation is immediate at the origin (ADR-0045, D12)', () => {
  it('answers 404 on the very next request after the row flips', async () => {
    const app = buildApp()
    expect((await get(app)).status).toBe(200)
    stored.value = widgetRow({ enabled: false })
    expect((await get(app)).status).toBe(404)
    // Two requests, two reads: there is no config cache in front of the row.
    expect(resolved).toEqual([WIDGET, WIDGET])
  })
})

describe('the two-key envelope (ADR-0045, D3)', () => {
  it('carries exactly the four fields the owner typed', async () => {
    const res = await get(buildApp())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { widget: Record<string, unknown>; data: unknown }
    expect(Object.keys(body).sort()).toEqual(['data', 'widget'])
    // No id (the caller already has it), no origins (a list of the owner's other
    // pages is not the reader's business), no `enabled` (a disabled widget
    // answers 404), no timestamps.
    expect(Object.keys(body.widget).sort()).toEqual(['limit', 'range', 'surface', 'title'])
    expect(body.widget).toEqual({
      surface: 'pages',
      title: 'Most read this week',
      range: '7d',
      limit: 5,
    })
  })

  it('never leaks the site id or the origin allowlist', async () => {
    const res = await get(buildApp())
    const raw = await res.text()
    expect(raw).not.toContain(SITE)
    expect(raw).not.toContain(ALLOWED_ORIGIN)
  })

  it('reports range and limit as null on a realtime widget', async () => {
    stored.value = widgetRow({ surface: 'realtime', range: null, limit: null, title: null })
    const res = await get(buildApp())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { widget: Record<string, unknown> }
    expect(body.widget).toEqual({ surface: 'realtime', title: null, range: null, limit: null })
  })
})

describe('data is the public share response, unchanged (ADR-0039 D4 and D10)', () => {
  const HISTORICAL = [
    'overview',
    'timeseries',
    'sessions',
    'pages',
    'sources',
    'devices',
    'geography',
  ] as const

  it.each(HISTORICAL)('%s answers 200 and carries no meta.freshness', async (surface) => {
    stored.value = widgetRow({
      surface,
      limit:
        surface === 'overview' || surface === 'timeseries' || surface === 'sessions' ? null : 5,
    })
    const res = await get(buildApp())
    expect(res.status, surface).toBe(200)
    const body = (await res.json()) as { data: { meta: Record<string, unknown> } }
    expect(body.data.meta, surface).not.toHaveProperty('freshness')
    // Not merely absent from `meta`: absent from the whole document. The
    // failure this guards against is a future field arriving by inheritance.
    expect(JSON.stringify(body), surface).not.toContain('freshness')
  })

  it('the overview withholds the billable-event count', async () => {
    stored.value = widgetRow({ surface: 'overview', limit: null })
    const res = await get(buildApp())
    const body = (await res.json()) as { data: { totals: Record<string, unknown> } }
    expect(Object.keys(body.data.totals).sort()).toEqual(['events', 'pageviews', 'visitors'])
    expect(JSON.stringify(body)).not.toContain('billable')
  })

  it('sessions withholds `layering` — our finalizer’s watermark is not published', async () => {
    stored.value = widgetRow({ surface: 'sessions', limit: null })
    const res = await get(buildApp())
    const body = (await res.json()) as { data: Record<string, unknown> }
    expect(body.data).not.toHaveProperty('layering')
    expect(JSON.stringify(body)).not.toContain('finalized_through')
  })

  it('timeseries reports no comparison — no public read accepts `compare`', async () => {
    stored.value = widgetRow({ surface: 'timeseries', limit: null })
    const res = await get(buildApp())
    const body = (await res.json()) as {
      data: { comparison: unknown; meta: { comparison_range: unknown } }
    }
    expect(body.data.comparison).toBeNull()
    expect(body.data.meta.comparison_range).toBeNull()
  })
})

describe('the stored configuration is the whole request (ADR-0045, D10)', () => {
  it('serves the site’s reporting zone, never UTC and never a viewer’s', async () => {
    const res = await get(buildApp())
    const body = (await res.json()) as { data: { meta: { timezone: string } } }
    // `meta.timezone` reports what was used, so nothing is hidden.
    expect(body.data.meta.timezone).toBe('Europe/Istanbul')
  })

  it('falls back to UTC when the site has configured no clock', async () => {
    stored.value = widgetRow({ reportingTimezone: null })
    const res = await get(buildApp())
    const body = (await res.json()) as { data: { meta: { timezone: string } } }
    expect(body.data.meta.timezone).toBe('UTC')
  })

  it('ignores every query parameter a caller invents', async () => {
    // There is nothing for a caller to ask for, nothing to validate and no 400
    // on this route. A `limit=500` that changed the answer would be the whole
    // decision undone.
    const app = buildApp()
    const plain = await app.fetch(new Request(url()))
    const meddled = await app.fetch(
      new Request(
        `${url()}?limit=500&from=2020-01-01T00:00:00.000Z&to=2020-01-02T00:00:00.000Z&timezone=UTC&resolution=minute&compare=true`,
      ),
    )
    expect(meddled.status).toBe(200)
    const [a, b] = [
      (await plain.json()) as Record<string, unknown>,
      (await meddled.json()) as Record<string, unknown>,
    ]
    expect((b['data'] as { meta: Record<string, unknown> }).meta['requested_range']).toEqual(
      (a['data'] as { meta: Record<string, unknown> }).meta['requested_range'],
    )
    expect((b['data'] as { meta: Record<string, unknown> }).meta['timezone']).toBe(
      'Europe/Istanbul',
    )
  })

  it('serves the fixed grain for the range, and never `minute`', async () => {
    for (const [range, grain] of [
      ['today', 'hour'],
      ['7d', 'day'],
      ['12mo', 'week'],
    ] as const) {
      stored.value = widgetRow({ surface: 'timeseries', range, limit: null })
      const res = await get(buildApp())
      const body = (await res.json()) as { data: { meta: { resolution: string } } }
      expect(body.data.meta.resolution, range).toBe(grain)
    }
  })

  it('sends `sessions` no resolution at all — it keeps automatic selection', async () => {
    // No sessions read anywhere, private or public, takes a `resolution`: the
    // rollups are 1h/1d and the finalized/provisional split owns the bucketing.
    stored.value = widgetRow({ surface: 'sessions', range: '12mo', limit: null })
    const res = await get(buildApp())
    expect(res.status).toBe(200)
  })
})

describe('the breakdown row cap', () => {
  it('asks for the stored limit', async () => {
    await get(buildApp())
    const pages = queries.find((q) => q.operation.startsWith('analytics.pages'))
    expect(pages?.params['limit']).toBe(5)
  })

  it('defaults a NULL row_limit to ten rather than to the public 500', async () => {
    // A breakdown widget *can* hold a null `row_limit` — the column is nullable
    // for the surfaces that have no row cap — so this path must never assume it
    // is set. Five hundred rows in a sidebar on a stranger's page is bytes
    // nobody asked for.
    stored.value = widgetRow({ limit: null })
    await get(buildApp())
    const pages = queries.find((q) => q.operation.startsWith('analytics.pages'))
    expect(pages?.params['limit']).toBe(WIDGET_LIMIT_DEFAULT)
    expect(WIDGET_LIMIT_DEFAULT).toBe(10)
  })

  it('threads the site’s cache epoch, so a lifecycle change unreachable-s the cache', async () => {
    await get(buildApp())
    // It travels as a gateway option rather than a bound parameter — it keys the
    // gateway's own cache, it is not part of the query.
    const pages = queries.find((q) => q.operation.startsWith('analytics.pages'))
    expect(pages?.options?.['cacheEpoch']).toBe(7)
  })
})

describe('realtime is a snapshot poll, not a stream (ADR-0045, D2)', () => {
  beforeEach(() => {
    stored.value = widgetRow({ surface: 'realtime', range: null, limit: null, title: null })
  })

  it('answers the ADR-0024 D7 payload byte for byte', async () => {
    const res = await get(buildApp())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Record<string, unknown> }
    expect(Object.keys(body.data).sort()).toEqual(['active_visitors', 'generated_at', 'type'])
    expect(body.data['type']).toBe('snapshot')
    expect(body.data['active_visitors']).toBe(128)
    expect(typeof body.data['generated_at']).toBe('string')
  })

  it('reads the presence store for this site and runs no gateway query', async () => {
    await get(buildApp())
    expect(presence.calls.map((c) => c.siteId)).toEqual([SITE])
    expect(queries).toEqual([])
  })

  it('refuses honestly when no presence store is configured', async () => {
    // Not a 404: the widget exists and is enabled, and telling its owner's
    // readers "no such widget" because an operator has not configured Valkey
    // would be a lie about the customer's configuration.
    const res = await get(buildApp({ withoutRealtime: true }))
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'SERVICE_UNAVAILABLE',
    )
  })
})

describe('the honest refusal when no query gateway is configured', () => {
  it('answers 503 rather than falling through to the session guard', async () => {
    // An unmounted path under `/v1` meets the business subtree's blanket session
    // middleware and answers `401`, which would tell an anonymous caller
    // something about the deployment and would break D7's one answer.
    const res = await get(buildApp({ withoutAnalytics: true }))
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'SERVICE_UNAVAILABLE',
    )
  })

  it('still answers 404 for an unknown id, so the surface is never a 401', async () => {
    stored.value = null
    const res = await get(buildApp({ withoutAnalytics: true }), { id: UNKNOWN })
    expect(res.status).toBe(404)
  })
})

describe('cache headers state a staleness bound (ADR-0045, D12)', () => {
  it('is 60 seconds on the seven historical surfaces', async () => {
    const res = await get(buildApp())
    expect(res.headers.get('cache-control')).toBe('public, max-age=60')
  })

  it('is 10 seconds on realtime, where a minute-old "now" is a wrong number', async () => {
    stored.value = widgetRow({ surface: 'realtime', range: null, limit: null })
    const res = await get(buildApp())
    expect(res.headers.get('cache-control')).toBe('public, max-age=10')
  })

  it('states nothing on the 404 — a refusal is not a cacheable answer', async () => {
    stored.value = null
    const res = await get(buildApp(), { id: UNKNOWN })
    expect(res.headers.get('cache-control')).toBeNull()
  })
})

describe('the per-widget origin allowlist (ADR-0045, D4)', () => {
  it('echoes an allowlisted origin, with Vary and never credentials', async () => {
    const res = await get(buildApp(), { origin: ALLOWED_ORIGIN })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN)
    expect(res.headers.get('vary')?.toLowerCase()).toContain('origin')
    // There is no credential to send, and a wildcard-with-credentials pair is
    // invalid anyway.
    expect(res.headers.get('access-control-allow-credentials')).toBeNull()
  })

  it('serves an unlisted origin the data with no CORS header, never a 404', async () => {
    // D4's refusal, stated as a test: answering 404 here would claim a secrecy
    // CORS does not provide, and would break server-side rendering for an owner
    // who wanted the number on their own backend-rendered page.
    const res = await get(buildApp(), { origin: OTHER_ORIGIN })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(res.headers.get('vary')?.toLowerCase()).toContain('origin')
    expect((await res.json()) as Record<string, unknown>).toHaveProperty('widget')
  })

  it('compares whole strings — a suffix lookalike is a different origin', async () => {
    stored.value = widgetRow({ allowedOrigins: ['https://app.getopen.so'] })
    const app = buildApp()
    const exact = await get(app, { origin: 'https://app.getopen.so' })
    const lookalike = await get(app, { origin: 'https://evil-app.getopen.so' })
    expect(exact.headers.get('access-control-allow-origin')).toBe('https://app.getopen.so')
    expect(lookalike.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('renders nowhere on an empty list', async () => {
    stored.value = widgetRow({ allowedOrigins: [] })
    const res = await get(buildApp(), { origin: ALLOWED_ORIGIN })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('echoes the request’s own origin for a `["*"]` list, never the literal star', async () => {
    // The echo is what keeps a shared cache from handing one origin's header to
    // another; `*` as a response value would defeat `Vary: Origin`.
    stored.value = widgetRow({ allowedOrigins: ['*'] })
    const app = buildApp()
    const first = await get(app, { origin: OTHER_ORIGIN })
    expect(first.headers.get('access-control-allow-origin')).toBe(OTHER_ORIGIN)
    const second = await get(app, { origin: ALLOWED_ORIGIN })
    expect(second.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN)
  })

  it('sends no allow header at all when the request carries no Origin', async () => {
    // A `curl` or a server-side renderer. It gets the data — the capability is
    // the id — and there is nothing to echo.
    const res = await get(buildApp())
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(res.headers.get('vary')?.toLowerCase()).toContain('origin')
  })
})

describe('the limiter is keyed per (IP, widget id) (ADR-0045, D5)', () => {
  it('does not let one widget’s traffic close another from the same address', async () => {
    const app = buildApp({ perMinute: 2 })
    expect((await get(app, { ip: '203.0.113.7' })).status).toBe(200)
    expect((await get(app, { ip: '203.0.113.7' })).status).toBe(200)
    // The third on this widget is over budget …
    expect((await get(app, { ip: '203.0.113.7' })).status).toBe(429)
    // … while the other widget from the same address still has its own.
    expect((await get(app, { id: OTHER_WIDGET, ip: '203.0.113.7' })).status).toBe(200)
  })

  it('does not let one address close a widget for another', async () => {
    const app = buildApp({ perMinute: 1 })
    expect((await get(app, { ip: '203.0.113.7' })).status).toBe(200)
    expect((await get(app, { ip: '203.0.113.7' })).status).toBe(429)
    expect((await get(app, { ip: '198.51.100.4' })).status).toBe(200)
  })

  it('answers the share surface’s own 429 shape, with Retry-After', async () => {
    const app = buildApp({ perMinute: 1 })
    await get(app, { ip: '203.0.113.9' })
    const res = await get(app, { ip: '203.0.113.9' })
    expect(res.status).toBe(429)
    const body = (await res.json()) as { error: Record<string, unknown> }
    expect(body.error['code']).toBe('RATE_LIMITED')
    expect(res.headers.get('retry-after')).not.toBeNull()
  })

  it('charges the budget before the row is read', async () => {
    const app = buildApp({ perMinute: 1 })
    await get(app, { ip: '203.0.113.11' })
    resolved.length = 0
    await get(app, { ip: '203.0.113.11' })
    expect(resolved).toEqual([])
  })
})

/**
 * **A gap between two sentences of ADR-0045 D10, pinned rather than papered
 * over.**
 *
 * D10 says an `all` widget on a site that has never ingested an event "resolves
 * to a zero-width window and renders empty, rather than inventing a start", and
 * the same decision says this route has "no `400` … at all". With the existing
 * read pipeline those cannot both hold: `chooseResolution` is total and returns
 * `servable: false` for any span `<= 0` ("range must be half-open with from <
 * to"), which the service raises as `RESOLUTION_NOT_AVAILABLE` — a `400`.
 *
 * The resolver implements the sentence that is a *statement about the range*
 * (the window is genuinely zero-width, and `resolveWidgetRange` is tested on
 * it); this test states what the route therefore does today, so the behaviour is
 * a recorded decision to make rather than a surprise found on a customer's page.
 * The three ways out are all decisions, not implementation details: build an
 * empty response per surface (a second response builder, which D3 refuses),
 * anchor a widget with no first event at today's start (inventing a start, which
 * D10 refuses), or accept the refusal. **Nothing is improvised here.**
 */
describe('KNOWN GAP: `all` with no first event (ADR-0045, D10)', () => {
  it('answers 400 RESOLUTION_NOT_AVAILABLE rather than an empty chart', async () => {
    stored.value = widgetRow({
      surface: 'overview',
      range: 'all',
      limit: null,
      firstEventAt: null,
    })
    const res = await get(buildApp())
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'RESOLUTION_NOT_AVAILABLE',
    )
  })

  it('is only that one combination — a site with a first event is fine', async () => {
    stored.value = widgetRow({ surface: 'overview', range: 'all', limit: null })
    expect((await get(buildApp())).status).toBe(200)
  })
})
