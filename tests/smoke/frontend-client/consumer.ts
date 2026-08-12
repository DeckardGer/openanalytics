/**
 * Frontend smoke consumer (plan Milestone 7 item 10; acceptance criterion 5:
 * "the generated client builds in the frontend smoke project").
 *
 * This file stands in for `apps/web` — which this checkpoint must not touch — as
 * a consumer that sees ONLY the published `@openanalytics/contracts` artifact
 * (resolved here against the built `dist`, exactly as the frontend resolves the
 * package; D-218 forbids the frontend importing backend source). It exercises the
 * generated client and types the way a dashboard would, so it fails to compile if
 * the generated client has drifted from the OpenAPI document or a response shape
 * is wrong. It is a *type* check — nothing here runs — and it is kept dependency-
 * free (browser-runnable), matching the client's own contract.
 *
 * `pnpm run contracts:smoke` type-checks this against the built package.
 */

import {
  OpenAnalyticsClient,
  ANALYTICS_FIXTURES,
  analyticsOverviewFixture,
  type components,
  type paths,
} from '@openanalytics/contracts'

type Schemas = components['schemas']

const client = new OpenAnalyticsClient({ baseUrl: 'https://api.example.com' })

// The generated path map must carry the M7 read endpoints with typed responses.
type OverviewResponse =
  paths['/v1/sites/{site_id}/analytics/overview']['get']['responses']['200']['content']['application/json']
type TimeseriesResponse =
  paths['/v1/sites/{site_id}/analytics/timeseries']['get']['responses']['200']['content']['application/json']
type PublicGeographyResponse =
  paths['/v1/public/{share_slug}/geography']['get']['responses']['200']['content']['application/json']

async function loadOverview(siteId: string): Promise<OverviewResponse> {
  const query = new URLSearchParams({
    from: '2026-07-01T00:00:00.000Z',
    to: '2026-07-08T00:00:00.000Z',
    timezone: 'America/New_York',
    compare: 'true',
  })
  return client.get<OverviewResponse>(`/v1/sites/${siteId}/analytics/overview?${query.toString()}`)
}

// A "render" function that only compiles if the response fields are exactly the
// contract's — the sort of code a dashboard component would contain.
function renderOverview(res: OverviewResponse): string {
  const delta =
    res.comparison === null
      ? 'no comparison'
      : `${res.totals.visitors - res.comparison.totals.visitors} vs previous period`
  const freshness: Schemas['FreshnessState'] = res.meta.freshness.state
  return `${res.totals.pageviews} pageviews (${delta}); data ${freshness}; range ${res.meta.effective_range.from}`
}

function renderSeries(res: TimeseriesResponse): number {
  return res.series.reduce((sum, point) => sum + point.events, 0)
}

function renderPublicGeography(res: PublicGeographyResponse): string[] {
  return res.items.map((row) =>
    row.city_suppressed ? `${row.country} (other cities)` : `${row.city}`,
  )
}

// The typed fixtures the frontend mocks against must line up with those types.
const overview: OverviewResponse = analyticsOverviewFixture
const timeseries: TimeseriesResponse = ANALYTICS_FIXTURES.getAnalyticsTimeseries
const publicGeo: PublicGeographyResponse = ANALYTICS_FIXTURES.getPublicGeography

// Reference everything so the checker treats it all as used.
export const smoke = {
  loadOverview,
  renderOverview: () => renderOverview(overview),
  renderSeries: () => renderSeries(timeseries),
  renderPublicGeography: () => renderPublicGeography(publicGeo),
}
