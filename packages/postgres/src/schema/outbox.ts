import { index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { createdAt, instant, primaryId } from './_shared.ts'

/**
 * Transactional outbox (mirror of migration 0005).
 *
 * A row is written in the same transaction as the state change that causes it,
 * and a worker delivers it idempotently keyed on `idempotencyKey`. Milestone 2
 * uses it for verification/invite email through the Resend adapter.
 */

export type OutboxStatus = 'pending' | 'processing' | 'delivered' | 'failed' | 'dead'

export const outbox = pgTable(
  'outbox',
  {
    id: primaryId(),
    topic: text('topic').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').$type<OutboxStatus>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    availableAt: instant('available_at').notNull().defaultNow(),
    lastError: text('last_error'),
    createdAt: createdAt(),
    deliveredAt: instant('delivered_at'),
  },
  (t) => [
    uniqueIndex('outbox_idempotency_key').on(t.idempotencyKey),
    index('outbox_due_idx').on(t.status, t.availableAt),
  ],
)
