import { boolean, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { createdAt, idColumn, instant, primaryId, updatedAt } from './_shared.ts'

/**
 * Better Auth core tables (mirror of migration 0001).
 *
 * Property keys are Better Auth's camelCase model fields, so the drizzle adapter
 * maps model → schema without per-field overrides; column names are snake_case
 * to stay idiomatic in SQL (ADR-0006). The library owns writes to these tables;
 * the token and password columns hold what it stores, and their redaction in
 * logs is centralized in `@openanalytics/observability`, not here.
 */

export const users = pgTable(
  'users',
  {
    id: primaryId(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    /**
     * The user's home timezone, as an IANA identifier (ADR-0026, migration
     * 0023). Nullable, and NULL means "never chosen" — not UTC. It is declared
     * to Better Auth as a `user.additionalFields` entry, which is what puts it
     * on the session response the frontend already reads; the property name and
     * the column name match, so the adapter needs no field override.
     */
    timezone: text('timezone'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_key').on(t.email)],
)

export const sessions = pgTable(
  'sessions',
  {
    id: primaryId(),
    userId: idColumn('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('sessions_token_key').on(t.token),
    index('sessions_user_id_idx').on(t.userId),
  ],
)

export const accounts = pgTable(
  'accounts',
  {
    id: primaryId(),
    userId: idColumn('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: instant('access_token_expires_at'),
    refreshTokenExpiresAt: instant('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('accounts_provider_account_key').on(t.providerId, t.accountId),
    index('accounts_user_id_idx').on(t.userId),
  ],
)

export const verifications = pgTable(
  'verifications',
  {
    id: primaryId(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('verifications_identifier_idx').on(t.identifier)],
)
