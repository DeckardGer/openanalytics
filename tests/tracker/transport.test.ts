import {
  LIMITS,
  RETRY_MAX_EVENTS,
  RETRY_TTL_MS,
  createRetryQueue,
  createSessionTracker,
  createTransport,
  safeStorage,
  type TrackerEvent,
} from '../../apps/tracker/src/index.ts'
import { beforeEach, describe, expect, it } from 'vitest'
import { createHarness, resetBrowser, settle } from './harness.ts'

/**
 * Batching, the bounded retry queue and storage safety (docs snapshot 02 §7.3).
 */

beforeEach(() => {
  resetBrowser()
})

const event = (id: string, name: string): TrackerEvent => ({
  event_id: id,
  type: 'custom_event',
  occurred_at: '2026-07-20T10:30:00.000Z',
  name,
})

describe('offline retry queue', () => {
  it('is bounded: an endless offline period cannot fill storage', () => {
    const queue = createRetryQueue(safeStorage(window.localStorage))
    const now = Date.parse('2026-07-20T10:30:00.000Z')

    for (let index = 0; index < RETRY_MAX_EVENTS + 50; index += 1) {
      queue.push([event(`id_${index}`, `e_${index}`)], now)
    }

    expect(queue.size(now)).toBe(RETRY_MAX_EVENTS)
    // The oldest are the ones dropped; the freshest survive.
    const kept = queue.take(now).map((entry) => entry.name)
    expect(kept.at(-1)).toBe(`e_${RETRY_MAX_EVENTS + 49}`)
  })

  it('expires at 24 hours, because the server would reject the event anyway', () => {
    const queue = createRetryQueue(safeStorage(window.localStorage))
    const start = Date.parse('2026-07-20T10:30:00.000Z')

    queue.push([event('id_old', 'stale')], start)

    expect(queue.size(start + RETRY_TTL_MS - 1)).toBe(1)
    expect(queue.size(start + RETRY_TTL_MS)).toBe(0)
    expect(queue.take(start + RETRY_TTL_MS)).toEqual([])
  })

  it('survives storage that throws, as in Safari private mode', () => {
    // An analytics script that throws on a customer's site is a far worse defect
    // than one that loses a queued event.
    const hostile = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    } as unknown as Storage

    const queue = createRetryQueue(safeStorage(hostile))
    const now = Date.parse('2026-07-20T10:30:00.000Z')

    expect(() => queue.push([event('id_1', 'x')], now)).not.toThrow()
    // Degrades to memory: the event is still retried within this page's life.
    expect(queue.size(now)).toBe(1)
  })

  it('ignores a corrupt stored queue instead of throwing on every page load', () => {
    window.localStorage.setItem('oa.retry', '{not json')
    const queue = createRetryQueue(safeStorage(window.localStorage))

    expect(queue.size(Date.now())).toBe(0)
  })
})

describe('delivery', () => {
  it('requeues on a server fault and on a network error', async () => {
    const harness = createHarness()
    harness.respondWith(503)
    harness.tracker.track('kept')
    harness.runTimers()
    await settle()

    const queue = createRetryQueue(safeStorage(window.localStorage))
    expect(queue.size(harness.now())).toBe(1)
    harness.stop()
  })

  it('drops a batch the server rejected deterministically', async () => {
    // Retrying a validation failure or a blocked site forever would only burn
    // the visitor's battery; 4xx other than 429 is final.
    const harness = createHarness()
    harness.respondWith(400)
    harness.tracker.track('rejected')
    harness.runTimers()
    await settle()

    const queue = createRetryQueue(safeStorage(window.localStorage))
    expect(queue.size(harness.now())).toBe(0)
    harness.stop()
  })

  it('retries a rate limit', async () => {
    const harness = createHarness()
    harness.respondWith(429)
    harness.tracker.track('slow_down')
    harness.runTimers()
    await settle()

    expect(createRetryQueue(safeStorage(window.localStorage)).size(harness.now())).toBe(1)
    harness.stop()
  })

  it('sends queued events with the next page load', async () => {
    const first = createHarness()
    first.respondWith(503)
    first.tracker.track('from_yesterday')
    first.runTimers()
    await settle()
    first.stop()

    // A new page: the tracker drains whatever the last one could not deliver.
    const second = createHarness()
    const names = second.events().map((entry) => entry['name'])
    expect(names).toContain('from_yesterday')
    second.stop()
  })

  it('splits a run of events into batches inside the contract limits', () => {
    const sent: string[] = []
    const queue = createRetryQueue(safeStorage(window.localStorage))
    const transport = createTransport({
      collectorUrl: 'https://collect.example.com',
      trackingKey: 'oa_pub_live_abcdef123456',
      context: { sdk: 'web', sdk_version: '2.0.0' },
      queue,
      now: () => Date.parse('2026-07-20T10:30:00.000Z'),
      fetchImpl: (_url, init) => {
        sent.push(String(init.body))
        return Promise.resolve(new Response(null, { status: 202 }))
      },
      schedule: () => {},
    })

    for (let index = 0; index < LIMITS.maxEventsPerBatch + 20; index += 1) {
      transport.enqueue(event(`id_${index}`, `e_${index}`))
    }
    transport.flush()

    expect(sent).toHaveLength(2)
    for (const payload of sent) {
      const batch = JSON.parse(payload) as { events: unknown[] }
      expect(batch.events.length).toBeLessThanOrEqual(LIMITS.maxEventsPerBatch)
      expect(payload.length).toBeLessThanOrEqual(LIMITS.maxBatchBytes)
    }
  })
})

describe('client session hint', () => {
  it('keeps one id inside the inactivity window and rotates after it', () => {
    let id = 0
    const session = createSessionTracker(safeStorage(window.sessionStorage), () => `s_${(id += 1)}`)
    const start = Date.parse('2026-07-20T10:30:00.000Z')

    expect(session.current(start)).toBe('s_1')
    expect(session.current(start + 29 * 60_000)).toBe('s_1')
    // Docs snapshot 02 §10: 30 minutes of inactivity ends the session.
    expect(session.current(start + 29 * 60_000 + 31 * 60_000)).toBe('s_2')
  })
})
