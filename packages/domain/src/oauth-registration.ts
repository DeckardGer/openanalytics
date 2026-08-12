/**
 * RFC 7591 dynamic client registration — the policy half (ADR-0047).
 *
 * It lives in `domain` for the reason the device-flow vocabulary does: the rules
 * are data-in/data-out and a unit test should be able to exhaust them without
 * mounting a router. `apps/api`'s `POST /v1/oauth/register` is the transport;
 * this file is what it enforces.
 *
 * The frame is the F-309 settlement (2026-08-08): public clients only, PKCE
 * required (the provider's job, not this file's), redirect URIs https or
 * loopback with no wildcards, and the scope ceiling stays whatever the
 * authorization server supports — registration introduces a client, it never
 * widens scopes.
 */

/** RFC 7591 §3.2.2's refusal vocabulary — the subset this server uses. */
export const CLIENT_REGISTRATION_ERRORS = [
  /** A redirect URI failed the https-or-loopback / no-wildcard policy. */
  'invalid_redirect_uri',
  /** Any other metadata refusal: wrong auth method, wrong grant, bad shape. */
  'invalid_client_metadata',
] as const

export type ClientRegistrationError = (typeof CLIENT_REGISTRATION_ERRORS)[number]

/** The grants a registered client may name. The device grant is deliberately
 * absent: it stays first-party-only (ADR-0047 D4), so the CLI's surface does
 * not move. */
export const REGISTRABLE_GRANT_TYPES = ['authorization_code', 'refresh_token'] as const

const REGISTRABLE_RESPONSE_TYPES = ['code'] as const

/** More URIs than any real client registers, few enough that a spray writes a
 * bounded row. */
export const MAX_REDIRECT_URIS = 10

/** The hosts RFC 8252 §7.3 lets a native client listen on over plain http. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost'])

export interface ValidatedClientRegistration {
  readonly redirectUris: readonly string[]
  /** Registration-supplied, for the consent screen; absent falls back to the
   * first redirect URI's host, so the screen always names *something* stable. */
  readonly clientName: string
  readonly grantTypes: readonly string[]
  readonly responseTypes: readonly string[]
  /** The requested scopes intersected with what the server supports — an echo,
   * not an authorization (ADR-0047 D4). */
  readonly scope: string
  /** `client_uri`, `logo_uri`, `software_id`, `software_version` — kept, not
   * rendered (ADR-0047 D5). */
  readonly metadata: Readonly<Record<string, string>> | null
}

export type ClientRegistrationResult =
  | { readonly ok: true; readonly registration: ValidatedClientRegistration }
  | {
      readonly ok: false
      readonly error: ClientRegistrationError
      readonly description: string
    }

function refuse(error: ClientRegistrationError, description: string): ClientRegistrationResult {
  return { ok: false, error, description }
}

/**
 * One redirect URI against ADR-0047 D3, or the sentence that refuses it.
 *
 * `https:` for any host; `http:` only for the loopback hosts, any port; no
 * fragment (RFC 6749 §3.1.2); no `*` anywhere in the string — a wildcard is
 * refused at registration so exact-match comparison at authorize time has
 * nothing to misjudge. Custom schemes are a policy widening to make
 * deliberately, not a default (ADR-0047 D3).
 */
function redirectUriRefusal(uri: string): string | null {
  if (uri.includes('*')) return `redirect_uri must not contain a wildcard: ${uri}`
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return `redirect_uri is not an absolute URL: ${uri}`
  }
  if (parsed.hash !== '') return `redirect_uri must not contain a fragment: ${uri}`
  if (parsed.protocol === 'https:') return null
  if (parsed.protocol === 'http:') {
    if (LOOPBACK_HOSTS.has(parsed.hostname === '::1' ? '[::1]' : parsed.hostname)) return null
    return `http redirect_uri is only accepted on a loopback host: ${uri}`
  }
  return `redirect_uri must be https or a loopback http URL: ${uri}`
}

/**
 * Judge an RFC 7591 registration request body.
 *
 * Pure and total: every path out is a value, so the endpoint's job reduces to
 * rate limiting, persisting and answering. The body arrives as `unknown`
 * because it is attacker-supplied JSON; nothing here trusts a shape it has not
 * checked.
 */
export function validateClientRegistration(
  body: unknown,
  supportedScopes: readonly string[],
): ClientRegistrationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return refuse('invalid_client_metadata', 'The registration request must be a JSON object')
  }
  const request = body as Record<string, unknown>

  // Public clients only (ADR-0047 D2). Absent means RFC 7591's default,
  // `client_secret_basic`, and is refused with the same sentence: a client that
  // asked for a secret and silently did not get one fails later and further
  // from the cause.
  if (request['token_endpoint_auth_method'] !== 'none') {
    return refuse(
      'invalid_client_metadata',
      "Only public clients are accepted: send token_endpoint_auth_method 'none'",
    )
  }

  const uris = request['redirect_uris']
  if (!Array.isArray(uris) || uris.length === 0) {
    return refuse('invalid_redirect_uri', 'redirect_uris must be a non-empty array')
  }
  if (uris.length > MAX_REDIRECT_URIS) {
    return refuse('invalid_redirect_uri', `redirect_uris must not exceed ${MAX_REDIRECT_URIS}`)
  }
  for (const uri of uris) {
    if (typeof uri !== 'string') {
      return refuse('invalid_redirect_uri', 'redirect_uris must be strings')
    }
    const refusal = redirectUriRefusal(uri)
    if (refusal !== null) return refuse('invalid_redirect_uri', refusal)
  }
  const redirectUris = uris as string[]

  const grantTypes = request['grant_types'] ?? [...REGISTRABLE_GRANT_TYPES]
  if (!Array.isArray(grantTypes) || grantTypes.length === 0) {
    return refuse('invalid_client_metadata', 'grant_types must be a non-empty array')
  }
  for (const grant of grantTypes) {
    if (!REGISTRABLE_GRANT_TYPES.includes(grant as (typeof REGISTRABLE_GRANT_TYPES)[number])) {
      return refuse(
        'invalid_client_metadata',
        `Unsupported grant_type: ${String(grant)}. Supported: ${REGISTRABLE_GRANT_TYPES.join(', ')}`,
      )
    }
  }

  const responseTypes = request['response_types'] ?? [...REGISTRABLE_RESPONSE_TYPES]
  if (
    !Array.isArray(responseTypes) ||
    responseTypes.length === 0 ||
    responseTypes.some((type) => type !== 'code')
  ) {
    return refuse('invalid_client_metadata', "response_types must be ['code']")
  }

  const rawName = request['client_name']
  if (rawName !== undefined && (typeof rawName !== 'string' || rawName.trim().length === 0)) {
    return refuse('invalid_client_metadata', 'client_name must be a non-empty string')
  }
  if (typeof rawName === 'string' && rawName.length > 120) {
    return refuse('invalid_client_metadata', 'client_name must be 120 characters or fewer')
  }
  const clientName = typeof rawName === 'string' ? rawName.trim() : new URL(redirectUris[0]!).host

  const rawScope = request['scope']
  if (rawScope !== undefined && typeof rawScope !== 'string') {
    return refuse('invalid_client_metadata', 'scope must be a space-delimited string')
  }
  const scope = (
    typeof rawScope === 'string' && rawScope.trim().length > 0
      ? rawScope.split(/\s+/u).filter((entry) => supportedScopes.includes(entry))
      : [...supportedScopes]
  ).join(' ')

  const kept: Record<string, string> = {}
  for (const field of ['client_uri', 'logo_uri', 'software_id', 'software_version'] as const) {
    const value = request[field]
    if (typeof value === 'string' && value.length > 0 && value.length <= 500) kept[field] = value
  }

  return {
    ok: true,
    registration: {
      redirectUris,
      clientName,
      grantTypes: grantTypes as string[],
      responseTypes: responseTypes as string[],
      scope,
      metadata: Object.keys(kept).length > 0 ? kept : null,
    },
  }
}
