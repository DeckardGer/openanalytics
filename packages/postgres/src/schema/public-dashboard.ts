import { sql } from 'drizzle-orm'
import { boolean, check, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { createdAt, idColumn, updatedAt } from './_shared.ts'
import { sites } from './sites.ts'

/**
 * Per-site public-dashboard sharing settings (mirror of migrations 0016, 0018,
 * 0040 and 0047; docs snapshot 02 §20).
 *
 * Public sharing is off by default — a site with no row is private-only. The
 * `share_slug` is the opaque, rotatable public address of a shared dashboard and
 * is never the internal `site_id`; it is unique across sites, enforced by a
 * partial unique index over the rows that carry one. **Every surface opts in
 * independently** — one column each, so an opt-in granted today cannot be
 * widened by a surface added tomorrow (ADR-0039 D2). The `suspended` gate
 * is re-checked at read time against `sites.status`, not stored here.
 */

export const sitePublicDashboardSettings = pgTable(
  'site_public_dashboard_settings',
  {
    siteId: idColumn('site_id')
      .primaryKey()
      .references(() => sites.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(false),
    shareSlug: text('share_slug'),
    shareOverview: boolean('share_overview').notNull().default(false),
    shareGeography: boolean('share_geography').notNull().default(false),
    shareRealtime: boolean('share_realtime').notNull().default(false),
    // Migration 0040 (ADR-0039): the five reads that complete the shared board.
    shareTimeseries: boolean('share_timeseries').notNull().default(false),
    shareSessions: boolean('share_sessions').notNull().default(false),
    sharePages: boolean('share_pages').notNull().default(false),
    shareSources: boolean('share_sources').notNull().default(false),
    shareDevices: boolean('share_devices').notNull().default(false),
    // Migration 0047 (ADR-0044): the ninth surface, and the only one that is not
    // a board card. It publishes the site's name and favicon domain on the share
    // page; the timezone and first-event instant beside them are rendering facts
    // and are served whatever this says.
    shareIdentity: boolean('share_identity').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'site_public_dashboard_slug_format',
      sql`${t.shareSlug} IS NULL OR ${t.shareSlug} ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'`,
    ),
    uniqueIndex('site_public_dashboard_slug_key')
      .on(t.shareSlug)
      .where(sql`${t.shareSlug} IS NOT NULL`),
  ],
)
