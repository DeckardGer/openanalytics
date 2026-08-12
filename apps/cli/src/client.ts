import {
  DEVICE_CODE_GRANT_TYPE,
  isDeviceTokenPending,
  type DeviceTokenError,
} from '@openanalytics/domain'
import { EXIT_CODES, exitCodeForApiError, type ExitCode } from './exit-codes.ts'

/**
 * The CLI's whole HTTP surface (ADR-0043 D10).
 *
 * It talks to `/v1/read/*` and to the two device-flow endpoints, and to nothing
 * else. That is not minimalism for its own sake: §20 lists event definitions,
 * import/export status and key management as commands added "in stages", and a
 * client that already knew how to reach those routes would make adding them a
 * question of taste rather than of a decision.
 */

/** A failure the CLI can report and exit on, carrying its own exit code. */
export class CliError extends Error {
  readonly exitCode: ExitCode
  readonly detail: Record<string, unknown> | undefined

  constructor(message: string, exitCode: ExitCode, detail?: Record<string, unknown>) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
    this.detail = detail
  }
}

export interface ApiClientOptions {
  readonly baseUrl: string
  readonly accessToken?: string | undefined
  readonly siteId?: string | undefined
  readonly fetchImpl?: typeof fetch
}

interface ErrorEnvelope {
  readonly error?: { readonly code?: string; readonly message?: string }
}

export class ApiClient {
  readonly #baseUrl: string
  readonly #accessToken: string | undefined
  readonly #siteId: string | undefined
  readonly #fetch: typeof fetch

  constructor(options: ApiClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/u, '')
    this.#accessToken = options.accessToken
    this.#siteId = options.siteId
    this.#fetch = options.fetchImpl ?? fetch
  }

  /**
   * A `GET` on the read surface, with the API's error envelope turned into a
   * `CliError` carrying the right exit code.
   *
   * The translation happens here, once, rather than at each call site: every
   * command wants the same mapping, and a command that forgot it would exit `0`
   * on a `403`.
   */
  async get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.#baseUrl}${path}`)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)

    const headers: Record<string, string> = { accept: 'application/json' }
    if (this.#accessToken) headers['authorization'] = `Bearer ${this.#accessToken}`
    // Only when a site is selected. Sending an empty header would be a request
    // that names a site and does not, which the server refuses — correctly.
    if (this.#siteId) headers['x-oa-site'] = this.#siteId

    let response: Response
    try {
      response = await this.#fetch(url, { headers })
    } catch (error) {
      throw new CliError(
        `Could not reach ${this.#baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
        EXIT_CODES.failure,
      )
    }

    if (response.ok) return (await response.json()) as T

    const body = (await response.json().catch(() => ({}))) as ErrorEnvelope
    const code = body.error?.code ?? 'INTERNAL_ERROR'
    const retryAfter = response.headers.get('retry-after')
    throw new CliError(
      body.error?.message ?? `Request failed with status ${response.status}`,
      exitCodeForApiError(code),
      {
        code,
        status: response.status,
        ...(retryAfter === null ? {} : { retry_after_seconds: Number(retryAfter) }),
      },
    )
  }
}

export interface DeviceAuthorization {
  readonly deviceCode: string
  readonly userCode: string
  readonly verificationUri: string
  readonly verificationUriComplete: string | undefined
  readonly intervalSeconds: number
  readonly expiresInSeconds: number
}

export interface DeviceToken {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresInSeconds: number
  readonly scope: string
}

/** Start a device authorization (RFC 8628 §3.1). */
export async function requestDeviceAuthorization(input: {
  readonly baseUrl: string
  readonly clientId: string
  readonly scope: string
  readonly fetchImpl?: typeof fetch
}): Promise<DeviceAuthorization> {
  const doFetch = input.fetchImpl ?? fetch
  const response = await doFetch(`${input.baseUrl.replace(/\/$/u, '')}/api/auth/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: input.clientId, scope: input.scope }),
  })
  if (!response.ok) {
    throw new CliError(
      `The server refused to start a device authorization (${response.status})`,
      EXIT_CODES.failure,
    )
  }
  const body = (await response.json()) as {
    device_code: string
    user_code: string
    verification_uri: string
    verification_uri_complete?: string
    interval: number
    expires_in: number
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    verificationUriComplete: body.verification_uri_complete,
    intervalSeconds: body.interval,
    expiresInSeconds: body.expires_in,
  }
}

/**
 * Poll the token endpoint until a human answers (RFC 8628 §3.4–3.5).
 *
 * Three things this gets right, and each of them is a way real device-flow
 * clients get it wrong:
 *
 * - **`slow_down` widens the interval permanently**, by the RFC's five seconds,
 *   rather than being retried at the same cadence. A client that ignores it
 *   converts a polite refusal into a flood.
 * - **Only `authorization_pending` and `slow_down` continue.** Everything else
 *   stops — and `isDeviceTokenPending` in `packages/domain` is what decides,
 *   rather than a list this file maintains, so the CLI and the server cannot
 *   disagree about which errors mean "not yet". Treating `access_denied` as
 *   retryable is a CLI that polls forever after somebody clicked Deny.
 * - **The deadline is the server's `expires_in`**, so the CLI gives up when the
 *   code does rather than on a timeout of its own invention.
 */
export async function pollForDeviceToken(input: {
  readonly baseUrl: string
  readonly clientId: string
  readonly authorization: DeviceAuthorization
  readonly fetchImpl?: typeof fetch
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
}): Promise<DeviceToken> {
  const doFetch = input.fetchImpl ?? fetch
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const now = input.now ?? (() => Date.now())

  let intervalMs = Math.max(1, input.authorization.intervalSeconds) * 1000
  const deadline = now() + input.authorization.expiresInSeconds * 1000

  for (;;) {
    if (now() >= deadline) {
      throw new CliError(
        'The code expired before it was approved. Run `oa login` again.',
        EXIT_CODES.unauthenticated,
      )
    }
    await sleep(intervalMs)

    const response = await doFetch(`${input.baseUrl.replace(/\/$/u, '')}/v1/oauth/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: DEVICE_CODE_GRANT_TYPE,
        device_code: input.authorization.deviceCode,
        client_id: input.clientId,
      }).toString(),
    })

    if (response.ok) {
      const body = (await response.json()) as {
        access_token: string
        refresh_token: string
        expires_in: number
        scope: string
      }
      return {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresInSeconds: body.expires_in,
        scope: body.scope,
      }
    }

    const body = (await response.json().catch(() => ({}))) as {
      error?: string
      error_description?: string
    }
    const error = (body.error ?? 'invalid_request') as DeviceTokenError
    if (!isDeviceTokenPending(error)) {
      throw new CliError(
        body.error_description ?? `Authorization failed (${error})`,
        error === 'access_denied' ? EXIT_CODES.forbidden : EXIT_CODES.unauthenticated,
        { error },
      )
    }
    if (error === 'slow_down') {
      // RFC 8628 §3.5: add five seconds and keep it. Not a one-off backoff — the
      // server is telling us our steady rate is wrong.
      intervalMs += 5000
    }
  }
}

/**
 * Exchange a refresh token for a new access token.
 *
 * This is the authorization server's own endpoint, not ours: the device exchange
 * writes a token row in the shape Better Auth issues and reads, so every renewal
 * after the first one is the library's. That is what makes the device flow "one
 * exchange" rather than a second token system.
 */
export async function refreshAccessToken(input: {
  readonly baseUrl: string
  readonly clientId: string
  readonly refreshToken: string
  readonly fetchImpl?: typeof fetch
}): Promise<DeviceToken> {
  const doFetch = input.fetchImpl ?? fetch
  const response = await doFetch(`${input.baseUrl.replace(/\/$/u, '')}/api/auth/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: input.clientId,
    }).toString(),
  })
  if (!response.ok) {
    throw new CliError(
      'Your session could not be renewed. Run `oa login`.',
      EXIT_CODES.unauthenticated,
    )
  }
  const body = (await response.json()) as {
    access_token: string
    refresh_token: string
    expires_in: number
    scope: string
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresInSeconds: body.expires_in,
    scope: body.scope,
  }
}
