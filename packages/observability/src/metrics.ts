import type { Logger } from './logger.ts'

/**
 * Counter port.
 *
 * G-005 requires every limit trigger to emit a metric and an alert; G-006 — the
 * gate that picks the metric backend, the error tracker and the notification
 * channel — is still open, and closes before Milestone 6. So this is the seam,
 * not the vendor: services call `increment`, and which pipeline that reaches is
 * a deployment decision no service code names.
 *
 * The default implementation writes a structured log line. That is deliberately
 * the *weakest* useful backend: every host this system runs on collects stdout,
 * so a limit trigger is queryable from the first deploy rather than from the day
 * G-006 closes — and an alert rule keyed on `metric` is a rule the eventual
 * pipeline can adopt unchanged.
 *
 * Labels are low-cardinality by contract. A metric labelled with a site id is a
 * time series per customer; one labelled with an IP or a user agent is an
 * unbounded series and a privacy problem in a store that has no redaction.
 */

export interface MetricLabels {
  readonly [label: string]: string | number | boolean | undefined
}

export interface Metrics {
  /**
   * Add to a counter. `value` defaults to 1.
   *
   * Never throws: a metrics backend that can fail a request converts an
   * observable problem into an outage, which is the opposite of the point.
   */
  increment(name: string, labels?: MetricLabels, value?: number): void

  /**
   * Record the current value of a gauge.
   *
   * Distinct from a counter because some of the things that have to be alerted
   * on do not accumulate. Queue oldest-age is the case that forced this
   * (docs snapshot 05, G-006 and 02 §26): it goes up while a worker is stalled
   * and back down when it catches up, and expressing it as a counter would make
   * "the queue is 40 seconds behind" indistinguishable from "the queue has been
   * behind for a total of 40 seconds since the process started".
   *
   * Latency is deliberately *not* a third method. A duration is reported as a
   * `_ms` counter alongside a `_total` counter, so the ratio is the average and
   * both halves survive a backend that only understands counters. A real
   * histogram is a decision for the milestone that needs percentiles from the
   * backend rather than from a measurement harness.
   */
  gauge(name: string, value: number, labels?: MetricLabels): void
}

/** Discards everything. For tests and for a service with no sink configured. */
export const NOOP_METRICS: Metrics = { increment: () => undefined, gauge: () => undefined }

/**
 * Emits each counter as one structured log line at `info`.
 *
 * The `metric` field is what an alert rule keys on, so it stays a stable name
 * rather than being folded into the message. Labels pass through the logger's
 * redaction like any other field.
 */
export function createLoggingMetrics(logger: Logger): Metrics {
  const emit = (kind: 'counter' | 'gauge', name: string, value: number, labels: MetricLabels) => {
    try {
      logger.info('metric', { metric: name, metric_kind: kind, value, ...labels })
    } catch {
      // A counter must never be the reason a request fails.
    }
  }

  return {
    increment(name, labels = {}, value = 1) {
      emit('counter', name, value, labels)
    },
    gauge(name, value, labels = {}) {
      emit('gauge', name, value, labels)
    },
  }
}

/** Records every increment in memory, so a test can assert what was emitted. */
export interface RecordedMetric {
  readonly name: string
  readonly labels: MetricLabels
  readonly value: number
  readonly kind: 'counter' | 'gauge'
}

export function createRecordingMetrics(): Metrics & {
  readonly recorded: readonly RecordedMetric[]
  countOf(name: string): number
  /** Latest recorded value of a gauge, or null if it was never set. */
  gaugeOf(name: string): number | null
  reset(): void
} {
  const recorded: RecordedMetric[] = []

  return {
    increment(name, labels = {}, value = 1) {
      recorded.push({ name, labels, value, kind: 'counter' })
    },
    gauge(name, value, labels = {}) {
      recorded.push({ name, labels, value, kind: 'gauge' })
    },
    recorded,
    countOf(name) {
      return recorded
        .filter((entry) => entry.name === name && entry.kind === 'counter')
        .reduce((total, entry) => total + entry.value, 0)
    },
    gaugeOf(name) {
      const entries = recorded.filter((entry) => entry.name === name && entry.kind === 'gauge')
      return entries.length === 0 ? null : (entries[entries.length - 1]?.value ?? null)
    },
    reset() {
      recorded.length = 0
    },
  }
}
