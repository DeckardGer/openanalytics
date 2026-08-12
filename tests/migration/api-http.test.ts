import { createAuth, drizzleAuthDatabase, type Auth } from '@openanalytics/auth'
import { loadServiceEnv } from '@openanalytics/domain'
import { createServiceMetadata } from '@openanalytics/observability'
import {
  addMember,
  createDatabase,
  createPool,
  createSiteWithOwner,
  newId,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../apps/api/src/app.ts'

/**
 * The Milestone 2 HTTP surface end to end, over a real Postgres and the real
 * Better Auth pipeline. Proves the server-side authorization chain and — this
 * time at the HTTP level — that a public tracking key works on no read endpoint.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

const ORIGIN = 'http://localhost:3000'
const PASSWORD = 'sup3r-secret-pw'

describeIfPostgres('api http surface', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m2http_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database
  let app: ReturnType<typeof createApp>
  const tokens: string[] = []

  let ownerCookie: string
  let siteId: string

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.fetch(
      new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
        body: JSON.stringify(body),
      }),
    )

  const get = (path: string, headers: Record<string, string> = {}) =>
    app.fetch(new Request(`${ORIGIN}${path}`, { headers: { origin: ORIGIN, ...headers } }))

  const sessionCookie = (res: Response): string | null => {
    for (const raw of res.headers.getSetCookie()) {
      const pair = raw.split(';')[0] ?? ''
      if (pair.includes('oa_session')) return pair
    }
    return null
  }

  async function signUpVerifyLogin(email: string): Promise<{ userId: string; cookie: string }> {
    const created = await post('/api/auth/sign-up/email', { email, password: PASSWORD, name: 'U' })
    expect(created.ok, 'sign-up should succeed').toBe(true)
    const body = (await created.json()) as { user: { id: string } }
    const token = tokens[tokens.length - 1]
    await get(`/api/auth/verify-email?token=${encodeURIComponent(token ?? '')}`)
    const loggedIn = await post('/api/auth/sign-in/email', { email, password: PASSWORD })
    expect(loggedIn.ok, 'sign-in should succeed').toBe(true)
    const cookie = sessionCookie(loggedIn)
    expect(cookie, 'sign-in should set a session cookie').not.toBeNull()
    return { userId: body.user.id, cookie: cookie as string }
  }

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

    const owner = await signUpVerifyLogin(`owner-${Date.now()}@example.com`)
    ownerCookie = owner.cookie
    const created = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'Acme',
      ownerUserId: owner.userId,
    })
    siteId = created.siteId
  })

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

  it('requires a session for the business surface', async () => {
    expect((await get('/v1/sites')).status).toBe(401)
  })

  it('lists and reads the caller’s site, and hides sites they are not in', async () => {
    const list = await get('/v1/sites', { cookie: ownerCookie })
    expect(list.status).toBe(200)
    const body = (await list.json()) as { items: { site_id: string; role: string }[] }
    expect(body.items).toContainEqual(expect.objectContaining({ site_id: siteId, role: 'owner' }))

    expect((await get(`/v1/sites/${siteId}`, { cookie: ownerCookie })).status).toBe(200)
    // A well-formed but unknown/not-a-member site is 404, not 403.
    expect((await get(`/v1/sites/${newId()}`, { cookie: ownerCookie })).status).toBe(404)
  })

  it('lets an owner manage keys but forbids a viewer', async () => {
    const created = await post(
      `/v1/sites/${siteId}/keys`,
      { type: 'private_read', name: 'server' },
      { cookie: ownerCookie },
    )
    expect(created.status).toBe(201)

    const viewer = await signUpVerifyLogin(`viewer-${Date.now()}@example.com`)
    await addMember(db, { siteId, userId: viewer.userId, role: 'viewer' })
    const forbidden = await post(
      `/v1/sites/${siteId}/keys`,
      { type: 'private_read' },
      { cookie: viewer.cookie },
    )
    expect(forbidden.status).toBe(403)
  })

  it('accepts a private read key on the read endpoint but rejects a tracking key', async () => {
    const priv = (await (
      await post(`/v1/sites/${siteId}/keys`, { type: 'private_read' }, { cookie: ownerCookie })
    ).json()) as { raw_token: string }
    const track = (await (
      await post(`/v1/sites/${siteId}/keys`, { type: 'tracking_write' }, { cookie: ownerCookie })
    ).json()) as { raw_token: string }

    // The private read key resolves the read endpoint.
    const ok = await get('/v1/read/site', { authorization: `Bearer ${priv.raw_token}` })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { site_id: string }).site_id).toBe(siteId)

    // The public tracking key is write-only and is rejected on the read endpoint.
    const rejected = await get('/v1/read/site', { authorization: `Bearer ${track.raw_token}` })
    expect(rejected.status).toBe(401)
  })

  /**
   * The mint surface's half of ADR-0042 D3, end to end through the real routes
   * and a real database: what an owner asks for is what the key gets, and what
   * they mistype is refused rather than quietly minted narrow.
   */
  describe('key scopes', () => {
    const mint = async (body: Record<string, unknown>) =>
      post(`/v1/sites/${siteId}/keys`, body, { cookie: ownerCookie })

    it('mints the minimum scope when none is named, and lists it', async () => {
      const created = (await (await mint({ type: 'private_read' })).json()) as { id: string }
      const listed = (await (
        await get(`/v1/sites/${siteId}/keys`, { cookie: ownerCookie })
      ).json()) as { items: { id: string; type: string; scopes: string[] | null }[] }

      const row = listed.items.find((item) => item.id === created.id)
      expect(row?.scopes).toEqual(['site:read'])
      // And a tracking key reports null rather than an empty list: it carries no
      // scopes, which is a different statement from carrying none of them.
      expect(listed.items.find((item) => item.type === 'tracking_write')?.scopes).toBeNull()
    })

    it('grants analytics:read only when it is asked for', async () => {
      const created = (await (
        await mint({ type: 'private_read', scopes: ['analytics:read'] })
      ).json()) as { id: string; raw_token: string }

      const listed = (await (
        await get(`/v1/sites/${siteId}/keys`, { cookie: ownerCookie })
      ).json()) as { items: { id: string; scopes: string[] | null }[] }
      // `site:read` is added even though it was not asked for: a key that could
      // read analytics but not the site context those numbers belong to would be
      // a credential nobody meant to create.
      expect(listed.items.find((item) => item.id === created.id)?.scopes).toEqual([
        'site:read',
        'analytics:read',
      ])

      // And the grant is live on the surface it was granted for.
      const read = await get(
        '/v1/read/analytics/overview?from=2026-07-16T00:00:00.000Z&to=2026-07-23T00:00:00.000Z&timezone=UTC',
        {
          authorization: `Bearer ${created.raw_token}`,
        },
      )
      // No query gateway is configured in this suite, so the honest answer is
      // "not available here" — but crucially not 403, which is what a key
      // without the scope would get.
      expect(read.status).toBe(503)
    })

    it('refuses a mistyped scope instead of minting a key without it', async () => {
      const res = await mint({ type: 'private_read', scopes: ['analytics.read'] })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: { code: string; details?: unknown } }
      expect(body.error.code).toBe('VALIDATION_FAILED')
      expect(JSON.stringify(body.error.details)).toContain('scopes')
    })

    it('refuses scopes on a tracking key, which carries none', async () => {
      const res = await mint({ type: 'tracking_write', scopes: ['site:read'] })
      expect(res.status).toBe(400)
    })

    it('refuses an empty scope list, which is not the same as omitting it', async () => {
      expect((await mint({ type: 'private_read', scopes: [] })).status).toBe(400)
    })

    /**
     * ADR-0043 D5, through the real route: the two scopes a key can never hold
     * are refused at mint time rather than stored and ignored.
     *
     * Stored-and-ignored is the failure worth naming. The key would list
     * `revenue:read` on the API-keys page forever, an owner would believe they
     * had granted it, and the resolver would refuse every revenue request from
     * a credential the page says is authorized for it.
     */
    it('refuses the two scopes no key can hold, naming the reason', async () => {
      for (const scope of ['realtime:read', 'revenue:read']) {
        const res = await mint({ type: 'private_read', scopes: [scope] })
        expect(res.status, `${scope} must be refused`).toBe(400)
        const body = (await res.json()) as { error: { code: string; message: string } }
        expect(body.error.code).toBe('VALIDATION_FAILED')
        // The recovery, not just the rule: a different credential kind.
        expect(body.error.message).toContain('OAuth token')
      }
    })

    it('refuses the whole request when one scope of several is ineligible', async () => {
      // Not "mints the eligible ones and drops the rest": partial success would
      // leave an owner believing the grant they asked for is what they got.
      const res = await mint({
        type: 'private_read',
        scopes: ['analytics:read', 'revenue:read'],
      })
      expect(res.status).toBe(400)

      const listed = (await (
        await get(`/v1/sites/${siteId}/keys`, { cookie: ownerCookie })
      ).json()) as { items: { scopes: string[] | null }[] }
      expect(
        listed.items.some((item) => item.scopes?.includes('revenue:read')),
        'no key anywhere holds a scope keys cannot hold',
      ).toBe(false)
    })
  })
})
