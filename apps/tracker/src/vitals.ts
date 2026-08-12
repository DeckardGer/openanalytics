import type { WebVitalPayload } from './types.ts'

/**
 * Core Web Vitals, collected in the right lifecycle (docs snapshot 02 §11).
 *
 * The lifecycle is the hard part, not the maths. LCP and CLS are only final once
 * the page stops being visible, and the moment to report them is the first
 * transition to hidden — not `unload`, which never fires on mobile Safari and is
 * ignored by the back/forward cache. So everything is observed continuously and
 * reported once, on the first hidden.
 *
 * Every metric is optional: an unsupported entry type throws inside `observe`,
 * and a browser without `PerformanceObserver` simply reports nothing. A missing
 * measurement is not worth a broken tracker.
 *
 * Usage weight is 0 (D-101).
 */

interface LayoutShiftEntry extends PerformanceEntry {
  readonly value?: number
  readonly hadRecentInput?: boolean
}

export interface ObserverHost {
  PerformanceObserver?: new (callback: (list: { getEntries(): PerformanceEntry[] }) => void) => {
    observe(options: { type: string; buffered?: boolean; durationThreshold?: number }): void
    disconnect(): void
  }
  performance?: { getEntriesByType(type: string): PerformanceEntry[] }
}

export interface WebVitalsDeps {
  readonly host: ObserverHost
  readonly emit: (payload: WebVitalPayload) => void
}

/** Google's published thresholds; the server stores the rating, not a verdict. */
const THRESHOLDS: Record<string, readonly [number, number]> = {
  LCP: [2_500, 4_000],
  CLS: [0.1, 0.25],
  INP: [200, 500],
  FCP: [1_800, 3_000],
  TTFB: [800, 1_800],
}

function rate(metric: string, value: number): WebVitalPayload['rating'] {
  const threshold = THRESHOLDS[metric]
  if (!threshold) return undefined
  if (value <= threshold[0]) return 'good'
  return value <= threshold[1] ? 'needs-improvement' : 'poor'
}

export function createWebVitals(deps: WebVitalsDeps) {
  const observers: { disconnect(): void }[] = []
  const measured = new Map<string, number>()
  let reported = false

  // CLS is a session-window maximum, not a running total: shifts more than one
  // second apart, or beyond a five-second window, start a new session.
  let clsValue = 0
  let sessionValue = 0
  let sessionStart = 0
  let sessionLast = 0

  const observe = (
    type: string,
    options: { buffered?: boolean; durationThreshold?: number },
    onEntries: (entries: PerformanceEntry[]) => void,
  ): void => {
    const Observer = deps.host.PerformanceObserver
    if (!Observer) return
    try {
      const observer = new Observer((list) => onEntries(list.getEntries()))
      observer.observe({ type, ...options })
      observers.push(observer)
    } catch {
      // An unsupported entry type. Nothing to do and nothing to report.
    }
  }

  return {
    start(): void {
      observe('largest-contentful-paint', { buffered: true }, (entries) => {
        const last = entries[entries.length - 1]
        if (last) measured.set('LCP', last.startTime)
      })

      observe('paint', { buffered: true }, (entries) => {
        for (const entry of entries) {
          if (entry.name === 'first-contentful-paint') measured.set('FCP', entry.startTime)
        }
      })

      observe('layout-shift', { buffered: true }, (entries) => {
        for (const entry of entries as LayoutShiftEntry[]) {
          if (entry.hadRecentInput === true) continue
          const value = entry.value ?? 0

          if (
            sessionValue !== 0 &&
            (entry.startTime - sessionLast >= 1_000 || entry.startTime - sessionStart >= 5_000)
          ) {
            sessionValue = 0
          }
          if (sessionValue === 0) sessionStart = entry.startTime

          sessionValue += value
          sessionLast = entry.startTime
          clsValue = Math.max(clsValue, sessionValue)
          measured.set('CLS', clsValue)
        }
      })

      observe('event', { buffered: true, durationThreshold: 40 }, (entries) => {
        for (const entry of entries) {
          measured.set('INP', Math.max(measured.get('INP') ?? 0, entry.duration))
        }
      })

      try {
        const navigation = deps.host.performance?.getEntriesByType('navigation')?.[0] as
          { responseStart?: number } | undefined
        if (navigation && typeof navigation.responseStart === 'number') {
          measured.set('TTFB', navigation.responseStart)
        }
      } catch {
        // Navigation timing is unavailable in some embedded contexts.
      }
    },

    /**
     * Report every measurement taken so far, once. Called on the first
     * transition to hidden; later transitions are no-ops.
     */
    report(): void {
      if (reported) return
      reported = true

      for (const [metric, value] of measured) {
        const rating = rate(metric, value)
        const payload: WebVitalPayload = {
          metric: metric as WebVitalPayload['metric'],
          value: metric === 'CLS' ? Math.round(value * 10_000) / 10_000 : Math.round(value),
          ...(rating === undefined ? {} : { rating }),
        }
        deps.emit(payload)
      }
    },

    stop(): void {
      for (const observer of observers) {
        try {
          observer.disconnect()
        } catch {
          /* already gone */
        }
      }
      observers.length = 0
    },
  }
}

export type WebVitals = ReturnType<typeof createWebVitals>
