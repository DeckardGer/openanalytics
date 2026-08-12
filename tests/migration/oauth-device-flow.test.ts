import { createAuth, drizzleAuthDatabase, type Auth } from '@openanalytics/auth'
import { DEVICE_CODE_GRANT_TYPE, loadServiceEnv } from '@openanalytics/domain'
import { createServiceMetadata } from '@openanalytics/observability'
import {
  createDatabase,
  createPool,
  sweepExpiredDeviceCodes,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../apps/api/src/app.ts'
import { InProcessRateLimiter } from '../../apps/api/src/http/rate-limit.ts'

/**
 * RFC 8628, end to end, over a real Postgres and the real Better Auth pipeline
 * (ADR-0043 D13 and D14).
 *
 * This suite exists because the interesting half of the device flow is *state*,
 * and every claim about it is a claim about two requests interleaving: a device
 * polling while a human approves, a code exchanged twice, a code polled faster
 * than its interval. None of that is observable from a unit test of the handler.
 *
 * The most important assertion here is negative: `POST /api/auth/device/token`
 * — Better Auth's own endpoint, which mints a **session** — must not exist. If a
 * library upgrade puts it back, a CLI would silently receive a credential that
 * authenticates the entire dashboard.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

const ORIGIN = 'http://localhost:3000'
const PASSWORD = 'sup3r-secret-pw'
const CLI = 'oa-cli'

describeIfPostgres('the device authorization flow', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m16dev_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database
  let app: ReturnType<typeof createApp>
  let limitedApp: ReturnType<typeof createApp>
  const tokens: string[] = []
  let userCookie: string
  let userId: string

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

  const postForm = (
    path: string,
    fields: Record<string, string>,
    headers: Record<string, string> = {},
  ) =>
    request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(fields).toString(),
    })

  /** Start a device authorization the way the CLI does. */
  const startDevice = async (scope: string): Promise<{ deviceCode: string; userCode: string }> => {
    const res = await postJson('/api/auth/device/code', { client_id: CLI, scope })
    expect(res.status, 'device code request should succeed').toBe(200)
    const body = (await res.json()) as { device_code: string; user_code: string }
    return { deviceCode: body.device_code, userCode: body.user_code }
  }

  /** What a device that respected the five-second interval looks like. */
  const waitedOutTheInterval = async (deviceCode: string): Promise<void> => {
    await pool.query(
      `UPDATE device_codes SET last_polled_at = now() - interval '1 minute' WHERE device_code = $1`,
      [deviceCode],
    )
  }

  const exchange = (deviceCode: string, clientId = CLI) =>
    postForm('/v1/oauth/device/token', {
      grant_type: DEVICE_CODE_GRANT_TYPE,
      device_code: deviceCode,
      client_id: clientId,
    })

  /**
   * The same exchange against the small-budget app below, from a named address.
   *
   * `X-Real-IP` because that is the header the endpoint reads: the reverse proxy
   * in front of the api asserts it from the connection, so it is the one address
   * value on the request a caller cannot choose.
   */
  const limitedExchange = (deviceCode: string, address: string) =>
    limitedApp.fetch(
      new Request(`${ORIGIN}/v1/oauth/device/token`, {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/x-www-form-urlencoded',
          'x-real-ip': address,
        },
        body: new URLSearchParams({
          grant_type: DEVICE_CODE_GRANT_TYPE,
          device_code: deviceCode,
          client_id: CLI,
        }).toString(),
      }),
    )

  /** A well-shaped device code nobody issued — 40 alphanumerics, as the plugin mints. */
  const inventedDeviceCode = (): string => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    let code = ''
    for (let i = 0; i < 40; i += 1) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)]
    }
    return code
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

    // A second app over the same database, carrying a deliberately tiny device
    // token budget. What the budget tests below prove is the *shape* of the
    // limiter key, not its number, and proving it against the shipped 60/90
    // would cost ninety-one polls per assertion. Three per device code and
    // eight per address is the smallest pair that still tells the two keys
    // apart.
    limitedApp = createApp({
      service,
      logger,
      env,
      auth,
      db,
      oauth: {
        deviceTokenRateLimiter: new InProcessRateLimiter({
          requestsPerMinute: 3,
          burst: 3,
          limitsByPrefix: { 'device-ip:': { requestsPerMinute: 8, burst: 8 } },
        }),
      },
    })

    const email = `dev-${Date.now()}@example.com`
    const created = await postJson('/api/auth/sign-up/email', {
      email,
      password: PASSWORD,
      name: 'U',
    })
    userId = ((await created.json()) as { user: { id: string } }).user.id
    await request(`/api/auth/verify-email?token=${encodeURIComponent(tokens.at(-1) ?? '')}`)
    const loggedIn = await postJson('/api/auth/sign-in/email', { email, password: PASSWORD })
    const cookie = loggedIn.headers
      .getSetCookie()
      .map((raw) => raw.split(';')[0] ?? '')
      .find((pair) => pair.includes('oa_session'))
    expect(cookie).toBeDefined()
    userCookie = cookie as string
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

  it('does not expose Better Auth’s session-issuing token endpoint', async () => {
    // ADR-0043 D13, and the assertion this whole file is built around. The
    // plugin's own `/device/token` returns `session.token` — a credential for
    // the entire dashboard — dressed as an OAuth `access_token`. It is deleted
    // from the plugin, so there is no route, under any spelling.
    const { deviceCode } = await startDevice('site:read')
    const res = await postJson('/api/auth/device/token', {
      grant_type: DEVICE_CODE_GRANT_TYPE,
      device_code: deviceCode,
      client_id: CLI,
    })
    expect(res.status).toBe(404)
    // And nothing that looks like a token came back.
    expect(await res.text()).not.toContain('access_token')
  })

  it('refuses a device code for a client nobody registered', async () => {
    const res = await postJson('/api/auth/device/code', { client_id: 'somebody-elses-app' })
    expect(res.status).toBe(400)
  })

  it('answers authorization_pending until a human approves, then issues a scoped token', async () => {
    const { deviceCode, userCode } = await startDevice('site:read analytics:read')

    const pending = await exchange(deviceCode)
    expect(pending.status).toBe(400)
    expect(((await pending.json()) as { error: string }).error).toBe('authorization_pending')

    // The page a human lands on names the code and what is being asked for, in
    // the words `READ_SCOPE_DESCRIPTIONS` gives — not in scope strings.
    const page = await request(`/oauth/device?user_code=${userCode}`, {
      headers: { cookie: userCookie },
    })
    expect(page.status).toBe(200)
    const pageHtml = await page.text()
    expect(pageHtml).toContain(userCode)
    expect(pageHtml).toContain('Read your sites’ traffic reports')
    // The scopes it did NOT ask for are not offered.
    expect(pageHtml).not.toContain('live visitor stream')

    const approved = await postForm(
      '/oauth/device',
      { user_code: userCode, decision: 'approve' },
      { cookie: userCookie },
    )
    expect(approved.status).toBe(200)

    // Wind `last_polled_at` back rather than sleeping five real seconds. The
    // interval is enforced from the database clock, so moving the stamp is
    // exactly what a device that waited looks like — and the interval itself has
    // its own test below, so nothing is being skipped here.
    await waitedOutTheInterval(deviceCode)

    const issued = await exchange(deviceCode)
    expect(issued.status).toBe(200)
    const token = (await issued.json()) as {
      access_token: string
      token_type: string
      expires_in: number
      refresh_token: string
      scope: string
    }
    expect(token.token_type).toBe('Bearer')
    expect(token.scope).toBe('site:read analytics:read')
    expect(token.expires_in).toBe(3600)
    expect(token.access_token).not.toBe(token.refresh_token)

    // It is an OAuth token row, bound to the person who approved it — not a
    // session. Both halves matter: a `sessions` row would be the D13 defect.
    const stored = await pool.query<{ user_id: string; scopes: string; n: string }>(
      `SELECT user_id, scopes, count(*) OVER ()::text AS n
       FROM oauth_access_tokens WHERE access_token = $1`,
      [token.access_token],
    )
    expect(stored.rows[0]?.user_id).toBe(userId)
    expect(stored.rows[0]?.scopes).toBe('site:read analytics:read')

    // Single use: the code is consumed by the exchange that succeeded.
    const replay = await exchange(deviceCode)
    expect(replay.status).toBe(400)
    expect(((await replay.json()) as { error: string }).error).toBe('invalid_grant')
  })

  it('narrows a grant it cannot name rather than trusting the stored string', async () => {
    // A device code carrying an unknown scope — or one written into the row
    // directly — must not become authority. The grant is re-read through the
    // vocabulary on the way out.
    const { deviceCode, userCode } = await startDevice('site:read widgets:read')
    await postForm(
      '/oauth/device',
      { user_code: userCode, decision: 'approve' },
      { cookie: userCookie },
    )
    const issued = await exchange(deviceCode)
    expect(((await issued.json()) as { scope: string }).scope).toBe('site:read')
  })

  it('stops a denied device, and does not let it keep asking', async () => {
    const { deviceCode, userCode } = await startDevice('site:read')
    const denied = await postForm(
      '/oauth/device',
      { user_code: userCode, decision: 'deny' },
      { cookie: userCookie },
    )
    expect(denied.status).toBe(200)
    expect(await denied.text()).toContain('Denied')

    const first = await exchange(deviceCode)
    expect(((await first.json()) as { error: string }).error).toBe('access_denied')
    // The row is gone, so a device that ignores the refusal learns nothing new.
    const again = await exchange(deviceCode)
    expect(((await again.json()) as { error: string }).error).toBe('invalid_grant')
  })

  it('refuses a device code presented by a different client', async () => {
    const { deviceCode, userCode } = await startDevice('site:read')
    await postForm(
      '/oauth/device',
      { user_code: userCode, decision: 'approve' },
      { cookie: userCookie },
    )
    const wrong = await exchange(deviceCode, 'oa-mcp')
    expect(wrong.status).toBe(400)
    expect(((await wrong.json()) as { error: string }).error).toBe('invalid_grant')
    // And the code survives for its rightful owner: a wrong-client poll must not
    // burn somebody else's authorization. It must also not have stamped
    // `last_polled_at` — a stranger's poll should not be able to make the real
    // device wait — which is why the client check runs before the update.
    expect((await exchange(deviceCode)).status).toBe(200)
  })

  it('tells a device polling too fast to slow down', async () => {
    const { deviceCode } = await startDevice('site:read')
    const first = await exchange(deviceCode)
    expect(((await first.json()) as { error: string }).error).toBe('authorization_pending')
    // Immediately again, inside the five-second interval.
    const second = await exchange(deviceCode)
    expect(((await second.json()) as { error: string }).error).toBe('slow_down')
  })

  it('expires a code, and deletes it rather than leaving it approvable', async () => {
    const { deviceCode, userCode } = await startDevice('site:read')
    await pool.query(
      `UPDATE device_codes SET expires_at = now() - interval '1 minute' WHERE device_code = $1`,
      [deviceCode],
    )

    const expired = await exchange(deviceCode)
    expect(((await expired.json()) as { error: string }).error).toBe('expired_token')

    // Gone: nobody can approve it afterwards and see a success page for a device
    // that already gave up.
    const page = await request(`/oauth/device?user_code=${userCode}`, {
      headers: { cookie: userCookie },
    })
    expect(page.status).toBe(404)
  })

  it('sweeps an abandoned authorization, but not one still worth an expired_token', async () => {
    // The gap this closes: the exchange deletes a code whenever it is *polled*,
    // so a flow that simply stops — a CLI killed mid-login — leaves a row nothing
    // will ever reach. An hour of grace past expiry rather than none, so a device
    // that polls late still gets `expired_token` ("run login again") instead of
    // `invalid_grant` ("there is no such code").
    const recent = await startDevice('site:read')
    const ancient = await startDevice('site:read')
    await pool.query(
      `UPDATE device_codes SET expires_at = now() - interval '2 minutes' WHERE device_code = $1`,
      [recent.deviceCode],
    )
    await pool.query(
      `UPDATE device_codes SET expires_at = now() - interval '3 hours' WHERE device_code = $1`,
      [ancient.deviceCode],
    )

    const swept = await sweepExpiredDeviceCodes(db)
    expect(swept).toBeGreaterThanOrEqual(1)

    // The old one is gone; the recently-expired one survives so its device can
    // still be told *why* it failed.
    const remaining = await pool.query<{ device_code: string }>(
      `SELECT device_code FROM device_codes WHERE device_code = ANY($1::text[])`,
      [[recent.deviceCode, ancient.deviceCode]],
    )
    expect(remaining.rows.map((row) => row.device_code)).toEqual([recent.deviceCode])

    const late = await exchange(recent.deviceCode)
    expect(((await late.json()) as { error: string }).error).toBe('expired_token')
  })

  it('refuses a malformed exchange before it touches a device code', async () => {
    expect((await postForm('/v1/oauth/device/token', { client_id: CLI })).status).toBe(400)
    const wrongGrant = await postForm('/v1/oauth/device/token', {
      grant_type: 'authorization_code',
      device_code: 'x',
      client_id: CLI,
    })
    expect(((await wrongGrant.json()) as { error: string }).error).toBe('invalid_request')
  })

  describe('the polling budget', () => {
    it('does not let one device code’s polling exhaust another’s', async () => {
      const address = '198.51.100.10'
      const first = await startDevice('site:read')
      const second = await startDevice('site:read')

      // Spend the first code's own budget. The middle polls answer `slow_down`
      // from the *database* (they are inside the five-second interval), which is
      // the endpoint working as designed; what matters is the one after it.
      for (let i = 0; i < 3; i += 1) await limitedExchange(first.deviceCode, address)
      const spent = await limitedExchange(first.deviceCode, address)
      expect(spent.status).toBe(429)
      expect(((await spent.json()) as { error: string }).error).toBe('slow_down')
      expect(spent.headers.get('retry-after')).toBeTruthy()

      // The second device has not polled once, and must not be paying for the
      // first one's retry storm. Keyed by client id — a constant — every CLI in
      // the world shares one bucket and this answers `slow_down`.
      const other = await limitedExchange(second.deviceCode, address)
      expect(other.status).toBe(400)
      expect(((await other.json()) as { error: string }).error).toBe('authorization_pending')
    })

    it('bounds a spray of invented codes from one address, before the database', async () => {
      const sprayer = '198.51.100.20'
      const bystander = '198.51.100.30'
      const real = await startDevice('site:read')

      // Codes nobody issued, a fresh one each time: every request gets its own
      // untouched per-code bucket, so the address budget is the only thing that
      // can stop them.
      const refusals: Response[] = []
      for (let i = 0; i < 9; i += 1) {
        refusals.push(await limitedExchange(inventedDeviceCode(), sprayer))
      }
      const last = refusals.at(-1) as Response
      expect(last.status).toBe(429)
      expect(((await last.json()) as { error: string }).error).toBe('slow_down')

      // Refused *before* the claim: a real code polled from the spent address is
      // turned away and its row is untouched — `claimApprovedDeviceCode` stamps
      // `last_polled_at` on every path that reaches it.
      const blocked = await limitedExchange(real.deviceCode, sprayer)
      expect(blocked.status).toBe(429)
      const stamp = await pool.query<{ last_polled_at: string | null }>(
        `SELECT last_polled_at FROM device_codes WHERE device_code = $1`,
        [real.deviceCode],
      )
      expect(stamp.rows[0]?.last_polled_at).toBeNull()

      // And the sprayer's budget is the sprayer's. A device somewhere else is
      // unaffected, which one global bucket cannot express: there, one address
      // starves every other.
      const elsewhere = await limitedExchange(real.deviceCode, bystander)
      expect(elsewhere.status).toBe(400)
      expect(((await elsewhere.json()) as { error: string }).error).toBe('authorization_pending')
    })
  })

  describe('the approval page', () => {
    it('approves on “approve”, and treats anything else as no decision at all', async () => {
      // A POST with no `decision` — the shape any stray same-site form post has.
      // It must not approve, and it must not deny either: the code stays pending
      // for the human who was actually asked.
      const missing = await startDevice('site:read')
      const noDecision = await postForm(
        '/oauth/device',
        { user_code: missing.userCode },
        { cookie: userCookie },
      )
      expect(noDecision.status).toBe(400)
      const stillPending = await exchange(missing.deviceCode)
      expect(((await stillPending.json()) as { error: string }).error).toBe('authorization_pending')

      // And a third value, which a handler that only tests for `deny` reads as
      // approval.
      const third = await startDevice('site:read')
      const yes = await postForm(
        '/oauth/device',
        { user_code: third.userCode, decision: 'yes' },
        { cookie: userCookie },
      )
      expect(yes.status).toBe(400)
      const alsoPending = await exchange(third.deviceCode)
      expect(((await alsoPending.json()) as { error: string }).error).toBe('authorization_pending')
    })

    it('sends a signed-out visitor to the login screen, not to a form', async () => {
      const res = await request('/oauth/device?user_code=XXXXXXXX')
      expect(res.status).toBe(302)
      const location = res.headers.get('location') ?? ''
      expect(location).toContain('/login')
      // And it says where to come back to, so the code is not lost — including
      // the code itself, which is the whole point of returning there.
      const next = new URL(location).searchParams.get('next') ?? ''
      expect(next).toContain('user_code=XXXXXXXX')
      // **Built on the deployment's own origin, not on the request URL's.**
      // Behind a TLS-terminating proxy the api is reached over plain HTTP, so
      // `c.req.url` yields `http://…` — which leaks the internal scheme and
      // hands the browser a URL that only works because a redirect catches it.
      // Seen in production on this page's first deploy.
      expect(next.startsWith('http://localhost:4000')).toBe(true)
    })

    it('refuses a form posted from another origin', async () => {
      // The device-flow phishing case: an attacker starts an authorization and
      // gets a logged-in victim to submit the approval. `SameSite=Lax` would
      // normally stop it, but the pre-launch window sets the cookie to `none`,
      // so this check must not depend on it.
      const { userCode } = await startDevice('site:read')
      const res = await app.fetch(
        new Request(`${ORIGIN}/oauth/device`, {
          method: 'POST',
          headers: {
            origin: 'https://evil.example',
            cookie: userCookie,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ user_code: userCode, decision: 'approve' }).toString(),
        }),
      )
      expect(res.status).toBe(403)
    })

    it('escapes what it echoes back, and never echoes an unknown client id at all', async () => {
      // Since ADR-0047 D8 the heading resolves a *name* — configuration for the
      // first-party ids, the registered name for a `dcr_…` id — so a raw query
      // `client_id` is not echoed anywhere: an unknown id gets the neutral
      // fallback. The free-text field that reaches this page is now the
      // registration-supplied name, and that is what must arrive escaped.
      const unknown = await request(
        `/oauth/consent?consent_code=abc&client_id=${encodeURIComponent('<img src=x onerror=alert(1)>')}`,
        { headers: { cookie: userCookie } },
      )
      const unknownBody = await unknown.text()
      expect(unknownBody).not.toContain('<img src=x')
      expect(unknownBody).toContain('An application')

      const registered = await postJson('/v1/oauth/register', {
        token_endpoint_auth_method: 'none',
        redirect_uris: ['https://example.com/callback'],
        client_name: '<img src=x onerror=alert(1)>',
      })
      expect(registered.status).toBe(201)
      const { client_id: clientId } = (await registered.json()) as { client_id: string }
      const res = await request(
        `/oauth/consent?consent_code=abc&client_id=${encodeURIComponent(clientId)}`,
        { headers: { cookie: userCookie } },
      )
      const body = await res.text()
      expect(body).not.toContain('<img src=x')
      expect(body).toContain('&lt;img src=x')
    })

    it('does not let itself be framed', async () => {
      const res = await request('/oauth/consent?consent_code=abc', {
        headers: { cookie: userCookie },
      })
      expect(res.headers.get('x-frame-options')).toBe('DENY')
      expect(res.headers.get('cache-control')).toBe('no-store')
    })
  })
})
