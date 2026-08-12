import { boolean, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { createdAt, idColumn, instant, primaryId, updatedAt } from './_shared.ts'
import { users } from './auth.ts'

/**
 * Better Auth's authorization-server tables (mirror of migration 0045).
 *
 * Four models, from two plugins: `oidcProvider` brings `oauthApplication`,
 * `oauthAccessToken` and `oauthConsent`; `deviceAuthorization` brings
 * `deviceCode`. Property keys are Better Auth's camelCase model fields so the
 * drizzle adapter maps model → schema without per-field overrides, exactly as
 * `auth.ts` does for the core four; column names stay snake_case (ADR-0006).
 *
 * **Every one of these is user-scoped, and none of them is reached by a
 * cascade.** `users` rows are *scrubbed* and never deleted (ADR-0030 D8,
 * `site_billing_assignments.billing_user_id` being `NOT NULL RESTRICT`), so an
 * `ON DELETE CASCADE` on `user_id` would be a clause that can never fire — the
 * shape that let `idempotency_keys` survive account deletion until 2026-08-06.
 * The foreign keys below therefore carry **no** `ON DELETE` action, and account
 * deletion's Postgres teardown names all three of the tables that hold a
 * departing user's rows.
 */

/**
 * Registered OAuth clients.
 *
 * Our own CLI and MCP clients are configured as Better Auth `trustedClients` —
 * a list in code rather than rows an operator can edit out from under it, and a
 * redirect URL that changes is a deploy rather than a migration. `getClient`
 * consults the trusted list first and falls back to this table, so the
 * first-party ids never appear here.
 *
 * The only writer is dynamic client registration — F-309, settled by ADR-0047:
 * `POST /v1/oauth/register` writes public clients here with a `dcr_`-prefixed
 * `client_id` and **never** a `user_id` (registration is a client introducing
 * itself, not a user acquiring property — and a populated `user_id` on this
 * no-`ON DELETE` foreign key would block that user's account deletion). A row
 * whose `client_id` lacks the `dcr_` prefix should not exist.
 */
export const oauthApplications = pgTable(
  'oauth_applications',
  {
    id: primaryId(),
    name: text('name').notNull(),
    icon: text('icon'),
    metadata: text('metadata'),
    clientId: text('client_id').notNull(),
    /** Null for a public client (PKCE), which is what both of ours are. */
    clientSecret: text('client_secret'),
    /** Comma-separated, as Better Auth stores and splits it. */
    redirectUrls: text('redirect_urls').notNull(),
    type: text('type').notNull(),
    disabled: boolean('disabled').notNull().default(false),
    userId: idColumn('user_id').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('oauth_applications_client_id_key').on(t.clientId),
    index('oauth_applications_user_id_idx').on(t.userId),
  ],
)

/**
 * Issued access tokens and their refresh tokens.
 *
 * **`access_token` and `refresh_token` are stored as issued, not hashed**, and
 * that is Better Auth's design rather than ours: `/oauth2/userinfo` and the
 * `refresh_token` grant both look the row up by plain equality on these columns.
 * Hashing them would break the library's own endpoints. ADR-0043 D9 said the
 * token columns would store hashes; they cannot, and the correction is recorded
 * there. `sessions.token` has had the same property since M2, so this adds a
 * table to an existing class rather than opening a new one — and a unit test
 * pins it, so nobody reads the column and believes it is a digest.
 *
 * `client_id` has **no foreign key** to `oauth_applications`, deliberately.
 * Better Auth's declared schema puts one there, and with our clients living in
 * configuration rather than in that table, the constraint would reject every
 * token this system can issue.
 */
export const oauthAccessTokens = pgTable(
  'oauth_access_tokens',
  {
    id: primaryId(),
    accessToken: text('access_token').notNull(),
    refreshToken: text('refresh_token').notNull(),
    accessTokenExpiresAt: instant('access_token_expires_at').notNull(),
    refreshTokenExpiresAt: instant('refresh_token_expires_at').notNull(),
    clientId: text('client_id').notNull(),
    userId: idColumn('user_id').references(() => users.id),
    /** The granted scopes, space-delimited (RFC 6749). `readScopesFromGrant`
     * is the single reading of this string. */
    scopes: text('scopes').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('oauth_access_tokens_access_token_key').on(t.accessToken),
    uniqueIndex('oauth_access_tokens_refresh_token_key').on(t.refreshToken),
    index('oauth_access_tokens_user_id_idx').on(t.userId),
    index('oauth_access_tokens_client_id_idx').on(t.clientId),
  ],
)

/** A user's standing consent for a client and a scope set (authorization-code
 * flow). The device flow's approval is the consent and does not write here. */
export const oauthConsents = pgTable(
  'oauth_consents',
  {
    id: primaryId(),
    clientId: text('client_id').notNull(),
    userId: idColumn('user_id').references(() => users.id),
    scopes: text('scopes').notNull(),
    consentGiven: boolean('consent_given').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('oauth_consents_client_id_idx').on(t.clientId),
    index('oauth_consents_user_id_idx').on(t.userId),
  ],
)

/**
 * In-flight device authorizations (RFC 8628).
 *
 * `user_code` is unique. Better Auth generates it from an 8-character
 * ambiguity-free alphabet with no collision check, and looks a device up by it:
 * two live rows sharing a code would let one person approve another person's
 * device. A collision is astronomically unlikely and the constraint turns it
 * into a failed `POST /device/code` the CLI retries, which is the direction to
 * fail in.
 */
export const deviceCodes = pgTable(
  'device_codes',
  {
    id: primaryId(),
    deviceCode: text('device_code').notNull(),
    userCode: text('user_code').notNull(),
    /** Null until somebody approves it — the row exists before anyone owns it. */
    userId: idColumn('user_id').references(() => users.id),
    expiresAt: instant('expires_at').notNull(),
    status: text('status').notNull(),
    lastPolledAt: instant('last_polled_at'),
    /** Milliseconds, as Better Auth writes it. */
    pollingInterval: integer('polling_interval'),
    clientId: text('client_id'),
    /** The scopes the device asked for, space-delimited; shown on the approval
     * page, and the ceiling on the token the exchange mints. */
    scope: text('scope'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('device_codes_device_code_key').on(t.deviceCode),
    uniqueIndex('device_codes_user_code_key').on(t.userCode),
    index('device_codes_user_id_idx').on(t.userId),
    index('device_codes_expires_at_idx').on(t.expiresAt),
  ],
)
