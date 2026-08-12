import { loadServiceEnv } from '@openanalytics/domain'
import type { Auth } from '@openanalytics/auth'
import type { Database } from '@openanalytics/postgres'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../apps/api/src/app.ts'
import { parseTrustedOrigins } from '../../apps/api/src/http/cors.ts'

/**
 * Credentialed CORS, without any infrastructure.
 *
 * The failure this pins was observed live: `api.getopen.so` returned no CORS
 * header at all and a preflight `OPTIONS /v1/sites` answered 401, so a browser
 * on `https://app.getopen.so` could not make a single call. Docs snapshot 03 §7
 * decides the rule — credentialed CORS answers only the exact app origin — and
 * these assertions are that rule.
 *
 * A stub auth that never returns a session is enough: everything under test is
 * decided before the session middleware, and the preflight case is specifically
 * about *not* reaching it.
 */

const APP_ORIGIN = 'https://app.getopen.so'
const OTHER_ORIGIN = 'https://evil.example.com'

const auth = {
  api: { getSession: async () => null },
  handler: async () => new Response(null),
} as unknown as Auth
const db = {} as Database

function buildApp(trustedOrigins: string | undefined) {
  const { logger } = createCapturedLogger()
  return createApp({
    service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
    logger,
    env: loadServiceEnv(
      'api',
      testEnv(trustedOrigins === undefined ? {} : { AUTH_TRUSTED_ORIGINS: trustedOrigins }),
    ),
    auth,
    db,
  })
}

const app = buildApp(`${APP_ORIGIN},https://staging.getopen.so`)
const closedApp = buildApp(undefined)

const get = (target: ReturnType<typeof buildApp>, path: string, origin?: string) =>
  target.fetch(
    new Request(`https://api.test${path}`, {
      headers: origin === undefined ? {} : { origin },
    }),
  )

const preflight = (target: ReturnType<typeof buildApp>, path: string, origin: string) =>
  target.fetch(
    new Request(`https://api.test${path}`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,idempotency-key',
      },
    }),
  )

describe('parseTrustedOrigins', () => {
  it('is the one definition of how AUTH_TRUSTED_ORIGINS is read', () => {
    expect(parseTrustedOrigins(` ${APP_ORIGIN} , https://b.example.com `)).toEqual([
      APP_ORIGIN,
      'https://b.example.com',
    ])
    // An unset or empty variable is an empty allowlist, never a list containing
    // the empty string — which a naive comparison could match.
    expect(parseTrustedOrigins(undefined)).toEqual([])
    expect(parseTrustedOrigins('')).toEqual([])
    expect(parseTrustedOrigins(',  ,')).toEqual([])
  })
})

describe('credentialed CORS', () => {
  it('echoes the exact allowed origin with credentials, never a wildcard', async () => {
    const res = await get(app, '/v1/sites', APP_ORIGIN)
    expect(res.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN)
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    // A wildcard is invalid with credentials; a browser rejects the pair.
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*')
  })

  it('emits no CORS header at all for an origin that is not on the list', async () => {
    const res = await get(app, '/v1/sites', OTHER_ORIGIN)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(res.headers.get('access-control-allow-credentials')).toBeNull()
  })

  it('fails closed when no origins are configured', async () => {
    const res = await get(closedApp, '/v1/sites', APP_ORIGIN)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    // Still varies, so a cache cannot later serve this to a different origin.
    expect(res.headers.get('vary')).toContain('Origin')
  })

  it('sets Vary: Origin on every response, matched or not and with no Origin', async () => {
    for (const res of [
      await get(app, '/v1/sites', APP_ORIGIN),
      await get(app, '/v1/sites', OTHER_ORIGIN),
      await get(app, '/v1/sites'),
      await get(app, '/health'),
    ]) {
      expect(res.headers.get('vary')).toContain('Origin')
    }
  })

  it('covers /health and /api/auth/*, not only /v1', async () => {
    const health = await get(app, '/health', APP_ORIGIN)
    expect(health.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN)

    // The sign-in calls that set the session cookie live here; without the
    // header the browser would discard the Set-Cookie response.
    const session = await get(app, '/api/auth/get-session', APP_ORIGIN)
    expect(session.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN)
  })

  it('answers a preflight 204 without reaching the session middleware', async () => {
    // The observed production failure: this returned 401, so the browser never
    // sent the real request. A preflight carries no cookie by construction, so a
    // session guard can only ever refuse it.
    const authenticated = await get(app, '/v1/sites', APP_ORIGIN)
    expect(authenticated.status).toBe(401)

    const res = await preflight(app, '/v1/sites', APP_ORIGIN)
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN)
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    expect(res.headers.get('vary')).toContain('Origin')

    const methods = res.headers.get('access-control-allow-methods') ?? ''
    for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']) {
      expect(methods).toContain(method)
    }
    const headers = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase()
    expect(headers).toContain('content-type')
    expect(headers).toContain('idempotency-key')
    expect(Number(res.headers.get('access-control-max-age'))).toBeGreaterThan(0)
  })

  it('refuses a preflight from a disallowed origin by answering without CORS headers', async () => {
    const res = await preflight(app, '/v1/sites', OTHER_ORIGIN)
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(res.headers.get('access-control-allow-methods')).toBeNull()
    expect(res.headers.get('vary')).toContain('Origin')
  })
})
