import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, pgTable, text } from 'drizzle-orm/pg-core'
import { createdAt, idColumn, updatedAt } from './_shared.ts'
import { sites } from './sites.ts'
import { users } from './auth.ts'

/**
 * Embeddable widget configuration (mirror of migration 0048; ADR-0045).
 *
 * Configuration only: a row here is `(surface, range, limit, title)` plus an
 * origin allowlist and a reversible on/off, and it never carries a number. What
 * a widget publishes is computed on every anonymous read through the existing
 * public read pipeline.
 *
 * **The primary key is the opaque widget id itself**, not a surrogate. ADR-0045
 * D1 makes the public address and the management handle the same string, so the
 * id in the dashboard's list is the id in the embed snippet; a `uuid` beside it
 * would be the translation that decision refuses.
 *
 * The CHECKs mirror the bounds in `packages/domain/src/widget.ts`, the module
 * the API validates against, so a configuration that could not be served cannot
 * be stored. The per-site cap of fifty is deliberately *not* here: a CHECK
 * cannot count sibling rows, and ADR-0045 D9 keeps the cap in application code
 * so raising it is not a migration.
 */

/** Which public read a widget publishes; mirrors `WIDGET_SURFACES`. */
export type WidgetSurfaceColumn =
  | 'overview'
  | 'timeseries'
  | 'sessions'
  | 'pages'
  | 'sources'
  | 'devices'
  | 'geography'
  | 'realtime'

/** The relative window key; mirrors `WIDGET_RANGES`. */
export type WidgetRangeColumn =
  'today' | 'yesterday' | '24h' | '7d' | '30d' | '90d' | '6mo' | '12mo' | 'all'

export const widgets = pgTable(
  'widgets',
  {
    /** 96 random bits in base36 behind a `w` — opaque by design, and never an
     * encoding of the site id (the property `generateShareSlug` states). */
    id: text('id').primaryKey(),
    siteId: idColumn('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    surface: text('surface').$type<WidgetSurfaceColumn>().notNull(),
    /** NULL exactly when `surface = 'realtime'`. `range` is a non-reserved
     * keyword in PostgreSQL, so the column keeps the wire's name. */
    range: text('range').$type<WidgetRangeColumn>(),
    /** `row_limit`, because `limit` is a reserved word and a quoted-identifier
     * column would need quoting in every hand-written query forever. */
    rowLimit: integer('row_limit'),
    title: text('title'),
    /** Empty means nowhere (ADR-0045, D4), which is why the default is `{}`. */
    allowedOrigins: text('allowed_origins').array().notNull().default([]),
    enabled: boolean('enabled').notNull().default(true),
    /** `set null`, exactly as `funnels` does it: an embed on a customer's page
     * must not blank because the colleague who created it closed their account. */
    createdByUserId: idColumn('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('widgets_site_idx').on(t.siteId),
    check('widgets_id_format', sql`${t.id} ~ '^w[a-z0-9]{10,31}$'`),
    check(
      'widgets_surface_check',
      sql`${t.surface} IN ('overview', 'timeseries', 'sessions', 'pages', 'sources', 'devices', 'geography', 'realtime')`,
    ),
    check(
      'widgets_range_check',
      // The `IS NOT NULL` conjunct is load-bearing: a CHECK passes on NULL and
      // `NULL IN (...)` is NULL, so without it a range-less `overview` widget
      // would be storable through a constraint that names the rule.
      sql`CASE WHEN ${t.surface} = 'realtime' THEN ${t.range} IS NULL ELSE ${t.range} IS NOT NULL AND ${t.range} IN ('today', 'yesterday', '24h', '7d', '30d', '90d', '6mo', '12mo', 'all') END`,
    ),
    check(
      'widgets_row_limit_check',
      sql`${t.rowLimit} IS NULL OR (${t.surface} IN ('pages', 'sources', 'devices', 'geography') AND ${t.rowLimit} BETWEEN 1 AND 50)`,
    ),
    check(
      'widgets_title_length_check',
      // No lower bound on purpose: the contract's `title` has a `maxLength` and
      // no `minLength`, so `""` is a legal wire value and a database that
      // refused it would be stricter than the validator.
      sql`${t.title} IS NULL OR char_length(${t.title}) <= 80`,
    ),
    check('widgets_allowed_origins_check', sql`cardinality(${t.allowedOrigins}) <= 20`),
  ],
)
