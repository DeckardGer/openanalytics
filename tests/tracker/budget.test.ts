import { beforeEach, describe, expect, it } from 'vitest'
import { createHarness, resetBrowser } from './harness.ts'

/**
 * The performance half of the tracker budget (docs snapshot 04, Milestone 4
 * item 10). The size half is enforced by `pnpm run tracker:build` in CI.
 *
 * These thresholds are deliberately loose. A CI runner's wall clock is shared
 * and noisy, so a tight number here would be a flaky test rather than a budget;
 * what these catch is a pathological regression — an accidental O(n²) in the
 * batching path, a synchronous loop over stored events per call, a listener
 * added per event. The measured values sit two orders of magnitude below the
 * ceilings, which is what makes the ceilings safe to keep.
 */

beforeEach(() => {
  resetBrowser()
})

describe('tracker performance budget', () => {
  it('starts, sends the first pageview and installs its listeners quickly', () => {
    const started = performance.now()
    const harness = createHarness()
    const elapsed = performance.now() - started

    expect(harness.eventsOfType('page_view')).toHaveLength(1)
    expect(elapsed).toBeLessThan(100)
    harness.stop()
  })

  it('stays linear across a burst of events', () => {
    const harness = createHarness()

    const started = performance.now()
    for (let index = 0; index < 500; index += 1) {
      harness.tracker.track(`event_${index}`, { index })
    }
    harness.runTimers()
    const elapsed = performance.now() - started

    expect(harness.eventsOfType('custom_event')).toHaveLength(500)
    expect(elapsed).toBeLessThan(500)
    harness.stop()
  })

  it('does not accumulate listeners across SPA route changes', () => {
    // A listener added per route is the classic SPA tracker leak: it survives
    // every navigation and multiplies the work of the next one.
    const harness = createHarness()
    const added: string[] = []
    const original = window.addEventListener.bind(window)
    window.addEventListener = ((type: string, ...rest: unknown[]) => {
      added.push(type)
      return original(type, ...(rest as [EventListenerOrEventListenerObject]))
    }) as typeof window.addEventListener

    for (let index = 0; index < 20; index += 1) {
      window.history.pushState(null, '', `/route-${index}`)
    }

    window.addEventListener = original
    expect(added).toHaveLength(0)
    expect(harness.eventsOfType('page_view')).toHaveLength(21)
    harness.stop()
  })
})
