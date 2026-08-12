import { GRANT_SCOPES, READ_SCOPES, type ReadScope } from '@openanalytics/domain'

/**
 * Our two first-party OAuth clients (ADR-0043 D9, D10).
 *
 * **Configuration, not rows.** Better Auth's `oidc-provider` consults its
 * `trustedClients` list before it queries `oauth_applications`, so a client
 * declared here needs no seed migration. That is the point: a client id seeded
 * by migration is a row an operator can edit or delete out from under the code,
 * changing a redirect URL becomes a migration, and `oauth_applications` stops
 * being a table whose emptiness *means* something. Empty, it says dynamic client
 * registration has never run — which is F-309's decision to make, not this
 * milestone's.
 *
 * Both are **public** clients: no secret, PKCE required. A secret compiled into
 * a CLI that runs on a customer's laptop is not a secret, and OAuth 2.1 says so.
 */

/** The CLI. Its credential comes from the device flow, so it never redirects. */
export const CLI_CLIENT_ID = 'oa-cli'

/** The MCP server's client, for the authorization-code flow an MCP host runs. */
export const MCP_CLIENT_ID = 'oa-mcp'

export const FIRST_PARTY_CLIENT_IDS: readonly string[] = [CLI_CLIENT_ID, MCP_CLIENT_ID]

/**
 * The redirect URLs an authorization-code client may come back to.
 *
 * A loopback address with an unspecified port is what a native client uses
 * (RFC 8252 §7.3), and Better Auth compares the whole URL, so the concrete ports
 * are listed rather than wildcarded. `oa-cli` has none at all: the device flow
 * has no redirect, and giving it one would leave an unused authorization-code
 * path open on a client that does not need it.
 */
const MCP_REDIRECT_URLS = [
  'http://127.0.0.1:8976/callback',
  'http://localhost:8976/callback',
] as const

export interface FirstPartyClient {
  readonly clientId: string
  readonly clientSecret?: string
  readonly name: string
  readonly type: 'public'
  readonly disabled: boolean
  readonly redirectUrls: string[]
  readonly metadata: Record<string, unknown> | null
  readonly icon?: string
}

export function firstPartyClients(productName: string): FirstPartyClient[] {
  return [
    {
      clientId: CLI_CLIENT_ID,
      name: `${productName} CLI`,
      type: 'public',
      disabled: false,
      redirectUrls: [],
      metadata: null,
    },
    {
      clientId: MCP_CLIENT_ID,
      name: `${productName} MCP`,
      type: 'public',
      disabled: false,
      redirectUrls: [...MCP_REDIRECT_URLS],
      metadata: null,
    },
  ]
}

/**
 * The scopes the authorization server will hand out at all.
 *
 * The four read scopes, the OAuth-only account-read and write scopes
 * (ADR-0048 D1), and the OIDC ones Better Auth's own endpoints need. They
 * travel in the same space-delimited string and are told apart on the way out
 * by the narrowing each surface applies — `readScopesFromGrant` for the read
 * arm and the device exchange (which is what keeps the CLI at the four read
 * scopes with no CLI change), `grantScopesFromGrant` for the consent screen
 * and the business subtree's grant arm. `openid` never becomes authorization
 * anywhere by sharing a string with `analytics:read`.
 *
 * This list is the ceiling: a scope absent here cannot be granted to any
 * client, first-party or registered (ADR-0047 D4).
 */
export const OIDC_BASE_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const

/**
 * A function rather than the constant it used to be, because the grantable
 * vocabulary is now extensible: an optional surface registers its scopes at
 * import time (`registerGrantScopes`), and a ceiling computed once at module
 * evaluation would have silently refused the scope the surface had just added —
 * a consent screen offering something the authorization server would not issue.
 * `GRANT_SCOPES` is that live list, and the OIDC basics are this package's own.
 */
export function supportedOAuthScopes(): readonly string[] {
  return [...OIDC_BASE_SCOPES, ...GRANT_SCOPES]
}

/** The read scopes a first-party client may ask for. Both may ask for all four;
 * what they actually *get* is intersected with the user's own authorization on
 * the selected site, every request (ADR-0043 D4). */
export const REQUESTABLE_READ_SCOPES: readonly ReadScope[] = READ_SCOPES
