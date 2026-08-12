import { createAuth, drizzleAuthDatabase, type Auth } from '@openanalytics/auth'
import { loadServiceEnv } from '@openanalytics/domain'
import { createServiceMetadata } from '@openanalytics/observability'
import {
  createDatabase,
  createOAuthApplication,
  createPool,
  issueOAuthAccessToken,
  newId,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../apps/api/src/app.ts'

/**
 * ADR-0048 D4: the connected-apps list and one-click revoke, end to end.
 *
 * The two claims under test are that the list enumerates from *tokens* (so a
 * device-flow login with no consent row still appears) and that revoke deletes
 * tokens **and** consents (so a standing consent cannot silently re-issue).
 * Both are properties of the seam between Better Auth's tables and this
 * surface, so they are exercised over a real Postgres.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

const ORIGIN = 'http://localhost:3000'
const PASSWORD = 'sup3r-secret-pw'

describeIfPostgres('the connected-apps surface (ADR-0048 D4)', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `capps_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database
  let app: ReturnType<typeof createApp>
  const tokens: string[] = []
  let userId: string
  let cookie: string

  const request = (path: string, init: RequestInit = {}) =>
    app.fetch(
      new Request(`${ORIGIN}${path}`, {
        ...init,
        headers: { origin: ORIGIN, ...((init.headers as Record<string, string>) ?? {}) },
      }),
    )

  const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })

  const mintToken = (clientId: string, scope: string) =>
    issueOAuthAccessToken(db, {
      userId,
      clientId,
      scope,
      accessTokenExpiresInSeconds: 3600,
      refreshTokenExpiresInSeconds: 7200,
    })

  beforeAll(async () => {
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`CREATE SCHEMA ${schemaName}`)
    } finally {
      await admin.end()
    }
    const url = new URL(connectionString)
    url.searchParams.set('options', `-c search_path=${schemaName}`)
    const scoped = url.toString()

    const { logger } = createCapturedLogger()
    await applyPostgresStreams({ connectionString: scoped, logger })
    pool = createPool(scoped)
    db = createDatabase(pool)

    const auth: Auth = createAuth({
      database: drizzleAuthDatabase(db),
      secret: 'test-secret-'.padEnd(32, 'x'),
      baseURL: ORIGIN,
      productName: 'Acme Metrics',
      trustedOrigins: [ORIGIN],
      sendVerificationEmail: async ({ token }) => {
        tokens.push(token)
      },
    })
    const env = loadServiceEnv('api', testEnv())
    const service = createServiceMetadata({
      name: 'api',
      version: '0.0.0-test',
      environment: 'test',
    })
    app = createApp({ service, logger, env, auth, db })

    const email = `capps-${Date.now()}@example.com`
    const created = await postJson('/api/auth/sign-up/email', {
      email,
      password: PASSWORD,
      name: 'U',
    })
    userId = ((await created.json()) as { user: { id: string } }).user.id
    await request(`/api/auth/verify-email?token=${encodeURIComponent(tokens.at(-1) ?? '')}`)
    const loggedIn = await postJson('/api/auth/sign-in/email', { email, password: PASSWORD })
    cookie = loggedIn.headers
      .getSetCookie()
      .map((raw) => raw.split(';')[0] ?? '')
      .find((pair) => pair.includes('oa_session')) as string
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
    } finally {
      await admin.end()
    }
  })

  it('lists a first-party client by name and a registered one by its registered name', async () => {
    await mintToken('oa-cli', 'site:read analytics:read')
    const registered = await createOAuthApplication(db, {
      clientName: 'Claude for Desktop',
      redirectUris: ['https://claude.ai/cb'],
      metadata: null,
    })
    await mintToken(registered.clientId, 'site:read funnels:write')

    const res = await request('/v1/me/connected-apps', { headers: { cookie } })
    expect(res.status).toBe(200)
    const { apps } = (await res.json()) as {
      apps: {
        client_id: string
        name: string
        scopes: { scope: string }[]
        active_token_count: number
      }[]
    }
    const byId = new Map(apps.map((a) => [a.client_id, a]))

    // The CLI resolves to its first-party display name, not the bare id. (The
    // product name comes from the same env both `createAuth` and the route
    // read in production; the test's auth instance and route env differ, so the
    // invariant asserted here is "a human name, not `oa-cli`".)
    const cli = byId.get('oa-cli')
    expect(cli?.name).not.toBe('oa-cli')
    expect(cli?.name).toMatch(/CLI$/u)
    // The registered client resolves to the name it registered under (ADR-0047).
    const claude = byId.get(registered.clientId)
    expect(claude?.name).toBe('Claude for Desktop')
    // Scopes are rendered as human sentences; the write scope is present.
    expect(claude?.scopes.map((s) => s.scope)).toContain('funnels:write')
  })

  it('counts live grants and unions their scopes per client', async () => {
    const clientId = `dcr_${newId().replace(/-/gu, '').slice(0, 22)}`
    await mintToken(clientId, 'site:read')
    await mintToken(clientId, 'analytics:read widgets:write')

    const res = await request('/v1/me/connected-apps', { headers: { cookie } })
    const { apps } = (await res.json()) as {
      apps: { client_id: string; active_token_count: number; scopes: { scope: string }[] }[]
    }
    const entry = apps.find((a) => a.client_id === clientId)
    expect(entry?.active_token_count).toBe(2)
    const scopes = entry?.scopes.map((s) => s.scope) ?? []
    expect(scopes).toEqual(expect.arrayContaining(['site:read', 'analytics:read', 'widgets:write']))
  })

  it('revokes a client — its tokens die and it leaves the list', async () => {
    const clientId = `dcr_${newId().replace(/-/gu, '').slice(0, 22)}`
    const issued = await mintToken(clientId, 'site:read analytics:read')

    // A consent row too, so revoke's both-tables delete is exercised.
    await pool.query(
      `INSERT INTO oauth_consents (id, client_id, user_id, scopes, consent_given, created_at, updated_at)
       VALUES ($1, $2, $3, $4, true, now(), now())`,
      [newId(), clientId, userId, 'site:read analytics:read'],
    )

    const del = await request(`/v1/me/connected-apps/${clientId}`, {
      method: 'DELETE',
      headers: { cookie },
    })
    expect(del.status).toBe(204)

    // Gone from the list…
    const listed = (await (
      await request('/v1/me/connected-apps', { headers: { cookie } })
    ).json()) as {
      apps: { client_id: string }[]
    }
    expect(listed.apps.find((a) => a.client_id === clientId)).toBeUndefined()

    // …and the token no longer opens anything.
    const withDeadToken = await request('/v1/me/connected-apps', {
      headers: { authorization: `Bearer ${issued.accessToken}` },
    })
    // The grant arm has no allowlist row for this path, but a *dead* token is
    // refused before the allowlist even runs: 401, not 403.
    expect(withDeadToken.status).toBe(401)

    // Both tables were cleared.
    const rows = await pool.query<{ n: string }>(
      `SELECT
         (SELECT count(*) FROM oauth_access_tokens WHERE client_id = $1)::text AS n`,
      [clientId],
    )
    expect(rows.rows[0]?.n).toBe('0')
    const consents = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM oauth_consents WHERE client_id = $1`,
      [clientId],
    )
    expect(consents.rows[0]?.n).toBe('0')
  })

  it('answers 404 for a client the user never connected', async () => {
    const res = await request(`/v1/me/connected-apps/dcr_neverconnected0000000`, {
      method: 'DELETE',
      headers: { cookie },
    })
    expect(res.status).toBe(404)
  })

  it('requires a session — a live grant cannot list or revoke connected apps', async () => {
    // The claim is about a *bearer*, so a bearer is what is sent. The previous
    // version of this test sent no `Authorization` header at all and asserted
    // `401`, which proves only that anonymous callers are refused — it would
    // have stayed green if `/me/connected-apps` had grown an allowlist row and
    // become the one surface where an app could revoke its own siblings.
    const clientId = `dcr_${newId().replace(/-/gu, '').slice(0, 22)}`
    const issued = await mintToken(
      clientId,
      'site:read analytics:read team:read sites:write funnels:write events:write widgets:write share:write',
    )
    const authorization = { authorization: `Bearer ${issued.accessToken}` }

    for (const [method, path] of [
      ['GET', '/v1/me/connected-apps'],
      ['DELETE', `/v1/me/connected-apps/${clientId}`],
    ] as const) {
      const res = await request(path, { method, headers: authorization })
      // 403, not 401: the token resolves to a real principal that simply has no
      // door here — and not 200, whatever scope string it carries.
      expect(res.status, `${method} ${path}`).toBe(403)
      expect(
        ((await res.json()) as { error: { message: string } }).error.message,
        `${method} ${path}`,
      ).toBe('This application is not permitted to perform that operation')
    }

    // The token is still alive: the refusal above is the allowlist's, not a dead
    // credential's. Proven on a path a grant *may* reach — the read arm's site
    // list, which `site:read` opens and which every deployment serves. It was
    // `/v1/billing/usage` until the open-core split, and that route is the hosted
    // surface's.
    const alive = await request('/v1/read/sites', { headers: authorization })
    expect(alive.status, await alive.clone().text()).toBe(200)

    // And an anonymous caller is still 401 rather than 403.
    expect((await request('/v1/me/connected-apps')).status).toBe(401)
  })
})
