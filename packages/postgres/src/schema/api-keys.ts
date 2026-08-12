import type { ApiKeyHolder } from '@openanalytics/domain'
import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { createdAt, idColumn, instant, primaryId } from './_shared.ts'
import { sites } from './sites.ts'
import { users } from './auth.ts'

/**
 * API keys (mirror of migration 0004, plus 0014's live-tracking-key index).
 *
 * `publicToken` holds the raw value only for the public `tracking_write` key;
 * the CHECK forbids it for the secret `private_read` key, so a private raw token
 * can never reach the database — the schema-level half of the redaction rule
 * whose behavioural test lives in the audit/keys sub-part.
 */

export type ApiKeyType = 'tracking_write' | 'private_read'

export const apiKeys = pgTable(
  'api_keys',
  {
    id: primaryId(),
    siteId: idColumn('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    type: text('type').$type<ApiKeyType>().notNull(),
    name: text('name'),
    keyPrefix: text('key_prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    publicToken: text('public_token'),
    scopes: text('scopes').array(),
    /**
     * Who holds the secret after it was shown once — the person who minted it,
     * or the machine they installed it into (migration 0044, ADR-0043 D8). It
     * decides whether the key survives its holder's departure from the site.
     */
    heldBy: text('held_by').$type<ApiKeyHolder>().notNull().default('user'),
    /** Stamped when a holder of this site-held key left; cleared only by
     * rotation, which is revoke-then-mint. Null is the ordinary state. */
    rotationRequiredAt: instant('rotation_required_at'),
    createdByUserId: idColumn('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    lastUsedAt: instant('last_used_at'),
    revokedAt: instant('revoked_at'),
    expiresAt: instant('expires_at'),
  },
  (t) => [
    uniqueIndex('api_keys_key_hash_key').on(t.keyHash),
    index('api_keys_site_type_idx').on(t.siteId, t.type),
    index('api_keys_active_idx')
      .on(t.siteId)
      .where(sql`revoked_at IS NULL`),
    index('api_keys_tracking_live_idx')
      .on(t.siteId)
      .where(sql`type = 'tracking_write' AND revoked_at IS NULL`),
    index('api_keys_rotation_required_idx')
      .on(t.siteId)
      .where(sql`rotation_required_at IS NOT NULL AND revoked_at IS NULL`),
    check(
      'api_keys_private_no_raw_check',
      sql`${t.type} = 'tracking_write' OR ${t.publicToken} IS NULL`,
    ),
    check('api_keys_held_by_check', sql`${t.heldBy} IN ('user', 'site')`),
  ],
)
