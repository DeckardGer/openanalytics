import type { paths } from './generated/api.ts'
import { type ErrorEnvelope, ApiError, isErrorCode } from './errors.ts'

/**
 * Minimal typed client over the generated OpenAPI types.
 *
 * Docs snapshot 03 §3: the frontend never imports backend runtime source. It
 * consumes this package as a published artifact, so the client must stay
 * dependency-free and runnable in a browser as well as in Node.
 */

export type ApiPaths = paths

export interface ClientOptions {
  readonly baseUrl: string
  /**
   * Browser callers must send `credentials: 'include'` for the host-only
   * session cookie (docs snapshot 03 §7).
   */
  readonly credentials?: RequestCredentials
  readonly fetch?: typeof globalThis.fetch
  readonly headers?: Readonly<Record<string, string>>
}

export interface RequestOptions {
  readonly signal?: AbortSignal
  readonly headers?: Readonly<Record<string, string>>
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const error = (value as { error?: unknown }).error
  if (typeof error !== 'object' || error === null) return false
  return isErrorCode((error as { code?: unknown }).code)
}

export class OpenAnalyticsClient {
  readonly #baseUrl: string
  readonly #fetch: typeof globalThis.fetch
  readonly #credentials: RequestCredentials
  readonly #headers: Readonly<Record<string, string>>

  constructor(options: ClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.#credentials = options.credentials ?? 'include'
    this.#headers = options.headers ?? {}
  }

  async get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: 'GET',
      credentials: this.#credentials,
      headers: { accept: 'application/json', ...this.#headers, ...options.headers },
      ...(options.signal ? { signal: options.signal } : {}),
    })

    const text = await response.text()
    const body: unknown = text.length > 0 ? JSON.parse(text) : null

    if (!response.ok) {
      // The server always answers with the canonical envelope. A response that
      // is not one means a proxy or edge failed before the app did; surface that
      // as an infrastructure error rather than inventing a domain code.
      if (isErrorEnvelope(body)) {
        throw new ApiError(body.error.code, body.error.message, {
          status: response.status,
          details: body.error.details,
        })
      }
      throw new ApiError('SERVICE_UNAVAILABLE', `unexpected ${response.status} response`, {
        status: response.status,
        expose: false,
      })
    }

    return body as T
  }

  health(options: RequestOptions = {}) {
    type Health = paths['/health']['get']['responses']['200']['content']['application/json']
    return this.get<Health>('/health', options)
  }
}
