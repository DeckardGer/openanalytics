import {
  createRemoteWriteMetrics,
  encodeWriteRequest,
  isValidMetricName,
  normalizeLabelName,
  normalizeMetricName,
  sanitizeLabels,
  snappyEncodeLiteral,
} from '@openanalytics/observability'
import { createCapturedLogger } from '@openanalytics/testkit'
import { describe, expect, it } from 'vitest'

/**
 * The remote-write wire format (docs snapshot 05, G-006).
 *
 * The encoder is hand-written to avoid two dependencies for one wire format, so
 * it is tested at the byte level rather than trusted. A protobuf field that is
 * off by one wire type does not fail loudly — the receiver answers `400` and the
 * metrics simply never appear, which is the failure mode an observability
 * pipeline is least able to notice about itself.
 */

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values)

describe('protobuf encoding', () => {
  it('encodes a label as two length-delimited strings inside a Label message', () => {
    const encoded = encodeWriteRequest([{ labels: { __name__: 'x' }, samples: [] }])

    // WriteRequest.timeseries = field 1, wire 2 → 0x0A; TimeSeries.labels =
    // field 1, wire 2 → 0x0A; Label.name = field 1 → 0x0A; Label.value =
    // field 2 → 0x12.
    // Lengths counted from the protocol: Label = 2 + 8 ("__name__") + 2 + 1
    // ("x") = 13; the TimeSeries.labels entry wraps it as tag + length + 13 =
    // 15; WriteRequest.timeseries wraps that as tag + length + 15 = 17.
    expect(Array.from(encoded)).toEqual([
      0x0a,
      0x0f, // WriteRequest.timeseries, length 15
      0x0a,
      0x0d, // TimeSeries.labels, length 13
      0x0a,
      0x08,
      ...Array.from(new TextEncoder().encode('__name__')),
      0x12,
      0x01,
      0x78, // "x"
    ])
  })

  it('sorts labels by name, because the protocol requires it', () => {
    const encoded = encodeWriteRequest([
      { labels: { zeta: '1', __name__: 'm', alpha: '2' }, samples: [] },
    ])
    const text = new TextDecoder().decode(encoded)

    expect(text.indexOf('__name__')).toBeLessThan(text.indexOf('alpha'))
    expect(text.indexOf('alpha')).toBeLessThan(text.indexOf('zeta'))
  })

  it('encodes a sample as a little-endian double and a varint timestamp', () => {
    const encoded = encodeWriteRequest([{ labels: {}, samples: [{ value: 1, timestampMs: 300 }] }])

    // Sample.value = field 1, wire 1 (0x09) then 8 bytes of IEEE-754 for 1.0;
    // Sample.timestamp = field 2, wire 0 (0x10) then varint(300) = 0xAC 0x02.
    // Sample content is 9 + 3 = 12 bytes, wrapped twice.
    expect(Array.from(encoded)).toEqual([
      0x0a, 0x0e, 0x12, 0x0c, 0x09, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f, 0x10, 0xac,
      0x02,
    ])
  })

  it('encodes a multi-byte varint for a real millisecond timestamp', () => {
    const encoded = encodeWriteRequest([
      { labels: {}, samples: [{ value: 0, timestampMs: 1_784_800_000_000 }] },
    ])
    // Round-trips through the same varint reader a receiver would use. The
    // timestamp tag is located by walking past the sample's double rather than
    // by searching for 0x10 — a length prefix can legitimately be 0x10 too.
    const doubleTag = encoded.indexOf(0x09)
    const start = doubleTag + 9
    expect(encoded[start]).toBe(0x10)
    let value = 0
    let shift = 1
    for (let index = start + 1; index < encoded.length; index += 1) {
      const byte = encoded[index] as number
      value += (byte & 0x7f) * shift
      if ((byte & 0x80) === 0) break
      shift *= 128
    }
    expect(value).toBe(1_784_800_000_000)
  })
})

describe('snappy literal encoding', () => {
  it('prefixes the uncompressed length as a varint', () => {
    expect(Array.from(snappyEncodeLiteral(bytes(1, 2, 3)))).toEqual([
      3, // uncompressed length
      (3 - 1) << 2, // literal tag, length - 1 in the top six bits
      1,
      2,
      3,
    ])
  })

  it('switches to the extended tag past 60 bytes', () => {
    const input = new Uint8Array(100).fill(7)
    const encoded = snappyEncodeLiteral(input)

    expect(encoded[0]).toBe(100)
    expect(encoded[1]).toBe(60 << 2)
    expect(encoded[2]).toBe(99)
    expect(encoded.length).toBe(103)
  })

  it('encodes an empty payload as a zero-length block', () => {
    expect(Array.from(snappyEncodeLiteral(new Uint8Array(0)))).toEqual([0])
  })

  it('survives a payload larger than one chunk', () => {
    const input = new Uint8Array(200_000).fill(3)
    const encoded = snappyEncodeLiteral(input)
    // Header varint + two chunk tags + the bytes themselves.
    expect(encoded.length).toBeGreaterThan(input.length)
    expect(encoded.length).toBeLessThan(input.length + 32)
  })
})

describe('naming rules', () => {
  it('refuses a metric name Prometheus would reject', () => {
    expect(isValidMetricName('worker_batch_completed')).toBe(true)
    expect(isValidMetricName('worker.batch.completed')).toBe(false)
    expect(isValidMetricName('9lives')).toBe(false)
  })

  it('repairs an unusable label key rather than dropping the label', () => {
    // The drop was the label analogue of the silent name drop 09eb02d fixed:
    // the measurement survived but its dimension vanished, so every series
    // that keyed on it collapsed into one — and nothing said so. The key is
    // repaired the same way names are; only an undefined VALUE still skips,
    // because that is an absent measurement, not a naming mistake.
    expect(sanitizeLabels({ ok: 'yes', 'not-ok': 'x', missing: undefined })).toEqual({
      ok: 'yes',
      not_ok: 'x',
    })
  })

  it('repairs any rejected label key into one Prometheus accepts', () => {
    expect(normalizeLabelName('site-id')).toBe('site_id')
    expect(normalizeLabelName('9th')).toBe('_9th')
    // No colon in a label name, unlike a metric name.
    expect(normalizeLabelName('a:b')).toBe('a_b')
    expect(normalizeLabelName('')).toBe('_')
  })

  it('repairs any rejected name into one Prometheus accepts', () => {
    expect(normalizeMetricName('collector.rate_limited')).toBe('collector_rate_limited')
    expect(normalizeMetricName('realtime.disconnect')).toBe('realtime_disconnect')
    expect(normalizeMetricName('a-b.c')).toBe('a_b_c')
    expect(normalizeMetricName('9lives')).toBe('_9lives')
    // Total: whatever goes in, what comes out is a legal name — including for
    // the degenerate input, which is the case a `replace` alone gets wrong.
    expect(normalizeMetricName('')).toBe('_')
    for (const input of ['collector.rate_limited', 'a-b.c', '9lives', '', '...']) {
      expect(isValidMetricName(normalizeMetricName(input))).toBe(true)
    }
  })
})

describe('the exporter', () => {
  const capture = () => {
    const requests: { url: string; headers: Record<string, string>; body: Uint8Array }[] = []
    const fetchImpl = (async (url: unknown, init: unknown) => {
      const request = init as { headers: Record<string, string>; body: Uint8Array }
      requests.push({ url: String(url), headers: request.headers, body: request.body })
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch
    return { requests, fetchImpl }
  }

  const exporter = (fetchImpl: typeof fetch, overrides = {}) =>
    createRemoteWriteMetrics({
      url: 'https://example.invalid/api/prom/push',
      username: 'user',
      password: 'token',
      defaultLabels: { service: 'worker' },
      flushIntervalMs: 3_600_000,
      fetchImpl,
      now: () => 1_784_800_000_000,
      ...overrides,
    })

  it('accumulates a counter and pushes the cumulative value', async () => {
    // Cumulative is what remote-write means by a counter: `rate()` needs a
    // monotonic series, and pushing per-interval deltas would make every rate
    // wrong by the interval.
    const { requests, fetchImpl } = capture()
    const metrics = exporter(fetchImpl)

    metrics.increment('worker_batch_completed', {}, 2)
    metrics.increment('worker_batch_completed', {}, 3)
    await metrics.flush()
    await metrics.stop()

    const text = new TextDecoder().decode(requests[0]?.body)
    expect(requests).toHaveLength(2) // the explicit flush, then stop's final push
    expect(text).toContain('worker_batch_completed')
    // 5 as a little-endian double appears in the encoded sample.
    expect(Array.from(requests[0]?.body ?? [])).toEqual(
      expect.arrayContaining([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x14, 0x40]),
    )
  })

  it('sends the protocol headers a receiver checks', async () => {
    const { requests, fetchImpl } = capture()
    const metrics = exporter(fetchImpl)
    metrics.gauge('worker_queue_oldest_age_ms', 12)
    await metrics.flush()

    expect(requests[0]?.headers['Content-Type']).toBe('application/x-protobuf')
    expect(requests[0]?.headers['Content-Encoding']).toBe('snappy')
    expect(requests[0]?.headers['X-Prometheus-Remote-Write-Version']).toBe('0.1.0')
    expect(requests[0]?.headers['Authorization']).toMatch(/^Basic /)
  })

  it('stamps the default labels onto every series', async () => {
    const { requests, fetchImpl } = capture()
    const metrics = exporter(fetchImpl)
    metrics.increment('worker_batch_completed')
    await metrics.flush()

    expect(new TextDecoder().decode(requests[0]?.body)).toContain('service')
  })

  it('publishes a repaired label key and counts the repair', async () => {
    const { requests, fetchImpl } = capture()
    const metrics = exporter(fetchImpl)
    metrics.increment('worker_fence_dropped', { 'site-id': 's1' })
    await metrics.flush()

    const text = new TextDecoder().decode(requests[0]?.body)
    expect(text).toContain('site_id')
    expect(text).toContain('observability_label_name_normalized_total')
  })

  it('pushes nothing when nothing was recorded', async () => {
    const { requests, fetchImpl } = capture()
    await exporter(fetchImpl).flush()
    expect(requests).toHaveLength(0)
  })

  it('keeps republishing a counter that has not moved', async () => {
    // A counter series that stops being sent leaves a gap, and `rate()` over a
    // gap is not zero — it is nothing.
    const { requests, fetchImpl } = capture()
    const metrics = exporter(fetchImpl)
    metrics.increment('worker_batch_completed')
    await metrics.flush()
    await metrics.flush()

    expect(requests).toHaveLength(2)
  })

  it('bounds its own memory and says so on a series of its own', async () => {
    const { requests, fetchImpl } = capture()
    const metrics = exporter(fetchImpl, { maxSeries: 2 })

    metrics.increment('a_total', { k: '1' })
    metrics.increment('b_total', { k: '2' })
    metrics.increment('c_total', { k: '3' })
    await metrics.flush()

    const text = new TextDecoder().decode(requests[0]?.body)
    expect(text).toContain('observability_series_dropped_total')
    expect(text).not.toContain('c_total')
  })

  /**
   * The M18 defect, pinned as a prohibition rather than as a behaviour.
   *
   * The exporter used to answer a dotted name with a bare `return`. Every
   * `collector.*` and `realtime.*` counter was therefore emitted, recorded by
   * the in-memory sink the unit tests watch, and never seen by Grafana — a
   * green suite over a series that did not exist. What must never come back is
   * the *silence*: a name the backend would reject may be published under a
   * repaired name or refused outright, but the caller's measurement may not
   * disappear without a trace of the refusal.
   */
  it('never silently discards a measurement whose name Prometheus would reject', async () => {
    const { requests, fetchImpl } = capture()
    const { logger, find } = createCapturedLogger()
    const metrics = exporter(fetchImpl, { logger })

    metrics.increment('collector.rate_limited', { scope: 'site' }, 3)
    metrics.gauge('realtime.disconnect', 7)
    await metrics.flush()

    const text = new TextDecoder().decode(requests[0]?.body)
    const arrived = text.includes('collector_rate_limited') && text.includes('realtime_disconnect')
    const refused = find('metric_name_normalized').length === 2

    // Either the push carries the repaired series, or the exporter said out
    // loud that it would not carry them. Both, here — but the assertion is the
    // disjunction, because that is the invariant: not silence.
    expect(arrived || refused).toBe(true)
    expect(arrived).toBe(true)
    expect(refused).toBe(true)

    // And the fact that a repair happened is itself a series, so a name that
    // no alert rule mentions is still discoverable from the backend alone.
    expect(text).toContain('observability_metric_name_normalized_total')

    // The dotted strings themselves reach the wire nowhere: a receiver rejects
    // the whole write request over one, which is how a single bad name used to
    // be able to cost every other series in the push.
    expect(text).not.toContain('collector.rate_limited')
    expect(text).not.toContain('realtime.disconnect')

    // The log line names both halves of the mapping, so an operator reading it
    // knows which PromQL string to type.
    expect(find('metric_name_normalized')[0]).toMatchObject({
      metric: 'collector.rate_limited',
      published_as: 'collector_rate_limited',
    })
  })

  it('reports a repeatedly repaired name once, and counts every occurrence', async () => {
    const { requests, fetchImpl } = capture()
    const { logger, find } = createCapturedLogger()
    const metrics = exporter(fetchImpl, { logger })

    for (let index = 0; index < 5; index += 1) metrics.increment('collector.rate_limited')
    await metrics.flush()

    // One log line — the repair path must not become a log flood — while the
    // counter carries all five, so the size of the mistake stays visible.
    expect(find('metric_name_normalized')).toHaveLength(1)
    const text = new TextDecoder().decode(requests[0]?.body)
    expect(text).toContain('observability_metric_name_normalized_total')
    // 5.0 as a little-endian double, the value of both series in this push.
    expect(Array.from(requests[0]?.body ?? [])).toEqual(
      expect.arrayContaining([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x14, 0x40]),
    )
  })

  it('never throws into the caller when the backend is unreachable', async () => {
    const failing = (() => Promise.reject(new Error('ENOTFOUND'))) as unknown as typeof fetch
    const metrics = exporter(failing)
    metrics.increment('worker_batch_completed')
    await expect(metrics.flush()).resolves.toBeUndefined()
  })

  it('never throws into the caller when the backend rejects the push', async () => {
    const rejecting = (() =>
      Promise.resolve(new Response('bad request', { status: 400 }))) as unknown as typeof fetch
    const metrics = exporter(rejecting)
    metrics.gauge('worker_queue_oldest_age_ms', 1)
    await expect(metrics.flush()).resolves.toBeUndefined()
  })
})
