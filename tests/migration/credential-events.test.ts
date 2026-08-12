import { createAuth, drizzleAuthDatabase, type Auth } from '@openanalytics/auth'
import { credentialSourceHash, loadServiceEnv } from '@openanalytics/domain'
import { createServiceMetadata } from '@openanalytics/observability'
import {
  createApiKey,
  createDatabase,
  createPool,
  createSiteWithOwner,
  issueOAuthAccessToken,
  newId,
  revokeConnectedApp,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../apps/api/src/app.ts'

/**
 * G-010's credential events, end to end (ADR-0051).
 *
 * The decision this file guards is a **boundary**, so it is tested from both
 * sides: the events that must be written when something is genuinely new, and
 * the far larger set of requests that must write nothing at all. A journal that
 * over-reports is variant (a) by accident — a row per read — which is the thing
 * ADR-0051 explicitly declined.
 *
 * The security property with the sharpest edge is the source fingerprint's
 * input. `X-Forwarded-For` is caller-supplied; `X-Real-IP` is asserted by the
 * proxy from the connection. If the fingerprint read the former, somebody
 * holding a stolen key could name the victim's usual address and never trip the
 * new-source event — the alert would be off by construction. That case has its
 * own test.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

const ORIGIN = 'http://localhost:3000'
const SOURCE_SECRET = 'credential-source-secret-for-tests'

interface AuditRow {
  readonly action: string
  readonly target_type: string | null
  readonly target_id: string | null
  readonly site_id: string | null
  readonly actor_user_id: string | null
  readonly actor_type: string
  readonly metadata: Record<string, unknown>
}

describeIfPostgres('credential events (ADR-0051)', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `credev_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database
  let auth: Auth
  let app: ReturnType<typeof createApp>
  /** The same app with no `CREDENTIAL_SOURCE_SECRET`, for the degradation. */
  let appWithoutSecret: ReturnType<typeof createApp>
  let userId: string
  let siteId: string

  const appEnv = (extra: Record<string, string> = {}) =>
    loadServiceEnv('api', { ...testEnv(), ...extra })

  /** A read through the key surface, from a named address. */
  const readFrom = (
    token: string,
    headers: Record<string, string>,
    target: ReturnType<typeof createApp> = app,
  ) =>
    target.fetch(
      new Request(`${ORIGIN}/v1/read/sites`, {
        headers: { origin: ORIGIN, authorization: `Bearer ${token}`, ...headers },
      }),
    )

  const auditFor = async (targetId: string): Promise<AuditRow[]> => {
    const { rows } = await pool.query<AuditRow>(
      `SELECT action, target_type, target_id, site_id, actor_user_id, actor_type, metadata
         FROM audit_logs WHERE target_id = $1 ORDER BY occurred_at, action`,
      [targetId],
    )
    return rows
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

    auth = createAuth({
      database: drizzleAuthDatabase(db),
      secret: 'test-secret-'.padEnd(32, 'x'),
      baseURL: ORIGIN,
      productName: 'Acme Metrics',
      trustedOrigins: [ORIGIN],
      sendVerificationEmail: async () => {},
    })
    const service = createServiceMetadata({
      name: 'api',
      version: '0.0.0-test',
      environment: 'test',
    })
    app = createApp({
      service,
      logger,
      env: appEnv({ CREDENTIAL_SOURCE_SECRET: SOURCE_SECRET }),
      auth,
      db,
    })
    appWithoutSecret = createApp({ service, logger, env: appEnv(), auth, db })

    userId = newId()
    await pool.query(
      `INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'U', $2, true)`,
      [userId, `${userId}@example.com`],
    )
    siteId = (
      await createSiteWithOwner(db, { slug: `s-${newId()}`, name: 'S', ownerUserId: userId })
    ).siteId
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

  const privateKey = async () =>
    createApiKey(db, { siteId, type: 'private_read', createdByUserId: userId })

  describe('an API key', () => {
    it('reports first use once, a new source once, and nothing else', async () => {
      const key = await privateKey()

      const first = await readFrom(key.rawToken, { 'x-real-ip': '203.0.113.10' })
      expect(first.status, await first.clone().text()).toBe(200)

      // The same key from the same address, twice more. A per-read journal would
      // now hold three rows; variant (b) holds one.
      await readFrom(key.rawToken, { 'x-real-ip': '203.0.113.10' })
      await readFrom(key.rawToken, { 'x-real-ip': '203.0.113.10' })

      let rows = await auditFor(key.id)
      expect(rows.map((row) => row.action)).toEqual(['api_key.created', 'credential.first_used'])

      const used = rows[1] as AuditRow
      expect(used.target_type).toBe('api_key')
      expect(used.site_id).toBe(siteId)
      // A key has no user (ADR-0043 D2), and the actor is the credential.
      expect(used.actor_user_id).toBeNull()
      expect(used.actor_type).toBe('service')
      expect(used.metadata['sourceHash']).toBe(
        credentialSourceHash({
          address: '203.0.113.10',
          key: { secret: SOURCE_SECRET, keyVersion: 1 },
        }),
      )
      expect(JSON.stringify(used.metadata)).not.toContain('203.0.113.10')

      // A different address is the event G-010 asked for.
      await readFrom(key.rawToken, { 'x-real-ip': '198.51.100.20' })
      rows = await auditFor(key.id)
      expect(rows.map((row) => row.action)).toEqual([
        'api_key.created',
        'credential.first_used',
        'credential.source_first_seen',
      ])
    })

    it('cannot be fooled into hiding a new source with X-Forwarded-For', async () => {
      const key = await privateKey()
      await readFrom(key.rawToken, { 'x-real-ip': '203.0.113.30' })

      // The stolen-key case: a caller who knows the victim's usual address and
      // names it in the header they control. `X-Real-IP` is the proxy's, and it
      // is what the fingerprint reads — so this is still a new source.
      await readFrom(key.rawToken, {
        'x-real-ip': '198.51.100.99',
        'x-forwarded-for': '203.0.113.30',
      })

      const rows = await auditFor(key.id)
      expect(rows.map((row) => row.action)).toContain('credential.source_first_seen')
    })

    it('reads X-Real-IP alone, so a proxy-less deployment degrades instead of trusting input', async () => {
      const key = await privateKey()

      // No `X-Real-IP` at all — what a deployment not behind Caddy looks like —
      // while the caller names an address in the header they *can* set. The
      // fingerprint must ignore it: `unknown` is a signal that has stopped
      // working and says so, and a forgeable one is worse than that.
      await readFrom(key.rawToken, { 'x-forwarded-for': '203.0.113.111' })
      await readFrom(key.rawToken, { 'x-forwarded-for': '198.51.100.222' })

      const rows = await auditFor(key.id)
      expect(rows.map((row) => row.action)).toEqual(['api_key.created', 'credential.first_used'])
      expect(rows[1]?.metadata['sourceHash']).toBe(
        credentialSourceHash({
          address: 'unknown',
          key: { secret: SOURCE_SECRET, keyVersion: 1 },
        }),
      )
    })

    it('writes nothing at all when no source secret is configured', async () => {
      const key = await privateKey()
      const res = await readFrom(key.rawToken, { 'x-real-ip': '203.0.113.40' }, appWithoutSecret)

      // The read is unaffected — the degradation is the signal, never the gate.
      expect(res.status).toBe(200)
      expect((await auditFor(key.id)).map((row) => row.action)).toEqual(['api_key.created'])
    })
  })

  describe('an OAuth grant', () => {
    const clientId = 'dcr_credential_events_client'
    const ref = () => `${userId}:${clientId}`

    it('is journalled when issued, when first used, and when revoked', async () => {
      const issued = await issueOAuthAccessToken(db, {
        userId,
        clientId,
        scope: 'site:read',
        accessTokenExpiresInSeconds: 3600,
        refreshTokenExpiresInSeconds: 7200,
      })
      expect((await auditFor(ref())).map((row) => row.action)).toEqual(['oauth_grant.issued'])

      const res = await readFrom(issued.accessToken, { 'x-real-ip': '203.0.113.50' })
      expect(res.status, await res.clone().text()).toBe(200)

      const revoked = await revokeConnectedApp(db, userId, clientId)
      expect(revoked.tokensRevoked).toBe(1)

      const actions = (await auditFor(ref())).map((row) => row.action)
      expect(actions).toEqual([
        'oauth_grant.issued',
        'credential.first_used',
        'oauth_grant.revoked',
      ])
    })

    it('keys the credential on the grant, so a refresh is not a new credential', async () => {
      const secondClient = 'dcr_refresh_shape_client'
      const mint = async () =>
        issueOAuthAccessToken(db, {
          userId,
          clientId: secondClient,
          scope: 'site:read',
          accessTokenExpiresInSeconds: 3600,
          refreshTokenExpiresInSeconds: 7200,
        })

      const one = await mint()
      await readFrom(one.accessToken, { 'x-real-ip': '203.0.113.60' })

      // Better Auth's refresh grant inserts a *new* `oauth_access_tokens` row
      // (verified in the vendored plugin), which is what this second mint stands
      // in for. Keyed on the token row, the read below would report another
      // first use; keyed on `(user, client)` — ADR-0051 D6 — it reports nothing.
      const two = await mint()
      await readFrom(two.accessToken, { 'x-real-ip': '203.0.113.60' })

      const firstUses = (await auditFor(`${userId}:${secondClient}`)).filter(
        (row) => row.action === 'credential.first_used',
      )
      expect(firstUses).toHaveLength(1)
    })
  })

  describe('a grant that only ever writes', () => {
    it('is journalled too, without ever touching the read surface', async () => {
      const clientId = 'dcr_write_only_client'
      const issued = await issueOAuthAccessToken(db, {
        userId,
        clientId,
        scope: 'sites:write',
        accessTokenExpiresInSeconds: 3600,
        refreshTokenExpiresInSeconds: 7200,
      })

      // `POST /v1/sites` goes through `principalAuth`, not `readAuth`. An agent
      // that creates things and never reads is an ordinary MCP client, and a
      // journal watching only reads would report this credential as never used.
      const res = await app.fetch(
        new Request(`${ORIGIN}/v1/sites`, {
          method: 'POST',
          headers: {
            origin: ORIGIN,
            'content-type': 'application/json',
            authorization: `Bearer ${issued.accessToken}`,
            'x-real-ip': '203.0.113.80',
          },
          body: JSON.stringify({ slug: `w-${newId()}`, name: 'Written by a grant' }),
        }),
      )
      expect(res.status, await res.clone().text()).toBe(201)

      const actions = (await auditFor(`${userId}:${clientId}`)).map((row) => row.action)
      expect(actions).toEqual(['oauth_grant.issued', 'credential.first_used'])
    })
  })

  describe('what is deliberately not journalled', () => {
    it('records nothing for a browser session (D11)', async () => {
      const before = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit_logs WHERE action LIKE 'credential.%'`,
      )

      // No `Authorization` header at all is the session arm's exact condition,
      // and with no cookie it is a `401` — which is the point: whatever the
      // session arm answers, it never reaches the credential journal, because a
      // cookie has no credential row to key one by.
      const res = await app.fetch(
        new Request(`${ORIGIN}/v1/read/sites`, { headers: { origin: ORIGIN } }),
      )
      expect(res.status).toBe(401)

      const after = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit_logs WHERE action LIKE 'credential.%'`,
      )
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n)
    })

    it('records nothing for a credential that does not resolve', async () => {
      const before = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit_logs WHERE action LIKE 'credential.%'`,
      )
      const res = await readFrom('oa_sk_this-key-was-never-issued-abcdefgh', {
        'x-real-ip': '203.0.113.70',
      })
      expect(res.status).toBe(401)

      const after = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit_logs WHERE action LIKE 'credential.%'`,
      )
      // A journal that recorded refusals would be a free way for anybody on the
      // internet to write rows into it.
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n)
    })
  })
})
