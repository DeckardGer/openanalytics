import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { primaryId } from './_shared.ts'

/**
 * Append-only audit ledger (mirror of migration 0005).
 *
 * actor and site are bare `uuid` columns with no foreign keys: an audit record
 * must survive the deletion of the row it describes. `metadata` carries safe,
 * categorized detail only — no token, raw email or credential.
 */

export type AuditActorType = 'user' | 'system' | 'service'

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: primaryId(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    actorUserId: uuid('actor_user_id'),
    actorType: text('actor_type').$type<AuditActorType>().notNull().default('user'),
    siteId: uuid('site_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    requestId: text('request_id'),
  },
  (t) => [
    index('audit_logs_site_time_idx').on(t.siteId, t.occurredAt),
    index('audit_logs_actor_time_idx').on(t.actorUserId, t.occurredAt),
    index('audit_logs_action_idx').on(t.action),
  ],
)
