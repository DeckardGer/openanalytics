import { loadServiceEnv } from '@openanalytics/domain'
import type { Auth } from '@openanalytics/auth'
import type { Database } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import type { AnalyticsGateway } from '../../apps/api/src/gateway-client.ts'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The public dashboard read surface (plan Milestone 7 item 8; docs snapshot 02
 * §20). Proves the four §20 rules the backend must enforce: per-surface opt-in,
 * the suspended close, city coarsening at read time, and a rate limit — and
 * that none can be bypassed by a query parameter.
 *
 * Since ADR-0039 the surface is seven analytics reads rather than two, so the
 * per-surface rules are proven **for each one**: an unshared surface must 404 in
 * a way an anonymous caller cannot tell from a wrong slug, and the one read whose
 * public shape is narrower than its private shape (`sessions`) must not carry the
 * field it drops.
 *
 * ADR-0044 adds an eighth read that is not an analytics read at all —
 * `GET /v1/public/{slug}/site` — and it gates differently (on whether the share
 * publishes anything, not on its own flag), so it has its own describe block at
 * the end rather than joining `SURFACES`.
 */

/** The nine per-surface flags, all off — a test then names only what it opens. */
const ALL_OFF = {
  shareOverview: false,
  shareGeography: false,
  shareRealtime: false,
  shareTimeseries: false,
  shareSessions: false,
  sharePages: false,
  shareSources: false,
  shareDevices: false,
  shareIdentity: false,
}

const share = {
  value: null as ({ siteId: string; siteStatus: string; enabled: boolean } & typeof ALL_OFF) | null,
}

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    resolvePublicShare: async () => share.value,
    // The public sessions route reads the finalizer watermark to split the
    // range, exactly as the private one does. It never reaches the response.
    getFinalizerState: async () => ({ finalizedThrough: new Date('2026-07-22T00:00:00.000Z') }),
    // ADR-0044. The route decides which of these four reach the wire; the
    // repository read makes no authorization decision, so the stub answers the
    // same row whatever the flag says.
    readPublicSiteIdentity: async () => identity.value,
  }
})

const { createApp } = await import('../../apps/api/src/app.ts')
const { AnalyticsService } = await import('../../apps/api/src/analytics/service.ts')
const { InProcessRateLimiter } = await import('../../apps/api/src/http/rate-limit.ts')

const identity = {
  value: {
    displayName: 'Acme Metrics',
    faviconDomain: 'acme.example',
    reportingTimezone: 'Europe/Istanbul',
    firstEventAt: new Date('2026-06-02T08:14:09.221Z'),
  } as {
    displayName: string
    faviconDomain: string | null
    reportingTimezone: string | null
    firstEventAt: Date | null
  },
}

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const SLUG = 'sunny-otter-4821'
const WRONG_SLUG = 'no-such-share-0000'

function gateway(): AnalyticsGateway {
  return {
    query: <TRow = Record<string, unknown>>(operation: string) => {
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
    return [{ watermark: '2026-07-23 14:35:00.000', buckets: '5' }]
  }
  if (operation.startsWith('analytics.geography')) {
    return [
      { country: 'US', city: 'New York', views: '500', visitors: '300' },
      { country: 'US', city: 'Smalltown', views: '5', visitors: '2' },
    ]
  }
  if (operation.startsWith('analytics.timeseries')) {
    return [{ bucket: '2026-07-20 00:00:00.000', events: '12', pageviews: '9', visitors: '5' }]
  }
  if (operation.startsWith('analytics.sessions')) {
    return [
      {
        bucket: '2026-07-20 00:00:00.000',
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

const noAuth = {
  api: { getSession: async () => null },
  handler: async () => new Response(null),
} as unknown as Auth

function buildApp(options: { cityMinVisitors?: number | undefined; perMinute?: number } = {}) {
  const { logger } = createCapturedLogger()
  return createApp({
    service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
    logger,
    env: loadServiceEnv('api', testEnv()),
    auth: noAuth,
    db: {} as Database,
    analytics: new AnalyticsService(gateway()),
    publicDashboard: {
      rateLimiter: new InProcessRateLimiter({
        requestsPerMinute: options.perMinute ?? 100,
        burst: options.perMinute ?? 100,
      }),
      cityMinVisitors: options.cityMinVisitors,
    },
  })
}

const RANGE = 'from=2026-07-16T00:00:00.000Z&to=2026-07-23T00:00:00.000Z&timezone=UTC'
const url = (path: string, slug = SLUG) => `http://api.test/v1/public/${slug}/${path}?${RANGE}`

const overviewUrl = url('overview')
const geoUrl = url('geography')
/** The site-identity read takes no range at all (ADR-0044). */
const siteUrl = (slug = SLUG) => `http://api.test/v1/public/${slug}/site`

/** Every surface the public share can answer, with the flag that opens it. */
const SURFACES = [
  ['overview', 'shareOverview'],
  ['geography', 'shareGeography'],
  ['timeseries', 'shareTimeseries'],
  ['sessions', 'shareSessions'],
  ['pages', 'sharePages'],
  ['sources', 'shareSources'],
  ['devices', 'shareDevices'],
] as const

/** The five ADR-0039 reads, on their own — the ones this change added. */
const NEW_SURFACES = SURFACES.filter(
  ([surface]) => surface !== 'overview' && surface !== 'geography',
)

function sharedWith(flag: (typeof SURFACES)[number][1]) {
  return { siteId: SITE, siteStatus: 'active', enabled: true, ...ALL_OFF, [flag]: true }
}

/** An error envelope minus the per-request correlation id. */
function withoutRequestId(body: unknown): unknown {
  const envelope = body as { error?: Record<string, unknown> }
  if (!envelope.error) return body
  const { request_id: _ignored, ...rest } = envelope.error
  return { ...envelope, error: rest }
}

describe('public dashboard authorization (§20)', () => {
  beforeEach(() => {
    share.value = null
  })

  it('404 for an unknown slug', async () => {
    const res = await buildApp().fetch(new Request(overviewUrl))
    expect(res.status).toBe(404)
  })

  it('404 when the master switch is off', async () => {
    share.value = {
      siteId: SITE,
      siteStatus: 'active',
      enabled: false,
      ...ALL_OFF,
      shareOverview: true,
    }
    const res = await buildApp().fetch(new Request(overviewUrl))
    expect(res.status).toBe(404)
  })

  it('404 when the surface is not individually opted in', async () => {
    share.value = {
      siteId: SITE,
      siteStatus: 'active',
      enabled: true,
      ...ALL_OFF,
      shareGeography: true,
    }
    const res = await buildApp().fetch(new Request(overviewUrl))
    expect(res.status).toBe(404)
  })

  it('closes the public share while suspended', async () => {
    share.value = {
      siteId: SITE,
      siteStatus: 'suspended',
      enabled: true,
      ...ALL_OFF,
      shareOverview: true,
    }
    const res = await buildApp().fetch(new Request(overviewUrl))
    expect(res.status).toBe(404)
  })

  it('200 when enabled, opted-in and active', async () => {
    share.value = sharedWith('shareOverview')
    const res = await buildApp().fetch(new Request(overviewUrl))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      totals: { events: number }
      meta: { data_sources: string[]; accuracy: string }
    }
    expect(body.totals.events).toBe(10)
    // Every analytics response says where its numbers came from (ADR-0032, D5).
    // This share resolves no published import, so the answer is the one every
    // response gave before imports existed — the shape the contract's own
    // fixtures carry.
    expect(body.meta.data_sources).toEqual(['live'])
    expect(body.meta.accuracy).toBe('exact')
  })

  it('never ships the billable-event count to an anonymous caller', async () => {
    // ADR-0039 decision 4 as amended. The gateway stub answers
    // `billable_events: 9` for this range (see `overviewRows` above), so the
    // number exists and is deliberately not on the wire: an owner who shares
    // the overview is publishing how many people visited, not what they pay.
    //
    // Asserted on the *keys* rather than on a value, because the failure this
    // guards against is a future field arriving by inheritance — a
    // `...totals` spread in the route, or a new column on `OverviewTotals`.
    share.value = sharedWith('shareOverview')
    const res = await buildApp().fetch(new Request(overviewUrl))
    const body = (await res.json()) as { totals: Record<string, unknown> }

    expect(Object.keys(body.totals).sort()).toEqual(['events', 'pageviews', 'visitors'])
    expect(JSON.stringify(body)).not.toContain('billable')
    // And `comparison` goes with it: the public route asks for no comparison
    // period, so the field was `null` on every response this surface ever sent.
    expect(body).not.toHaveProperty('comparison')
  })
})

describe('the five ADR-0039 reads', () => {
  beforeEach(() => {
    share.value = null
  })

  it.each(NEW_SURFACES)('%s answers 200 with its own flag on', async (surface, flag) => {
    share.value = sharedWith(flag)
    const res = await buildApp().fetch(new Request(url(surface)))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { meta: { timezone: string } }
    expect(body.meta.timezone).toBe('UTC')
  })

  it.each(NEW_SURFACES)('%s stays shut while every other surface is open', async (surface) => {
    // Everything except this one. A flag that gated the wrong surface — or an
    // `isSurfaceShared` fallthrough — would answer 200 here.
    const flags = { ...ALL_OFF }
    for (const [other, otherFlag] of SURFACES) if (other !== surface) flags[otherFlag] = true
    share.value = { siteId: SITE, siteStatus: 'active', enabled: true, ...flags }

    const res = await buildApp().fetch(new Request(url(surface)))
    expect(res.status).toBe(404)
  })

  it.each(NEW_SURFACES)(
    '%s: a disabled surface is indistinguishable from a wrong slug',
    async (surface, flag) => {
      // A wrong slug: `resolvePublicShare` finds nothing at all.
      share.value = null
      const wrong = await buildApp().fetch(new Request(url(surface, WRONG_SLUG)))

      // A real slug on a real, active, enabled share — with this one surface
      // off. The site exists, the share exists, the caller simply may not read
      // this surface, and the answer must not say so.
      share.value = { ...sharedWith(flag), [flag]: false }
      const disabled = await buildApp().fetch(new Request(url(surface)))

      expect(disabled.status).toBe(wrong.status)
      expect(disabled.status).toBe(404)
      expect(disabled.headers.get('content-type')).toBe(wrong.headers.get('content-type'))
      // Everything but `request_id`, which is a per-request correlation id the
      // envelope carries on every error and says nothing about the share.
      expect(withoutRequestId(await disabled.json())).toEqual(withoutRequestId(await wrong.json()))
    },
  )

  it('the breakdown reads carry no privacy coarsening (ADR-0039, D3)', async () => {
    // A single-visitor page row is returned named. Geography is the surface with
    // a threshold; a path is not a person, so `pages` has no `*_suppressed`
    // field to set and no bucket to fold a quiet path into.
    share.value = sharedWith('sharePages')
    const res = await buildApp().fetch(new Request(url('pages')))
    const body = (await res.json()) as { items: Record<string, unknown>[] }
    expect(body.items[0]).toEqual({ page_path: '/pricing', views: 120, visitors: 80 })
  })

  it('timeseries reports no comparison — the public surface takes no compare', async () => {
    share.value = sharedWith('shareTimeseries')
    const res = await buildApp().fetch(new Request(`${url('timeseries')}&compare=true`))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { comparison: unknown; meta: { comparison_range: unknown } }
    expect(body.comparison).toBeNull()
    expect(body.meta.comparison_range).toBeNull()
  })
})

/**
 * ADR-0039, D8. The defect: a "Today" range is exactly 24 hours,
 * `MINUTE_GRAIN_MAX_HOURS` defaults to 24, and the comparison is `<=` — so the
 * public chart got ~1 440 buckets while the owner's got 24, and the client-side
 * re-bucketing that hid it was summing per-bucket `visitors`, which do not sum.
 */
describe('the public timeseries takes a resolution (ADR-0039, D8)', () => {
  /** Local midnight to local midnight: the range the whole defect is about. */
  const DAY = 'from=2026-07-22T00:00:00.000Z&to=2026-07-23T00:00:00.000Z&timezone=UTC'
  const dayUrl = (qs = '') => `http://api.test/v1/public/${SLUG}/timeseries?${DAY}${qs}`

  beforeEach(() => {
    share.value = sharedWith('shareTimeseries')
  })

  it('serves a full day at minute grain when the caller cannot name one', async () => {
    // The behaviour being fixed, pinned so nobody "tidies" the default away and
    // silently changes what an existing caller receives.
    const res = await buildApp().fetch(new Request(dayUrl()))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { meta: { resolution: string } }
    expect(body.meta.resolution).toBe('minute')
  })

  it('serves the same day at hour grain when asked', async () => {
    const res = await buildApp().fetch(new Request(dayUrl('&resolution=hour')))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { meta: { resolution: string } }
    // `meta.resolution` reports what was served, so a client never assumes.
    expect(body.meta.resolution).toBe('hour')
  })

  it('accepts every grain the private surface does, including week', async () => {
    // `week` is the second gap D8 closes: automatic selection never picks it at
    // any span, so a shared 12-month view could not match the owner's.
    for (const [grain, range] of [
      ['minute', DAY],
      ['hour', DAY],
      ['day', 'from=2026-01-01T00:00:00.000Z&to=2026-07-01T00:00:00.000Z&timezone=UTC'],
      ['week', 'from=2026-01-01T00:00:00.000Z&to=2026-07-01T00:00:00.000Z&timezone=UTC'],
    ] as const) {
      const res = await buildApp().fetch(
        new Request(`http://api.test/v1/public/${SLUG}/timeseries?${range}&resolution=${grain}`),
      )
      expect(res.status, grain).toBe(200)
      expect((await res.json()).meta.resolution, grain).toBe(grain)
    }
  })

  it('refuses a grain the range cannot honestly serve with RESOLUTION_NOT_AVAILABLE', async () => {
    // Six months at minute grain is far past the minute-rollup scan cap. This is
    // the distinction D8 insists on: the grain *exists*, it just cannot be
    // served for this range — which is a different fact from "no such grain",
    // and a caller that conflated them would retry the wrong thing.
    const res = await buildApp().fetch(
      new Request(
        `http://api.test/v1/public/${SLUG}/timeseries` +
          `?from=2026-01-01T00:00:00.000Z&to=2026-07-01T00:00:00.000Z&timezone=UTC&resolution=minute`,
      ),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; details: { reason: string } } }
    expect(body.error.code).toBe('RESOLUTION_NOT_AVAILABLE')
    // The reason names the cap it exceeded rather than saying "unavailable".
    expect(body.error.details.reason).toMatch(/minute/)
  })

  it('rejects a grain that does not exist as VALIDATION_FAILED, not RESOLUTION_NOT_AVAILABLE', async () => {
    const res = await buildApp().fetch(new Request(dayUrl('&resolution=fortnight')))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
  })

  it('does not leak the share behind a resolution error', async () => {
    // Authorization runs before the parameter is looked at, so a bad grain on a
    // slug that is not shared is still an indistinguishable 404 — a malformed
    // parameter must not become an oracle for which slugs exist.
    share.value = null
    const res = await buildApp().fetch(new Request(dayUrl('&resolution=fortnight')))
    expect(res.status).toBe(404)
  })

  it('is the only public read that accepts a resolution', async () => {
    // D8 is deliberately narrow. The other reads ignore the parameter rather
    // than acting on it — asserted so a future copy-paste is a failing test.
    share.value = sharedWith('shareOverview')
    const res = await buildApp().fetch(
      new Request(`http://api.test/v1/public/${SLUG}/overview?${DAY}&resolution=fortnight`),
    )
    expect(res.status).toBe(200)
  })
})

describe('public sessions drops what the private shape carries (ADR-0039, D4)', () => {
  beforeEach(() => {
    share.value = sharedWith('shareSessions')
  })

  it('the response has no `layering`, and the schema has no field for one', async () => {
    const res = await buildApp().fetch(new Request(url('sessions')))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>

    // `layering.finalized_through` is our session finalizer's watermark — a
    // statement about this pipeline's batch job, not a metric of the site — and
    // the §20 allowlist has no room for it. The private response carries it; the
    // public one must not.
    expect(body).not.toHaveProperty('layering')
    expect(Object.keys(body).sort()).toEqual(['meta', 'series', 'totals'])
  })

  it('withholding `layering` does not change a single number', async () => {
    const res = await buildApp().fetch(new Request(url('sessions')))
    const body = (await res.json()) as {
      totals: { sessions: number; bounce_rate: number; avg_session_duration_ms: number }
      series: { bucket: string; sessions: number }[]
    }
    // The finalizer watermark still split the range server-side and both layers
    // were read and merged — 20 sessions from the finalized rollup plus 20 from
    // the provisional facts, on the same bucket. Withholding the watermark
    // withholds the *report* of the split, not the split.
    expect(body.totals.sessions).toBe(40)
    expect(body.totals.bounce_rate).toBeCloseTo(0.4, 5)
    expect(body.totals.avg_session_duration_ms).toBe(30_000)
    expect(body.series).toHaveLength(1)
  })

  it('the contract schema rejects `layering` by name', async () => {
    const { readFile } = await import('node:fs/promises')
    const spec = await readFile('packages/contracts/openapi/openapi.yaml', 'utf8')
    const block = spec.slice(
      spec.indexOf('    PublicSessionsResponse:'),
      spec.indexOf('    FunnelStep:'),
    )
    expect(block).toContain('additionalProperties: false')
    expect(block).toMatch(/required: \[meta, totals, series\]/)
    // No `layering:` property key. Matched anchored, because the description
    // above it names the field on purpose — saying which field is withheld is
    // the point of the schema, and a bare substring search would read that
    // sentence as the field itself.
    expect(block).not.toMatch(/^\s+layering:/m)
    // The private one still declares it — this is a narrowing, not a removal.
    const privateBlock = spec.slice(
      spec.indexOf('    AnalyticsSessionsResponse:'),
      spec.indexOf('    PublicSessionsResponse:'),
    )
    expect(privateBlock).toMatch(/^\s+layering:/m)
  })
})

describe('public geography city privacy (G-008)', () => {
  beforeEach(() => {
    share.value = sharedWith('shareGeography')
  })

  it('suppresses all cities when the threshold is unset', async () => {
    const res = await buildApp({ cityMinVisitors: undefined }).fetch(new Request(geoUrl))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: { city: string | null; city_suppressed: boolean }[]
    }
    expect(body.items.every((r) => r.city === null && r.city_suppressed)).toBe(true)
  })

  it('names cities at or above the threshold once set', async () => {
    const res = await buildApp({ cityMinVisitors: 100 }).fetch(new Request(geoUrl))
    const body = (await res.json()) as { items: { city: string | null }[] }
    expect(body.items.some((r) => r.city === 'New York')).toBe(true)
    expect(body.items.some((r) => r.city === 'Smalltown')).toBe(false)
  })
})

describe('public rate limit', () => {
  it('429s past the per-window budget with a Retry-After', async () => {
    share.value = sharedWith('shareOverview')
    const app = buildApp({ perMinute: 1 })
    const first = await app.fetch(
      new Request(overviewUrl, { headers: { 'x-forwarded-for': '9.9.9.9' } }),
    )
    expect(first.status).toBe(200)
    const second = await app.fetch(
      new Request(overviewUrl, { headers: { 'x-forwarded-for': '9.9.9.9' } }),
    )
    expect(second.status).toBe(429)
    expect(second.headers.get('Retry-After')).toBeTruthy()
  })

  it('the eight reads of one page load share one (IP, slug) budget', async () => {
    // ADR-0039 D5, moved by one in ADR-0044: the limiter counts requests, not
    // page loads. A share page that fans out to every surface now spends eight
    // of its budget on one paint — seven analytics reads plus the site-identity
    // read — which is the arithmetic both ADRs record, pinned so it cannot
    // drift unnoticed.
    const app = buildApp({ perMinute: 8 })
    const headers = { 'x-forwarded-for': '7.7.7.7' }
    for (const [surface, flag] of SURFACES) {
      share.value = sharedWith(flag)
      const res = await app.fetch(new Request(url(surface), { headers }))
      expect(res.status).toBe(200)
    }
    share.value = sharedWith('shareOverview')
    const siteRead = await app.fetch(new Request(siteUrl(), { headers }))
    expect(siteRead.status).toBe(200)

    const ninth = await app.fetch(new Request(overviewUrl, { headers }))
    expect(ninth.status).toBe(429)
  })
})

/**
 * The public site-identity read (ADR-0044).
 *
 * Not an analytics read: no range, no gateway operation, no `meta`. What is
 * worth pinning is the key set per state — because the whole design is that two
 * of the four fields are **absent** rather than null when identity is not
 * published — and that the route is not an existence probe for a slug whose
 * board publishes nothing.
 */
describe('GET /v1/public/{slug}/site (ADR-0044)', () => {
  beforeEach(() => {
    share.value = null
    identity.value = {
      displayName: 'Acme Metrics',
      faviconDomain: 'acme.example',
      reportingTimezone: 'Europe/Istanbul',
      firstEventAt: new Date('2026-06-02T08:14:09.221Z'),
    }
  })

  it('serves the render facts and NOTHING else while share_identity is off', async () => {
    // A live board — one surface published — with identity withheld. Asserted on
    // the exact key set rather than on two absences, because the failure this
    // guards against is a field arriving by inheritance: a `...identity` spread
    // in the route would pass an absence check for the two names it knows.
    share.value = sharedWith('sharePages')
    const res = await buildApp().fetch(new Request(siteUrl()))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>

    expect(Object.keys(body).sort()).toEqual(['first_event_at', 'reporting_timezone'])
    // Absent, not null. A present-and-null `display_name` says "this site has no
    // name", which is false and is a different statement from "you may not
    // know" (ADR-0044, D1).
    expect(body).not.toHaveProperty('display_name')
    expect(body).not.toHaveProperty('favicon_domain')
    expect(JSON.stringify(body)).not.toContain('Acme')
    // And the render facts are really there: an anonymous share still has to cut
    // its buckets in the owner's clock and anchor "All time".
    expect(body['reporting_timezone']).toBe('Europe/Istanbul')
    expect(body['first_event_at']).toBe('2026-06-02T08:14:09.221Z')
  })

  it('adds exactly the identity pair when share_identity is on', async () => {
    share.value = { ...sharedWith('sharePages'), shareIdentity: true }
    const res = await buildApp().fetch(new Request(siteUrl()))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>

    expect(Object.keys(body).sort()).toEqual([
      'display_name',
      'favicon_domain',
      'first_event_at',
      'reporting_timezone',
    ])
    expect(body['display_name']).toBe('Acme Metrics')
    expect(body['favicon_domain']).toBe('acme.example')
  })

  it('the two render facts are required-and-nullable, so null is a statement', async () => {
    // A site with no allowlist, no configured zone and no event ever ingested.
    // Every key is still present: `null` means "not configured" / "none has",
    // never "unknown", which is the ADR-0027 convention this response follows.
    share.value = { ...sharedWith('sharePages'), shareIdentity: true }
    identity.value = {
      displayName: 'Acme Metrics',
      faviconDomain: null,
      reportingTimezone: null,
      firstEventAt: null,
    }
    const res = await buildApp().fetch(new Request(siteUrl()))
    const body = (await res.json()) as Record<string, unknown>

    expect(body['reporting_timezone']).toBeNull()
    expect(body['first_event_at']).toBeNull()
    expect(body['favicon_domain']).toBeNull()
  })

  it('a wrong slug, a closed share and an identity-only share are byte-identical 404s', async () => {
    // ADR-0044 D2. The third case is the one this predicate exists for: an
    // enabled share whose only open flag is `share_identity` publishes no board,
    // so answering here would make this the cheapest existence probe on the
    // whole public surface — the thing the other seven reads are built not to
    // be.
    const app = buildApp()

    share.value = null
    const wrong = await app.fetch(new Request(siteUrl(WRONG_SLUG)))

    share.value = { siteId: SITE, siteStatus: 'active', enabled: true, ...ALL_OFF }
    const nothingShared = await app.fetch(new Request(siteUrl()))

    share.value = {
      siteId: SITE,
      siteStatus: 'active',
      enabled: true,
      ...ALL_OFF,
      shareIdentity: true,
    }
    const identityOnly = await app.fetch(new Request(siteUrl()))

    const wrongBody = withoutRequestId(await wrong.json())
    for (const [label, res] of [
      ['nothing shared', nothingShared],
      ['identity only', identityOnly],
    ] as const) {
      expect(res.status, label).toBe(404)
      expect(res.status, label).toBe(wrong.status)
      expect(res.headers.get('content-type'), label).toBe(wrong.headers.get('content-type'))
      expect(withoutRequestId(await res.json()), label).toEqual(wrongBody)
    }
  })

  it('is closed while the site is suspended, like every other public read', async () => {
    share.value = {
      ...sharedWith('sharePages'),
      siteStatus: 'suspended',
      shareIdentity: true,
    }
    const res = await buildApp().fetch(new Request(siteUrl()))
    expect(res.status).toBe(404)
  })

  it('carries no analytics envelope at all', async () => {
    // It describes the site, not a query, which is exactly ADR-0039 D9's reason
    // for refusing to hang these fields off `AnalyticsMeta`. A `meta` here would
    // mean that refusal had been quietly undone.
    share.value = { ...sharedWith('shareOverview'), shareIdentity: true }
    const res = await buildApp().fetch(new Request(siteUrl()))
    const body = (await res.json()) as Record<string, unknown>
    expect(body).not.toHaveProperty('meta')
    expect(JSON.stringify(body)).not.toContain('freshness')
  })

  it('the contract declares the pair optional and the render facts required', async () => {
    const { readFile } = await import('node:fs/promises')
    const spec = await readFile('packages/contracts/openapi/openapi.yaml', 'utf8')
    const start = spec.indexOf('\n    PublicSiteIdentity:\n')
    expect(start, 'PublicSiteIdentity must exist').toBeGreaterThan(-1)
    const next = spec.slice(start + 1).search(/\n {4}[A-Za-z0-9_]+:\n/)
    const block = spec.slice(start, next === -1 ? undefined : start + 1 + next)

    expect(block).toContain('additionalProperties: false')
    // Optionality is the contract's half of "absent, never null": a required
    // `display_name` would force the flag-off response to send a key it must
    // not, and a generated client would then type it as always present.
    expect(block).toContain('required: [reporting_timezone, first_event_at]')
    expect(block).toMatch(/^\s+display_name:/m)
    expect(block).toMatch(/^\s+favicon_domain:/m)
    // No analytics envelope on this schema, per ADR-0039 D9.
    expect(block).not.toContain('PublicAnalyticsMeta')

    expect(spec).toContain('operationId: getPublicSiteIdentity')
    expect(spec).toContain('/v1/public/{share_slug}/site:')
  })
})

/**
 * `meta.freshness` does not cross the public boundary (ADR-0039, D10).
 *
 * The same argument D4 applied to `layering`, one level up. `freshness.state`
 * is our ingest pipeline's health — the worker heartbeat and the queue age
 * (ADR-0025, whose title is "freshness measures the pipeline, not the site's
 * last visitor") — so publishing it makes every share link an unauthenticated
 * probe of our own lag. `freshness.watermark` is worse on this surface than
 * `layering` was: `analytics.freshness` is `max(bucket_start) FROM metrics_1m
 * WHERE site_id = …` with **no range filter**, so it answers "when did this
 * site last have a visitor", to the minute, for all time — including now, and
 * including outside the window the share is showing.
 */
describe('the public surface carries no pipeline metadata (ADR-0039, D10)', () => {
  it.each(SURFACES)('%s answers without meta.freshness', async (surface, flag) => {
    share.value = sharedWith(flag)
    const res = await buildApp().fetch(new Request(url(surface)))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { meta: Record<string, unknown> }

    expect(body.meta).not.toHaveProperty('freshness')
    // Not a `revenue` block either: revenue is owner-only behind `revenue:read`
    // and structurally unreachable through a slug, so the type omits it.
    expect(body.meta).not.toHaveProperty('revenue')
    // And the string appears nowhere in the payload, which also catches a row
    // or a total that started carrying it.
    expect(JSON.stringify(body)).not.toContain('freshness')
    expect(JSON.stringify(body)).not.toContain('watermark')
  })

  it.each(SURFACES)('%s still describes the query it answered', async (surface, flag) => {
    // The narrowing must not have taken the useful half with it: everything
    // that describes *the query* stays, which is what `AnalyticsMeta` is for
    // (ADR-0039 D9). A meta stripped to nothing would pass the test above.
    share.value = sharedWith(flag)
    const res = await buildApp().fetch(new Request(url(surface)))
    const body = (await res.json()) as { meta: Record<string, unknown> }

    expect(Object.keys(body.meta).sort()).toEqual([
      'accuracy',
      'cached',
      'comparison_range',
      'data_sources',
      'effective_range',
      'partial',
      'requested_range',
      'resolution',
      'timezone',
      'truncated',
    ])
  })

  it('the contract schema has no field for it, and the private one still does', async () => {
    const { readFile } = await import('node:fs/promises')
    const spec = await readFile('packages/contracts/openapi/openapi.yaml', 'utf8')

    const publicBlock = spec.slice(
      spec.indexOf('    PublicAnalyticsMeta:'),
      spec.indexOf('    OverviewTotals:'),
    )
    // Anchored: the description above deliberately names the field it withholds
    // and says why, and a bare substring search would read that sentence as the
    // property itself — the same trap the `layering` assertion documents.
    expect(publicBlock).not.toMatch(/^\s+freshness:/m)
    expect(publicBlock).not.toMatch(/^\s+revenue:/m)
    expect(publicBlock).toContain('additionalProperties: false')

    // A narrowing, not a removal: the authenticated surface is unchanged.
    const privateBlock = spec.slice(
      spec.indexOf('    AnalyticsMeta:'),
      spec.indexOf('    PublicAnalyticsMeta:'),
    )
    expect(privateBlock).toMatch(/^\s+freshness:/m)

    // Every public response points at the narrow meta. Listed by name rather
    // than discovered, so adding a public read without narrowing its envelope
    // fails here instead of shipping.
    for (const schema of [
      'PublicOverviewResponse',
      'PublicGeographyResponse',
      'PublicTimeseriesResponse',
      'PublicSessionsResponse',
      'PublicPagesResponse',
      'PublicSourcesResponse',
      'PublicDevicesResponse',
    ]) {
      const start = spec.indexOf(`\n    ${schema}:\n`)
      expect(start, `${schema} must exist`).toBeGreaterThan(-1)
      // To the next schema heading — a line of exactly four spaces, a name and
      // a colon. Slicing by a byte offset would cut mid-block on a long
      // description and pass by accident.
      const next = spec.slice(start + 1).search(/\n {4}[A-Za-z0-9_]+:\n/)
      const block = spec.slice(start, next === -1 ? undefined : start + 1 + next)
      expect(block, `${schema} must use PublicAnalyticsMeta`).toContain(
        "$ref: '#/components/schemas/PublicAnalyticsMeta'",
      )
      expect(block, `${schema} must not use AnalyticsMeta`).not.toContain(
        "$ref: '#/components/schemas/AnalyticsMeta'",
      )
    }
  })
})
