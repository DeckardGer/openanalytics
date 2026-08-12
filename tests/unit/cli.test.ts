import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EXIT_CODES,
  exitCodeForApiError,
  parseScopes,
  createCredentialStore,
  describeProtection,
  run,
} from '@openanalytics/cli'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * The CLI (ADR-0043 D10; docs snapshot 02 §20).
 *
 * Two things here are **contract** and are therefore pinned rather than
 * described: the exit-code table, and `--json` on every command. A script that
 * branches on `$?` is a consumer exactly like a client that branches on
 * `error.code`, and a renumbering that no test notices is a silent breaking
 * change for everybody who wrote one.
 *
 * `run` takes its streams, its clock, its `fetch` and its credential path as
 * arguments and returns an exit code instead of calling `process.exit`, which is
 * what lets every case below be an ordinary test rather than a spawned child.
 */

const BASE = 'https://api.test'

let home: string
let credentialFile: string
let out: string[]
let err: string[]

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'oa-cli-'))
  credentialFile = join(home, 'credentials.json')
  out = []
  err = []
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const START = 1_700_000_000_000

/**
 * A clock that advances when the CLI sleeps.
 *
 * **Not a constant, and this matters more than it looks.** The poll loop's only
 * exit besides an answer is the server's `expires_in` deadline, measured against
 * this clock. With a frozen clock a broken `isDeviceTokenPending` — one that
 * treated `access_denied` as retryable — would loop *forever* instead of
 * failing, and the test pinning that behaviour would hang CI rather than report
 * it. Found by breaking it: a test that cannot fail fast is a test that pins
 * nothing you will ever see.
 */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let current = START
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms
    },
  }
}

const invoke = (argv: string[], fetchImpl?: typeof fetch, clock = fakeClock()) =>
  run({
    argv,
    env: { OA_API_URL: BASE },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    credentialFile,
    now: clock.now,
    // No real sleeping: the poll's cadence is the server's to set, and skipping
    // it still advances the clock so the deadline is reachable.
    sleep: clock.sleep,
    ...(fetchImpl ? { fetchImpl } : {}),
  })

/** A `fetch` that answers a scripted list of routes, in order of registration. */
function scripted(routes: { match: RegExp; reply: () => Response }[]): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const route = routes.find((candidate) => candidate.match.test(url))
    if (!route) throw new Error(`no scripted route for ${url}`)
    return route.reply()
  }) as unknown as typeof fetch
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

describe('the exit-code table', () => {
  it('is the nine values documented in the usage text, and each is distinct', () => {
    // A renumbering here breaks every script anybody wrote. Compared as a whole
    // object rather than value by value, so an added code has to be added here
    // too — the same reason the scope vocabulary is compared as a list.
    expect(EXIT_CODES).toEqual({
      ok: 0,
      failure: 1,
      usage: 2,
      unauthenticated: 3,
      forbidden: 4,
      notFound: 5,
      rateLimited: 6,
      rangeTooLarge: 7,
      unavailable: 8,
    })
    expect(new Set(Object.values(EXIT_CODES)).size).toBe(Object.values(EXIT_CODES).length)
  })

  it('maps each API error code to the action a script can take', () => {
    // Keyed on `error.code`, never on the HTTP status: `VALIDATION_FAILED`,
    // `RESOLUTION_NOT_AVAILABLE` and `RANGE_TOO_LARGE` are all 400 and only the
    // last means "ask for less".
    expect(exitCodeForApiError('UNAUTHENTICATED')).toBe(EXIT_CODES.unauthenticated)
    expect(exitCodeForApiError('FORBIDDEN')).toBe(EXIT_CODES.forbidden)
    expect(exitCodeForApiError('SITE_NOT_FOUND')).toBe(EXIT_CODES.notFound)
    expect(exitCodeForApiError('RATE_LIMITED')).toBe(EXIT_CODES.rateLimited)
    expect(exitCodeForApiError('RANGE_TOO_LARGE')).toBe(EXIT_CODES.rangeTooLarge)
    expect(exitCodeForApiError('SERVICE_UNAVAILABLE')).toBe(EXIT_CODES.unavailable)
    expect(exitCodeForApiError('VALIDATION_FAILED')).toBe(EXIT_CODES.failure)
    // An unknown code is a failure, not a success. The direction matters: a
    // future error code must not exit 0 until somebody maps it.
    expect(exitCodeForApiError('SOMETHING_NEW')).toBe(EXIT_CODES.failure)
  })

  it('exits 2 with no command and 0 for --help', async () => {
    expect(await invoke([])).toBe(EXIT_CODES.usage)
    out.length = 0
    expect(await invoke(['--help'])).toBe(EXIT_CODES.ok)
    expect(out.join('\n')).toContain('oa stats')
  })

  it('exits 2 on an unknown command and on a missing required flag', async () => {
    expect(await invoke(['teleport'])).toBe(EXIT_CODES.usage)
    expect(await invoke(['stats'])).toBe(EXIT_CODES.usage)
  })

  it('exits 3 when nothing is logged in', async () => {
    expect(await invoke(['sites'])).toBe(EXIT_CODES.unauthenticated)
  })
})

describe('oa login', () => {
  const deviceRoutes = (tokenReplies: (() => Response)[]) => {
    let i = 0
    return scripted([
      {
        match: /\/api\/auth\/device\/code$/u,
        reply: () =>
          json({
            device_code: 'dev-1',
            user_code: 'WDJBMJHT',
            verification_uri: `${BASE}/oauth/device`,
            verification_uri_complete: `${BASE}/oauth/device?user_code=WDJBMJHT`,
            interval: 5,
            expires_in: 600,
          }),
      },
      {
        match: /\/v1\/oauth\/device\/token$/u,
        reply: () => {
          const reply = tokenReplies[Math.min(i, tokenReplies.length - 1)]
          i += 1
          return (reply as () => Response)()
        },
      },
    ])
  }

  const granted = () =>
    json({
      access_token: 'a'.repeat(32),
      refresh_token: 'r'.repeat(32),
      expires_in: 3600,
      scope: 'site:read analytics:read',
    })

  it('prints the code and the URL before it starts polling', async () => {
    const code = await invoke(['login'], deviceRoutes([granted]))
    expect(code).toBe(EXIT_CODES.ok)
    // On stderr, so `--json` piped to a file still carries only the result.
    expect(err.join('\n')).toContain('WDJBMJHT')
    expect(err.join('\n')).toContain('/oauth/device?user_code=WDJBMJHT')
  })

  it('keeps polling through authorization_pending and slow_down', async () => {
    const pending = () => json({ error: 'authorization_pending', error_description: 'wait' }, 400)
    const slowDown = () => json({ error: 'slow_down', error_description: 'slower' }, 400)
    expect(await invoke(['login'], deviceRoutes([pending, slowDown, pending, granted]))).toBe(
      EXIT_CODES.ok,
    )
    expect(readFileSync(credentialFile, 'utf8')).toContain('a'.repeat(32))
  })

  it('stops on access_denied rather than polling forever', async () => {
    // The failure this pins: `isDeviceTokenPending` deciding wrongly would make
    // the CLI poll until the code expires after somebody clicked Deny.
    const denied = () => json({ error: 'access_denied', error_description: 'denied' }, 400)
    expect(await invoke(['login'], deviceRoutes([denied]))).toBe(EXIT_CODES.forbidden)
  })

  it('gives up at the server’s deadline rather than polling forever', async () => {
    // The bound is `expires_in`, not a timeout of the CLI's invention — so a
    // server that answers `authorization_pending` for ever still ends in a
    // refusal a person can act on, and this test ends at all.
    const pending = () => json({ error: 'authorization_pending' }, 400)
    expect(await invoke(['login'], deviceRoutes([pending]))).toBe(EXIT_CODES.unauthenticated)
    expect(err.join(' ')).toContain('expired')
  })

  it('stops on expired_token', async () => {
    const expired = () => json({ error: 'expired_token', error_description: 'gone' }, 400)
    expect(await invoke(['login'], deviceRoutes([expired]))).toBe(EXIT_CODES.unauthenticated)
  })

  it('says where the token went and what is actually protecting it (D10)', async () => {
    await invoke(['login', '--json'], deviceRoutes([granted]))
    const printed = JSON.parse(out.join('\n')) as {
      credential_path: string
      protection: string
      protection_detail: string
    }
    expect(printed.credential_path).toBe(credentialFile)
    // D10's condition, and the reason it is a condition: a token in a plain file
    // is acceptable only if the CLI says so out loud. Whatever the platform gave
    // us, the CLI reports it rather than claiming the best case.
    expect(['posix-0600', 'windows-acl', 'unrestricted']).toContain(printed.protection)
    if (printed.protection === 'unrestricted') {
      expect(printed.protection_detail).toContain('NOT restricted')
    } else {
      expect(printed.protection_detail).toContain('only by you')
    }
  })

  it('refuses a scope the server has never heard of, before any network call', async () => {
    const code = await invoke(['login', '--scope', 'everything:read'], scripted([]))
    expect(code).toBe(EXIT_CODES.usage)
    expect(err.join('\n')).toContain('Unknown scope')
  })
})

describe('parseScopes', () => {
  it('defaults to the two scopes a stats command needs', () => {
    expect(parseScopes(undefined)).toEqual(['site:read', 'analytics:read'])
  })

  it('folds in the minimum, as the server does', () => {
    // A credential that can read analytics but not the site those numbers belong
    // to is one nobody meant to ask for.
    expect(parseScopes('analytics:read')).toEqual(['site:read', 'analytics:read'])
  })

  it('accepts the two scopes only a person can hold', () => {
    expect(parseScopes('realtime:read revenue:read')).toEqual([
      'site:read',
      'realtime:read',
      'revenue:read',
    ])
  })

  it('deduplicates rather than sending a scope twice', () => {
    expect(parseScopes('site:read site:read analytics:read')).toEqual([
      'site:read',
      'analytics:read',
    ])
  })
})

describe('the credential store', () => {
  it('round-trips a credential and restricts the file', () => {
    const store = createCredentialStore(credentialFile)
    const protection = store.write({
      accessToken: 'a'.repeat(32),
      refreshToken: 'r'.repeat(32),
      expiresAt: new Date(START).toISOString(),
      apiBaseUrl: BASE,
      scope: 'site:read',
    })
    expect(store.read()?.accessToken).toBe('a'.repeat(32))

    // The measurement this file exists downstream of: on Windows `chmod` is a
    // no-op, so the POSIX branch must not be asserted there — what is asserted
    // is that the CLI *reports* whichever protection it actually got.
    if (process.platform === 'win32') {
      expect(['windows-acl', 'unrestricted']).toContain(protection.kind)
    } else {
      expect(statSync(credentialFile).mode & 0o777).toBe(0o600)
      expect(protection.kind).toBe('posix-0600')
    }
    expect(describeProtection(protection)).toMatch(/only by you|NOT restricted/u)
  })

  it('reads a missing file as "not logged in" rather than throwing', () => {
    expect(createCredentialStore(join(home, 'nope.json')).read()).toBeNull()
  })

  it('reads a corrupt file as "not logged in" too', () => {
    const store = createCredentialStore(credentialFile)
    store.write({
      accessToken: 'a'.repeat(32),
      refreshToken: 'r'.repeat(32),
      expiresAt: '',
      apiBaseUrl: BASE,
      scope: '',
    })
    // Truncated mid-write, which is what a killed process leaves behind. The
    // recovery is `oa login`, which overwrites it — the same thing a person
    // would do — so crashing here would only make that harder to reach.
    writeFileSync(credentialFile, '{"accessToken":')
    expect(store.read()).toBeNull()
  })

  it('removes the file on logout and says whether there was one', async () => {
    const store = createCredentialStore(credentialFile)
    store.write({
      accessToken: 'a'.repeat(32),
      refreshToken: 'r'.repeat(32),
      expiresAt: '',
      apiBaseUrl: BASE,
      scope: '',
    })
    expect(await invoke(['logout', '--json'])).toBe(EXIT_CODES.ok)
    expect(JSON.parse(out.join('\n'))).toMatchObject({ logged_out: true, removed: true })

    out.length = 0
    expect(await invoke(['logout', '--json'])).toBe(EXIT_CODES.ok)
    // Idempotent, and honest about it: logging out twice is not a failure and
    // does not claim to have removed something.
    expect(JSON.parse(out.join('\n'))).toMatchObject({ removed: false })
  })
})

describe('oa sites and oa stats', () => {
  const loggedIn = (expiresInMs = 3_600_000): void => {
    createCredentialStore(credentialFile).write({
      accessToken: 't'.repeat(32),
      refreshToken: 'r'.repeat(32),
      expiresAt: new Date(START + expiresInMs).toISOString(),
      apiBaseUrl: BASE,
      scope: 'site:read analytics:read',
    })
  }

  const siteList = () =>
    json({
      items: [
        {
          site_id: 'a1b2c3d4-0000-4000-8000-000000000001',
          slug: 'my-blog',
          name: 'Blog',
          status: 'active',
          role: 'owner',
        },
      ],
    })

  it('lists sites as JSON and as columns from the same object', async () => {
    loggedIn()
    await invoke(['sites', '--json'], scripted([{ match: /\/v1\/read\/sites$/u, reply: siteList }]))
    const asJson = JSON.parse(out.join('\n')) as { items: { slug: string }[] }
    expect(asJson.items[0]?.slug).toBe('my-blog')

    out.length = 0
    await invoke(['sites'], scripted([{ match: /\/v1\/read\/sites$/u, reply: siteList }]))
    // The human form is a rendering of the same answer, never a second query, so
    // a person and a script can never see different numbers.
    expect(out.join('\n')).toContain('my-blog')
    expect(out.join('\n')).toContain('owner')
  })

  it('turns a slug into an id before selecting the site', async () => {
    loggedIn()
    const seen: string[] = []
    const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const headers = new Headers(init?.headers ?? {})
      if (url.includes('/v1/read/sites')) return siteList()
      seen.push(headers.get('x-oa-site') ?? '')
      return json({ totals: { pageviews: 12 } })
    }) as unknown as typeof fetch

    expect(await invoke(['stats', '--site', 'my-blog', '--json'], fetchImpl)).toBe(EXIT_CODES.ok)
    // The reason `GET /v1/read/sites` is served to both credential kinds: a human
    // types a slug and the header takes an id.
    expect(seen).toEqual(['a1b2c3d4-0000-4000-8000-000000000001'])
  })

  it('sends an id straight through without a lookup round trip', async () => {
    loggedIn()
    const urls: string[] = []
    const fetchImpl = (async (input: URL | RequestInfo) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      urls.push(url)
      return json({ totals: { pageviews: 1 } })
    }) as unknown as typeof fetch

    await invoke(['stats', '--site', 'a1b2c3d4-0000-4000-8000-000000000001', '--json'], fetchImpl)
    expect(urls.some((url) => url.includes('/v1/read/sites'))).toBe(false)
  })

  it('exits 5 for a slug the caller cannot see', async () => {
    loggedIn()
    const code = await invoke(
      ['stats', '--site', 'not-mine'],
      scripted([{ match: /\/v1\/read\/sites$/u, reply: () => json({ items: [] }) }]),
    )
    expect(code).toBe(EXIT_CODES.notFound)
  })

  it('exits 7 and says to narrow when the range is too wide', async () => {
    loggedIn()
    const code = await invoke(
      ['stats', '--site', 'a1b2c3d4-0000-4000-8000-000000000001'],
      scripted([
        {
          match: /overview/u,
          reply: () =>
            json({ error: { code: 'RANGE_TOO_LARGE', message: 'ask for a narrower window' } }, 400),
        },
      ]),
    )
    expect(code).toBe(EXIT_CODES.rangeTooLarge)
    expect(err.join('\n')).toContain('narrower')
  })

  it('exits 6 and reports the wait when the budget is gone', async () => {
    loggedIn()
    const code = await invoke(
      ['stats', '--site', 'a1b2c3d4-0000-4000-8000-000000000001'],
      scripted([
        {
          match: /overview/u,
          reply: () =>
            json({ error: { code: 'RATE_LIMITED', message: 'budget spent' } }, 429, {
              'retry-after': '900',
            }),
        },
      ]),
    )
    expect(code).toBe(EXIT_CODES.rateLimited)
    expect(err.join('\n')).toContain('900s')
  })

  it('prints a failure as JSON when --json was asked for', async () => {
    loggedIn()
    await invoke(
      ['stats', '--site', 'a1b2c3d4-0000-4000-8000-000000000001', '--json'],
      scripted([
        {
          match: /overview/u,
          reply: () => json({ error: { code: 'FORBIDDEN', message: 'owner only' } }, 403),
        },
      ]),
    )
    // A `--json` consumer parsing stdout must be able to parse a failure too,
    // rather than getting prose where it expected an object.
    expect(() => JSON.parse(out.join('\n'))).not.toThrow()
    expect(JSON.parse(out.join('\n'))).toMatchObject({ error: { code: 'FORBIDDEN' } })
  })

  it('renews an expired access token silently and retries nothing else', async () => {
    // Expired an hour ago.
    loggedIn(-3_600_000)
    const calls: string[] = []
    const fetchImpl = (async (input: URL | RequestInfo) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push(url)
      if (url.includes('/api/auth/oauth2/token')) {
        return json({
          access_token: 'n'.repeat(32),
          refresh_token: 'r2'.repeat(16),
          expires_in: 3600,
          scope: 'site:read',
        })
      }
      return siteList()
    }) as unknown as typeof fetch

    expect(await invoke(['sites', '--json'], fetchImpl)).toBe(EXIT_CODES.ok)
    // The renewal is the authorization server's own endpoint — the device
    // exchange wrote a row in the shape it issues and reads, which is what makes
    // that exchange one edge rather than a second token system.
    expect(calls[0]).toContain('/api/auth/oauth2/token')
    expect(createCredentialStore(credentialFile).read()?.accessToken).toBe('n'.repeat(32))
  })

  it('exits 3 when the refresh token is dead too', async () => {
    loggedIn(-3_600_000)
    const code = await invoke(
      ['sites'],
      scripted([{ match: /oauth2\/token/u, reply: () => json({ error: 'invalid_grant' }, 401) }]),
    )
    expect(code).toBe(EXIT_CODES.unauthenticated)
    expect(err.join('\n')).toContain('oa login')
  })
})
