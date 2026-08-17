/**
 * Authorization helpers.
 *
 * The role and capability *vocabulary* and the role → capability matrix are
 * domain policy and live in `@openanalytics/domain` (with plans and entitlement
 * rules); they are re-exported here so authorization consumers have one import.
 * This package adds the Better Auth configuration and the enforcement helpers on
 * top (docs snapshot 02 §19).
 */
export {
  CAPABILITIES,
  SITE_ROLES,
  SITE_STATES,
  capabilitiesForRole,
  isCapability,
  isSiteRole,
  roleHasCapability,
  type Capability,
  type SiteRole,
  type SiteState,
} from '@openanalytics/domain'

export { AuthorizationError, authorizeCapability, canAct } from './authorize.ts'

/**
 * Service-to-service request signing.
 *
 * This lives in a package rather than in the gateway because it has two sides
 * that must not drift: the API signs, the query gateway verifies, and a signer
 * that disagrees with its verifier is the most likely way this scheme breaks.
 * Apps are forbidden from importing each other (`pnpm run boundaries`), so a
 * shared definition has to sit below both of them.
 */
export {
  SIGNATURE_HEADERS,
  SIGNATURE_LIFETIME_CEILING_MS,
  SIGNATURE_SCHEME,
  canonicalSigningString,
  loadVerifyKey,
  sha256Hex,
  signRequest,
  signedPathOf,
  verifySignature,
  type SignRequestInput,
  type SignatureFields,
} from './service-signature.ts'

/**
 * Realtime scoped-token codec (docs snapshot 05, D-213). Like the service
 * signature, it lives here because the api signs and the realtime gateway
 * verifies, and the two sides must not drift.
 */
export {
  REALTIME_TOKEN_AUDIENCE,
  REALTIME_TOKEN_IAT_SKEW_SECONDS,
  REALTIME_TOKEN_SCHEME,
  loadRealtimeVerifyKey,
  signRealtimeToken,
  verifyRealtimeToken,
  type RealtimeTokenClaims,
  type RealtimeTokenRejectReason,
  type RealtimeTokenScope,
  type RealtimeTokenVerifyResult,
  type SignRealtimeTokenInput,
  type VerifyRealtimeTokenOptions,
} from './realtime-token.ts'

/**
 * Better Auth configuration — Postgres sessions, verified email, 30-day rolling
 * session and env-gated OAuth (docs snapshot 02 §1 item 13). The verification
 * email leaves only through the injected outbox enqueue callback.
 */
export {
  CLI_CLIENT_ID,
  FIRST_PARTY_CLIENT_IDS,
  MCP_CLIENT_ID,
  OIDC_BASE_SCOPES,
  REQUESTABLE_READ_SCOPES,
  firstPartyClients,
  supportedOAuthScopes,
  type FirstPartyClient,
} from './oauth-clients.ts'

export {
  MAGIC_LINK_EXPIRES_IN_SECONDS,
  OAUTH_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
  OAUTH_DEVICE_CODE_EXPIRES_IN,
  OAUTH_DEVICE_POLL_INTERVAL,
  OAUTH_REFRESH_TOKEN_EXPIRES_IN_SECONDS,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
  buildAuthOptions,
  createAuth,
  drizzleAuthDatabase,
  memoryAdapter,
  type Auth,
  type AuthDatabase,
  type BuildAuthOptionsDeps,
  type OAuthCredentials,
} from './better-auth.ts'
