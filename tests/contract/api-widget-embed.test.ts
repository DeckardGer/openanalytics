import { loadServiceEnv } from '@openanalytics/domain'
import type { Database, ResolvedPublicWidget } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'

/**
 * The embed vehicle: `GET /embed/{widget_id}` (ADR-0045, CP3).
 *
 * The document CP2's JSON read is consumed by. It is the api's own HTML, at the
 * api's root beside `/oauth/*`, and that placement is forced rather than
 * preferred (D13): the document has to answer
 * `Content-Security-Policy: frame-ancestors` from the widget's `allowed_origins`,
 * and that list lives only on the widget row — it is deliberately absent from the
 * public read, so a frontend-served page could never emit the header without a
 * second, wider disclosure.
 *
 * What this suite proves, given that no local stack can serve real widget data
 * (there is no query gateway and no Valkey here, and the JSON the document
 * fetches is fetched by a *browser*, not by this test):
 *
 * - **The document is a document**: status, content type, `nosniff`, and the one
 *   staleness bound D12 states — the same `WIDGET_READ_CACHE_MAX_AGE_SECONDS` the
 *   JSON read uses, because the document's CSP *is* a projection of
 *   `allowed_origins` and must not outlive it.
 * - **The origin policy is in the header**, in all three shapes an allowlist can
 *   take: empty renders nowhere, `["*"]` renders anywhere, and a real list names
 *   its members and nobody else (D4).
 * - **One indistinguishable `404`** (D7) across the same four causes the JSON read
 *   is pinned on, *plus* a malformed id — which is refused without a database
 *   read at all.
 * - **Nothing owner-authored is interpolated into the markup.** The title, the
 *   paths, the referrer domains and the city names are attacker-influenceable
 *   strings; the server-rendered document therefore carries **none** of them, and
 *   the client renders every one through `textContent`.
 * - **Zero external requests.** No font, no image, no CDN, and exactly one fetch
 *   target: the same-origin relative JSON read.
 *
 * **Deliberately not proven here, and not by any local run:** that a real browser
 * on a foreign origin renders the frame, and that `frame-ancestors` blocks one
 * that is not on the list. Both are CP4's production live matrix — a browser, a
 * real widget and a real page — and asserting them from a `fetch` in vitest would
 * be asserting that we sent a header, which is what the tests below already say.
 */

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const WIDGET = 'w3f9xk21qm70c4bd'
const UNKNOWN = 'wzzzzzzzzzzzzzzz'

const ALLOWED_ORIGIN = 'https://shop.example.com'
const SECOND_ORIGIN = 'https://blog.example.com'

/** The four self-containment directives every widget document carries, whatever
 * its origin list says. Written out here rather than imported, so a change to the
 * policy has to be typed twice — once in the route and once in the decision this
 * file records. */
const SELF_CONTAINED =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'"

function widgetRow(overrides: Partial<ResolvedPublicWidget> = {}): ResolvedPublicWidget {
  return {
    id: WIDGET,
    siteId: SITE,
    surface: 'pages',
    title: 'Most read this week',
    range: '7d',
    limit: 5,
    allowedOrigins: [ALLOWED_ORIGIN],
    enabled: true,
    siteStatus: 'active',
    configVersion: 7,
    reportingTimezone: 'Europe/Istanbul',
    firstEventAt: new Date('2026-06-02T08:14:09.221Z'),
    publishedImportRunId: null,
    importCutoverDate: null,
    ...overrides,
  } as ResolvedPublicWidget
}

const stored = { value: widgetRow() as ResolvedPublicWidget | null }
/** Every id the route asked the repository for — so "a malformed id never
 * reaches the database" is provable rather than asserted. */
const resolved: string[] = []

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    resolvePublicWidget: async (_db: unknown, id: string) => {
      resolved.push(id)
      return stored.value === null ? null : { ...stored.value, id }
    },
  }
})

const { createApp } = await import('../../apps/api/src/app.ts')
const { InProcessRateLimiter } = await import('../../apps/api/src/http/rate-limit.ts')

/** A budget small enough to exhaust in a test, wired the way production wires
 * it: **one** limiter object, handed to both widget doors. */
function buildApp(options: { readonly perMinute?: number } = {}) {
  const { logger } = createCapturedLogger()
  const limit = options.perMinute ?? 500
  return createApp({
    service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
    logger,
    env: loadServiceEnv('api', testEnv()),
    db: {} as Database,
    widgetRead: {
      rateLimiter: new InProcessRateLimiter({ requestsPerMinute: limit, burst: limit }),
      cacheMaxAgeSeconds: 60,
      realtimeCacheMaxAgeSeconds: 10,
    },
  })
}

const url = (id = WIDGET) => `http://api.test/embed/${id}`

async function get(app: ReturnType<typeof buildApp>, id = WIDGET, ip?: string): Promise<Response> {
  const headers: Record<string, string> = {}
  if (ip !== undefined) headers['x-forwarded-for'] = ip
  return app.fetch(new Request(url(id), { headers }))
}

/** The JSON read CP2 serves, on the other door of the same budget. */
async function json(app: ReturnType<typeof buildApp>, id = WIDGET, ip?: string): Promise<Response> {
  const headers: Record<string, string> = {}
  if (ip !== undefined) headers['x-forwarded-for'] = ip
  return app.fetch(new Request(`http://api.test/v1/widget/${id}`, { headers }))
}

/** The served document, as text. */
async function markup(app: ReturnType<typeof buildApp>, id = WIDGET): Promise<string> {
  return (await get(app, id)).text()
}

beforeEach(() => {
  stored.value = widgetRow()
  resolved.length = 0
})

describe('the document itself', () => {
  it('is HTML, unsniffable, and served at the api root outside /v1', async () => {
    const res = await get(buildApp())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    // The one header that stops a browser from deciding for itself what this is.
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    const body = await res.text()
    expect(body.startsWith('<!doctype html>')).toBe(true)
  })

  it('states the same staleness bound the JSON read does (ADR-0045, D12)', async () => {
    // The document's CSP is a projection of `allowed_origins`, so it may not
    // outlive the answer it frames: one number, one story. A realtime widget's
    // *data* is the JSON's 10-second concern; the document is static either way.
    const res = await get(buildApp())
    expect(res.headers.get('cache-control')).toBe('public, max-age=60')
    stored.value = widgetRow({ surface: 'realtime', range: null, limit: null, title: null })
    const realtime = await get(buildApp())
    expect(realtime.headers.get('cache-control')).toBe('public, max-age=60')
  })

  it('makes no external request of any kind', async () => {
    const body = await markup(buildApp())
    // No subresource of any sort: a widget document that fetched a webfont would
    // hand a third-party host the reading list of somebody else's page.
    expect(body).not.toMatch(/<(?:img|link|iframe|object|embed)\b/iu)
    expect(body).not.toMatch(/<script[^>]+\bsrc=/iu)
    expect(body).not.toContain('@import')
    expect(body).not.toContain('url(')
    // Exactly one absolute URL, and it is not a request the document makes: the
    // SVG namespace is an identifier. Pinned as a closed list so a second URL (a
    // webfont, a beacon) is a deliberate change, not a drive-by. This app is built
    // with no `watermarkUrl`, which is the self-hosted default; configured, the
    // footer's href joins the list as a navigation target a reader must click —
    // the CSP above already proves nothing is fetched either way.
    expect(body.match(/https?:\/\/[^\s"'()]+/gu) ?? []).toEqual(['http://www.w3.org/2000/svg'])
  })

  it('fetches one same-origin relative URL, carrying the id exactly once', async () => {
    const body = await markup(buildApp())
    expect(body).toContain('/v1/widget/')
    // Exactly once: the id is the whole credential, and a document that repeated
    // it (in a link, a title, a data attribute) would be that many more places to
    // get the escaping wrong.
    expect(body.split(WIDGET).length - 1).toBe(1)
    // Relative, so the iframe path needs no CORS at all (D13): the document and
    // the JSON read are the same origin by construction, not by configuration.
    expect(body).not.toMatch(/fetch\(\s*['"`]https?:/u)
  })

  it('interpolates the id only after re-checking it against the contract pattern', async () => {
    // Belt and braces: the route parameter already matched, but the id is the one
    // caller-supplied string in this document and it lands inside a JavaScript
    // literal. Proven by the shape of what is emitted — a bare, quoted id.
    const body = await markup(buildApp())
    expect(body).toMatch(new RegExp(`['"]${WIDGET}['"]`, 'u'))
  })
})

describe('nothing owner-authored reaches the markup', () => {
  it('never server-interpolates the title, hostile or otherwise', async () => {
    stored.value = widgetRow({ title: '<script>alert(1)</script>' })
    const body = await markup(buildApp())
    // Not the raw string …
    expect(body).not.toContain('<script>alert(1)</script>')
    // … and not an escaped one either: the title is not in this document at all.
    // It is rendered client-side from the JSON, through `textContent`, which is
    // the only escaping rule that cannot be got wrong by a later edit.
    expect(body).not.toContain('alert(1)')
    expect(body).not.toContain('alert')
  })

  it('carries no title even when it is perfectly innocent', async () => {
    // The point is structural, not a filter: if an innocent title were
    // interpolated, a hostile one would be one escaping bug away from executing.
    const body = await markup(buildApp())
    expect(body).not.toContain('Most read this week')
  })

  it('publishes neither the site id nor the origin allowlist in the body', async () => {
    stored.value = widgetRow({ allowedOrigins: [ALLOWED_ORIGIN, SECOND_ORIGIN] })
    const body = await markup(buildApp())
    expect(body).not.toContain(SITE)
    // The list is a header — a browser-enforced rendering policy — and a reader
    // has no business learning the owner's other pages from the document text.
    expect(body).not.toContain(ALLOWED_ORIGIN)
    expect(body).not.toContain(SECOND_ORIGIN)
  })

  it('renders every string through textContent, never innerHTML', async () => {
    const body = await markup(buildApp())
    // Paths, referrer domains and city names are attacker-influenceable strings
    // that arrive in the JSON. `innerHTML` anywhere in this document would be one
    // careless assignment away from executing them inside our own origin.
    expect(body).not.toContain('innerHTML')
    expect(body).not.toContain('outerHTML')
    expect(body).not.toContain('insertAdjacentHTML')
    expect(body).not.toContain('document.write')
    expect(body).toContain('textContent')
  })
})

describe('frame-ancestors is the origin policy (ADR-0045, D4)', () => {
  const csp = (res: Response) => res.headers.get('content-security-policy')

  it("renders nowhere on an empty list — 'none', because an omission fails closed", async () => {
    stored.value = widgetRow({ allowedOrigins: [] })
    expect(csp(await get(buildApp()))).toBe(`${SELF_CONTAINED}; frame-ancestors 'none'`)
  })

  it('renders anywhere on `["*"]`, which the owner had to write on purpose', async () => {
    stored.value = widgetRow({ allowedOrigins: ['*'] })
    expect(csp(await get(buildApp()))).toBe(`${SELF_CONTAINED}; frame-ancestors *`)
  })

  it('names every member of a real list, space-separated in source-list syntax', async () => {
    stored.value = widgetRow({ allowedOrigins: [ALLOWED_ORIGIN, SECOND_ORIGIN] })
    expect(csp(await get(buildApp()))).toBe(
      `${SELF_CONTAINED}; frame-ancestors ${ALLOWED_ORIGIN} ${SECOND_ORIGIN}`,
    )
  })

  it('names one member as itself, with no wildcarding of the host', async () => {
    // `app.getopen.so` and `evil-app.getopen.so` are different origins;
    // `frame-ancestors` compares hosts the same way `cors.ts` does, and nothing
    // here turns an exact entry into a suffix rule.
    stored.value = widgetRow({ allowedOrigins: ['https://app.getopen.so'] })
    expect(csp(await get(buildApp()))).toBe(
      `${SELF_CONTAINED}; frame-ancestors https://app.getopen.so`,
    )
  })

  it('does not use X-Frame-Options, which cannot express a list', async () => {
    const res = await get(buildApp())
    expect(res.headers.get('x-frame-options')).toBeNull()
  })

  it('keeps a stored entry that is not an origin out of the header entirely', async () => {
    // The write path validates every entry, so this row cannot exist today. It is
    // asserted anyway because a CSP is a *header*: a stored `evil.com; script-src
    // *` would append a directive rather than name an ancestor, and the direction
    // an unrecognised entry must fail in is closed.
    stored.value = widgetRow({
      allowedOrigins: ['https://ok.example.com', 'evil.example.com; script-src *'],
    })
    expect(csp(await get(buildApp()))).toBe(
      `${SELF_CONTAINED}; frame-ancestors https://ok.example.com`,
    )
  })

  it('falls back to nowhere when a list survives validation empty', async () => {
    stored.value = widgetRow({ allowedOrigins: ['not an origin at all'] })
    expect(csp(await get(buildApp()))).toBe(`${SELF_CONTAINED}; frame-ancestors 'none'`)
  })
})

describe('one indistinguishable 404, in HTML (ADR-0045, D7)', () => {
  async function snapshot(app: ReturnType<typeof buildApp>, id = WIDGET) {
    const res = await get(app, id)
    return {
      status: res.status,
      contentType: res.headers.get('content-type'),
      csp: res.headers.get('content-security-policy'),
      cacheControl: res.headers.get('cache-control'),
      nosniff: res.headers.get('x-content-type-options'),
      body: await res.text(),
    }
  }

  it('is byte-identical across all four causes and a malformed id', async () => {
    const app = buildApp()

    // 1. No such widget id.
    stored.value = null
    const unknown = await snapshot(app, UNKNOWN)
    // 2. The widget was deleted — the same absent row, reached by a real id.
    const deleted = await snapshot(app)
    // 3. `enabled: false`.
    stored.value = widgetRow({ enabled: false })
    const disabled = await snapshot(app)
    // 4. The site stopped paying. A widget id sits in the HTML of a page anyone
    //    can view, so a distinguishable "this site is suspended" would
    //    publish a customer's billing state to their own readers.
    stored.value = widgetRow({ siteStatus: 'suspended' })
    const blocked = await snapshot(app)
    // 5. And an id that never could have been one.
    const malformed = await snapshot(app, 'not-a-widget-id')

    expect(unknown.status).toBe(404)
    for (const [label, page] of [
      ['deleted', deleted],
      ['disabled', disabled],
      ['suspended', blocked],
      ['malformed', malformed],
    ] as const) {
      expect(page, label).toEqual(unknown)
    }
  })

  it('closes on every non-active lifecycle state', async () => {
    for (const status of ['suspended', 'deleting', 'deleted'] as const) {
      stored.value = widgetRow({ siteStatus: status })
      expect((await get(buildApp())).status, status).toBe(404)
    }
  })

  it('never touches the database for a malformed id', async () => {
    const app = buildApp()
    for (const bad of [
      'not-a-widget-id',
      'W3F9XK21QM70C4BD',
      'w-short',
      '../../etc/passwd',
      'x'.repeat(64),
    ]) {
      expect((await get(app, bad)).status, bad).toBe(404)
    }
    expect(resolved).toEqual([])
  })

  it('carries no trace of the widget it refused to serve', async () => {
    stored.value = widgetRow({ enabled: false })
    const res = await get(buildApp())
    const body = await res.text()
    // Not the origin list — a 404 that projected it would be an oracle for "this
    // origin is on some widget's list" — and not the title or the site.
    expect(res.headers.get('content-security-policy')).not.toContain(ALLOWED_ORIGIN)
    expect(body).not.toContain(ALLOWED_ORIGIN)
    expect(body).not.toContain('Most read this week')
    expect(body).not.toContain(SITE)
  })

  it('is not cacheable, so a re-enabled widget is not shadowed by its own refusal', async () => {
    stored.value = null
    const res = await get(buildApp(), UNKNOWN)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('is HTML, because an iframe showing a JSON error envelope is a worse answer', async () => {
    stored.value = null
    const res = await get(buildApp(), UNKNOWN)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await res.text()).toContain('Not found')
  })
})

/**
 * **The document is not an unlimited door** (ADR-0045, D5 as amended
 * 2026-08-07).
 *
 * It is anonymous and it performs a Postgres read per request, and no other
 * public route on this api is unlimited — §20's "the widget endpoints get their
 * own rate limit" is plural. The budget is not a second one: it is **the same
 * limiter instance and the same (IP, widget id) key** the JSON read charges, so
 * there is no new config group and no new number anybody has to reason about. A
 * full first paint costs two tokens of the 120/minute budget — the document and
 * the one JSON read it makes — and the realtime poll loop afterwards touches only
 * the JSON, so D5's ~30-simultaneous-tab arithmetic is unchanged in steady state.
 */
describe('both widget doors spend one budget (ADR-0045, D5)', () => {
  it('refuses the document once the budget is gone', async () => {
    const app = buildApp({ perMinute: 2 })
    expect((await get(app, WIDGET, '203.0.113.7')).status).toBe(200)
    expect((await get(app, WIDGET, '203.0.113.7')).status).toBe(200)
    expect((await get(app, WIDGET, '203.0.113.7')).status).toBe(429)
  })

  it('is poorer for what the JSON read spent, and the JSON read for what it spent', async () => {
    // One bucket, not two lookalikes. Spending on either door has to be visible
    // from the other, or a spray costs half as much as the budget claims.
    const app = buildApp({ perMinute: 2 })
    expect((await json(app, WIDGET, '198.51.100.4')).status).not.toBe(429)
    expect((await get(app, WIDGET, '198.51.100.4')).status).toBe(200)
    expect((await get(app, WIDGET, '198.51.100.4')).status).toBe(429)

    // And the other way round: the document's spending closes the JSON door too.
    const other = buildApp({ perMinute: 2 })
    expect((await get(other, WIDGET, '198.51.100.9')).status).toBe(200)
    expect((await get(other, WIDGET, '198.51.100.9')).status).toBe(200)
    expect((await json(other, WIDGET, '198.51.100.9')).status).toBe(429)
  })

  it('keys per (IP, widget id), exactly as the JSON read does', async () => {
    const app = buildApp({ perMinute: 1 })
    expect((await get(app, WIDGET, '203.0.113.11')).status).toBe(200)
    expect((await get(app, WIDGET, '203.0.113.11')).status).toBe(429)
    // Another widget from the same address still has its own budget …
    expect((await get(app, 'w7bq04mz1ke82ahd', '203.0.113.11')).status).toBe(200)
    // … and another address still has this widget's.
    expect((await get(app, WIDGET, '203.0.113.12')).status).toBe(200)
  })

  it('charges before it judges the id, exactly as the JSON read does', async () => {
    // CP2's middleware charges before the handler knows anything about the id,
    // and this route mirrors that order rather than improving on it: two doors
    // that validate in different orders make one spray cost different amounts,
    // which is a difference an attacker gets to choose.
    const app = buildApp({ perMinute: 1 })
    expect((await get(app, 'not-a-widget-id', '203.0.113.13')).status).toBe(404)
    // The malformed request spent the token, so the well-formed one meets an
    // empty budget — and still never reaches the database.
    resolved.length = 0
    expect((await get(app, 'not-a-widget-id', '203.0.113.13')).status).toBe(429)
    expect(resolved).toEqual([])
  })

  it('answers HTML, because an iframe cannot render a JSON envelope', async () => {
    const app = buildApp({ perMinute: 1 })
    await get(app, WIDGET, '203.0.113.14')
    const res = await get(app, WIDGET, '203.0.113.14')
    expect(res.status).toBe(429)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    // A refusal is not an answer: it must not be cached over the widget it is
    // temporarily standing in for.
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    // The same value the JSON door sets, from the same decision.
    expect(res.headers.get('retry-after')).not.toBeNull()
    const body = await res.text()
    expect(body).toContain('Too many requests')
    expect(body).not.toContain('RATE_LIMITED')
  })

  it('says nothing about the widget it did not look up', async () => {
    // The refusal happens before the row is read, so it cannot leak — pinned so
    // that stays true if the order is ever revisited. Each id has its own bucket
    // (that is what "per (IP, widget id)" means), so each is exhausted in turn.
    const app = buildApp({ perMinute: 1 })
    // Spend each bucket's one token …
    await get(app, WIDGET, '203.0.113.15')
    stored.value = null
    await get(app, UNKNOWN, '203.0.113.15')
    // … and from here on, nothing may reach the repository at all.
    resolved.length = 0
    stored.value = widgetRow()
    const live = await get(app, WIDGET, '203.0.113.15')
    stored.value = null
    const absent = await get(app, UNKNOWN, '203.0.113.15')

    expect(live.status).toBe(429)
    expect(absent.status).toBe(429)
    // A widget that exists and one that never did are refused identically, and
    // neither refusal projects an origin list.
    expect(await absent.text()).toBe(await live.text())
    expect(live.headers.get('content-security-policy')).toBe(
      absent.headers.get('content-security-policy'),
    )
    expect(live.headers.get('content-security-policy')).not.toContain(ALLOWED_ORIGIN)
    expect(resolved).toEqual([])
  })
})
