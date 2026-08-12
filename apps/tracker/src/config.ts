import type { TrackerConfigPatch, TrackerRuntimeConfig } from './core.ts'
import type { SafeStorage } from './storage.ts'

/**
 * Tracker configuration fetch (docs snapshot 02 §11).
 *
 * The response is public, cacheable and version-stamped. Two caches sit in front
 * of it: the CDN's, keyed by `ETag`, and this one in `localStorage`. Inside the
 * soft TTL the tracker makes no request at all; after it, the request is a
 * conditional `If-None-Match`, so the common answer is a 304 with no body.
 *
 * The tracking key is a query parameter here because a `<script>`-driven GET has
 * nowhere else to put it. It stays write-only: this endpoint returns
 * configuration, never data, and the response carries no credential of any kind.
 *
 * A failed or malformed config is never fatal — the tracker keeps its defaults.
 */

const CONFIG_KEY = 'oa.config'

/**
 * Skip the network entirely for this long after a successful fetch.
 *
 * Five minutes, aligned with the endpoint's own `max-age=300` (ADR-0034, D4).
 * It was six hours, which made this a second and much longer staleness layer
 * stacked on the HTTP cache: a rule published in the dashboard reached an
 * already-cached browser up to six hours later, and a publish a customer cannot
 * observe is not a publish. At five minutes the `localStorage` copy is what it
 * is actually useful as — a de-dupe across rapid page loads — and the worst case
 * from Publish to a browser evaluating the rule is the ~600 s D4 states.
 *
 * The cost is at most one conditional `GET` per visitor per five minutes,
 * answered `304` with no body. A session shorter than five minutes — most of
 * them — makes no extra request at all.
 */
export const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000

interface TrackerConfigResponse {
  config_version?: number
  redact_query_keys?: string[]
  interaction_sampling?: number
  heartbeat_interval_seconds?: number
  features?: Partial<TrackerRuntimeConfig['features']>
  no_code_rules?: TrackerRuntimeConfig['noCodeRules']
}

interface CachedConfig {
  etag: string | null
  at: number
  body: TrackerConfigResponse
}

export function toRuntimeConfig(response: TrackerConfigResponse): TrackerConfigPatch {
  const runtime: {
    redactQueryKeys?: readonly string[]
    interactionSampling?: number
    heartbeatIntervalSeconds?: number
    features?: TrackerRuntimeConfig['features']
    noCodeRules?: TrackerRuntimeConfig['noCodeRules']
  } = {}

  if (Array.isArray(response.redact_query_keys)) {
    runtime.redactQueryKeys = response.redact_query_keys
      .filter((key): key is string => typeof key === 'string')
      .map((key) => key.toLowerCase())
  }
  if (typeof response.interaction_sampling === 'number') {
    runtime.interactionSampling = Math.min(1, Math.max(0, response.interaction_sampling))
  }
  if (typeof response.heartbeat_interval_seconds === 'number') {
    runtime.heartbeatIntervalSeconds = Math.min(
      300,
      Math.max(5, Math.round(response.heartbeat_interval_seconds)),
    )
  }
  if (Array.isArray(response.no_code_rules)) {
    // Passed through as received. Every rule was validated server-side at save
    // time (ADR-0034, D2), and a second, smaller validator in the bundle would
    // be a second opinion that could disagree with the first — the direction
    // that disagreement fails in is a rule the dashboard shows as live and the
    // browser silently ignores.
    runtime.noCodeRules = response.no_code_rules
  }
  if (response.features) {
    runtime.features = {
      web_vitals: response.features.web_vitals !== false,
      engagement: response.features.engagement !== false,
      interactions: response.features.interactions !== false,
      heartbeat: response.features.heartbeat !== false,
    }
  }

  return runtime as TrackerConfigPatch
}

export interface ConfigLoaderDeps {
  readonly collectorUrl: string
  readonly trackingKey: string
  readonly storage: SafeStorage
  readonly now: () => number
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
  /**
   * A rule-preview token from the page URL (ADR-0034, D6).
   *
   * Its presence changes three things: the request carries it, the response is
   * this page's *draft* rules rather than the published set, and nothing is read
   * from or written to the local cache. A preview must not displace the real
   * configuration for the next ordinary page load.
   */
  readonly previewToken?: string | undefined
}

function readCache(storage: SafeStorage): CachedConfig | null {
  const raw = storage.get(CONFIG_KEY)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && typeof (parsed as CachedConfig).at === 'number') {
      return parsed as CachedConfig
    }
  } catch {
    /* corrupt entry; treated as absent */
  }
  return null
}

export async function loadTrackerConfig(
  deps: ConfigLoaderDeps,
): Promise<TrackerConfigPatch | null> {
  const preview = deps.previewToken
  const cached = preview ? null : readCache(deps.storage)

  if (cached && deps.now() - cached.at < CONFIG_CACHE_TTL_MS) {
    return toRuntimeConfig(cached.body)
  }

  const fetchImpl = deps.fetchImpl
  if (!fetchImpl) return cached ? toRuntimeConfig(cached.body) : null

  const url = `${deps.collectorUrl.replace(/\/+$/, '')}/v1/tracker/config?key=${encodeURIComponent(
    deps.trackingKey,
  )}${preview ? `&preview=${encodeURIComponent(preview)}` : ''}`

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      credentials: 'omit',
      mode: 'cors',
      ...(cached?.etag ? { headers: { 'If-None-Match': cached.etag } } : {}),
    })

    if (response.status === 304 && cached) {
      deps.storage.set(CONFIG_KEY, JSON.stringify({ ...cached, at: deps.now() }))
      return toRuntimeConfig(cached.body)
    }

    if (!response.ok) return cached ? toRuntimeConfig(cached.body) : null

    const body = (await response.json()) as TrackerConfigResponse
    // A preview is never cached, at any layer — the server says `no-store` and
    // this is the other half of it. A draft rule set written here would be
    // served to the next ordinary page load from localStorage, long after the
    // preview session ended.
    if (!preview) {
      deps.storage.set(
        CONFIG_KEY,
        JSON.stringify({ etag: response.headers.get('etag'), at: deps.now(), body }),
      )
    }
    return toRuntimeConfig(body)
  } catch {
    // Offline, blocked or malformed: the tracker keeps working on defaults or
    // the last known good configuration.
    return cached ? toRuntimeConfig(cached.body) : null
  }
}
