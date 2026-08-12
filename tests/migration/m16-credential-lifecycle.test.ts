import { createAuth, drizzleAuthDatabase, type Auth } from '@openanalytics/auth'
import { DEVICE_CODE_GRANT_TYPE, loadServiceEnv } from '@openanalytics/domain'
import { createServiceMetadata } from '@openanalytics/observability'
import {
  addMember,
  createDatabase,
  createPool,
  createSiteWithOwner,
  issueOAuthAccessToken,
  newId,
  removeMember,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../apps/api/src/app.ts'

/**
 * Plan 04 §Milestone 16 item 5, and ADR-0043 D11: **revocation, expired token
 * and wrong site — for both credential kinds.**
 *
 * D11 named these three at design time and said why they are the list: they are
 * what "first-class beside OAuth" means in practice. A key and a token are
 * genuinely different objects with genuinely different revocation stories, and
 * the claim this milestone makes is that both stories end in the same observable
 * outcome. Three mechanisms, one answer.
 *
 * They live in one file rather than scattered through the suites that happen to
 * exercise them, because the deliverable is the **matrix** — every cell filled,
 * visibly — and a matrix spread over four files is one nobody can check is
 * complete.
 *
 * | | private key | OAuth token |
 * | --- | --- | --- |
 * | revoked | `revoked_at` set → 401 | row deleted → 401 |
 * | revoked *by a departure* | the holder's key dies with their membership (D8) | membership check refuses the site |
 * | expired | past `expires_at` → 401 | past `access_token_expires_at` → 401 |
 * | wrong site | header refused outright | `SITE_NOT_FOUND`, same as a bad id |
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

const ORIGIN = 'http://localhost:3000'
const PASSWORD = 'sup3r-secret-pw'

describeIfPostgres('M16 credential lifecycle (plan item 5)', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m16life_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database
  let app: ReturnType<typeof createApp>
  const verifications: string[] = []

  let ownerId: string
  let ownerCookie: string
  let siteA: string
  let siteB: string

  const get = (path: string, headers: Record<string, string> = {}) =>
    app.fetch(new Request(`${ORIGIN}${path}`, { headers: { origin: ORIGIN, ...headers } }))

  const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.fetch(
      new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
        body: JSON.stringify(body),
      }),
    )

  /** The one read both credential kinds can make, so the matrix uses one probe. */
  const probe = (bearer: string, siteId?: string) =>
    get('/v1/read/site', {
      authorization: `Bearer ${bearer}`,
      ...(siteId === undefined ? {} : { 'x-oa-site': siteId }),
    })

  const errorCode = async (res: Response): Promise<string> =>
    ((await res.json()) as { error: { code: string } }).error.code

  async function signUpVerifyLogin(email: string): Promise<{ userId: string; cookie: string }> {
    const created = await postJson('/api/auth/sign-up/email', {
      email,
      password: PASSWORD,
      name: 'U',
    })
    const body = (await created.json()) as { user: { id: string } }
    await get(`/api/auth/verify-email?token=${encodeURIComponent(verifications.at(-1) ?? '')}`)
    const loggedIn = await postJson('/api/auth/sign-in/email', { email, password: PASSWORD })
    const cookie = loggedIn.headers
      .getSetCookie()
      .map((raw) => raw.split(';')[0] ?? '')
      .find((pair) => pair.includes('oa_session'))
    return { userId: body.user.id, cookie: cookie as string }
  }

  const mintKey = async (siteId: string, cookie: string, body: Record<string, unknown> = {}) => {
    const res = await postJson(
      `/v1/sites/${siteId}/keys`,
      { type: 'private_read', ...body },
      { cookie },
    )
    return (await res.json()) as { id: string; raw_token: string }
  }

  const mintToken = async (userId: string, seconds = 3600): Promise<string> =>
    (
      await issueOAuthAccessToken(db, {
        userId,
        clientId: 'oa-cli',
        scope: 'site:read analytics:read',
        accessTokenExpiresInSeconds: seconds,
        refreshTokenExpiresInSeconds: 86_400,
      })
    ).accessToken

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
        verifications.push(token)
      },
    })

    app = createApp({
      service: createServiceMetadata({ name: 'api', version: '0', environment: 'test' }),
      logger,
      env: loadServiceEnv('api', testEnv()),
      auth,
      db,
    })

    const owner = await signUpVerifyLogin(`life-owner-${Date.now()}@example.com`)
    ownerId = owner.userId
    ownerCookie = owner.cookie
    siteA = (
      await createSiteWithOwner(db, { slug: `la-${newId()}`, name: 'Alpha', ownerUserId: ownerId })
    ).siteId
    siteB = (
      await createSiteWithOwner(db, { slug: `lb-${newId()}`, name: 'Beta', ownerUserId: ownerId })
    ).siteId
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

  describe('revocation', () => {
    it('refuses a revoked key on its very next request', async () => {
      const key = await mintKey(siteA, ownerCookie)
      expect((await probe(key.raw_token)).status, 'live before revocation').toBe(200)

      const revoked = await app.fetch(
        new Request(`${ORIGIN}/v1/sites/${siteA}/keys/${key.id}`, {
          method: 'DELETE',
          headers: { origin: ORIGIN, cookie: ownerCookie },
        }),
      )
      expect(revoked.status).toBeLessThan(300)

      const after = await probe(key.raw_token)
      expect(after.status).toBe(401)
      expect(await errorCode(after)).toBe('UNAUTHENTICATED')
    })

    it('refuses a deleted token on its very next request', async () => {
      /**
       * **The one assertion in this file that has not been seen red, and the
       * reason is worth stating rather than hiding.** Every other case here was
       * verified by breaking the mechanism it pins and watching it fail. This
       * one cannot be: its post-condition is that a row which no longer exists
       * is not found, and there is no edit to the resolver that makes a deleted
       * row resolve. What *is* breakable is the lookup itself, and that is
       * covered — removing the expiry predicate fails the expiry test two blocks
       * down, which exercises the same query.
       *
       * The pre-condition is load-bearing anyway: asserting `200` before the
       * delete is what stops this from passing on a token that never worked.
       */
      const token = await mintToken(ownerId)
      expect((await probe(token, siteA)).status, 'live before deletion').toBe(200)
      await pool.query(`DELETE FROM oauth_access_tokens WHERE access_token = $1`, [token])
      expect((await probe(token, siteA)).status).toBe(401)
    })

    it('kills a departing member’s own key with their membership (D8)', async () => {
      // The third mechanism, and the one M16 built: a key `held_by = 'user'` is
      // revoked when its holder leaves, so a credential and a membership go
      // together without anybody having to remember to revoke it.
      const member = await signUpVerifyLogin(`life-member-${Date.now()}@example.com`)
      await addMember(db, { siteId: siteA, userId: member.userId, role: 'admin' })
      const key = await mintKey(siteA, member.cookie)
      expect((await probe(key.raw_token)).status).toBe(200)

      await removeMember(db, { siteId: siteA, userId: member.userId, actorUserId: ownerId })
      expect((await probe(key.raw_token)).status).toBe(401)
    })

    it('keeps a key the departing member installed into a machine, flagged (D8)', async () => {
      // The carve-out, on the read surface rather than in the repository: this is
      // the WordPress plugin's key, and revoking it would take a working
      // installation down over a personnel change.
      const member = await signUpVerifyLogin(`life-installer-${Date.now()}@example.com`)
      await addMember(db, { siteId: siteB, userId: member.userId, role: 'admin' })
      const key = await mintKey(siteB, member.cookie, { held_by: 'site' })
      expect((await probe(key.raw_token)).status).toBe(200)

      await removeMember(db, { siteId: siteB, userId: member.userId, actorUserId: ownerId })
      expect((await probe(key.raw_token)).status, 'the machine keeps working').toBe(200)

      // And the exposure is visible, which is the condition D8 accepted it under.
      const listed = (await (
        await get(`/v1/sites/${siteB}/keys`, { cookie: ownerCookie })
      ).json()) as { items: { id: string; rotation_required_at: string | null }[] }
      expect(listed.items.find((item) => item.id === key.id)?.rotation_required_at).not.toBeNull()
    })

    it('loses a removed member’s token on that site alone, with no revocation at all', async () => {
      const member = await signUpVerifyLogin(`life-both-${Date.now()}@example.com`)
      await addMember(db, { siteId: siteA, userId: member.userId, role: 'viewer' })
      await addMember(db, { siteId: siteB, userId: member.userId, role: 'viewer' })
      const token = await mintToken(member.userId)

      expect((await probe(token, siteA)).status).toBe(200)
      expect((await probe(token, siteB)).status).toBe(200)

      await removeMember(db, { siteId: siteA, userId: member.userId, actorUserId: ownerId })

      // The same token, unrevoked and unexpired. Three different mechanisms —
      // a revoked row, a deleted row, a membership that ended — and one
      // observable outcome, which is D11's whole point.
      expect((await probe(token, siteA)).status).toBe(404)
      expect((await probe(token, siteB)).status).toBe(200)
    })
  })

  describe('expiry', () => {
    it('refuses a key past its expires_at', async () => {
      const key = await mintKey(siteA, ownerCookie)
      expect((await probe(key.raw_token)).status).toBe(200)
      await pool.query(
        `UPDATE api_keys SET expires_at = now() - interval '1 minute' WHERE id = $1`,
        [key.id],
      )
      expect((await probe(key.raw_token)).status).toBe(401)
    })

    it('refuses a token past its lifetime, indistinguishably from one that never existed', async () => {
      const expired = await mintToken(ownerId, -60)
      const stale = await probe(expired, siteA)
      const invented = await probe('z'.repeat(32), siteA)
      expect(stale.status).toBe(401)
      expect(invented.status).toBe(401)
      expect(await errorCode(stale)).toBe(await errorCode(invented))
    })

    it('answers expired_token on a device code past its deadline, per RFC 8628', async () => {
      // D11 names this one specifically: the device flow's expiry has its own
      // vocabulary, and a generic failure would leave a CLI unable to tell
      // "start again" from "something is broken".
      const started = await postJson('/api/auth/device/code', {
        client_id: 'oa-cli',
        scope: 'site:read',
      })
      const { device_code: deviceCode } = (await started.json()) as { device_code: string }
      await pool.query(
        `UPDATE device_codes SET expires_at = now() - interval '1 minute' WHERE device_code = $1`,
        [deviceCode],
      )

      const res = await app.fetch(
        new Request(`${ORIGIN}/v1/oauth/device/token`, {
          method: 'POST',
          headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: DEVICE_CODE_GRANT_TYPE,
            device_code: deviceCode,
            client_id: 'oa-cli',
          }).toString(),
        }),
      )
      expect(res.status).toBe(400)
      // RFC 8628's shape, not this API's envelope — the one endpoint under `/v1`
      // that makes that exception, and it makes it for a client that reads the RFC.
      expect(((await res.json()) as { error: string }).error).toBe('expired_token')
    })
  })

  describe('the wrong site', () => {
    it('answers SITE_NOT_FOUND for a site the token’s user is not in', async () => {
      const stranger = await signUpVerifyLogin(`life-stranger-${Date.now()}@example.com`)
      const theirSite = (
        await createSiteWithOwner(db, {
          slug: `ls-${newId()}`,
          name: 'Theirs',
          ownerUserId: stranger.userId,
        })
      ).siteId

      const token = await mintToken(ownerId)
      const foreign = await probe(token, theirSite)
      expect(foreign.status).toBe(404)
      expect(await errorCode(foreign)).toBe('SITE_NOT_FOUND')

      // Indistinguishable from a site that does not exist and from an id that is
      // not one — the dashboard has always told those apart the same way, and a
      // different answer here would be an oracle a token could enumerate with.
      const missing = await probe(token, newId())
      const malformed = await probe(token, 'definitely-not-a-uuid')
      expect(await errorCode(missing)).toBe('SITE_NOT_FOUND')
      expect(await errorCode(malformed)).toBe('SITE_NOT_FOUND')
    })

    it('refuses a key that names any site at all, right or wrong', async () => {
      // A key has no wrong site to name, because it has no *choice* of site. The
      // refusal is the same whether the header happens to match.
      const key = await mintKey(siteA, ownerCookie)
      const rightSite = await probe(key.raw_token, siteA)
      const wrongSite = await probe(key.raw_token, siteB)
      expect(rightSite.status).toBe(400)
      expect(wrongSite.status).toBe(400)
      expect(await errorCode(rightSite)).toBe('VALIDATION_FAILED')
      // A key that agreed by accident today would disagree tomorrow when
      // somebody pointed the plugin at the wrong site.
      expect(await errorCode(wrongSite)).toBe('VALIDATION_FAILED')
    })
  })
})
