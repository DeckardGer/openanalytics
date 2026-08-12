import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { primaryId } from './_shared.ts'

/**
 * Where a credential has been used from (mirror of migration 0050).
 *
 * ADR-0051 D5. State, not a journal — the journal is `audit_logs`. Its whole job
 * is to make "has this credential been seen from this source before?" a point
 * lookup on the read path, which is the one thing the ledger cannot be.
 *
 * `sourceHash` is an HMAC of the client address under `CREDENTIAL_SOURCE_SECRET`
 * (D4); the address itself is never stored. `credentialRef` is the api key's
 * uuid, or `<user_id>:<client_id>` for an OAuth grant — never the access-token
 * row id, which Better Auth replaces on every refresh (D6).
 *
 * `siteId` and `userId` exist only so the two deletion vocabularies can find
 * these rows; exactly one is set per row.
 */

export type CredentialKind = 'api_key' | 'oauth_grant'

export const credentialSources = pgTable(
  'credential_sources',
  {
    id: primaryId(),
    credentialKind: text('credential_kind').$type<CredentialKind>().notNull(),
    credentialRef: text('credential_ref').notNull(),
    keyVersion: integer('key_version').notNull(),
    sourceHash: text('source_hash').notNull(),
    siteId: uuid('site_id'),
    userId: uuid('user_id'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('credential_sources_identity_idx').on(
      t.credentialKind,
      t.credentialRef,
      t.keyVersion,
      t.sourceHash,
    ),
    index('credential_sources_site_idx').on(t.siteId),
    index('credential_sources_user_idx').on(t.userId),
  ],
)
