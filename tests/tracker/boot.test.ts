import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONFIG_CACHE_TTL_MS } from '../../apps/tracker/src/config.ts'
import { INGEST_CONTENT_TYPE } from '../../apps/tracker/src/transport.ts'
import { resetBrowser } from './harness.ts'

/**
 * The production boot path — `apps/tracker/src/browser.ts`, imported the way a
 * `<script>` tag runs it.
 *
 * Every other tracker test builds a runtime with `createTracker` and injected
 * doubles, which is exactly why ADR-0019 open item 1 survived every one of them:
 * the doubles supplied the `fetchImpl`/`beaconImpl` that the real entry point
 * did not, so the suite proved the runtime works when it is handed a transport
 * while the shipped bundle was handed none and sent nothing from any real page.
 *
 * So this file injects nothing into the tracker. It writes a real
 * `<script data-key … data-collector …>` into a real DOM, stubs the *browser
 * capabilities* (`window.fetch`, `navigator.sendBeacon`) rather than the
 * tracker's parameters, imports the entry module so its top-level `boot()` runs,
 * and asserts that a request left the page. Nothing here can pass unless the
 * entry file wires a transport itself.
 *
 * `vi.resetModules()` before each import is what makes a module whose work
 * happens at import time re-runnable; the entry file is unchanged and still
 * calls `boot()` exactly once per load, as it does in a browser.
 */

const TRACKING_KEY = 'oa_pub_live_abcdef123456'
const COLLECTOR_URL = 'https://collect.example.com'

interface Sent {
  readonly url: string
  readonly via: 'fetch' | 'beacon'
  readonly payload: unknown
  readonly contentType: string | undefined
}

let sent: Sent[] = []

type Capabilities = { fetch?: boolean; sendBeacon?: boolean }

const originalFetch = globalThis.fetch
const originalSendBeacon = globalThis.navigator.sendBeacon

function setCapabilities({ fetch = true, sendBeacon = true }: Capabilities): void {
  const globals = globalThis as unknown as Record<string, unknown>

  globals['fetch'] = fetch
    ? (url: string, init: RequestInit = {}) => {
        const headers = (init.headers ?? {}) as Record<string, string>
        sent.push({
          url,
          via: 'fetch',
          payload: init.body ?? null,
          contentType: headers['Content-Type'],
        })
        // The config GET is answered with a real body, because the tracker only
        // caches what it could parse — and the TTL this file asserts on only
        // exists once something is cached.
        if (url.includes('/v1/tracker/config')) {
          return Promise.resolve(
            new Response(JSON.stringify({ config_version: 1 }), {
              status: 200,
              headers: { 'content-type': 'application/json', etag: '"cfg-1"' },
            }),
          )
        }
        return Promise.resolve(new Response(null, { status: 202 }))
      }
    : undefined

  ;(globalThis.navigator as unknown as Record<string, unknown>)['sendBeacon'] = sendBeacon
    ? (url: string, payload?: unknown) => {
        sent.push({ url, via: 'beacon', payload, contentType: undefined })
        return true
      }
    : undefined
}

/** Writes the customer's snippet into the page and loads the bundle entry. */
async function boot(attributes: Record<string, string> = {}): Promise<void> {
  const script = document.createElement('script')
  script.setAttribute('data-key', TRACKING_KEY)
  script.setAttribute('data-collector', COLLECTOR_URL)
  for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value)
  document.head.appendChild(script)

  vi.resetModules()
  await import('../../apps/tracker/src/browser.ts')
}

interface InstalledTracker {
  track(name: string, properties?: Record<string, unknown>): void
  stop(): void
}

function installed(): InstalledTracker {
  const tracker = (globalThis as unknown as Record<string, unknown>)['oa']
  expect(tracker).toBeTypeOf('object')
  return tracker as InstalledTracker
}

/** Every configuration GET this page made. */
const configRequests = (): Sent[] =>
  sent.filter((request) => request.url.includes('/v1/tracker/config'))

/** Historical batches only — the heartbeat rides the same transports. */
const batches = (via?: 'fetch' | 'beacon'): Sent[] =>
  sent.filter(
    (request) => request.url.endsWith('/v1/events') && (via === undefined || request.via === via),
  )

const eventTypes = (request: Sent): string[] => {
  const body = JSON.parse(String(request.payload)) as { events?: { type?: string }[] }
  return (body.events ?? []).map((event) => String(event.type))
}

/** A failed send only reaches the retry queue after its response resolves. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  resetBrowser()
  sent = []
  setCapabilities({})
})

afterEach(() => {
  installed().stop()
  for (const node of Array.from(document.head.querySelectorAll('script'))) node.remove()
  resetBrowser()
  const globals = globalThis as unknown as Record<string, unknown>
  globals['fetch'] = originalFetch
  ;(globalThis.navigator as unknown as Record<string, unknown>)['sendBeacon'] = originalSendBeacon
})

describe('tracker boot path', () => {
  it('sends the first pageview from a real <script> tag, with no injected transport', async () => {
    await boot()

    const [batch] = batches()
    expect(batch).toBeDefined()
    if (!batch) return

    expect(batch.url).toBe(`${COLLECTOR_URL}/v1/events`)
    expect(eventTypes(batch)).toContain('page_view')

    const body = JSON.parse(String(batch.payload)) as { tracking_key?: string }
    expect(body.tracking_key).toBe(TRACKING_KEY)

    // `text/plain;charset=UTF-8` is what keeps this a CORS *simple* request, so
    // the batch costs no preflight on any page load.
    expect(batch.contentType).toBe(INGEST_CONTENT_TYPE)
  })

  it('queues nothing: the no_transport branch is never taken', async () => {
    // The exact production symptom of ADR-0019 open item 1 was an event that
    // went nowhere and came back to the retry queue with reason `no_transport`,
    // forever. A delivered pageview leaves the queue empty.
    await boot()
    await settle()

    expect(window.localStorage.getItem('oa.retry')).toBeNull()
  })

  it('also loads the site configuration, as it always did', async () => {
    await boot()

    const config = sent.find((request) => request.url.includes('/v1/tracker/config'))
    expect(config?.url).toBe(
      `${COLLECTOR_URL}/v1/tracker/config?key=${encodeURIComponent(TRACKING_KEY)}`,
    )
  })

  it('flushes on the way out through sendBeacon, with a string payload', async () => {
    await boot()
    installed().track('checkout_started')
    window.dispatchEvent(new Event('pagehide'))

    const [beacon] = batches('beacon')
    expect(beacon?.url).toBe(`${COLLECTOR_URL}/v1/events`)
    // A string, never a Blob: the browser then stamps the beacon
    // `text/plain;charset=UTF-8` itself, which is the one content type that both
    // matches INGEST_CONTENT_TYPE and keeps the request preflight-free. A Blob
    // would let a type be set — and any type we set costs a preflight on a
    // request the page is unloading out from under.
    expect(typeof beacon?.payload).toBe('string')
    expect(beacon && eventTypes(beacon)).toContain('custom_event')
  })

  it('still delivers in a browser with no sendBeacon', async () => {
    setCapabilities({ sendBeacon: false })
    await boot()
    installed().track('checkout_started')
    window.dispatchEvent(new Event('pagehide'))
    await settle()

    expect(sent.some((request) => request.via === 'beacon')).toBe(false)
    const custom = batches('fetch').filter((batch) => eventTypes(batch).includes('custom_event'))
    expect(custom).toHaveLength(1)
    expect(window.localStorage.getItem('oa.retry')).toBeNull()
  })

  it('still delivers the unload flush in a browser with no fetch', async () => {
    setCapabilities({ fetch: false })
    await boot()
    installed().track('checkout_started')
    window.dispatchEvent(new Event('pagehide'))

    // With no fetch the pageview is correctly requeued rather than lost, and the
    // beacon on the way out carries both it and the buffered custom event.
    const [beacon] = batches('beacon')
    expect(beacon).toBeDefined()
    if (!beacon) return
    expect(eventTypes(beacon)).toEqual(expect.arrayContaining(['page_view', 'custom_event']))
  })

  it('revalidates configuration on a route change, but only once the TTL has expired', async () => {
    // ADR-0034 D4's second half. Configuration is fetched once, at start, so a
    // single-page app tab that never reloads would sit on a five-minute cache
    // forever — the TTL alone fixes nothing without something asking again.
    const startedAt = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt)

    await boot()
    await settle()
    expect(configRequests()).toHaveLength(1)

    // Inside the TTL a route change costs nothing: the cache answers without
    // touching the network, which is what makes this affordable at all.
    window.history.pushState({}, '', '/inside-the-ttl')
    await settle()
    expect(configRequests()).toHaveLength(1)

    // Past it, the next route change revalidates. In production that request is
    // conditional and the common answer is a bodyless 304.
    clock.mockReturnValue(startedAt + CONFIG_CACHE_TTL_MS + 1)
    window.history.pushState({}, '', '/past-the-ttl')
    await settle()
    expect(configRequests()).toHaveLength(2)

    clock.mockRestore()
  })

  it('does not revalidate on route change during a rule preview', async () => {
    // A preview bypasses the cache by design (ADR-0034, D6), so wiring the
    // revalidation here would make every route change an unconditional request
    // for a draft rule set nobody asked for again.
    // The token is read from the PAGE URL, which is where the dashboard puts it
    // — not from a script attribute.
    resetBrowser('/pricing?oa_preview=tok')
    const startedAt = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt)

    await boot()
    await settle()
    const afterBoot = configRequests().length
    expect(afterBoot).toBeGreaterThan(0)

    // Well past the TTL — the interval that makes the previous test revalidate.
    clock.mockReturnValue(startedAt + CONFIG_CACHE_TTL_MS * 10)
    window.history.pushState({}, '', '/a?oa_preview=tok')
    await settle()
    window.history.pushState({}, '', '/b?oa_preview=tok')
    await settle()

    expect(configRequests()).toHaveLength(afterBoot)
    clock.mockRestore()
  })

  it('starts nothing when the snippet carries no key', async () => {
    // Unchanged behaviour, pinned because the transport wiring sits right next
    // to this guard: a snippet without a key must not install a tracker at all.
    const script = document.createElement('script')
    script.setAttribute('data-collector', COLLECTOR_URL)
    document.head.appendChild(script)

    vi.resetModules()
    await import('../../apps/tracker/src/browser.ts')

    expect((globalThis as unknown as Record<string, unknown>)['oa']).toBeUndefined()
    expect(sent).toHaveLength(0)

    // The afterEach hook expects an installed tracker; give it a no-op.
    ;(globalThis as unknown as Record<string, unknown>)['oa'] = { stop: () => undefined }
  })
})
