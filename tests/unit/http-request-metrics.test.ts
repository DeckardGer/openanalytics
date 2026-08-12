import { createRecordingMetrics, createServiceMetadata } from '@openanalytics/observability'
import { createServiceApp } from '@openanalytics/observability/hono'
import { createCapturedLogger } from '@openanalytics/testkit'
import { describe, expect, it } from 'vitest'

/**
 * Generic per-request counters emitted by the shared middleware (ADR-0016).
 *
 * `createServiceApp` already logs one `http_request` line per request; when a
 * `Metrics` sink is wired it also increments `http_requests` (and `http_errors`
 * on a 5xx), labelled by the *matched route pattern* — never the concrete path,
 * which would be unbounded cardinality. This proves the labels, the 5xx split,
 * the pattern-not-path invariant, and that a bare app (no metrics) still serves.
 */

const meta = createServiceMetadata({ name: 'api', version: '1.0.0', environment: 'test' })

function buildApp(metrics?: ReturnType<typeof createRecordingMetrics>) {
  const { logger } = createCapturedLogger()
  const app = createServiceApp({ service: meta, logger, ...(metrics ? { metrics } : {}) })
  app.get('/v1/sites/:site_id/analytics/overview', (c) => c.json({ ok: true }))
  app.get('/v1/boom', () => {
    throw new Error('kaboom')
  })
  return app
}

describe('http request metrics middleware', () => {
  it('increments http_requests with route pattern, method and 2xx on success', async () => {
    const metrics = createRecordingMetrics()
    const app = buildApp(metrics)

    const response = await app.request('/v1/sites/abc/analytics/overview')
    expect(response.status).toBe(200)

    const requests = metrics.recorded.filter((m) => m.name === 'http_requests')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.labels).toEqual({
      route: '/v1/sites/:site_id/analytics/overview',
      method: 'GET',
      status_class: '2xx',
    })
    // A success is never an error.
    expect(metrics.countOf('http_errors')).toBe(0)
  })

  it('increments both http_requests and http_errors on a 5xx', async () => {
    const metrics = createRecordingMetrics()
    const app = buildApp(metrics)

    const response = await app.request('/v1/boom')
    expect(response.status).toBe(500)

    expect(metrics.countOf('http_requests')).toBe(1)
    expect(metrics.countOf('http_errors')).toBe(1)
    const error = metrics.recorded.find((m) => m.name === 'http_errors')
    expect(error?.labels).toEqual({ route: '/v1/boom', method: 'GET', status_class: '5xx' })
  })

  it('labels by the matched pattern, not the concrete path', async () => {
    const metrics = createRecordingMetrics()
    const app = buildApp(metrics)

    // Two different ids collapse onto the one route series — a concrete-path
    // label would make this two unbounded series instead of a count of 2.
    await app.request('/v1/sites/one/analytics/overview')
    await app.request('/v1/sites/two/analytics/overview')

    const routes = metrics.recorded
      .filter((m) => m.name === 'http_requests')
      .map((m) => m.labels['route'])
    expect(routes).toEqual([
      '/v1/sites/:site_id/analytics/overview',
      '/v1/sites/:site_id/analytics/overview',
    ])
    expect(metrics.countOf('http_requests')).toBe(2)
  })

  it('serves normally when no metrics sink is wired', async () => {
    const app = buildApp()

    const ok = await app.request('/v1/sites/abc/analytics/overview')
    expect(ok.status).toBe(200)

    // A thrown handler with no metrics must still resolve to the error envelope,
    // never crash the request path.
    const boom = await app.request('/v1/boom')
    expect(boom.status).toBe(500)
  })
})
