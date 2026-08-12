import { createUuidV7 } from '../../apps/tracker/src/index.ts'
import { beforeEach, describe, expect, it } from 'vitest'
import { createHarness, resetBrowser, settle } from './harness.ts'

/**
 * Tracker core: identity, the first pageview, SPA routing and the public API
 * (docs snapshot 02 §7.1, §7.3, §10, §11).
 */

beforeEach(() => {
  resetBrowser()
})

describe('event identity', () => {
  it('mints a UUIDv7 before the first send attempt', () => {
    const harness = createHarness()
    const [event] = harness.events()

    expect(event?.['event_id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    harness.stop()
  })

  it('keeps the same id across a retry, which is the entire point', async () => {
    // Docs snapshot 02 §7.1: a server-generated id could not deduplicate a retry
    // whose response was lost. So the id is created once, at enqueue time.
    const harness = createHarness()
    harness.respondWith(503)
    harness.tracker.track('signup_started')
    harness.runTimers()
    await settle()

    const firstAttempt = harness.events().at(-1)
    expect(firstAttempt?.['name']).toBe('signup_started')

    harness.respondWith(202)
    harness.advance(1_000)
    harness.tracker.flush()

    const retried = harness
      .events()
      .filter((event) => event['name'] === 'signup_started')
      .map((event) => event['event_id'])

    expect(retried).toHaveLength(2)
    expect(retried[0]).toBe(retried[1])
    harness.stop()
  })

  it('orders ids inside one millisecond instead of relying on randomness', () => {
    const uuid = createUuidV7({ now: () => 1_753_000_000_000 })
    const ids = [uuid(), uuid(), uuid()]

    expect(new Set(ids).size).toBe(3)
    expect([...ids].sort()).toEqual(ids)
  })
})

describe('pageviews', () => {
  it('sends the first pageview immediately, without waiting for a batch window', () => {
    const harness = createHarness()

    // No timers have run: a fast bounce must still be measured.
    expect(harness.eventsOfType('page_view')).toHaveLength(1)
    expect(harness.batches()[0]?.body['tracking_key']).toBe('oa_pub_live_abcdef123456')
    harness.stop()
  })

  it('sanitizes the URL and the referrer before they leave the browser', () => {
    window.history.replaceState(null, '', '/checkout?token=s3cr3t&utm_source=google#reset=abc')
    const harness = createHarness()

    const page = harness.eventsOfType('page_view')[0]?.['page'] as Record<string, unknown>
    expect(String(page['url'])).not.toContain('s3cr3t')
    expect(String(page['url'])).not.toContain('#')
    expect(String(page['url'])).toContain('utm_source=google')
    harness.stop()
  })

  it('reports an SPA route change as a new pageview', () => {
    const harness = createHarness()
    expect(harness.eventsOfType('page_view')).toHaveLength(1)

    window.history.pushState(null, '', '/features')
    expect(harness.eventsOfType('page_view')).toHaveLength(2)

    window.history.replaceState(null, '', '/features/compare')
    expect(harness.eventsOfType('page_view')).toHaveLength(3)

    window.dispatchEvent(new PopStateEvent('popstate'))
    // popstate without a URL change is not a new pageview.
    expect(harness.eventsOfType('page_view')).toHaveLength(3)
    harness.stop()
  })

  it('does not start a new session on a route change', () => {
    // Docs snapshot 02 §10: an SPA route change is a new pageview, not a new
    // session.
    const harness = createHarness()
    window.history.pushState(null, '', '/features')

    const sessions = harness.eventsOfType('page_view').map((event) => event['client_session_id'])
    expect(new Set(sessions).size).toBe(1)
    harness.stop()
  })

  it('rotates the session after 30 minutes of inactivity', () => {
    const harness = createHarness()
    const first = harness.eventsOfType('page_view')[0]?.['client_session_id']

    harness.advance(31 * 60 * 1_000)
    window.history.pushState(null, '', '/later')

    const second = harness.eventsOfType('page_view').at(-1)?.['client_session_id']
    expect(second).not.toBe(first)
    harness.stop()
  })

  it('restores the history methods it patched when stopped', () => {
    const original = window.history.pushState
    const harness = createHarness()
    expect(window.history.pushState).not.toBe(original)

    harness.stop()
    expect(window.history.pushState).toBe(original)
  })
})

describe('public API', () => {
  it('sends track, identify and conversion in the documented shapes', () => {
    // Docs snapshot 02 §11.
    const harness = createHarness()

    harness.tracker.track('signup_started', { plan: 'growth' })
    harness.tracker.identify('customer-internal-id')
    harness.tracker.conversion('purchase', { order_id: 'o_123', value: 49, currency: 'USD' })
    harness.runTimers()

    const custom = harness.eventsOfType('custom_event')[0]
    expect(custom?.['name']).toBe('signup_started')
    expect(custom?.['properties']).toEqual({ plan: 'growth' })

    expect(harness.eventsOfType('identify')[0]?.['external_user_id']).toBe('customer-internal-id')

    const conversion = harness.eventsOfType('conversion')[0]
    expect(conversion?.['name']).toBe('purchase')
    expect(conversion?.['properties']).toEqual({ order_id: 'o_123', value: 49, currency: 'USD' })
    harness.stop()
  })

  it('batches non-critical events into one request', () => {
    const harness = createHarness()
    const before = harness.batches().length

    harness.tracker.track('a')
    harness.tracker.track('b')
    harness.tracker.track('c')
    expect(harness.batches().length).toBe(before)

    harness.runTimers()
    expect(harness.batches().length).toBe(before + 1)
    expect(harness.batches().at(-1)?.body['events']).toHaveLength(3)
    harness.stop()
  })

  it('drops a call the server would reject rather than failing the batch', () => {
    const harness = createHarness()

    harness.tracker.track('not a valid name!')
    harness.tracker.track('')
    harness.tracker.identify('')
    harness.runTimers()

    expect(harness.eventsOfType('custom_event')).toHaveLength(0)
    expect(harness.eventsOfType('identify')).toHaveLength(0)
    harness.stop()
  })

  it('never lets a property carry a secret or an unsupported shape', () => {
    const harness = createHarness()

    harness.tracker.track('checkout', {
      plan: 'growth',
      // Assembled at runtime: a literal of this shape is a secret-scanner hit
      // in any repository this file is ever published to.
      api_key: ['sk_live', '51QaBcDeFgHiJkLmNoP'].join('_'),
      contact: 'someone@example.com',
      nested: { deep: true },
      oa_billable: true,
    })
    harness.runTimers()

    const properties = harness.eventsOfType('custom_event')[0]?.['properties'] as Record<
      string,
      unknown
    >
    expect(properties).toEqual({ plan: 'growth', contact: '[redacted]' })
    harness.stop()
  })

  it('has no way to state a billing field', () => {
    // Milestone 4 acceptance, client half: the tracker has no field for
    // `billable`, `billing_user_id`, `usage_window_id`, geo or `site_id`, so a
    // customer's own code cannot put one on the wire through the public API.
    const harness = createHarness()

    harness.tracker.track('checkout', {
      billable: false,
      billing_user_id: 'user_someone_else',
      usage_window_id: 'win_1',
      site_id: 'site_other',
      country: 'ZZ',
    })
    harness.runTimers()

    const event = harness.eventsOfType('custom_event')[0] as Record<string, unknown>
    expect(Object.keys(event)).not.toContain('billable')
    expect(Object.keys(event)).not.toContain('billing_user_id')
    expect(Object.keys(event)).not.toContain('site_id')

    // They can only land inside `properties`, where they are inert data the
    // server never reads as billing input — and `oa_`-prefixed keys are dropped.
    const properties = event['properties'] as Record<string, unknown>
    expect(properties['billable']).toBe(false)
    expect(harness.batches().at(-1)?.body['billable']).toBeUndefined()
    harness.stop()
  })
})

describe('page lifecycle', () => {
  it('flushes with sendBeacon on the way out', () => {
    const harness = createHarness()
    harness.tracker.track('late_event')

    window.dispatchEvent(new Event('pagehide'))

    const beaconBatches = harness.sent.filter((request) => request.via === 'beacon')
    expect(beaconBatches.length).toBeGreaterThan(0)
    expect(JSON.stringify(beaconBatches)).toContain('late_event')
    harness.stop()
  })

  it('posts as text/plain so a cross-origin batch needs no preflight', () => {
    const harness = createHarness()
    expect(harness.batches()[0]?.contentType).toBe('text/plain;charset=UTF-8')
    harness.stop()
  })

  it('leaves once, not once per lifecycle event', () => {
    const harness = createHarness()
    harness.tracker.track('one')

    window.dispatchEvent(new Event('pagehide'))
    const after = harness.sent.length
    window.dispatchEvent(new Event('pagehide'))

    expect(harness.sent.length).toBe(after)
    harness.stop()
  })
})
