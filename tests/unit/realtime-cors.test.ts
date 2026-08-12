import { generateKeyPairSync } from 'node:crypto'
import { healthResponseSchema } from '@openanalytics/contracts'
import { loadServiceEnv } from '@openanalytics/domain'
import { loadRealtimeVerifyKey } from '@openanalytics/auth'
import type { RealtimeCache } from '@openanalytics/redis'
import { createServiceMetadata, createRecordingMetrics } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../apps/realtime/src/app.ts'
import type { RealtimeSubscriber } from '../../apps/realtime/src/subscriber.ts'

/**
 * Public CORS on the SSE stream surface.
 *
 * The failure this pins was structural, and invisible from the server: the
 * gateway had no CORS middleware and no `OPTIONS` route. The scoped token rides
 * in an `Authorization` header (D-213), which is not CORS-safelisted — so every
 * browser connection preflights, the preflight got a CORS-header-less 404, and
 * the browser refused to open the stream from *any* cross-origin page,
 * production dashboard included. Tokens minted fine; `curl` streamed fine; only
 * the browser knew.
 *
 * The policy is the collector's, not the api's: wildcard origin and no
 * `Access-Control-Allow-Credentials` ever. Nothing ambient exists on this
 * surface — no cookie, default credentials mode — and the bearer token is
 * explicit script-held state whose real authorization (scoped claims, TTL,
 * epoch re-check) the gateway enforces on connect. See
 * `apps/realtime/src/cors.ts` for the full argument.
 *
 * The doubles are deliberately minimal: under test are response headers and the
 * `OPTIONS` answer, not stream behaviour, which `realtime-gateway.test.ts` owns.
 */

const { publicKey } = generateKeyPairSync('ed25519')
const VERIFY_KEY = loadRealtimeVerifyKey(
  publicKey.export({ type: 'spki', format: 'pem' }).toString(),
)

const PAGE_ORIGIN = 'http://localhost:3000'
const STREAM_PATH = '/v1/realtime/stream'

/** Never reached: a malformed bearer is rejected before any cache call. */
const cache = {
  getEpoch: () => Promise.reject(new Error('cache must not be consulted')),
  readPresenceSnapshot: () => Promise.reject(new Error('cache must not be consulted')),
} as unknown as RealtimeCache

const subscriber: RealtimeSubscriber = {
  subscribe: () => Promise.resolve(),
  unsubscribe: () => Promise.resolve(),
  onMessage: () => undefined,
  close: () => Promise.resolve(),
}

function build(withStream: boolean) {
  const captured = createCapturedLogger()
  const { app } = createApp({
    service: createServiceMetadata({ name: 'realtime', version: 't', environment: 'test' }),
    logger: captured.logger,
    env: loadServiceEnv('realtime', testEnv({})),
    metrics: createRecordingMetrics(),
    ...(withStream ? { cache, subscriber, verifyKey: VERIFY_KEY } : {}),
  })
  return app
}

function preflight(app: ReturnType<typeof build>, headers: string) {
  return app.request(STREAM_PATH, {
    method: 'OPTIONS',
    headers: {
      origin: PAGE_ORIGIN,
      'access-control-request-method': 'GET',
      'access-control-request-headers': headers,
    },
  })
}

describe('realtime CORS', () => {
  it('answers the stream preflight and advertises authorization and last-event-id', async () => {
    // `use-realtime.ts` sends exactly these non-safelisted headers: the token on
    // every connect, the resume id on every reconnect.
    const response = await preflight(build(true), 'authorization, last-event-id')

    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    // Never sent, not even as `false`. Its absence is what makes `*` legal.
    expect(response.headers.get('access-control-allow-credentials')).toBeNull()

    const headers = (response.headers.get('access-control-allow-headers') ?? '').toLowerCase()
    expect(headers).toContain('authorization')
    expect(headers).toContain('last-event-id')

    const methods = response.headers.get('access-control-allow-methods') ?? ''
    for (const method of ['GET', 'OPTIONS']) expect(methods).toContain(method)

    expect(Number(response.headers.get('access-control-max-age'))).toBeGreaterThan(0)
  })

  it('lets the browser read a rejected connect, so 401 means access_lost, not a network error', async () => {
    // Without the wildcard on the *response*, a browser turns the gateway's
    // typed 401 into an opaque TypeError and `use-realtime.ts` retries a token
    // that will never work instead of reporting `access_lost`.
    const response = await build(true).request(STREAM_PATH, {
      headers: {
        origin: PAGE_ORIGIN,
        accept: 'text/event-stream',
        authorization: 'Bearer not-a-token',
      },
    })

    expect(response.status).toBe(401)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-allow-credentials')).toBeNull()
  })

  it('answers the preflight even when the stream did not mount', async () => {
    // An unmounted gateway must fail readably: the preflight succeeds, the GET
    // 404s with the wildcard, and the hook can tell "gone" from "network".
    const response = await preflight(build(false), 'authorization')

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('leaves a bare OPTIONS to the router: it is not a preflight', async () => {
    const response = await build(true).request(STREAM_PATH, {
      method: 'OPTIONS',
      headers: { origin: PAGE_ORIGIN },
    })

    expect(response.status).toBe(404)
  })

  it('leaves /health exactly as it was', async () => {
    // `/health` is an operator endpoint that no browser calls; the middleware is
    // mounted after it on purpose, and this is the check of that order.
    const response = await build(true).request('/health')

    expect(response.status).toBe(200)
    const body = healthResponseSchema.parse(await response.json())
    expect(body.service).toBe('realtime')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })
})
