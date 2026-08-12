import { createAuth, memoryAdapter, type Auth } from '@openanalytics/auth'
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * The Milestone 2 session-security gate, driven against the real Better Auth
 * request pipeline over its in-memory adapter (no Postgres needed):
 *
 *   - CSRF / wrong-origin: a state-changing request from an untrusted origin is
 *     rejected.
 *   - Verified-email policy: password sign-in is refused until the address is
 *     verified.
 *   - Cookie attributes: the session cookie is HttpOnly, Secure, SameSite and
 *     host-only (no Domain).
 *   - Session fixation: an attacker-supplied cookie value is not honoured.
 *   - Revoked session: after sign-out the same cookie no longer authenticates.
 */

const ORIGIN = 'http://localhost:3000'
const EVIL_ORIGIN = 'http://evil.test'
const EMAIL = 'person@example.com'
const PASSWORD = 'sup3r-secret-pw'

function buildAuth(): { auth: Auth; tokens: { url: string; token: string }[] } {
  const tokens: { url: string; token: string }[] = []
  const auth = createAuth({
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    secret: 'test-secret-'.padEnd(32, 'x'),
    baseURL: ORIGIN,
    productName: 'Acme Metrics',
    trustedOrigins: [ORIGIN],
    // Force Secure so the attribute can be asserted regardless of the http test URL.
    secureCookies: true,
    sendVerificationEmail: async ({ url, token }) => {
      tokens.push({ url, token })
    },
  })
  return { auth, tokens }
}

function post(auth: Auth, path: string, body: unknown, headers: Record<string, string> = {}) {
  return auth.handler(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
      body: JSON.stringify(body),
    }),
  )
}

function get(auth: Auth, path: string, headers: Record<string, string> = {}) {
  return auth.handler(new Request(`${ORIGIN}${path}`, { headers: { origin: ORIGIN, ...headers } }))
}

function sessionCookie(res: Response): { name: string; value: string; raw: string } | null {
  for (const raw of res.headers.getSetCookie()) {
    const pair = raw.split(';')[0] ?? ''
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (name.includes('oa_session')) return { name, value, raw }
  }
  return null
}

async function signUp(auth: Auth, origin: string = ORIGIN): Promise<Response> {
  return post(
    auth,
    '/api/auth/sign-up/email',
    { email: EMAIL, password: PASSWORD, name: 'Person' },
    { origin },
  )
}

async function verify(auth: Auth, token: string): Promise<void> {
  await get(auth, `/api/auth/verify-email?token=${encodeURIComponent(token)}`)
}

async function signIn(auth: Auth): Promise<Response> {
  return post(auth, '/api/auth/sign-in/email', { email: EMAIL, password: PASSWORD })
}

describe('auth session security', () => {
  let auth: Auth
  let tokens: { url: string; token: string }[]

  beforeEach(() => {
    ;({ auth, tokens } = buildAuth())
  })

  it('rejects a credentialed state-changing request from an untrusted origin (CSRF)', async () => {
    // Better Auth validates the origin only when the request carries a cookie —
    // the case that actually enables CSRF, since that is when a browser attaches
    // the victim's session automatically. So the attack is a cookie-bearing
    // request whose Origin is the attacker's site.
    await signUp(auth)
    await verify(auth, tokens[0]?.token as string)
    const signedIn = await signIn(auth)
    const cookie = sessionCookie(signedIn)
    expect(cookie).not.toBeNull()
    const header = `${cookie?.name}=${cookie?.value}`

    const forged = await auth.handler(
      new Request(`${ORIGIN}/api/auth/sign-out`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: EVIL_ORIGIN, cookie: header },
        body: '{}',
      }),
    )
    expect(forged.ok).toBe(false)
    expect(forged.status).toBe(403)

    // The same request from the trusted origin is allowed, so the rejection is
    // the origin check and not a broken endpoint.
    const legit = await post(auth, '/api/auth/sign-out', {}, { cookie: header })
    expect(legit.ok).toBe(true)
  })

  it('refuses password sign-in until the email is verified', async () => {
    const created = await signUp(auth)
    expect(created.ok).toBe(true)

    const beforeVerify = await signIn(auth)
    expect(beforeVerify.ok).toBe(false)
    expect(beforeVerify.status).toBe(403)
  })

  it('sets a host-only, HttpOnly, Secure, SameSite session cookie on sign-in', async () => {
    await signUp(auth)
    const token = tokens[0]?.token
    expect(token).toBeDefined()
    await verify(auth, token as string)

    const res = await signIn(auth)
    expect(res.ok).toBe(true)

    const cookie = sessionCookie(res)
    expect(cookie, 'a session cookie must be set on sign-in').not.toBeNull()
    const raw = cookie?.raw ?? ''
    expect(raw).toMatch(/HttpOnly/i)
    expect(raw).toMatch(/Secure/i)
    expect(raw).toMatch(/SameSite=Lax/i)
    // Host-only: never scoped to a parent domain.
    expect(raw).not.toMatch(/Domain=/i)
  })

  it('does not honour an attacker-supplied session cookie value (fixation)', async () => {
    const res = await get(auth, '/api/auth/get-session', {
      cookie: '__Secure-oa_session=attacker-chosen-value',
    })
    const body = (await res.json().catch(() => null)) as { session?: unknown } | null
    expect(body?.session ?? null).toBeNull()
  })

  it('stops authenticating a session after sign-out (revocation)', async () => {
    await signUp(auth)
    await verify(auth, tokens[0]?.token as string)
    const signedIn = await signIn(auth)
    const cookie = sessionCookie(signedIn)
    expect(cookie).not.toBeNull()
    const header = `${cookie?.name}=${cookie?.value}`

    const before = await get(auth, '/api/auth/get-session', { cookie: header })
    const beforeBody = (await before.json().catch(() => null)) as { session?: unknown } | null
    expect(beforeBody?.session ?? null).not.toBeNull()

    const signedOut = await post(auth, '/api/auth/sign-out', {}, { cookie: header })
    expect(signedOut.ok).toBe(true)

    const after = await get(auth, '/api/auth/get-session', { cookie: header })
    const afterBody = (await after.json().catch(() => null)) as { session?: unknown } | null
    expect(afterBody?.session ?? null).toBeNull()
  })
})
