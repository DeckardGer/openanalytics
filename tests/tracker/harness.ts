import { createTracker, type Tracker, type TrackerOptions } from '../../apps/tracker/src/index.ts'

/**
 * Test harness for the browser tracker.
 *
 * Every source of nondeterminism the tracker can reach — the clock, randomness,
 * timers, `fetch` and `sendBeacon` — is injected, so a test asserts on exactly
 * what would have gone over the wire, at exactly the moment it would have.
 */

export const TRACKING_KEY = 'oa_pub_live_abcdef123456'
export const COLLECTOR_URL = 'https://collect.example.com'
export const START_TIME = Date.parse('2026-07-20T10:30:00.000Z')

export interface SentRequest {
  readonly url: string
  readonly body: Record<string, unknown>
  readonly raw: string
  readonly via: 'fetch' | 'beacon'
  readonly contentType?: string | undefined
}

export interface Harness {
  readonly tracker: Tracker
  readonly sent: SentRequest[]
  /** All events across every historical batch, in send order. */
  events(): Record<string, unknown>[]
  eventsOfType(type: string): Record<string, unknown>[]
  batches(): SentRequest[]
  heartbeats(): SentRequest[]
  advance(ms: number): void
  runTimers(): void
  fireHeartbeatInterval(): void
  now(): number
  respondWith(status: number): void
  failNextWith(error: Error): void
  stop(): void
}

export function createHarness(overrides: Partial<TrackerOptions> = {}): Harness {
  const sent: SentRequest[] = []
  const scheduled: (() => void)[] = []
  const intervals: { task: () => void; ms: number }[] = []

  let clock = START_TIME
  let status = 202
  let nextError: Error | null = null

  const record = (
    url: string,
    raw: string,
    via: 'fetch' | 'beacon',
    contentType?: string | undefined,
  ): void => {
    sent.push({ url, raw, via, contentType, body: JSON.parse(raw) as Record<string, unknown> })
  }

  const tracker = createTracker({
    trackingKey: TRACKING_KEY,
    collectorUrl: COLLECTOR_URL,
    window: globalThis.window as unknown as Window & typeof globalThis,
    now: () => clock,
    random: () => 0.5,
    schedule: (task) => {
      scheduled.push(task)
    },
    setIntervalImpl: (task, ms) => {
      intervals.push({ task, ms })
      return intervals.length
    },
    clearIntervalImpl: () => {
      intervals.length = 0
    },
    fetchImpl: (url, init) => {
      if (nextError) {
        const error = nextError
        nextError = null
        return Promise.reject(error)
      }
      const headers = init.headers as Record<string, string> | undefined
      record(url, String(init.body), 'fetch', headers?.['Content-Type'])
      return Promise.resolve(new Response(null, { status }))
    },
    beaconImpl: (url, body) => {
      record(url, body, 'beacon')
      return true
    },
    ...overrides,
  })

  const isBatch = (request: SentRequest): boolean => request.url.endsWith('/v1/events')

  return {
    tracker,
    sent,
    events() {
      return sent
        .filter(isBatch)
        .flatMap((request) => (request.body['events'] as Record<string, unknown>[]) ?? [])
    },
    eventsOfType(type) {
      return this.events().filter((event) => event['type'] === type)
    },
    batches() {
      return sent.filter(isBatch)
    },
    heartbeats() {
      return sent.filter((request) => request.url.endsWith('/v1/realtime/heartbeat'))
    },
    advance(ms) {
      clock += ms
    },
    runTimers() {
      const tasks = scheduled.splice(0)
      for (const task of tasks) task()
    },
    fireHeartbeatInterval() {
      for (const interval of intervals) interval.task()
    },
    now() {
      return clock
    },
    respondWith(next) {
      status = next
    },
    failNextWith(error) {
      nextError = error
    },
    stop() {
      tracker.stop()
    },
  }
}

/**
 * Let the transport's in-flight promises settle. A failed send only reaches the
 * retry queue after its response resolves, so a test that asserts on requeueing
 * has to yield first.
 */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** A fresh DOM between tests: storage, URL and any leftover globals. */
export function resetBrowser(url = '/pricing?utm_source=google'): void {
  window.localStorage.clear()
  window.sessionStorage.clear()
  window.history.replaceState(null, '', url)
  delete (globalThis as unknown as Record<string, unknown>)['oa']
  delete (globalThis as unknown as Record<string, unknown>)['openanalytics']
}
