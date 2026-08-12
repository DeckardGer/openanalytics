import type { Logger } from './logger.ts'
import type { MetricLabels, Metrics } from './metrics.ts'

/**
 * Prometheus remote-write exporter for the vendor-neutral counter port
 * (docs snapshot 05, G-006; 02 §26).
 *
 * Named for the protocol, not the vendor. G-006 chose Grafana Cloud, and this
 * ships to it — but remote-write is a Prometheus wire format that Mimir,
 * VictoriaMetrics, Thanos and a self-hosted Prometheus all accept, so changing
 * the backend is an environment variable rather than a code change. That is the
 * shape G-006 asked for: "the vendor stays behind an adapter, and changing it
 * does not change domain code."
 *
 * ## Why remote-write and not OTLP
 *
 * The endpoint the operator provisioned is a Prometheus remote-write URL
 * (`/api/prom/push`), so it is what the credentials actually open. OTLP would
 * have meant asking for a second endpoint and a second credential to reach the
 * same backend, and the alert rules are written in PromQL either way.
 *
 * ## Why there is a protobuf encoder in this file
 *
 * Remote-write is snappy-compressed protobuf, and the alternative was two
 * dependencies — a protobuf runtime and a snappy implementation — to send four
 * message types and one compression format. The encoder below writes exactly the
 * five messages the protocol defines, and the compressor emits an all-literal
 * snappy block, which is valid snappy that every decoder accepts and costs no
 * compression ratio worth a dependency at this volume. Both are pure functions
 * with unit tests, and the wire format is frozen by the protocol rather than by
 * anything here.
 */

// ---------------------------------------------------------------------------
// Protobuf (the five messages prometheus/prompb defines for a write request)
// ---------------------------------------------------------------------------

function varint(value: number): Uint8Array {
  const bytes: number[] = []
  let remaining = value
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80)
    remaining = Math.floor(remaining / 128)
  }
  bytes.push(remaining)
  return Uint8Array.from(bytes)
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** `(field << 3) | wireType`, then a length-delimited payload. */
function lengthDelimited(field: number, payload: Uint8Array): Uint8Array {
  return concat([varint((field << 3) | 2), varint(payload.length), payload])
}

function stringField(field: number, value: string): Uint8Array {
  return lengthDelimited(field, new TextEncoder().encode(value))
}

/** `double`, wire type 1: eight little-endian bytes. */
function doubleField(field: number, value: number): Uint8Array {
  const buffer = new ArrayBuffer(8)
  new DataView(buffer).setFloat64(0, value, true)
  return concat([varint((field << 3) | 1), new Uint8Array(buffer)])
}

/** `int64`, wire type 0: a plain varint, not zigzag (that is `sint64`). */
function int64Field(field: number, value: number): Uint8Array {
  return concat([varint(field << 3), varint(value)])
}

export interface RemoteWriteSample {
  readonly value: number
  /** Unix milliseconds. */
  readonly timestampMs: number
}

export interface RemoteWriteSeries {
  /** Must contain `__name__`; sorted by name before encoding. */
  readonly labels: Readonly<Record<string, string>>
  readonly samples: readonly RemoteWriteSample[]
}

export function encodeWriteRequest(series: readonly RemoteWriteSeries[]): Uint8Array {
  const encoded = series.map((entry) => {
    // Sorted by label name: the protocol requires it, and a receiver is entitled
    // to reject an unsorted series rather than sort it for you.
    const labels = Object.entries(entry.labels)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, value]) =>
        lengthDelimited(1, concat([stringField(1, name), stringField(2, value)])),
      )

    const samples = entry.samples.map((sample) =>
      lengthDelimited(2, concat([doubleField(1, sample.value), int64Field(2, sample.timestampMs)])),
    )

    return lengthDelimited(1, concat([...labels, ...samples]))
  })

  return concat(encoded)
}

// ---------------------------------------------------------------------------
// Snappy (raw block format, literals only)
// ---------------------------------------------------------------------------

/**
 * Encodes a snappy raw block containing only literal runs.
 *
 * Valid snappy: the format's literal element exists precisely so an encoder may
 * decline to find a match. Every decoder handles it, and skipping match-finding
 * costs ratio rather than correctness — at a few kilobytes of metrics per push
 * that is not a trade worth a dependency for.
 */
export function snappyEncodeLiteral(input: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [varint(input.length)]

  // Chunked because a literal's length is encoded in at most four extra bytes,
  // and chunking keeps the tag path simple and total.
  const CHUNK = 1 << 16
  for (let offset = 0; offset < input.length; offset += CHUNK) {
    const chunk = input.subarray(offset, Math.min(offset + CHUNK, input.length))
    const n = chunk.length - 1

    if (n < 60) {
      parts.push(Uint8Array.from([n << 2]))
    } else if (n < 0x100) {
      parts.push(Uint8Array.from([60 << 2, n]))
    } else if (n < 0x10000) {
      parts.push(Uint8Array.from([61 << 2, n & 0xff, (n >> 8) & 0xff]))
    } else {
      parts.push(Uint8Array.from([62 << 2, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]))
    }
    parts.push(chunk)
  }

  // An empty payload is a zero-length block, not a zero-length body.
  return input.length === 0 ? Uint8Array.from([0]) : concat(parts)
}

// ---------------------------------------------------------------------------
// The exporter
// ---------------------------------------------------------------------------

/** Prometheus metric and label naming. A rejected name loses the whole push. */
const NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/
const LABEL_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/

export function isValidMetricName(name: string): boolean {
  return NAME_PATTERN.test(name)
}

/**
 * Rewrites a name Prometheus would reject into one it accepts.
 *
 * Every character outside `[a-zA-Z0-9_:]` becomes `_`, and a leading digit gains
 * a `_` prefix. Total by construction: the result always satisfies
 * `NAME_PATTERN`, including for the empty string (`_`).
 *
 * **This is a repair path, not the naming convention.** A name that has to be
 * rewritten publishes under a series name no alert rule in this repository
 * mentions, so the exporter also counts the rewrite on
 * `observability_metric_name_normalized_total` and logs it once — the drop it
 * replaces was silent, and a silent rewrite would only move the same failure.
 */
export function normalizeMetricName(name: string): string {
  const replaced = name.replace(/[^a-zA-Z0-9_:]/gu, '_')
  return NAME_PATTERN.test(replaced) ? replaced : `_${replaced}`
}

/**
 * `normalizeMetricName`'s label twin, total the same way. The only difference
 * is the alphabet: a label name allows no colon.
 */
export function normalizeLabelName(key: string): string {
  const replaced = key.replace(/[^a-zA-Z0-9_]/gu, '_')
  return LABEL_PATTERN.test(replaced) ? replaced : `_${replaced}`
}

/**
 * Labels for the wire. An undefined VALUE is skipped — that is an absent
 * measurement, not a mistake — but a key Prometheus would reject is REPAIRED,
 * never dropped (2026-08-10, completing 09eb02d): dropping it kept the
 * measurement while silently deleting its dimension, so every series keyed on
 * it collapsed into one and nothing said so. `onRepair` lets the exporter
 * count and log the rewrite; two keys that repair to the same name last-write
 * win, which is the same visible-collapse a repaired metric name accepts.
 */
export function sanitizeLabels(
  labels: MetricLabels,
  onRepair?: (original: string, rewritten: string) => void,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(labels)) {
    if (value === undefined) continue
    const usable = LABEL_PATTERN.test(key) ? key : normalizeLabelName(key)
    if (usable !== key) onRepair?.(key, usable)
    out[usable] = String(value)
  }
  return out
}

function seriesKey(name: string, labels: Record<string, string>): string {
  const rendered = Object.entries(labels)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join(',')
  return `${name}{${rendered}}`
}

export interface RemoteWriteOptions {
  readonly url: string
  readonly username: string
  readonly password: string
  /** Applied to every series — service, environment, version. */
  readonly defaultLabels?: MetricLabels
  readonly flushIntervalMs?: number
  readonly logger?: Logger
  /** Injectable for tests. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
  /**
   * Series kept in memory between flushes.
   *
   * A metrics exporter must not be able to exhaust the process it observes. Past
   * this, new series are dropped and counted — visibly, on a series of its own,
   * because silently sampling metrics makes every number downstream a guess.
   */
  readonly maxSeries?: number
}

export interface RemoteWriteMetrics extends Metrics {
  /** Pushes whatever has accumulated. Safe to call concurrently with writes. */
  flush(): Promise<void>
  stop(): Promise<void>
}

export const DEFAULT_FLUSH_INTERVAL_MS = 15_000
export const DEFAULT_MAX_SERIES = 5_000

/** Distinct non-conforming names logged per process. The counter is unbounded;
 * only the log lines are capped, so a caller generating names in a loop cannot
 * turn the repair path into a log flood. */
const MAX_REPORTED_NONCONFORMING_NAMES = 20

/**
 * Buffers counters and gauges in memory and pushes them on an interval.
 *
 * Counters are **cumulative**, which is what remote-write means by a counter:
 * the adapter keeps the running total per series and pushes that, so a `rate()`
 * in an alert rule sees a monotonic series and a process restart reads as a
 * counter reset rather than as a spike. Gauges push the last value seen.
 *
 * Nothing here can throw into a caller. `increment` and `gauge` are called from
 * request and ingest paths, and a metrics backend that can fail a batch converts
 * an observable problem into an outage.
 *
 * Nothing here silently discards a measurement either. A name Prometheus would
 * reject is repaired rather than dropped, and the repair is counted on
 * `observability_metric_name_normalized_total`; a series past `maxSeries` is
 * dropped and counted on `observability_series_dropped_total`. Both because a
 * counter that is emitted and never arrives is worse than one that was never
 * written — the code, the test and the dashboard all say it exists.
 */
export function createRemoteWriteMetrics(options: RemoteWriteOptions): RemoteWriteMetrics {
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
  const maxSeries = options.maxSeries ?? DEFAULT_MAX_SERIES
  const doFetch = options.fetchImpl ?? fetch
  const now = options.now ?? (() => Date.now())
  const defaults = sanitizeLabels(options.defaultLabels ?? {})
  const authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString('base64')}`

  interface Entry {
    readonly name: string
    readonly labels: Record<string, string>
    value: number
    readonly cumulative: boolean
    dirty: boolean
  }

  const entries = new Map<string, Entry>()
  let dropped = 0
  let normalized = 0
  let labelNormalized = 0
  const reportedNames = new Set<string>()
  const reportedLabels = new Set<string>()
  let stopped = false

  const noteNormalized = (original: string, rewritten: string): void => {
    normalized += 1
    if (reportedNames.has(original) || reportedNames.size >= MAX_REPORTED_NONCONFORMING_NAMES)
      return
    reportedNames.add(original)
    options.logger?.warn('metric_name_normalized', {
      metric: original,
      published_as: rewritten,
      retryable: false,
    })
  }

  const noteLabelNormalized = (original: string, rewritten: string): void => {
    labelNormalized += 1
    if (reportedLabels.has(original) || reportedLabels.size >= MAX_REPORTED_NONCONFORMING_NAMES)
      return
    reportedLabels.add(original)
    options.logger?.warn('label_name_normalized', {
      label: original,
      published_as: rewritten,
      retryable: false,
    })
  }

  const record = (name: string, labels: MetricLabels, value: number, cumulative: boolean): void => {
    try {
      // Never a silent `return` on a name Prometheus would reject. That was the
      // original behaviour and it cost every `collector.*` and `realtime.*`
      // series: the emission site was correct, the unit tests recorded it, and
      // nothing at all arrived at the backend. The measurement is published
      // under a repaired name and the repair is counted (see `flush`), so the
      // series exists and the naming mistake is visible instead of silent.
      const seriesName = isValidMetricName(name) ? name : normalizeMetricName(name)
      if (seriesName !== name) noteNormalized(name, seriesName)
      const merged = {
        ...defaults,
        ...sanitizeLabels(labels, noteLabelNormalized),
        __name__: seriesName,
      }
      const key = seriesKey(seriesName, merged)
      const existing = entries.get(key)

      if (existing) {
        existing.value = cumulative ? existing.value + value : value
        existing.dirty = true
        return
      }

      if (entries.size >= maxSeries) {
        dropped += 1
        return
      }
      entries.set(key, { name: seriesName, labels: merged, value, cumulative, dirty: true })
    } catch {
      // A counter must never be the reason anything else fails.
    }
  }

  const flush = async (): Promise<void> => {
    const timestampMs = now()
    const series: RemoteWriteSeries[] = []

    for (const entry of entries.values()) {
      // A cumulative counter is republished every interval even when it did not
      // move, so its series stays continuous and `rate()` does not see a gap.
      // A gauge is only sent once it has been observed at least once.
      if (!entry.cumulative && !entry.dirty) continue
      series.push({ labels: entry.labels, samples: [{ value: entry.value, timestampMs }] })
      entry.dirty = false
    }

    if (dropped > 0) {
      series.push({
        labels: { ...defaults, __name__: 'observability_series_dropped_total' },
        samples: [{ value: dropped, timestampMs }],
      })
    }

    // The repair path, on a series of its own. A rewritten name reaches the
    // backend under a string no alert rule here mentions, so the only thing that
    // makes it findable is this counter being non-zero for a service.
    if (normalized > 0) {
      series.push({
        labels: { ...defaults, __name__: 'observability_metric_name_normalized_total' },
        samples: [{ value: normalized, timestampMs }],
      })
    }

    // The label analogue of the counter above, for the same reason: a repaired
    // key publishes under a label no dashboard filter here mentions, and this
    // being non-zero is what makes that discoverable.
    if (labelNormalized > 0) {
      series.push({
        labels: { ...defaults, __name__: 'observability_label_name_normalized_total' },
        samples: [{ value: labelNormalized, timestampMs }],
      })
    }

    if (series.length === 0) return

    const body = snappyEncodeLiteral(encodeWriteRequest(series))

    try {
      const response = await doFetch(options.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-protobuf',
          'Content-Encoding': 'snappy',
          'X-Prometheus-Remote-Write-Version': '0.1.0',
          Authorization: authorization,
        },
        body,
      })

      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        options.logger?.warn('metrics_push_rejected', {
          status: response.status,
          series: series.length,
          // Truncated: the backend echoes sample content in some errors, and a
          // metrics failure must not become a second place data leaks into logs.
          detail: detail.slice(0, 200),
          retryable: response.status >= 500 || response.status === 429,
        })
      }
    } catch (err) {
      // Deliberately not retried and not buffered. A backlog of unsent metrics
      // grows without bound during exactly the outage that produced it, and the
      // next flush carries the cumulative value anyway — so a missed push costs
      // resolution, not data.
      options.logger?.warn('metrics_push_failed', { err, retryable: true })
    }
  }

  const timer = setInterval(() => {
    if (stopped) return
    void flush()
  }, flushIntervalMs)
  timer.unref?.()

  return {
    increment(name, labels = {}, value = 1) {
      record(name, labels, value, true)
    },
    gauge(name, value, labels = {}) {
      record(name, labels, value, false)
    },
    flush,
    async stop(): Promise<void> {
      stopped = true
      clearInterval(timer)
      // One last push, so the final seconds before a deploy are not a blind spot.
      await flush()
    },
  }
}

/**
 * Fans one call out to several backends.
 *
 * The logging metrics remain the floor everywhere: stdout is collected on every
 * host this runs on, so a limit trigger stays queryable even when the remote
 * backend is unreachable — which is the moment it matters most.
 */
export function combineMetrics(...sinks: readonly Metrics[]): Metrics {
  return {
    increment(name, labels, value) {
      for (const sink of sinks) sink.increment(name, labels, value)
    },
    gauge(name, value, labels) {
      for (const sink of sinks) sink.gauge(name, value, labels)
    },
  }
}
