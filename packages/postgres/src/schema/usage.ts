import { index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core'
import { createdAt, idColumn, primaryId } from './_shared.ts'
import { users } from './auth.ts'
import { sites } from './sites.ts'

/**
 * The usage batch idempotency ledger (mirror of migrations 0007 and 0022).
 *
 * Usage is a plain traffic counter. usageBatchDeltas' (batchId, billingUserId,
 * usageWindowId, siteId) unique is the exactly-once usage guard for
 * at-least-once delivery (D-209 step 5). NULLS NOT DISTINCT because rows may
 * carry a NULL siteId (written before the site dimension existed) or a NULL
 * usageWindowId (an installation that does not partition usage into windows),
 * and the guard must hold for them too.
 *
 * `usage_window_id` is a plain grouping column here — windows are a cloud
 * concept (`packages/postgres/src/cloud/schema/usage.ts`), and the FK on this
 * column is added by the cloud migration stream, from the stream that owns the
 * referent.
 */

export const usageBatches = pgTable(
  'usage_batches',
  {
    id: primaryId(),
    batchId: text('batch_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique('usage_batches_batch_id_key').on(t.batchId)],
)

export const usageBatchDeltas = pgTable(
  'usage_batch_deltas',
  {
    id: primaryId(),
    batchId: text('batch_id')
      .notNull()
      .references(() => usageBatches.batchId, { onDelete: 'cascade' }),
    billingUserId: idColumn('billing_user_id')
      .notNull()
      .references(() => users.id),
    usageWindowId: idColumn('usage_window_id'),
    // NULL only on rows from before the site dimension existed; their share of
    // a window is reported as "unattributed". The FK survives site deletion
    // because a deleted site is a tombstone (ADR-0030), never a removed row.
    siteId: idColumn('site_id').references(() => sites.id),
    delta: integer('delta').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('usage_batch_deltas_batch_user_window_site_key')
      .on(t.batchId, t.billingUserId, t.usageWindowId, t.siteId)
      .nullsNotDistinct(),
    index('usage_batch_deltas_window_idx').on(t.usageWindowId),
  ],
)
