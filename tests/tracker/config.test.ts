import {
  CONFIG_CACHE_TTL_MS,
  loadTrackerConfig,
  safeStorage,
  toRuntimeConfig,
} from '../../apps/tracker/src/index.ts'
import { beforeEach, describe, expect, it } from 'vitest'
import { createHarness, resetBrowser } from './harness.ts'

/**
 * The tracker's side of the configuration contract (docs snapshot 02 §11).
 *
 * Two caches: the CDN's, keyed by `ETag`, and this local one. Inside the soft
 * TTL there is no request at all; after it, the request is conditional. A failed
 * fetch is never fatal.
 */

const RESPONSE = {
  config_version: 7,
  site_timezone: 'Asia/Baku',
  allowed_domains: ['shop.example.com'],
  redact_query_keys: ['Order_Ref'],
  interaction_sampling: 0.25,
  heartbeat_interval_seconds: 30,
  features: { web_vitals: true, engagement: true, interactions: false, heartbeat: true },
}

interface FetchCall {
  url: string
  headers: Record<string, string> | undefined
}

function loader(calls: FetchCall[], respond: () => Response, now: () => number) {
  return {
    collectorUrl: 'https://collect.example.com',
    trackingKey: 'oa_pub_live_abcdef123456',
    storage: safeStorage(window.localStorage),
    now,
    fetchImpl: (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> | undefined })
      return Promise.resolve(respond())
    },
  }
}

const okResponse = () =>
  new Response(JSON.stringify(RESPONSE), {
    status: 200,
    headers: { ETag: '"oa-site_1-7"', 'Content-Type': 'application/json' },
  })

beforeEach(() => {
  resetBrowser()
})

describe('tracker config loader', () => {
  it('fetches, caches and normalizes the response', async () => {
    const calls: FetchCall[] = []
    const config = await loadTrackerConfig(loader(calls, okResponse, () => 1_000))

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(
      'https://collect.example.com/v1/tracker/config?key=oa_pub_live_abcdef123456',
    )
    expect(config?.heartbeatIntervalSeconds).toBe(30)
    expect(config?.interactionSampling).toBe(0.25)
    expect(config?.features?.interactions).toBe(false)
    // Redaction keys are matched case-insensitively, so they are normalized once.
    expect(config?.redactQueryKeys).toEqual(['order_ref'])
  })

  it('makes no request at all inside the soft TTL', async () => {
    const calls: FetchCall[] = []
    await loadTrackerConfig(loader(calls, okResponse, () => 1_000))
    await loadTrackerConfig(loader(calls, okResponse, () => 1_000 + CONFIG_CACHE_TTL_MS - 1))

    expect(calls).toHaveLength(1)
  })

  it('revalidates with If-None-Match once the TTL lapses', async () => {
    const calls: FetchCall[] = []
    await loadTrackerConfig(loader(calls, okResponse, () => 1_000))

    const config = await loadTrackerConfig(
      loader(
        calls,
        () => new Response(null, { status: 304 }),
        () => 1_000 + CONFIG_CACHE_TTL_MS + 1,
      ),
    )

    expect(calls).toHaveLength(2)
    expect(calls[1]?.headers?.['If-None-Match']).toBe('"oa-site_1-7"')
    // A 304 keeps the cached configuration rather than falling back to defaults.
    expect(config?.heartbeatIntervalSeconds).toBe(30)
  })

  it('keeps the last known good configuration when the fetch fails', async () => {
    const calls: FetchCall[] = []
    await loadTrackerConfig(loader(calls, okResponse, () => 1_000))

    const config = await loadTrackerConfig(
      loader(
        calls,
        () => new Response(null, { status: 500 }),
        () => 1_000 + CONFIG_CACHE_TTL_MS + 1,
      ),
    )

    expect(config?.interactionSampling).toBe(0.25)
  })

  it('returns nothing rather than throwing when there is no cache and no network', async () => {
    const config = await loadTrackerConfig({
      collectorUrl: 'https://collect.example.com',
      trackingKey: 'oa_pub_live_abcdef123456',
      storage: safeStorage(window.localStorage),
      now: () => 1_000,
      fetchImpl: () => Promise.reject(new Error('offline')),
    })

    expect(config).toBeNull()
  })

  it('clamps values a malformed configuration might carry', async () => {
    const runtime = toRuntimeConfig({
      interaction_sampling: 4,
      heartbeat_interval_seconds: 1,
    })

    expect(runtime.interactionSampling).toBe(1)
    expect(runtime.heartbeatIntervalSeconds).toBe(5)
  })
})

describe('applying configuration to a running tracker', () => {
  it('uses per-site redaction keys on the next pageview', () => {
    const harness = createHarness()
    harness.tracker.applyConfig({ redactQueryKeys: ['order_ref'] })

    window.history.pushState(null, '', '/thanks?order_ref=A100&utm_source=google')

    const page = harness.eventsOfType('page_view').at(-1)?.['page'] as Record<string, unknown>
    expect(String(page['url'])).not.toContain('A100')
    expect(String(page['url'])).toContain('utm_source=google')
    harness.stop()
  })

  it('turns a signal off without restating the rest of the features', () => {
    const harness = createHarness()
    harness.tracker.applyConfig({ features: { heartbeat: false } })

    const before = harness.heartbeats().length
    harness.fireHeartbeatInterval()
    expect(harness.heartbeats().length).toBe(before)
    harness.stop()
  })
})
