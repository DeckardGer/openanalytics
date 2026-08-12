import { createAuth, memoryAdapter, type Auth } from '@openanalytics/auth'
import { loadServiceEnv } from '@openanalytics/domain'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../apps/api/src/app.ts'

/**
 * The API mounts Better Auth under `/api/auth/*` when an auth instance is
 * provided, and still serves `/health` (and nothing under `/api/auth`) when it
 * is not — the Milestone 0 "starts without a database" contract.
 */

function memoryAuth(): Auth {
  return createAuth({
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    secret: 'x'.repeat(32),
    baseURL: 'http://localhost',
    productName: 'Acme Metrics',
    trustedOrigins: ['http://localhost'],
    sendVerificationEmail: async () => {},
  })
}

function buildApp(auth?: Auth) {
  const { logger } = createCapturedLogger()
  const env = loadServiceEnv('api', testEnv())
  const service = createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' })
  return createApp({ service, logger, env, ...(auth ? { auth } : {}) })
}

describe('api auth mount', () => {
  it('forwards /api/auth/* to Better Auth when mounted', async () => {
    const app = buildApp(memoryAuth())

    const health = await app.fetch(new Request('http://localhost/health'))
    expect(health.status).toBe(200)

    const session = await app.fetch(new Request('http://localhost/api/auth/get-session'))
    expect(session.status).toBe(200)
  })

  it('still serves health and leaves /api/auth unmounted without auth', async () => {
    const app = buildApp()

    const health = await app.fetch(new Request('http://localhost/health'))
    expect(health.status).toBe(200)

    const session = await app.fetch(new Request('http://localhost/api/auth/get-session'))
    expect(session.status).toBe(404)
  })
})
