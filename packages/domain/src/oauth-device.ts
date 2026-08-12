/**
 * RFC 8628's device-flow vocabulary (ADR-0043 D13).
 *
 * It lives in `domain` rather than in the api for the reason the read scopes do:
 * the CLI polls this endpoint and has to branch on these strings, and a
 * vocabulary defined inside the api is one the CLI would end up spelling a
 * second time.
 *
 * These are **not** our error envelope. `POST /v1/oauth/device/token` answers
 * `{ error, error_description }` with the status RFC 8628 assigns, because it is
 * an OAuth token endpoint and a client library that knows the RFC must be able
 * to read it. Every other endpoint on `/v1` uses `ApiError`; this one exception
 * is the protocol's, and it is the same exception the Better Auth endpoints it
 * sits beside already make.
 */

export const DEVICE_TOKEN_ERRORS = [
  /** Approved by nobody yet. The device keeps polling — this is the normal case. */
  'authorization_pending',
  /** Polled faster than the interval. The device must add 5 seconds (RFC 8628 §3.5). */
  'slow_down',
  /** The code aged out. The device starts a new authorization. */
  'expired_token',
  /** A human said no. The device stops. */
  'access_denied',
  /** Unknown device code, wrong client, or a code already exchanged. */
  'invalid_grant',
  /** Malformed request — a missing field or the wrong grant type. */
  'invalid_request',
] as const

export type DeviceTokenError = (typeof DEVICE_TOKEN_ERRORS)[number]

/** The grant type a device-code exchange must name (RFC 8628 §3.4). */
export const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

/**
 * Whether a device should keep polling after this error.
 *
 * The CLI's loop is written against this rather than against a list it
 * maintains: `slow_down` and `authorization_pending` are both "not yet", and
 * everything else is over. Getting that wrong in the other direction — treating
 * `access_denied` as retryable — is a CLI that polls forever after a human
 * clicked Deny.
 */
export function isDeviceTokenPending(error: DeviceTokenError): boolean {
  return error === 'authorization_pending' || error === 'slow_down'
}

/**
 * How a human reads a device-flow scope on the approval page.
 *
 * Here rather than in the page's HTML so the CLI's `--scope` help, the consent
 * screen and the approval screen cannot describe the same string three ways. The
 * wording states what the holder can *see*, not which endpoints exist: a person
 * approving a terminal is deciding about their data, not about our routes.
 */
export const READ_SCOPE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'site:read': 'See which sites you have access to, and their install details',
  'analytics:read': 'Read your sites’ traffic reports',
  'realtime:read': 'Watch your sites’ live visitor stream',
  'revenue:read': 'Read your sites’ revenue — only on sites you own',
}
