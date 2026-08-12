import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { deviceAuthorization, magicLink, mcp, oidcProvider } from 'better-auth/plugins'
import { newId, schema, type Database } from '@openanalytics/postgres'
import { firstPartyClients, supportedOAuthScopes } from './oauth-clients.ts'

/**
 * Better Auth configuration.
 *
 * The session model is closed (docs snapshot 02 §1 item 13): Postgres-backed
 * sessions, verified-email required for password login, a 30-day rolling
 * session refreshed at most daily. Social providers are env-gated — a provider
 * is configured only when its credentials are present, so a build without an
 * OAuth app simply has no button for it (plan Milestone 2 item 2). The magic
 * link is gated the same way, on the presence of its email callback.
 *
 * Cookies are host-only (no domain), HttpOnly and same-site; Better Auth adds
 * the `Secure` attribute and the `__Secure-` name prefix when the base URL is
 * HTTPS or the process is production (docs snapshot 02 §19, 03 §7). Requests
 * that change state are checked against `trustedOrigins`, which is the CSRF /
 * wrong-origin boundary.
 *
 * `buildAuthOptions` is separated from `createAuth`, and takes the database
 * adapter rather than a connection, so the configuration and the whole request
 * pipeline are testable against the in-memory adapter without Postgres.
 */

export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30 // 30 days (rolling)
export const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24 // refresh at most daily

/** The login card's copy promises "expires in 15 minutes"; this keeps it true. */
export const MAGIC_LINK_EXPIRES_IN_SECONDS = 60 * 15

/**
 * OAuth token lifetimes (ADR-0043 D9).
 *
 * One hour is the OIDC recommendation and Better Auth's default, restated here
 * so the number has a name rather than being an absent option. Thirty days on
 * the refresh token rather than the library's seven: a CLI that has to run
 * `oa login` weekly is a CLI people stop using, and the refresh token's exposure
 * is bounded by the same revocation the access token has — the row, and the
 * user's live membership on every request (D3).
 */
export const OAUTH_ACCESS_TOKEN_EXPIRES_IN_SECONDS = 60 * 60
export const OAUTH_REFRESH_TOKEN_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 30

/**
 * How long a device code is good for, and how often the device may poll.
 *
 * Ten minutes rather than the plugin's thirty: the code is on a human's screen
 * and being typed into a browser *now*, and a code that outlives the sitting is
 * a code somebody can approve after walking away from the terminal. Five seconds
 * is RFC 8628's recommended minimum interval, and the plugin enforces it with
 * `slow_down`.
 */
export const OAUTH_DEVICE_CODE_EXPIRES_IN = '10m'
export const OAUTH_DEVICE_POLL_INTERVAL = '5s'

/** Base session cookie name; `Secure` deployments get a `__Secure-` prefix. */
export const SESSION_COOKIE_NAME = 'oa_session'

/** The Better Auth database adapter type, so callers can inject either the
 * Drizzle adapter or the in-memory one used in tests. */
export type AuthDatabase = BetterAuthOptions['database']

export interface OAuthCredentials {
  readonly clientId: string
  readonly clientSecret: string
}

export interface BuildAuthOptionsDeps {
  readonly database: AuthDatabase
  readonly secret: string
  /** Public base URL of the auth API; drives HTTPS cookie detection. */
  readonly baseURL?: string
  /** Product display name from typed config, never a hard-coded brand (D-005). */
  readonly productName: string
  readonly trustedOrigins: readonly string[]
  readonly social?: {
    readonly google?: OAuthCredentials
    readonly github?: OAuthCredentials
  }
  /** Forces the `Secure` cookie attribute on/off; left to Better Auth's
   * base-URL/production detection when omitted. */
  readonly secureCookies?: boolean
  readonly cookieSameSite?: 'lax' | 'strict' | 'none'
  /**
   * Enqueues the verification email. The concrete implementation writes an
   * outbox row (docs snapshot 02 §6); this callback is all Better Auth sees, so
   * no email can leave without passing through the outbox.
   */
  readonly sendVerificationEmail: (input: {
    to: string
    url: string
    token: string
  }) => Promise<void>
  /**
   * Enqueues the magic-link email; same outbox seam as `sendVerificationEmail`.
   * The magic-link endpoints exist only when this is provided — a caller that
   * cannot deliver the email has no business exposing `/sign-in/magic-link`,
   * exactly as a build without OAuth credentials has no provider button.
   *
   * Sign-up via magic link is deliberately allowed: email, Google and GitHub
   * share one door — an unknown address gets an account on first verify, a
   * known one gets a session (product decision, 2026-07-26).
   */
  readonly sendMagicLinkEmail?: (input: { to: string; url: string; token: string }) => Promise<void>
  /**
   * Whether the email+password endpoints exist at all.
   *
   * The product's front door is OAuth and magic link; password sign-in is not
   * listed by `GET /v1/auth/providers` and exists only as a test-harness
   * affordance. The default stays `true` so the many tests that build an auth
   * instance directly keep their affordance, and `apps/api` passes the
   * env-derived value (`AUTH_PASSWORD_SIGNIN`, default disabled) — so
   * production, which does not set the variable, mounts no password routes
   * (ADR-0059).
   */
  readonly enablePasswordSignIn?: boolean
  /**
   * Whether a password session requires a verified address first.
   *
   * The default stays `true`, so this is not a relaxation of anything: every
   * caller that does not pass it — including `apps/api` when
   * `AUTH_EMAIL_VERIFICATION` is unset — behaves exactly as the hard-coded
   * `true` it replaces.
   *
   * It is a parameter because a self-hosted install can be in a state our
   * deployment never is: no working mail transport, and therefore no way to
   * receive the verification it is being asked for. `create-admin` avoids that
   * corner by writing a verified operator directly; this is the escape hatch for
   * the installs it does not cover.
   */
  readonly requireEmailVerification?: boolean
  /**
   * The three browser destinations the authorization server hands out
   * (ADR-0043 D14).
   *
   * All optional here and all computed by `apps/api` from environment, where
   * `loginPage` is the *frontend's* origin and the other two are the api's own
   * minimal pages. Omitted, each falls back to the same path on `baseURL`, which
   * is well-defined rather than a guess — `${baseURL}/login`,
   * `${baseURL}/oauth/consent`, `${baseURL}/oauth/device` — and is what keeps
   * every test that builds these options from having to name three URLs it does
   * not care about.
   *
   * `loginPage` is the one whose fallback is wrong in production: Better Auth's
   * base URL is the *api* host, and a login link built from it sends a person to
   * a page the api does not serve. That is exactly the defect ADR-0019 fixed for
   * the invite and Stripe links, which is why `apps/api` passes `APP_BASE_URL`
   * here and does not rely on this.
   */
  readonly loginPage?: string
  readonly consentPage?: string
  /** RFC 8628's `verification_uri` — printed for a human to type into whichever
   * browser they have, so it is absolute rather than a path. */
  readonly deviceVerificationUri?: string
}

/** Builds the Drizzle adapter with Better Auth's models mapped onto our tables. */
export function drizzleAuthDatabase(db: Database): AuthDatabase {
  return drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.users,
      session: schema.sessions,
      account: schema.accounts,
      verification: schema.verifications,
      // The authorization server's four (migration 0045). Mapped here rather
      // than left to the adapter's naming guess, which would look for tables
      // called `oauthApplication` and friends.
      oauthApplication: schema.oauthApplications,
      oauthAccessToken: schema.oauthAccessTokens,
      oauthConsent: schema.oauthConsents,
      deviceCode: schema.deviceCodes,
    },
  })
}

/**
 * RFC 8628's device flow, with its token endpoint removed (ADR-0043 D13).
 *
 * **`POST /device/token` does not mint an OAuth token. It creates a Better Auth
 * session and returns `session.token` as `access_token`** — read
 * `device-authorization/routes.mjs`, not the plugin's documentation. A session
 * token authenticates the *entire* dashboard surface, so a CLI holding one could
 * simply call `/v1/sites/...` instead of `/v1/read/...` and every scope on the
 * read surface would be a filter it routes around. That would make plan item 2's
 * "explicit analytics/realtime/revenue scopes" decorative.
 *
 * So the endpoint is deleted from the plugin rather than blocked in the router.
 * A path guard can be defeated by a spelling the router normalizes and this one
 * cannot: there is no route. What we keep is everything the plugin does well and
 * that is genuinely worth not re-deriving — user-code and device-code
 * generation, the `device_codes` lifecycle, expiry, and the session-authenticated
 * `/device/approve` and `/device/deny` where the human actually decides. The one
 * missing edge, an approved device code becoming a scoped access token, is
 * `apps/api`'s `POST /v1/oauth/device/token`.
 */
function scopedDeviceAuthorization(
  options: Parameters<typeof deviceAuthorization>[0],
): ReturnType<typeof deviceAuthorization> {
  const plugin = deviceAuthorization(options)
  const { deviceToken: _sessionIssuingTokenEndpoint, ...endpoints } = plugin.endpoints
  return { ...plugin, endpoints } as ReturnType<typeof deviceAuthorization>
}

/**
 * The OIDC provider, with its client-registration endpoint removed (ADR-0047
 * D1, third application of D13's technique).
 *
 * `POST /oauth2/register` is session-gated when `allowDynamicClientRegistration`
 * is false — gated, not closed: any logged-in user could register a client. And
 * what it registers is the wrong thing entirely: always `type: "web"`, always a
 * secret issued, which is the opposite of the public-clients-only stance both
 * ADR-0043 and ADR-0047 take. Dynamic registration is real now, but it is
 * `apps/api`'s `POST /v1/oauth/register`, which writes rows this provider's
 * `getClient` reads. The library endpoint is deleted so there is exactly one
 * registration door, and it is the one with the redirect policy and the rate
 * limit.
 */
function oidcWithoutClientRegistration(
  options: Parameters<typeof oidcProvider>[0],
): ReturnType<typeof oidcProvider> {
  const plugin = oidcProvider(options)
  const { registerOAuthApplication: _confidentialClientRegistrar, ...endpoints } = plugin.endpoints
  return { ...plugin, endpoints } as ReturnType<typeof oidcProvider>
}

/**
 * The MCP plugin, with its duplicate consent endpoint removed (ADR-0043 D13,
 * second application) — and, since ADR-0047, its registration endpoint too.
 *
 * `mcp()` is not a companion to `oidcProvider()` — it **contains one**. It
 * builds its own provider from `options.oidcConfig` and re-exports that
 * provider's `POST /oauth2/consent` as its own, so mounting both makes Better
 * Auth log `Endpoint path conflicts detected` at boot and leaves which handler
 * answers to registration order. That is not a warning to live with: the two
 * providers are separate instances, and the losing one would be configured
 * differently from the winner.
 *
 * Both are still mounted, because each carries something the other does not.
 * `oidcProvider` has the standard surface — `/oauth2/authorize`, `/oauth2/token`
 * (which is where the CLI's refresh grant lives), `/oauth2/userinfo`,
 * `/.well-known/openid-configuration`. `mcp` has RFC 9728's
 * `/.well-known/oauth-protected-resource`, RFC 8414's
 * `/.well-known/oauth-authorization-server`, `getMcpSession`, and the `after`
 * hook that completes an authorization interrupted by a login prompt.
 *
 * So the consent endpoint is deleted from `mcp` and kept on `oidcProvider`,
 * whose options are the ones this file actually configures. Both are handed the
 * **same options object**, so the internal provider cannot drift from the
 * mounted one — without that, `/mcp/authorize` would run with library defaults
 * and would not know our own clients exist.
 *
 * `registerMcpClient` (`POST /mcp/register`) is deleted for a sharper reason
 * than duplication: the library mounts it **with no gate at all** — no session,
 * no `allowDynamicClientRegistration` check, no https-or-loopback rule on
 * redirect URIs — and it only ever failed in production because it writes an
 * `authenticationScheme` field migration 0045 has no column for. ADR-0047
 * replaces that accident with `POST /v1/oauth/register` and its stated policy.
 *
 * The plugin's AS metadata document reads a top-level `metadata` override off
 * its options at runtime (the type does not declare it — the library's own
 * call passes `MCPOptions` where the signature says `OIDCOptions`), which is
 * why this wrapper's options type widens `Parameters<typeof mcp>[0]` by that
 * field: it is the only seam through which `registration_endpoint` and the
 * read scopes reach `/.well-known/oauth-authorization-server`.
 */
function mcpWithoutConsentOrRegistration(
  options: Parameters<typeof mcp>[0] & { metadata?: Record<string, unknown> },
): ReturnType<typeof mcp> {
  const plugin = mcp(options)
  const {
    oAuthConsent: _duplicateOfTheOidcProvidersOwn,
    registerMcpClient: _ungatedRegistrarWithoutOurRedirectPolicy,
    ...endpoints
  } = plugin.endpoints
  return { ...plugin, endpoints } as ReturnType<typeof mcp>
}

/** The default OAuth page URLs, on Better Auth's own base (see the deps doc). */
function oauthPages(deps: BuildAuthOptionsDeps): {
  loginPage: string
  consentPage: string
  deviceVerificationUri: string
} {
  const base = (deps.baseURL ?? 'http://localhost:4000').replace(/\/$/u, '')
  return {
    loginPage: deps.loginPage ?? `${base}/login`,
    consentPage: deps.consentPage ?? `${base}/oauth/consent`,
    deviceVerificationUri: deps.deviceVerificationUri ?? `${base}/oauth/device`,
  }
}

export function buildAuthOptions(deps: BuildAuthOptionsDeps): BetterAuthOptions {
  const pages = oauthPages(deps)

  /**
   * The registration endpoint, on the same base the pages use (ADR-0047 D1).
   * `apps/api` mounts it under `/v1` beside the device token exchange.
   */
  const registrationEndpoint = `${(deps.baseURL ?? 'http://localhost:4000').replace(/\/$/u, '')}/v1/oauth/register`

  /**
   * The metadata overrides both discovery documents must agree on (ADR-0047
   * D7): dynamic clients register at our endpoint, and the scopes on offer are
   * the real supported list, not the library's OIDC-only default. Spelled once
   * so `/.well-known/openid-configuration` and RFC 8414's
   * `/.well-known/oauth-authorization-server` cannot tell different stories.
   */
  const discoveryOverrides = {
    registration_endpoint: registrationEndpoint,
    scopes_supported: [...supportedOAuthScopes()],
  }

  /**
   * One options object, handed to both the mounted provider and the one the MCP
   * plugin builds internally. Written once for that reason: two spellings of
   * this would be two authorization servers that agree until somebody edits one.
   */
  const oidcOptions: Parameters<typeof oidcProvider>[0] = {
    // Where a `prompt=login` request sends the browser. `apps/web`'s login page,
    // because that is the only login screen there is — a URL, not a component,
    // so M16 still touches no frontend code.
    loginPage: pages.loginPage,
    // Our own page, served by the api as minimal HTML (D14). Better Auth would
    // otherwise render its default; ours states the scopes in the vocabulary the
    // rest of the product uses.
    consentPage: pages.consentPage,
    // OAuth 2.1. `plain` is refused: it is a code challenge that challenges
    // nothing, and a public client is exactly the case PKCE exists for.
    requirePKCE: true,
    allowPlainCodeChallengeMethod: false,
    // F-309 is settled (ADR-0047): dynamic registration is real, but it is
    // `apps/api`'s endpoint, not the library's — the endpoint this flag would
    // open is deleted by `oidcWithoutClientRegistration`. The flag stays false
    // as the second lock: a library upgrade that re-mounts a registration
    // endpoint behind it finds it shut, and the unit test pinning this line is
    // the tripwire that notices.
    allowDynamicClientRegistration: false,
    // ADR-0047 D7: the discovery documents advertise our registration endpoint
    // and the full scope list. This `metadata` reaches
    // `/.well-known/openid-configuration` directly, and the MCP plugin reads
    // `oidcConfig.metadata.scopes_supported` for its protected-resource
    // document — one override, two documents.
    metadata: discoveryOverrides,
    scopes: [...supportedOAuthScopes()],
    trustedClients: firstPartyClients(deps.productName),
    accessTokenExpiresIn: OAUTH_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
    refreshTokenExpiresIn: OAUTH_REFRESH_TOKEN_EXPIRES_IN_SECONDS,
  }

  const socialProviders: NonNullable<BetterAuthOptions['socialProviders']> = {}
  if (deps.social?.google) {
    socialProviders.google = {
      clientId: deps.social.google.clientId,
      clientSecret: deps.social.google.clientSecret,
    }
  }
  if (deps.social?.github) {
    socialProviders.github = {
      clientId: deps.social.github.clientId,
      clientSecret: deps.social.github.clientSecret,
    }
  }

  return {
    appName: deps.productName,
    secret: deps.secret,
    ...(deps.baseURL === undefined ? {} : { baseURL: deps.baseURL }),
    trustedOrigins: [...deps.trustedOrigins],
    database: deps.database,
    advanced: {
      // UUIDv7 ids, so Better Auth's rows carry the same id shape as every other
      // table and foreign keys line up on `uuid` (ADR-0006).
      database: { generateId: () => newId() },
      ...(deps.secureCookies === undefined ? {} : { useSecureCookies: deps.secureCookies }),
      // Enforce the origin/CSRF check in every environment. Better Auth otherwise
      // auto-disables it when it detects a test process, which would leave the
      // wrong-origin boundary unexercised in CI and staging.
      disableOriginCheck: false,
      cookiePrefix: 'oa',
      // Host-only (no domain), HttpOnly, same-site. The session cookie name is
      // fixed so the contract can name it (docs snapshot 03 §7).
      cookies: { session_token: { name: SESSION_COOKIE_NAME } },
      defaultCookieAttributes: { httpOnly: true, sameSite: deps.cookieSameSite ?? 'lax' },
    },
    emailAndPassword: {
      enabled: deps.enablePasswordSignIn ?? true,
      // Verified email is required before a password session is granted, unless
      // a self-hosted deployment has said otherwise (see the deps field).
      requireEmailVerification: deps.requireEmailVerification ?? true,
    },
    emailVerification: {
      sendOnSignUp: true,
      // A verification link must not silently log the user in; access follows a
      // deliberate sign-in, not a link click.
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url, token }) => {
        await deps.sendVerificationEmail({ to: user.email, url, token })
      },
    },
    session: {
      expiresIn: SESSION_MAX_AGE_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
    },
    user: {
      additionalFields: {
        /**
         * The user's home timezone (ADR-0026, migration 0023).
         *
         * Declared here for one reason: it makes Better Auth return the column on
         * the session response the frontend already fetches, so the dashboard
         * knows which clock to render in without a second round trip before its
         * first chart.
         *
         * `required: false` because the column is nullable and NULL is the
         * meaningful "never chosen" state. `input: false` because this surface
         * must not be able to set it — sign-up and `updateUser` would both accept
         * an unvalidated string, and the only writer that validates the
         * identifier against the runtime's tz database is
         * `PATCH /v1/me/preferences`. Readable here, writable there.
         */
        timezone: { type: 'string', required: false, input: false },
      },
    },
    socialProviders,
    /**
     * The plugin array is now unconditional (ADR-0043, D9).
     *
     * It used to exist only when a magic-link sender was configured, and the
     * conditional spread that expressed that is gone. Named here because it is
     * the kind of change a reader later mistakes for an accident: three plugins
     * are always on, and the magic link *joins* the list when its sender is
     * present instead of being the reason the list exists.
     */
    plugins: [
      ...(deps.sendMagicLinkEmail === undefined
        ? []
        : [
            magicLink({
              expiresIn: MAGIC_LINK_EXPIRES_IN_SECONDS,
              // Store only a hash; a database read must not yield a live link.
              storeToken: 'hashed',
              sendMagicLink: async ({ email, url, token }) => {
                await deps.sendMagicLinkEmail?.({ to: email, url, token })
              },
            }),
          ]),
      oidcWithoutClientRegistration(oidcOptions),
      scopedDeviceAuthorization({
        expiresIn: OAUTH_DEVICE_CODE_EXPIRES_IN,
        interval: OAUTH_DEVICE_POLL_INTERVAL,
        // The page a human types the code into — ours, not the plugin's JSON
        // status endpoint at `/api/auth/device`.
        verificationUri: pages.deviceVerificationUri,
        // A device code may only ever be requested for a client we know. Without
        // this, `POST /device/code` accepts any `client_id` string and the
        // approval page would name a client nobody registered.
        validateClient: (clientId) =>
          firstPartyClients(deps.productName).some((client) => client.clientId === clientId),
      }),
      // RFC 9728 protected-resource metadata, RFC 8414 authorization-server
      // metadata, and `getMcpSession`. Handed the *same* options object as the
      // provider above, because it builds a provider of its own out of them and
      // two differently-configured providers on one surface is the failure mode
      // `mcpWithoutConsentOrRegistration` exists to close. The top-level
      // `metadata` is the RFC 8414 document's override seam (ADR-0047 D7):
      // dynamic clients are public, so that document additionally narrows
      // `token_endpoint_auth_methods_supported` to what the token endpoint
      // will actually accept from them.
      mcpWithoutConsentOrRegistration({
        loginPage: pages.loginPage,
        oidcConfig: oidcOptions,
        metadata: {
          ...discoveryOverrides,
          token_endpoint_auth_methods_supported: ['none'],
        },
      }),
    ],
  }
}

export type Auth = ReturnType<typeof betterAuth>

export function createAuth(deps: BuildAuthOptionsDeps): Auth {
  return betterAuth(buildAuthOptions(deps))
}

/** In-memory Better Auth database, for tests and tooling. Re-exported here so
 * the `better-auth` dependency stays inside this package. */
export { memoryAdapter }
