import { createServiceMetrics, type ServiceMetricsEnv } from '@openanalytics/observability'
import { createCapturedLogger } from '@openanalytics/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The G-006 service-metrics wiring (docs snapshot 05, G-006; ADR-0010/0015).
 *
 * The exporter's wire format is proven byte-for-byte in `remote-write.test.ts`;
 * what this owns is the entrypoint decision every long-lived service now shares —
 * build the exporter only with all three credentials, keep the logging floor
 * either way, label every series with the service identity, and say so once when
 * remote-write is off.
 */

const BASE: ServiceMetricsEnv = {
  METRICS_FLUSH_INTERVAL_SECONDS: 15,
  ENVIRONMENT: 'test',
  SERVICE_VERSION: '9.9.9',
}

const WITH_CREDS: ServiceMetricsEnv = {
  ...BASE,
  METRICS_REMOTE_WRITE_URL: 'https://metrics.test/api/prom/push',
  METRICS_REMOTE_WRITE_USER: 'tenant-1',
  METRICS_REMOTE_WRITE_TOKEN: 'a-secret-token',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createServiceMetrics — no remote-write credentials', () => {
  it('returns the logging floor alone and records the degradation once', () => {
    const captured = createCapturedLogger()
    const sm = createServiceMetrics({
      env: BASE,
      logger: captured.logger,
      service: 'collector',
      instance: 'collector-abc123',
    })

    expect(sm.remoteWrite).toBeNull()
    expect(captured.find('metrics_remote_write_disabled')).toHaveLength(1)

    // The floor is live: an increment still lands as a structured metric line.
    sm.metrics.increment('collector_some_counter', { reason: 'x' })
    const metric = captured.find('metric')
    expect(metric).toHaveLength(1)
    expect(metric[0]?.['metric']).toBe('collector_some_counter')
  })

  it('stops cleanly when no exporter was built', async () => {
    const captured = createCapturedLogger()
    const sm = createServiceMetrics({
      env: BASE,
      logger: captured.logger,
      service: 'api',
      instance: 'api-abc123',
    })
    await expect(sm.stop()).resolves.toBeUndefined()
  })
})

describe('createServiceMetrics — remote-write credentials present', () => {
  it('builds the exporter, keeps the floor, and emits no disabled warning', () => {
    const captured = createCapturedLogger()
    const sm = createServiceMetrics({
      env: WITH_CREDS,
      logger: captured.logger,
      service: 'realtime',
      instance: 'realtime-abc123',
    })

    expect(sm.remoteWrite).not.toBeNull()
    expect(captured.find('metrics_remote_write_disabled')).toHaveLength(0)

    // The logging floor stays underneath the exporter.
    sm.metrics.increment('realtime_some_counter')
    expect(captured.find('metric')).toHaveLength(1)
  })

  it('labels every series with service/environment/version/instance', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const captured = createCapturedLogger()
    const sm = createServiceMetrics({
      env: WITH_CREDS,
      logger: captured.logger,
      service: 'query-gateway',
      instance: 'query-gateway-deadbeef',
    })

    // A Prometheus-valid name; the exporter's own validator drops dotted names.
    sm.metrics.increment('gateway_requests_total')
    await sm.remoteWrite!.flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(WITH_CREDS.METRICS_REMOTE_WRITE_URL)
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/x-protobuf')
    expect(headers['Content-Encoding']).toBe('snappy')
    expect(headers['Authorization']).toMatch(/^Basic /)

    // The body is a snappy literal block of the remote-write protobuf, so the
    // label strings appear verbatim — the default labels are applied to the
    // series the exporter pushes.
    const body = new TextDecoder().decode(init.body as Uint8Array)
    expect(body).toContain('query-gateway')
    expect(body).toContain('query-gateway-deadbeef')
    expect(body).toContain('9.9.9')
    expect(body).toContain('gateway_requests_total')
    expect(body).toContain('instance')
    expect(body).toContain('environment')

    await sm.stop()
  })
})
