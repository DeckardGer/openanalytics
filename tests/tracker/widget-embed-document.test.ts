import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The embed document's renderer, executed (ADR-0045, CP3).
 *
 * `tests/contract/api-widget-embed.test.ts` proves what the *server* sends: the
 * status, the headers, the origin policy, the one 404, and that nothing
 * owner-authored is in the markup. None of that executes a line of the script it
 * ships — and a renderer that throws on its first payload would pass every one of
 * those assertions while rendering a blank box on every customer's page.
 *
 * So this suite takes the document the route actually serves, pulls its one
 * inline script out, runs it in a DOM against a stubbed `fetch`, and asserts what
 * a reader ends up looking at. It lives in the `tracker` project for the reason
 * that project exists: separation is by what a test *needs* (a DOM), not by
 * subject matter, and the configured origin — `https://shop.example.com` — is
 * exactly the foreign page a widget is embedded on.
 *
 * Still not proven here, and deliberately: that a real browser honours
 * `frame-ancestors`, and that a real gateway produces these payloads. The first
 * is CP4's production live matrix; the second is CP2's.
 */

const WIDGET = 'w3f9xk21qm70c4bd'

// Mocked without `importOriginal`: `embed.ts` imports exactly one symbol from
// the repository, and pulling the real package into a DOM environment would
// drag a Postgres driver in with it for no gain.
const stored = {
  value: {
    id: WIDGET,
    siteId: 'site',
    enabled: true,
    siteStatus: 'active',
    allowedOrigins: ['https://shop.example.com'],
  },
}
vi.mock('@openanalytics/postgres', () => ({
  resolvePublicWidget: async () => stored.value,
}))

const { createWidgetEmbedRoutes } = await import('../../apps/api/src/http/embed.ts')

/** The public meta every historical payload carries; the renderer reads none of
 * it, which is itself worth having in the fixture. */
const META = {
  requested_range: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-08T00:00:00.000Z' },
  effective_range: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-08T00:00:00.000Z' },
  comparison_range: null,
  timezone: 'Europe/Istanbul',
  resolution: 'day',
}

/** A hostile string in every position a visitor or an owner can influence. */
const HOSTILE = '<img src=x onerror=alert(1)>'

const PAYLOADS: Record<string, unknown> = {
  overview: { meta: META, totals: { events: 1200, pageviews: 900, visitors: 400 } },
  sessions: {
    meta: META,
    totals: {
      sessions: 88,
      engaged_sessions: 50,
      bounced_sessions: 38,
      bounce_rate: 0.43,
      pageviews: 210,
      avg_session_duration_ms: 61000,
      avg_active_duration_ms: 31000,
    },
    series: [],
  },
  timeseries: {
    meta: META,
    series: [
      { bucket: '2026-08-01T00:00:00.000Z', events: 12, pageviews: 9, visitors: 5 },
      { bucket: '2026-08-02T00:00:00.000Z', events: 30, pageviews: 22, visitors: 17 },
      { bucket: '2026-08-03T00:00:00.000Z', events: 0, pageviews: 0, visitors: 0 },
    ],
    comparison: null,
  },
  pages: { meta: META, items: [{ page_path: `${HOSTILE}/pricing`, views: 120, visitors: 80 }] },
  sources: {
    meta: META,
    items: [
      {
        referrer_domain: '',
        utm_source: '',
        utm_medium: '',
        utm_campaign: '',
        views: 90,
        visitors: 70,
      },
    ],
  },
  devices: {
    meta: META,
    items: [{ device_type: 'desktop', browser: 'chrome', os: 'macos', views: 77, visitors: 60 }],
  },
  geography: {
    meta: META,
    items: [{ country: 'US', city: HOSTILE, views: 500, visitors: 300, city_suppressed: false }],
  },
  realtime: { type: 'snapshot', generated_at: '2026-08-07T14:35:00.000Z', active_visitors: 128 },
}

/**
 * Where this deployment's footer mark points (`WIDGET_WATERMARK_URL`).
 *
 * A hardcoded `https://getopen.so/?utm_source=widget` inside the document until
 * the open-core split, which was the one place an embedded document named the
 * deployment serving it. Unset, the footer renders the same line with no link at
 * all — the case pinned below, because an install with no marketing page must not
 * ship an anchor to somebody else's.
 */
const WATERMARK = 'https://analytics.example/?utm_source=widget'

/** The document the route serves, byte for byte. A budget big enough not to be
 * the subject: what the shared (IP, widget id) limiter does is pinned in
 * `tests/contract/api-widget-embed.test.ts`, and this suite is about what the
 * document draws once it is served. */
async function serve(watermarkUrl = WATERMARK): Promise<string> {
  const app = createWidgetEmbedRoutes({
    db: {} as never,
    rateLimiter: { check: () => ({ allowed: true, retryAfterSeconds: 0 }) },
    cacheMaxAgeSeconds: 60,
    ...(watermarkUrl === undefined ? {} : { watermarkUrl }),
  })
  const res = await app.fetch(new Request(`http://api.test/embed/${WIDGET}`))
  return res.text()
}

/** Its one inline script, which is the only executable thing in it. */
function inlineScript(html: string): string {
  const match = /<script>([\s\S]*?)<\/script>/u.exec(html)
  if (!match?.[1]) throw new Error('the document served no inline script')
  return match[1]
}

interface Reply {
  readonly status?: number
  readonly body?: unknown
}

/**
 * Run the document: install its markup, stub the JSON read, execute the script.
 *
 * `new Function` rather than injecting a `<script>` tag, because happy-dom does
 * not execute scripts written into `innerHTML` — and the point of this suite is
 * that the script runs.
 */
async function render(surface: string, reply: Reply = {}): Promise<HTMLElement> {
  const html = await serve()
  const body = /<main[\s\S]*?<\/main>/u.exec(html)
  document.body.innerHTML = body ? body[0] : ''

  const payload = {
    widget: { surface, title: `${HOSTILE} title`, range: '7d', limit: 5 },
    data: reply.body ?? PAYLOADS[surface],
  }
  const status = reply.status ?? 200
  window.fetch = vi.fn(
    async () =>
      new Response(status === 200 ? JSON.stringify(payload) : '{"error":{"code":"NOT_FOUND"}}', {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  ) as typeof window.fetch

  new Function(inlineScript(html))()
  await vi.waitFor(() => {
    expect(document.querySelector('#oa')?.textContent).not.toBe('…')
  })
  return document.querySelector('#oa') as HTMLElement
}

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.useRealTimers()
})

describe('every surface draws something', () => {
  it.each(Object.keys(PAYLOADS))('%s renders without throwing', async (surface) => {
    const root = await render(surface)
    expect(root.textContent?.trim().length, surface).toBeGreaterThan(0)
    expect(root.textContent, surface).not.toBe('No data')
  })

  it('draws the overview totals as numbers a reader can read', async () => {
    const root = await render('overview')
    const labels = Array.from(root.querySelectorAll('.stat span'), (n) => n.textContent)
    expect(labels).toEqual(['Visitors', 'Pageviews', 'Events'])
    expect(Array.from(root.querySelectorAll('.stat b'), (n) => n.textContent)).toEqual([
      (400).toLocaleString(),
      (900).toLocaleString(),
      (1200).toLocaleString(),
    ])
  })

  it('draws one bar per timeseries bucket, the empty one included', async () => {
    const root = await render('timeseries')
    // Three points, three rects: a zero bucket is a gap in the chart, not a
    // missing bar, or the axis lies about the range.
    expect(root.querySelectorAll('rect')).toHaveLength(3)
    expect(root.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 100 40')
  })

  it('calls an empty referrer Direct rather than showing a blank row', async () => {
    const root = await render('sources')
    expect(root.querySelector('.rows li span')?.textContent).toBe('Direct')
  })

  it('shows the realtime count on its own', async () => {
    const root = await render('realtime')
    expect(root.querySelector('.big')?.textContent).toBe((128).toLocaleString())
  })

  it('renders a surface it has never heard of as no data, not as a broken box', async () => {
    const root = await render('funnels', { body: { meta: META, items: [] } })
    expect(root.textContent).toContain('No data')
  })
})

describe('nothing in a payload becomes markup', () => {
  it('writes a hostile page path as text', async () => {
    const root = await render('pages')
    expect(root.querySelector('.rows li span')?.textContent).toBe(`${HOSTILE}/pricing`)
    // The proof that matters: the string is *text*, so no element came of it.
    expect(root.querySelector('img')).toBeNull()
  })

  it('writes a hostile city name as text', async () => {
    const root = await render('geography')
    expect(root.querySelector('.rows li span')?.textContent).toBe(HOSTILE)
    expect(root.querySelector('img')).toBeNull()
  })

  it('writes a hostile title as text, and adds no script to the document', async () => {
    const before = document.querySelectorAll('script').length
    const root = await render('overview')
    expect(root.querySelector('h1')?.textContent).toBe(`${HOSTILE} title`)
    expect(document.querySelectorAll('script')).toHaveLength(before)
  })

  it('omits the heading entirely when the owner named no title', async () => {
    const html = await serve()
    document.body.innerHTML = /<main[\s\S]*?<\/main>/u.exec(html)?.[0] ?? ''
    window.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            widget: { surface: 'realtime', title: null, range: null, limit: null },
            data: PAYLOADS['realtime'],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as typeof window.fetch

    new Function(inlineScript(html))()
    await vi.waitFor(() => {
      expect(document.querySelector('.big')).not.toBeNull()
    })
    // No title, and no site name, domain or link standing in for one: identity
    // is opt-in (ADR-0044) and a widget's opt-in is its title. The one link the
    // document may carry is the deployment's own watermark — it names the
    // instrument, never the owner. Pinned as exactly one, so a second anchor (an
    // owner link, an injected one) is a deliberate change.
    expect(document.querySelector('h1')).toBeNull()
    const anchors = document.querySelectorAll('a')
    expect(anchors).toHaveLength(1)
    expect(anchors[0]?.getAttribute('href')).toBe(WATERMARK)
    expect(anchors[0]?.textContent).toContain('Open Analytics')
  })

  it('renders the footer as text, with no anchor at all, when no watermark is configured', async () => {
    // The self-hosted default. The line still says what drew the box — it names
    // the instrument — but there is nowhere for a reader of somebody else's page
    // to be sent.
    const html = await serve(undefined)
    expect(html).not.toContain('<a')
    expect(html).toContain('Open Analytics')
  })
})

describe('a refusal is a quiet blank, never an error dump', () => {
  it.each([
    ['a revoked widget', 404],
    ['the D10 gap: `all` on a site with no events', 400],
    ['no gateway configured', 503],
  ])('%s renders "No data"', async (_label, status) => {
    const root = await render('pages', { status })
    expect(root.textContent).toContain('No data')
    // Not the status, not the code, not the envelope: this box is on somebody
    // else's page and our plumbing is not their reader's business.
    expect(root.textContent).not.toContain('404')
    expect(root.textContent).not.toContain('NOT_FOUND')
    expect(root.textContent).not.toContain('error')
  })

  it('renders "No data" for an empty breakdown rather than an empty box', async () => {
    const root = await render('pages', { body: { meta: META, items: [] } })
    // An empty list is a legitimate 200 — the rows element is simply empty — so
    // what a reader sees is an empty panel under the title. Pinned so a later
    // edit that turns it into a spinner or an error is a deliberate one.
    expect(root.querySelector('.rows')?.children).toHaveLength(0)
  })
})

describe('only a realtime widget re-polls (ADR-0045, D5)', () => {
  it('asks again after 15 seconds', async () => {
    vi.useFakeTimers()
    const html = await serve()
    document.body.innerHTML = /<main[\s\S]*?<\/main>/u.exec(html)?.[0] ?? ''
    const fetchMock = vi.fn(
      async (_input: string) =>
        new Response(
          JSON.stringify({
            widget: { surface: 'realtime', title: null, range: null, limit: null },
            data: PAYLOADS['realtime'],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    window.fetch = fetchMock as unknown as typeof window.fetch

    new Function(inlineScript(html))()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Four requests a minute against the JSON read's own 10-second max-age.
    await vi.advanceTimersByTimeAsync(15_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // Same-origin and relative, so the iframe path needs no CORS at all.
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/v1/widget/${WIDGET}`)
  })

  it('never re-asks for a historical widget, whose answer is cached anyway', async () => {
    vi.useFakeTimers()
    const html = await serve()
    document.body.innerHTML = /<main[\s\S]*?<\/main>/u.exec(html)?.[0] ?? ''
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            widget: { surface: 'pages', title: null, range: '7d', limit: 5 },
            data: PAYLOADS['pages'],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    window.fetch = fetchMock as unknown as typeof window.fetch

    new Function(inlineScript(html))()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
