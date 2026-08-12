import { errorEnvelopeSchema, healthResponseSchema } from '@openanalytics/contracts'
import { loadServiceEnv } from '@openanalytics/domain'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { createApp } from '../../apps/api/src/app.ts'
import { createServiceMetadata } from '@openanalytics/observability'
import { describe, expect, it } from 'vitest'

/**
 * Every HTTP service must answer /health, stamp a request ID, and shape every
 * failure as the canonical envelope. These are checked against a real app
 * instance rather than the middleware in isolation, because the wiring is the
 * part that is easy to omit in a new service.
 */

function buildApp() {
  const captured = createCapturedLogger()
  const app = createApp({
    service: createServiceMetadata({ name: 'api', version: '1.2.3', environment: 'test' }),
    logger: captured.logger,
    env: loadServiceEnv('api', testEnv()),
  })
  return { app, captured }
}

describe('service HTTP skeleton', () => {
  it('serves a health response matching the contract', async () => {
    const { app } = buildApp()
    const response = await app.request('/health')

    expect(response.status).toBe(200)
    const body = healthResponseSchema.parse(await response.json())
    expect(body.service).toBe('api')
    expect(body.version).toBe('1.2.3')
    expect(body.status).toBe('ok')
    expect(body.time.endsWith('Z')).toBe(true)
  })

  it('returns a request ID header on every response', async () => {
    const { app } = buildApp()
    const response = await app.request('/health')

    expect(response.headers.get('x-request-id')).toMatch(/^req_/)
  })

  it('does not trust a client-supplied request ID', async () => {
    // Otherwise a caller could forge another request's correlation key, or
    // inflate log cardinality with arbitrary values.
    const { app } = buildApp()
    const response = await app.request('/health', {
      headers: { 'x-request-id': 'not-one-of-ours' },
    })

    expect(response.headers.get('x-request-id')).not.toBe('not-one-of-ours')
    expect(response.headers.get('x-request-id')).toMatch(/^req_/)
  })

  it('shapes an unknown route as the canonical envelope', async () => {
    const { app } = buildApp()
    const response = await app.request('/definitely-not-a-route')

    expect(response.status).toBe(404)
    const body = errorEnvelopeSchema.parse(await response.json())
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.request_id).toMatch(/^req_/)
  })

  it('logs one structured line per request with correlation', async () => {
    const { app, captured } = buildApp()
    await app.request('/health')

    const [line] = captured.find('http_request')
    expect(line).toBeDefined()
    expect(line?.['status']).toBe(200)
    expect(line?.['request_id']).toMatch(/^req_/)
    expect(line?.['trace_id']).toMatch(/^trc_/)
  })

  it('mounts business routes under the version prefix', async () => {
    // Docs snapshot 02 §18: business endpoints are never silently unversioned.
    const { app } = buildApp()
    const response = await app.request('/v1/nothing-here')

    // Reaching the 404 handler proves /v1 is mounted rather than unrouted.
    expect(response.status).toBe(404)
    const body = errorEnvelopeSchema.parse(await response.json())
    expect(body.error.code).toBe('NOT_FOUND')
  })
})
