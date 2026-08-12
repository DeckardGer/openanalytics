import { loadServiceEnv } from '@openanalytics/domain'
import type { Auth } from '@openanalytics/auth'
import type { Database } from '@openanalytics/postgres'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../apps/api/src/app.ts'
import { enabledAuthProviders } from '../../apps/api/src/http/auth-providers.ts'

/**
 * `GET /v1/auth/providers`.
 *
 * The login screen hard-coded its Google and GitHub buttons, so a deployment
 * without a GitHub OAuth app still offered a GitHub button that could only end
 * on a provider error page. Which doors exist is server configuration.
 *
 * No infrastructure: the answer is derived from environment alone, and the route
 * must resolve with no session — that is the whole point of it.
 */

const auth = {
  api: { getSession: async () => null },
  handler: async () => new Response(null),
} as unknown as Auth
/**
 * The three answers the users read can give. `select().from().limit()` is the
 * whole of what `hasAnyUser` calls, so the stubs implement exactly that chain
 * and nothing else.
 */
const usersReturning = (rows: unknown[]) =>
  ({
    select: () => ({ from: () => ({ limit: async () => rows }) }),
  }) as unknown as Database

const emptyUsers = usersReturning([])
const oneUser = usersReturning([{ one: 1 }])
const brokenUsers = {
  select: () => ({
    from: () => ({
      limit: async () => {
        throw new Error('connection terminated')
      },
    }),
  }),
} as unknown as Database

const db = emptyUsers

const envWith = (overrides: Record<string, string>) => loadServiceEnv('api', testEnv(overrides))

function buildApp(overrides: Record<string, string>, users: Database = db) {
  const { logger } = createCapturedLogger()
  return createApp({
    service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
    logger,
    env: envWith(overrides),
    auth,
    db: users,
  })
}

const providersOf = async (app: ReturnType<typeof buildApp>) => {
  const res = await app.fetch(new Request('https://api.test/v1/auth/providers'))
  expect(res.status).toBe(200)
  return (await res.json()) as {
    items: { id: string; kind: string }[]
    setup_required: boolean
  }
}

describe('enabled auth providers', () => {
  it('offers the magic link even with no OAuth app configured', () => {
    // The plugin needs no provider credential — the send path is an outbox write
    // — so it is available wherever the auth surface is mounted at all.
    expect(enabledAuthProviders(envWith({}))).toEqual([{ id: 'magic_link', kind: 'email' }])
  })

  it('requires both halves of a credential before offering a provider', () => {
    // A client id with no secret is a button that fails at the callback rather
    // than at the click, which is strictly worse than not offering it.
    const halfConfigured = enabledAuthProviders(envWith({ GOOGLE_CLIENT_ID: 'gid' }))
    expect(halfConfigured.map((provider) => provider.id)).toEqual(['magic_link'])

    const configured = enabledAuthProviders(
      envWith({ GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'google-secret-0123456789' }),
    )
    expect(configured.map((provider) => provider.id)).toEqual(['google', 'magic_link'])
  })

  it('lists every configured provider with its interaction shape', () => {
    const all = enabledAuthProviders(
      envWith({
        GOOGLE_CLIENT_ID: 'gid',
        GOOGLE_CLIENT_SECRET: 'google-secret-0123456789',
        GITHUB_CLIENT_ID: 'hid',
        GITHUB_CLIENT_SECRET: 'github-secret-0123456789',
      }),
    )
    expect(all).toEqual([
      { id: 'google', kind: 'oauth' },
      { id: 'github', kind: 'oauth' },
      { id: 'magic_link', kind: 'email' },
    ])
  })

  it('offers email+password exactly when the deployment enables it', () => {
    // Off by default, which is the hosted deployment's answer. On, it is the
    // one door a self-hosted install has that needs neither a third-party OAuth
    // app nor a mail server — and the same flag decides whether Better Auth
    // mounts the endpoints, so the list can never advertise a form that is not
    // there.
    expect(enabledAuthProviders(envWith({})).map((p) => p.id)).not.toContain('password')

    const enabled = enabledAuthProviders(envWith({ AUTH_PASSWORD_SIGNIN: 'enabled' }))
    expect(enabled).toContainEqual({ id: 'password', kind: 'password' })
  })
})

describe('GET /v1/auth/providers', () => {
  it('answers without a session', async () => {
    // Asked by the login screen, where a session is precisely what does not
    // exist yet. It must resolve ahead of the business subtree's session guard.
    const body = await providersOf(buildApp({}))
    expect(body.items).toEqual([{ id: 'magic_link', kind: 'email' }])
  })

  it('reflects the deployment rather than a hard-coded list', async () => {
    const body = await providersOf(
      buildApp({ GITHUB_CLIENT_ID: 'hid', GITHUB_CLIENT_SECRET: 'github-secret-0123456789' }),
    )
    expect(body.items.map((provider) => provider.id)).toEqual(['github', 'magic_link'])
  })

  it('reports a fresh deployment as needing setup, and a claimed one as not', async () => {
    // The question the login screen asks one level above "which door": an
    // install with nobody in it offers to create the first account instead of
    // asking for one that cannot exist.
    const fresh = await providersOf(buildApp({}, emptyUsers))
    expect(fresh.setup_required).toBe(true)

    const claimed = await providersOf(buildApp({}, oneUser))
    expect(claimed.setup_required).toBe(false)
  })

  it('keeps the door open when the users read fails', async () => {
    // Fails closed, and answers 200. A database blip must not turn the login
    // screen into a 500, and it must never be read as "this deployment is
    // unclaimed" — that is the one wrong direction to guess in.
    const body = await providersOf(buildApp({}, brokenUsers))
    expect(body.setup_required).toBe(false)
    expect(body.items.map((provider) => provider.id)).toContain('magic_link')
  })

  it('discloses no credential material', async () => {
    const body = await providersOf(
      buildApp({
        GOOGLE_CLIENT_ID: 'gid-secretish',
        GOOGLE_CLIENT_SECRET: 'google-secret-0123456789',
      }),
    )
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('gid-secretish')
    expect(serialized).not.toContain('google-secret-0123456789')
  })
})
