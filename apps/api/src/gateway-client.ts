import { randomUUID } from 'node:crypto'
import { ApiError } from '@openanalytics/contracts'
import { signRequest } from '@openanalytics/auth'

/**
 * Signed service client for the query gateway (docs snapshot 05, D-208; plan
 * Milestone 7 item 5).
 *
 * This is the *only* way the API reaches analytics data. It never opens a
 * ClickHouse connection — the API is forbidden a ClickHouse credential
 * (packages/domain/src/env.ts FORBIDDEN_KEYS) — and it never speaks SQL. It posts
 * an allowlisted operation ID with typed parameters to `POST /v1/query`, under a
 * short-lived Ed25519 signature bound to method, path, body hash, audience and a
 * single-use nonce (the signing half lives in `@openanalytics/auth`; the gateway
 * verifies with the public key only).
 *
 * Two invariants this client keeps, both from AGENTS.md:
 *
 * - **A provider failure is never an empty result.** A dead gateway, a timeout or
 *   a non-2xx answer becomes a typed `ApiError`, never `{ rows: [] }`. The caller
 *   turns that into degraded/unavailable response metadata; it must not be able
 *   to mistake "the gateway is down" for "this site has no data".
 * - **The response's emptiness must stay interpretable.** The gateway's own
 *   `meta` (row_count, truncated, elapsed_ms, cached) is passed straight through
 *   so the read route can surface truncation and cache state.
 */

export interface GatewayMeta {
  readonly row_count: number
  readonly truncated: boolean
  readonly elapsed_ms: number
  readonly cached: boolean
}

export interface GatewayResult<TRow = Record<string, unknown>> {
  readonly operation: string
  readonly rows: readonly TRow[]
  readonly meta: GatewayMeta
}

/**
 * Per-request options that are not query parameters.
 *
 * `cacheEpoch` is the site's `sites.config_version` (ADR-0030, decision 6). It
 * travels beside `operation`/`params` in the signed body and the gateway mixes
 * it into its cache key, so a block, a reactivation or a deletion start makes
 * every entry cached under the previous version unreachable. It is never bound
 * into SQL and never reaches an operation's parameter schema.
 */
export interface GatewayQueryOptions {
  readonly cacheEpoch?: number | undefined
}

/** The narrow contract the read routes depend on, so tests inject a fake. */
export interface AnalyticsGateway {
  query<TRow = Record<string, unknown>>(
    operation: string,
    params: Record<string, unknown>,
    options?: GatewayQueryOptions,
  ): Promise<GatewayResult<TRow>>
}

export interface HttpGatewayOptions {
  /** Base URL of the gateway, e.g. `https://query-gateway.internal`. */
  readonly gatewayUrl: string
  readonly privateKeyPem: string
  readonly keyId: string
  readonly audience: string
  readonly signatureLifetimeMs: number
  readonly timeoutMs: number
  /** Injectable for tests. */
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => Date
  readonly nonce?: () => string
}

const QUERY_PATH = '/v1/query'

function isErrorEnvelope(
  value: unknown,
): value is { error: { code: string; message: string; details?: Record<string, unknown> } } {
  if (typeof value !== 'object' || value === null) return false
  const error = (value as { error?: unknown }).error
  return typeof error === 'object' && error !== null && 'code' in error
}

/**
 * The production gateway client. Constructed only when the URL and signing key
 * are both configured (see `createApp`), so its fields are non-optional here.
 */
export class HttpAnalyticsGateway implements AnalyticsGateway {
  readonly #url: string
  readonly #privateKeyPem: string
  readonly #keyId: string
  readonly #audience: string
  readonly #lifetimeMs: number
  readonly #timeoutMs: number
  readonly #fetch: typeof globalThis.fetch
  readonly #now: () => Date
  readonly #nonce: () => string

  constructor(options: HttpGatewayOptions) {
    // Normalise so `${base}${QUERY_PATH}` never doubles a slash.
    this.#url = `${options.gatewayUrl.replace(/\/+$/, '')}${QUERY_PATH}`
    this.#privateKeyPem = options.privateKeyPem
    this.#keyId = options.keyId
    this.#audience = options.audience
    this.#lifetimeMs = options.signatureLifetimeMs
    this.#timeoutMs = options.timeoutMs
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.#now = options.now ?? (() => new Date())
    this.#nonce = options.nonce ?? (() => randomUUID())
  }

  async query<TRow = Record<string, unknown>>(
    operation: string,
    params: Record<string, unknown>,
    options: GatewayQueryOptions = {},
  ): Promise<GatewayResult<TRow>> {
    // Omitted rather than sent as null when the caller has no site row to source
    // it from: the gateway's request schema is strict, and "absent" is exactly
    // the pre-ADR-0030 behaviour it must keep accepting.
    const body = JSON.stringify(
      options.cacheEpoch === undefined
        ? { operation, params }
        : { operation, params, cache_epoch: options.cacheEpoch },
    )
    const headers = signRequest({
      privateKeyPem: this.#privateKeyPem,
      keyId: this.#keyId,
      audience: this.#audience,
      method: 'POST',
      url: this.#url,
      body,
      nonce: this.#nonce(),
      issuedAt: this.#now(),
      lifetimeMs: this.#lifetimeMs,
    })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    let response: Response
    try {
      response = await this.#fetch(this.#url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
        signal: controller.signal,
      })
    } catch (error) {
      // A refused connection, DNS failure or the abort above all land here. The
      // gateway is unreachable — a "try again" for the caller, not empty data.
      const timedOut = error instanceof Error && error.name === 'AbortError'
      throw new ApiError('SERVICE_UNAVAILABLE', 'The analytics service is unreachable', {
        status: timedOut ? 504 : 503,
        details: { operation, timed_out: timedOut },
        expose: true,
        cause: error,
      })
    } finally {
      clearTimeout(timer)
    }

    const text = await response.text()
    let payload: unknown = null
    if (text.length > 0) {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = null
      }
    }

    if (!response.ok) {
      // The gateway answers every failure with the canonical envelope. Preserve
      // its code so a validation/unauthenticated fault is not laundered into a
      // generic 503, but never surface a bare non-envelope body.
      if (isErrorEnvelope(payload)) {
        throw new ApiError(
          asErrorCode(payload.error.code),
          'The analytics service rejected the request',
          {
            status: response.status,
            details: { operation, gateway_code: payload.error.code },
            expose: false,
          },
        )
      }
      throw new ApiError('SERVICE_UNAVAILABLE', 'The analytics service returned an error', {
        status: 503,
        details: { operation, gateway_status: response.status },
        expose: true,
      })
    }

    const result = payload as GatewayResult<TRow> | null
    if (!result || !Array.isArray(result.rows) || typeof result.meta !== 'object') {
      throw new ApiError(
        'SERVICE_UNAVAILABLE',
        'The analytics service returned a malformed answer',
        {
          status: 503,
          details: { operation },
          expose: true,
        },
      )
    }
    return result
  }
}

/**
 * Maps a gateway error code back onto the shared catalog. The gateway only ever
 * emits codes from the same catalog (packages/contracts), but a defensive default
 * keeps an unexpected string from crashing the mapping.
 */
function asErrorCode(code: string) {
  const known = [
    'VALIDATION_FAILED',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'SERVICE_UNAVAILABLE',
    'RATE_LIMITED',
  ] as const
  return (known as readonly string[]).includes(code)
    ? (code as (typeof known)[number])
    : 'SERVICE_UNAVAILABLE'
}
