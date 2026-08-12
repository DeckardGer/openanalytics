import { sql } from 'drizzle-orm'
import { bigint, check, index, jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import { createdAt, idColumn, instant, primaryId, updatedAt } from './_shared.ts'
import { sites } from './sites.ts'
import { users } from './auth.ts'

/**
 * Stored funnel definitions (mirror of migration 0024).
 *
 * The row is a saved *question*, not an answer: nothing here caches a funnel
 * result. Computing one is still `GET /v1/sites/{site_id}/analytics/funnel` with
 * these steps, which is unchanged by this table (ADR-0012).
 *
 * `steps` is the compute endpoint's payload verbatim — an ordered array of step
 * keys, each a page path or a custom event name — so the stored shape and the
 * request shape cannot drift apart. The CHECKs mirror the bounds in
 * `packages/domain/src/funnel.ts`, the module the compute endpoint validates
 * against, so a definition that could not be computed cannot be stored.
 */

/** How a stored funnel groups events into units; mirrors `FUNNEL_SCOPES`. */
export type FunnelScope = 'visitor' | 'session'

export const funnels = pgTable(
  'funnels',
  {
    id: primaryId(),
    siteId: idColumn('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    steps: jsonb('steps').$type<string[]>().notNull(),
    scope: text('scope').$type<FunnelScope>().notNull().default('visitor'),
    /** `bigint` in `number` mode: the 30-day ceiling overflows int4, and
     * 2_592_000_000 is comfortably inside `Number.MAX_SAFE_INTEGER`. */
    windowMs: bigint('window_ms', { mode: 'number' }).notNull(),
    createdByUserId: idColumn('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: instant('archived_at'),
  },
  (t) => [
    index('funnels_site_idx').on(t.siteId),
    index('funnels_site_active_idx')
      .on(t.siteId)
      .where(sql`archived_at IS NULL`),
    check('funnels_name_length_check', sql`char_length(${t.name}) BETWEEN 1 AND 200`),
    check(
      'funnels_steps_check',
      sql`jsonb_typeof(${t.steps}) = 'array' AND jsonb_array_length(${t.steps}) BETWEEN 2 AND 8`,
    ),
    check('funnels_window_ms_check', sql`${t.windowMs} BETWEEN 1 AND 2592000000`),
  ],
)
