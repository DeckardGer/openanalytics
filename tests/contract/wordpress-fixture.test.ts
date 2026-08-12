import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadServiceEnv } from '@openanalytics/domain'
import type { Database } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import type { AnalyticsGateway } from '../../apps/api/src/gateway-client.ts'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * The WordPress integration fixture (plan 04 §Milestone 14 item 4).
 *
 * `docs/wordpress/fixtures.json` is not hand-written. It is **recorded from the
 * real app** — the same routes, the same middleware, the same response
 * builders — and this test replays the recording and fails if the API's answers
 * have moved. A hand-written example is a second source of truth that drifts on
 * the first response change and misleads the plugin author who trusted it.
 *
 * The numbers are synthetic: the query gateway is stubbed with fixed rows, so
 * the shapes are real and the values are not. That is what a fixture is for.
 *
 * To re-record after a deliberate contract change:
 *
 *     UPDATE_WORDPRESS_FIXTURE=1 npx vitest run tests/contract/wordpress-fixture.test.ts --project contract
 *
 * and read the diff before committing it — a diff here is a change every plugin
 * built against this file will see.
 */

const FIXTURE_PATH = fileURLToPath(new URL('../../docs/wordpress/fixtures.json', import.meta.url))

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const KEY = 'oa_sk_ZmFrZS10ZXN0LWtleQ'
const RANGE = 'from=2026-07-16T00:00:00.000Z&to=2026-07-23T00:00:00.000Z&timezone=UTC'

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    resolveReadApiKey: async () => ({
      id: 'key-1',
      siteId: SITE,
      type: 'private_read',
      scopes: ['site:read', 'analytics:read'],
    }),
    getSiteBasics: async () => ({
      siteId: SITE,
      slug: 'shop',
      name: 'Shop',
      status: 'active',
      configVersion: 3,
      publishedImportRunId: null,
      importCutoverDate: null,
      reportingCurrency: 'USD',
    }),
    getFinalizerState: async () => ({ finalizedThrough: new Date('2026-07-22T00:00:00.000Z') }),
    getLiveTrackingToken: async () => 'oa_pk_EXAMPLE',
    touchApiKeyUsage: async () => ({ touched: true }),
    // The cost ledger (ADR-0043 D7): under budget, and the charge goes nowhere.
    // The fixture records what a plugin actually receives, and the ledger
    // changes none of that — but an unstubbed one turns every recorded body into
    // an INTERNAL_ERROR, which is how this file caught the omission.
    readCostSpent: async () => 0,
    chargeReadCost: async () => {},
  }
})

const { createApp } = await import('../../apps/api/src/app.ts')
const { AnalyticsService } = await import('../../apps/api/src/analytics/service.ts')

/**
 * Fixed gateway rows, chosen per operation family so every response has
 * something in it. A fixture full of empty arrays documents nothing.
 */
function stubRows(operation: string): Record<string, string>[] {
  if (operation === 'analytics.freshness') {
    return [{ watermark: '2026-07-23 00:00:00.000', buckets: '168' }]
  }
  if (operation.startsWith('analytics.sessions_')) {
    return [
      {
        bucket: '2026-07-16 00:00:00',
        sessions: '420',
        engaged_sessions: '310',
        bounced_sessions: '110',
        pageviews: '980',
        total_session_duration_ms: '52000000',
        total_engagement_ms: '31000000',
        visitors: '380',
      },
    ]
  }
  if (operation.startsWith('analytics.timeseries')) {
    return [{ bucket: '2026-07-16 00:00:00', events: '1200', pageviews: '980', visitors: '380' }]
  }
  if (operation.startsWith('analytics.pages')) {
    return [{ page_path: '/pricing', views: '310', visitors: '260' }]
  }
  if (operation.startsWith('analytics.sources')) {
    return [
      {
        referrer_domain: 'google.com',
        utm_source: '',
        utm_medium: '',
        utm_campaign: '',
        views: '240',
        visitors: '210',
      },
    ]
  }
  if (operation.startsWith('analytics.geography')) {
    return [{ country: 'AZ', city: 'Baku', views: '190', visitors: '150' }]
  }
  if (operation.startsWith('analytics.devices')) {
    return [
      {
        device_type: 'desktop',
        browser: 'Chrome',
        os: 'Windows',
        views: '600',
        visitors: '410',
      },
    ]
  }
  return [{ events: '1200', pageviews: '980', visitors: '380', billable_events: '1150' }]
}

function buildApp() {
  const gateway: AnalyticsGateway = {
    query: <TRow = Record<string, unknown>>(operation: string) => {
      const rows = stubRows(operation)
      return Promise.resolve({
        operation,
        rows: rows as unknown as readonly TRow[],
        meta: { row_count: rows.length, truncated: false, elapsed_ms: 1, cached: false },
      })
    },
  }
  const { logger } = createCapturedLogger()
  return createApp({
    service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
    logger,
    env: loadServiceEnv('api', { ...testEnv(), COLLECTOR_BASE_URL: 'https://c.getopen.so' }),
    db: {} as Database,
    analytics: new AnalyticsService(gateway),
  })
}

const REQUESTS: readonly { readonly name: string; readonly path: string }[] = [
  { name: 'site', path: '/v1/read/site' },
  { name: 'overview', path: `/v1/read/analytics/overview?${RANGE}&resolution=day` },
  { name: 'timeseries', path: `/v1/read/analytics/timeseries?${RANGE}&resolution=day` },
  { name: 'pages', path: `/v1/read/analytics/pages?${RANGE}&limit=5` },
  { name: 'sources', path: `/v1/read/analytics/sources?${RANGE}&limit=5` },
  { name: 'geography', path: `/v1/read/analytics/geography?${RANGE}&limit=5` },
  { name: 'devices', path: `/v1/read/analytics/devices?${RANGE}&limit=5` },
  { name: 'sessions', path: `/v1/read/analytics/sessions?${RANGE}` },
]

async function record(): Promise<Record<string, unknown>> {
  const app = buildApp()
  const responses: Record<string, unknown> = {}
  for (const request of REQUESTS) {
    const response = await app.fetch(
      new Request(`http://api.test${request.path}`, {
        headers: { authorization: `Bearer ${KEY}` },
      }),
    )
    responses[request.name] = {
      request: `GET ${request.path}`,
      status: response.status,
      body: await response.json(),
    }
  }
  return {
    $comment:
      'Recorded from the real app by tests/contract/wordpress-fixture.test.ts. Shapes are real; ' +
      'numbers are synthetic. Do not hand-edit — re-record with UPDATE_WORDPRESS_FIXTURE=1.',
    responses,
  }
}

describe('the WordPress integration fixture', () => {
  /**
   * `meta.freshness.as_of` is stamped with the wall clock, so a recording made
   * now and a recording made a second later differ in one field and the file
   * would be permanently dirty. Only `Date` is faked — faking timers as well
   * would stall the awaits below.
   */
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-23T09:00:00.000Z'))
  })
  afterAll(() => {
    vi.useRealTimers()
  })

  it('matches what the API actually answers', async () => {
    const recorded = await record()

    if (process.env['UPDATE_WORDPRESS_FIXTURE']) {
      await writeFile(FIXTURE_PATH, `${JSON.stringify(recorded, null, 2)}\n`, 'utf8')
    }

    const committed = JSON.parse(await readFile(FIXTURE_PATH, 'utf8')) as Record<string, unknown>
    expect(committed).toEqual(recorded)
  })

  it('records a successful answer for every documented read', async () => {
    const committed = JSON.parse(await readFile(FIXTURE_PATH, 'utf8')) as {
      responses: Record<string, { status: number }>
    }
    expect(Object.keys(committed.responses).sort()).toEqual(
      REQUESTS.map((request) => request.name).sort(),
    )
    for (const [name, entry] of Object.entries(committed.responses)) {
      expect(entry.status, name).toBe(200)
    }
  })
})
