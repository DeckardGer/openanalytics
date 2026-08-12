import { INTERACTION_MAX_PER_PAGE, createEngagement } from '../../apps/tracker/src/index.ts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, resetBrowser, settle } from './harness.ts'

/**
 * Tracker signals: engagement, Core Web Vitals, realtime heartbeat and the
 * heatmap `interaction` click (docs snapshot 02 §8, §10, §11; F-314, D-101).
 *
 * All four have usage weight 0. What is tested here is that they measure the
 * right thing, at the right moment, without ever carrying something they must
 * not carry.
 */

interface FakeEntry {
  name?: string
  startTime?: number
  duration?: number
  value?: number
  hadRecentInput?: boolean
}

const observers = new Map<string, ((entries: FakeEntry[]) => void)[]>()

class FakePerformanceObserver {
  private readonly callback: (list: { getEntries(): FakeEntry[] }) => void

  constructor(callback: (list: { getEntries(): FakeEntry[] }) => void) {
    this.callback = callback
  }

  observe(options: { type: string }): void {
    const existing = observers.get(options.type) ?? []
    existing.push((entries) => this.callback({ getEntries: () => entries }))
    observers.set(options.type, existing)
  }

  disconnect(): void {}
}

function emitEntries(type: string, entries: FakeEntry[]): void {
  for (const callback of observers.get(type) ?? []) callback(entries)
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
}

beforeEach(() => {
  resetBrowser()
  observers.clear()
  setVisibility('visible')
  document.body.innerHTML = ''
})

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>)['PerformanceObserver']
})

describe('engagement', () => {
  it('measures visible and active time, not time on page', () => {
    // Docs snapshot 02 §10: `Page duration` is visible, active time — a tab left
    // open in the background is not engagement.
    let clock = 0
    const engagement = createEngagement({
      document: { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' },
      window: { addEventListener() {}, removeEventListener() {} },
      now: () => clock,
    })

    engagement.start()
    clock += 10_000

    const collected = engagement.collect()
    expect(collected?.visible_ms).toBe(10_000)
    // No interaction happened, so none of it counted as active.
    expect(collected?.active_ms).toBe(0)
  })

  it('counts activity inside its window and stops when it lapses', () => {
    let clock = 0
    const listeners: (() => void)[] = []
    const engagement = createEngagement({
      document: { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' },
      window: {
        addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
          listeners.push(listener as () => void)
        },
        removeEventListener() {},
      },
      now: () => clock,
    })

    engagement.start()
    clock = 1_000
    for (const listener of listeners) listener()
    // The window is 5s: activity at 1s covers 1s–6s.
    clock = 20_000

    const collected = engagement.collect()
    expect(collected?.active_ms).toBe(5_000)
    expect(collected?.visible_ms).toBe(20_000)
  })

  it('reports per route and closes the previous route before the new pageview', () => {
    const harness = createHarness()
    harness.advance(4_000)

    window.history.pushState(null, '', '/features')
    harness.runTimers()

    const engagement = harness.eventsOfType('engagement')
    expect(engagement).toHaveLength(1)
    const payload = engagement[0]?.['engagement'] as { visible_ms: number; active_ms: number }
    expect(payload.visible_ms).toBe(4_000)
    harness.stop()
  })

  it('reports the last route on the way out', () => {
    const harness = createHarness()
    harness.advance(3_000)

    window.dispatchEvent(new Event('pagehide'))

    expect(harness.eventsOfType('engagement').length).toBeGreaterThan(0)
    harness.stop()
  })
})

describe('core web vitals', () => {
  it('reports on the first transition to hidden, not on unload', () => {
    // LCP and CLS are only final once the page stops being visible, and `unload`
    // never fires on mobile Safari.
    ;(globalThis as unknown as Record<string, unknown>)['PerformanceObserver'] =
      FakePerformanceObserver
    const harness = createHarness()

    emitEntries('largest-contentful-paint', [{ startTime: 1_200 }])
    emitEntries('paint', [{ name: 'first-contentful-paint', startTime: 800 }])
    emitEntries('layout-shift', [{ startTime: 100, value: 0.05 }])

    expect(harness.eventsOfType('web_vital')).toHaveLength(0)

    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))

    const vitals = harness.eventsOfType('web_vital')
    const metrics = vitals.map((event) => (event['web_vital'] as { metric: string }).metric)
    expect(metrics).toContain('LCP')
    expect(metrics).toContain('FCP')
    expect(metrics).toContain('CLS')
    harness.stop()
  })

  it('reports each metric once, however many times the page is hidden', () => {
    ;(globalThis as unknown as Record<string, unknown>)['PerformanceObserver'] =
      FakePerformanceObserver
    const harness = createHarness()
    emitEntries('largest-contentful-paint', [{ startTime: 1_200 }])

    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('pagehide'))

    expect(harness.eventsOfType('web_vital')).toHaveLength(1)
    harness.stop()
  })

  it('ignores shifts that followed user input and keeps a session maximum', () => {
    ;(globalThis as unknown as Record<string, unknown>)['PerformanceObserver'] =
      FakePerformanceObserver
    const harness = createHarness()

    emitEntries('layout-shift', [
      { startTime: 100, value: 0.1 },
      { startTime: 200, value: 0.2, hadRecentInput: true },
      { startTime: 300, value: 0.05 },
      // A gap of more than a second starts a new session window.
      { startTime: 5_000, value: 0.02 },
    ])

    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))

    const cls = harness
      .eventsOfType('web_vital')
      .map((event) => event['web_vital'] as { metric: string; value: number })
      .find((payload) => payload.metric === 'CLS')

    expect(cls?.value).toBeCloseTo(0.15, 5)
    harness.stop()
  })

  it('does nothing at all in a browser without PerformanceObserver', () => {
    const harness = createHarness()
    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))

    expect(harness.eventsOfType('web_vital')).toHaveLength(0)
    harness.stop()
  })
})

describe('heartbeat', () => {
  it('goes to the realtime endpoint and never into the historical batch', () => {
    // Docs snapshot 02 §7.3: heartbeat is not a member of the historical
    // contract. D-101: usage weight 0.
    const harness = createHarness()
    harness.fireHeartbeatInterval()

    expect(harness.heartbeats().length).toBeGreaterThan(0)
    expect(harness.heartbeats()[0]?.url).toBe('https://collect.example.com/v1/realtime/heartbeat')
    expect(harness.events().some((event) => event['type'] === 'heartbeat')).toBe(false)
    harness.stop()
  })

  it('carries no event_id, because nothing deduplicates it', () => {
    const harness = createHarness()
    harness.fireHeartbeatInterval()

    const body = harness.heartbeats()[0]?.body ?? {}
    expect(body['event_id']).toBeUndefined()
    expect(body['type']).toBeUndefined()
    expect(body['client_session_id']).toBeDefined()
    harness.stop()
  })

  it('is not retried when it fails: the next interval is the retry', async () => {
    const harness = createHarness()
    harness.failNextWith(new Error('offline'))
    harness.fireHeartbeatInterval()
    await settle()

    // Nothing landed in the durable queue — a lost ping is a lost realtime tick,
    // never a hole in history (§7.2).
    expect(window.localStorage.getItem('oa.retry')).toBeNull()
    harness.stop()
  })

  it('is silent while the document is hidden', () => {
    const harness = createHarness()
    const before = harness.heartbeats().length

    setVisibility('hidden')
    harness.fireHeartbeatInterval()

    expect(harness.heartbeats().length).toBe(before)
    harness.stop()
  })

  it('pings the moment the tab becomes visible again (ADR-0035 D10)', () => {
    // Without this a returning visitor waits out up to a full interval before
    // presence hears from them, so the board shows them gone for as long as 15
    // seconds after they are plainly back.
    const harness = createHarness()

    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    const whileHidden = harness.heartbeats().length

    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))

    expect(harness.heartbeats().length).toBe(whileHidden + 1)
    harness.stop()
  })

  it('sends nothing when visibilitychange fires on the hidden edge', () => {
    // D2 binds through the same `tick`: the ping is not a second path that could
    // drift into pinging a backgrounded tab. Every competitor client read for
    // ADR-0035 sends one ping at the transition to hidden and nothing after; we
    // send none, and this is what keeps it true.
    const harness = createHarness()
    const before = harness.heartbeats().length

    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))

    expect(harness.heartbeats().length).toBe(before)
    harness.stop()
  })

  it('does not ping on visibility when the heartbeat feature is off', () => {
    // `ping` refuses on its own rather than by the caller's discipline: one beat
    // from a site that disabled heartbeats is the only heartbeat it would ever
    // receive, which is worse than none.
    const harness = createHarness()
    harness.tracker.applyConfig({ features: { heartbeat: false } })
    const before = harness.heartbeats().length

    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))

    expect(harness.heartbeats().length).toBe(before)
    harness.stop()
  })
})

describe('heatmap interaction signal', () => {
  const click = (element: Element, x = 100, y = 200): void => {
    element.dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }) as Event,
    )
  }

  /** Clicks are batched like any other non-critical event; send what is buffered. */
  const flush = (harness: { tracker: { flush(): void } }): void => harness.tracker.flush()

  it('reports viewport percentages, a viewport class and a selector', () => {
    const harness = createHarness()
    document.body.innerHTML =
      '<section id="pricing"><button class="cta primary">Buy now</button></section>'
    const button = document.querySelector('button')

    click(button as Element)
    flush(harness)

    const payload = harness.eventsOfType('interaction')[0]?.['interaction'] as Record<
      string,
      unknown
    >
    expect(payload['x_percent']).toBeGreaterThan(0)
    expect(payload['y_percent']).toBeGreaterThan(0)
    expect(String(payload['viewport_class'])).toMatch(/mobile|tablet|desktop|wide/)
    expect(String(payload['selector'])).toContain('button.cta')
    expect(payload['text']).toBe('Buy now')
    harness.stop()
  })

  it('never emits an empty selector, whatever was clicked', () => {
    // The contract declares interaction.selector as min(1), a batch is validated
    // atomically, and the tracker treats a 400 as final - so an empty selector
    // does not lose its own event, it loses the whole batch, page views and all.
    // A real browser proved this on 2026-07-25 by clicking the page background:
    // the selector walk stops at body/html without pushing them, so nothing was
    // left to join. Every click must still name something.
    const harness = createHarness()
    document.body.innerHTML = '<p>plain text, no id, no class</p>'

    click(document.body)
    click(document.documentElement)
    click(document.querySelector('p') as Element)
    flush(harness)

    const payloads = harness
      .eventsOfType('interaction')
      .map((event) => (event['interaction'] as Record<string, unknown>)['selector'])
    expect(payloads.length).toBeGreaterThan(0)
    for (const selector of payloads) {
      expect(typeof selector).toBe('string')
      expect(String(selector).length).toBeGreaterThan(0)
    }
    harness.stop()
  })

  it('never captures anything from a form field', () => {
    // The rule that has no exceptions: an input's value is not truncated or
    // hashed — it is never read. For a field there is no text branch at all.
    const harness = createHarness()
    document.body.innerHTML = '<input id="email" value="someone@example.com" />'
    const input = document.querySelector('input')
    ;(input as HTMLInputElement).value = 'someone@example.com'

    click(input as Element)
    flush(harness)

    const payload = harness.eventsOfType('interaction')[0]?.['interaction'] as Record<
      string,
      unknown
    >
    expect(payload['text']).toBeUndefined()
    expect(JSON.stringify(harness.sent)).not.toContain('someone@example.com')
    harness.stop()
  })

  it('redacts PII out of element text', () => {
    const harness = createHarness()
    document.body.innerHTML = '<a href="/x">Write to sales@example.com now</a>'

    click(document.querySelector('a') as Element)
    flush(harness)

    const payload = harness.eventsOfType('interaction')[0]?.['interaction'] as Record<
      string,
      unknown
    >
    expect(String(payload['text'])).toContain('[redacted]')
    expect(String(payload['text'])).not.toContain('sales@example.com')
    harness.stop()
  })

  it("applies the site's redact_query_keys to click text, not only to URLs (ADR-0057 D7)", () => {
    // GAP 5 of the G-008 review: the dependency was wired and never invoked, so
    // a configured key had no effect on interaction text. A link whose visible
    // text quotes its own href is the ordinary way a query value ends up here.
    const harness = createHarness()
    harness.tracker.applyConfig({ redactQueryKeys: ['promo'] })
    document.body.innerHTML = '<a href="/x">shop.example.com/claim?promo=SECRET99</a>'

    click(document.querySelector('a') as Element)
    flush(harness)

    const payload = harness.eventsOfType('interaction')[0]?.['interaction'] as Record<
      string,
      unknown
    >
    expect(String(payload['text'])).toContain('promo=[redacted]')
    expect(JSON.stringify(harness.sent)).not.toContain('SECRET99')
    harness.stop()
  })

  it('redacts default sensitive query keys quoted in click text without any configuration', () => {
    const harness = createHarness()
    document.body.innerHTML = '<a href="/x">/reset?token=abc12345</a>'

    click(document.querySelector('a') as Element)
    flush(harness)

    const payload = harness.eventsOfType('interaction')[0]?.['interaction'] as Record<
      string,
      unknown
    >
    expect(String(payload['text'])).toContain('token=[redacted]')
    expect(JSON.stringify(harness.sent)).not.toContain('abc12345')
    harness.stop()
  })

  it('throttles rapid clicks', () => {
    const harness = createHarness()
    document.body.innerHTML = '<button>Go</button>'
    const button = document.querySelector('button') as Element

    click(button)
    click(button)
    click(button)
    flush(harness)
    expect(harness.eventsOfType('interaction')).toHaveLength(1)

    harness.advance(300)
    click(button)
    flush(harness)
    expect(harness.eventsOfType('interaction')).toHaveLength(2)
    harness.stop()
  })

  it('stops at the per-pageview ceiling and resets on a route change', () => {
    const harness = createHarness()
    document.body.innerHTML = '<button>Go</button>'
    const button = document.querySelector('button') as Element

    for (let index = 0; index < INTERACTION_MAX_PER_PAGE + 10; index += 1) {
      harness.advance(300)
      click(button)
    }
    flush(harness)
    expect(harness.eventsOfType('interaction')).toHaveLength(INTERACTION_MAX_PER_PAGE)

    window.history.pushState(null, '', '/next')
    harness.advance(300)
    click(button)
    flush(harness)
    expect(harness.eventsOfType('interaction')).toHaveLength(INTERACTION_MAX_PER_PAGE + 1)
    harness.stop()
  })

  it('honours the sampling rate from tracker config', () => {
    const harness = createHarness({ random: () => 0.9 })
    harness.tracker.applyConfig({ interactionSampling: 0.5 })
    document.body.innerHTML = '<button>Go</button>'

    click(document.querySelector('button') as Element)
    flush(harness)
    expect(harness.eventsOfType('interaction')).toHaveLength(0)

    harness.tracker.applyConfig({ interactionSampling: 1 })
    harness.advance(300)
    click(document.querySelector('button') as Element)
    flush(harness)
    expect(harness.eventsOfType('interaction')).toHaveLength(1)
    harness.stop()
  })

  it('can be switched off entirely by config', () => {
    const harness = createHarness({ config: { features: { interactions: false } } })
    document.body.innerHTML = '<button>Go</button>'

    click(document.querySelector('button') as Element)
    flush(harness)
    expect(harness.eventsOfType('interaction')).toHaveLength(0)
    harness.stop()
  })
})
