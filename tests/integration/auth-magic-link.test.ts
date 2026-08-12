import { createAuth, memoryAdapter, type Auth } from '@openanalytics/auth'
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * The magic-link door, driven against the real Better Auth request pipeline
 * over its in-memory adapter (no Postgres needed).
 *
 * The product model (decision 2026-07-26): email, Google and GitHub share one
 * approach — an unknown address gets an account on the link's first click, a
 * known one gets a session. There is no password and no separate sign-up, so
 * `disableSignUp` is deliberately NOT set on the plugin, and this suite is the
 * proof that both faces of that door actually open:
 *
 *   - Requesting a link never sends mail directly: the token leaves only
 *     through the injected callback (the outbox seam in production).
 *   - An unknown email + verify ⇒ an account exists and a session cookie is
 *     set (sign-up face).
 *   - A known email + verify ⇒ a session for that same account, not a second
 *     account (sign-in face).
 *   - A token is single-use, and a garbage token mints nothing — both fail by
 *     redirect, never with a session cookie.
 */

const ORIGIN = 'http://localhost:3000'
const EMAIL = 'person@example.com'

function buildAuth(): { auth: Auth; sent: { to: string; url: string; token: string }[] } {
  const sent: { to: string; url: string; token: string }[] = []
  const auth = createAuth({
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    secret: 'test-secret-'.padEnd(32, 'x'),
    baseURL: ORIGIN,
    productName: 'Acme Metrics',
    trustedOrigins: [ORIGIN],
    sendVerificationEmail: async () => {},
    sendMagicLinkEmail: async (input) => {
      sent.push(input)
    },
  })
  return { auth, sent }
}

function sessionCookie(res: Response): string | null {
  for (const raw of res.headers.getSetCookie()) {
    const pair = raw.split(';')[0] ?? ''
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    if (pair.slice(0, eq).trim().includes('oa_session')) return pair.trim()
  }
  return null
}

async function requestLink(auth: Auth, email: string = EMAIL): Promise<Response> {
  return auth.handler(
    new Request(`${ORIGIN}/api/auth/sign-in/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({
        email,
        callbackURL: `${ORIGIN}/dashboard`,
        errorCallbackURL: `${ORIGIN}/login`,
      }),
    }),
  )
}

/** Follows the emailed link. `redirect: 'manual'`-style — the handler answers
 * with a redirect Response; the session cookie (or its absence) is the verdict. */
async function clickLink(auth: Auth, url: string): Promise<Response> {
  return auth.handler(new Request(url, { headers: { origin: ORIGIN } }))
}

async function getSession(auth: Auth, cookie: string): Promise<unknown> {
  const res = await auth.handler(
    new Request(`${ORIGIN}/api/auth/get-session`, { headers: { origin: ORIGIN, cookie } }),
  )
  const body = (await res.json().catch(() => null)) as { session?: unknown } | null
  return body?.session ?? null
}

describe('magic-link door', () => {
  let auth: Auth
  let sent: { to: string; url: string; token: string }[]

  beforeEach(() => {
    ;({ auth, sent } = buildAuth())
  })

  it('sends the link only through the injected callback', async () => {
    const res = await requestLink(auth)
    expect(res.ok).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toBe(EMAIL)
    expect(sent[0]?.url).toContain('/magic-link/verify')
    // Requesting a link is not signing in; no cookie yet.
    expect(sessionCookie(res)).toBeNull()
  })

  it('creates the account on first click for an unknown email (sign-up face)', async () => {
    await requestLink(auth)
    const verified = await clickLink(auth, sent[0]?.url as string)

    const cookie = sessionCookie(verified)
    expect(cookie, 'the first click must mint a session').not.toBeNull()

    const session = (await getSession(auth, cookie as string)) as {
      userId?: string
    } | null
    expect(session).not.toBeNull()
  })

  it('signs the same account in on a later link (sign-in face)', async () => {
    // First door: account is created.
    await requestLink(auth)
    const first = await clickLink(auth, sent[0]?.url as string)
    const firstCookie = sessionCookie(first) as string
    const firstSession = (await getSession(auth, firstCookie)) as { userId?: string } | null

    // Second door, same address: a session for the same user, not a twin account.
    await requestLink(auth)
    expect(sent).toHaveLength(2)
    const second = await clickLink(auth, sent[1]?.url as string)
    const secondCookie = sessionCookie(second) as string
    const secondSession = (await getSession(auth, secondCookie)) as { userId?: string } | null

    expect(secondSession).not.toBeNull()
    expect(secondSession?.userId).toBe(firstSession?.userId)
  })

  it('consumes the token on first use', async () => {
    await requestLink(auth)
    const url = sent[0]?.url as string
    const first = await clickLink(auth, url)
    expect(sessionCookie(first)).not.toBeNull()

    const replay = await clickLink(auth, url)
    expect(sessionCookie(replay), 'a replayed link must not mint a session').toBeNull()
  })

  it('mints nothing for a forged token', async () => {
    const forged = await clickLink(
      auth,
      `${ORIGIN}/api/auth/magic-link/verify?token=forged&callbackURL=${encodeURIComponent(`${ORIGIN}/dashboard`)}`,
    )
    expect(sessionCookie(forged)).toBeNull()
  })
})
