import { sql } from 'drizzle-orm'
import { boolean, check, integer, pgTable, real, text } from 'drizzle-orm/pg-core'
import { createdAt, idColumn, updatedAt } from './_shared.ts'
import { sites } from './sites.ts'

/**
 * Per-site tracker/ingest settings (mirror of migration 0014).
 *
 * The storage behind `GET /v1/tracker/config`. The row is optional: a site
 * without one is served the defaults from `@openanalytics/domain`, so the table
 * needed no backfill and a site only acquires a row when a dashboard change
 * writes one.
 *
 * Cache invalidation lives on `sites.config_version`, not here — the ETag and
 * the collector's short-TTL ingest-config cache are keyed by it, and it has to
 * move when any part of a site's configuration does.
 */

export const siteIngestSettings = pgTable(
  'site_ingest_settings',
  {
    siteId: idColumn('site_id')
      .primaryKey()
      .references(() => sites.id, { onDelete: 'cascade' }),
    timezone: text('timezone').notNull().default('UTC'),
    redactQueryKeys: text('redact_query_keys')
      .array()
      .notNull()
      .default(sql`'{}'`),
    interactionSampling: real('interaction_sampling').notNull().default(1),
    heartbeatIntervalSeconds: integer('heartbeat_interval_seconds').notNull().default(15),
    featureWebVitals: boolean('feature_web_vitals').notNull().default(true),
    featureEngagement: boolean('feature_engagement').notNull().default(true),
    featureInteractions: boolean('feature_interactions').notNull().default(true),
    featureHeartbeat: boolean('feature_heartbeat').notNull().default(true),
    // ADR-0064 D4a (migration 0043). Not a feature flag despite the company it
    // keeps: it decides whether the browser sends the `order_id` linking hint,
    // which is why it is the one column here that defaults `false`.
    attributedRevenue: boolean('attributed_revenue').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'site_ingest_settings_interaction_sampling_check',
      sql`${t.interactionSampling} >= 0 AND ${t.interactionSampling} <= 1`,
    ),
    check(
      'site_ingest_settings_heartbeat_interval_seconds_check',
      sql`${t.heartbeatIntervalSeconds} BETWEEN 5 AND 300`,
    ),
  ],
)
