import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core'
import { createdAt, idColumn, instant, primaryId } from './_shared.ts'
import { users } from './auth.ts'

/**
 * The inbound request idempotency ledger (mirror of migration 0019).
 *
 * A durable record of "this caller already asked me this exact question, and
 * here is the answer I gave" (docs snapshot 02 §18). The grain is
 * (userId, scope, key): the key is client-generated, so it is scoped to the
 * caller — two customers may pick the same string, and neither may read or block
 * the other's — and to the operation, so one key generator reused across
 * endpoints does not turn a fresh request into a conflict.
 *
 * `requestHash` is what separates a genuine retry from a key reused with a
 * different payload. Only the hash is stored, never the request, so no customer
 * request body is retained here.
 *
 * A claim is written BEFORE the handler runs, which is why `responseStatus` and
 * `completedAt` are nullable: they are null exactly while the request is in
 * flight, and the CHECK keeps them from ever disagreeing.
 */

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: primaryId(),
    userId: idColumn('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The operation the key was presented to, e.g. `sites.create`. */
    scope: text('scope').notNull(),
    /** The client-generated key, verbatim. */
    key: text('key').notNull(),
    /** SHA-256 over the canonical request; never the request itself. */
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    completedAt: instant('completed_at'),
  },
  (t) => [
    unique('idempotency_keys_user_scope_key').on(t.userId, t.scope, t.key),
    check(
      'idempotency_keys_completion_check',
      sql`(${t.responseStatus} IS NULL) = (${t.completedAt} IS NULL)`,
    ),
    index('idempotency_keys_created_idx').on(t.createdAt),
  ],
)
