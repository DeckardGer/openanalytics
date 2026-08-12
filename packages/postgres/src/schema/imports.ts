import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  date,
  index,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import type { ImportRunState } from '@openanalytics/domain'
import { createdAt, idColumn, instant, primaryId, updatedAt } from './_shared.ts'
import { sites } from './sites.ts'

/**
 * Import runs and their staged uploads (mirror of migration 0030; ADR-0032 D3).
 *
 * The run is the *generation* imported rows are keyed by. Nothing here stores
 * analytics data — the staged aggregates live in their own ClickHouse family,
 * and this table is what decides whether any of them is visible.
 *
 * `sites.published_import_run_id` is deliberately not declared on this side of
 * the relationship: it lives on `sites` (see `schema/sites.ts`), which is where
 * the pointer belongs, and the two FKs form the cycle ADR-0032 D9 records.
 */

export const importRuns = pgTable(
  'import_runs',
  {
    id: primaryId(),
    siteId: idColumn('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    state: text('state').$type<ImportRunState>().notNull().default('uploading'),
    /** Per-report row counts, the imported date range and the staging warnings
     * the reviewer sees before publishing. Null until validation has run. */
    summary: jsonb('summary').$type<Record<string, unknown>>(),
    /** The D4 partition boundary, chosen at review time. `date` mode keeps it a
     * calendar date rather than an instant — it is compared against imported
     * day keys, not against a clock. */
    cutoverDate: date('cutover_date'),
    /** The chunk size staging started with; every retry reuses it so the insert
     * dedup token keeps naming the same rows (D7). */
    stagingChunkBytes: bigint('staging_chunk_bytes', { mode: 'number' }),
    /** Per-report next chunk number (migration 0031). Written after each durable
     * insert, so a reclaimed lease resumes after the last committed chunk. */
    stagingProgress: jsonb('staging_progress').$type<Record<string, number>>(),
    /**
     * The run this one superseded when it was published (migration 0031) — the
     * single rollback generation D3 keeps.
     *
     * Self-referential and deliberately not declared with a `references()`
     * callback on the column: drizzle cannot express a self-FK inline without a
     * circular initializer, so the constraint lives in the migration and this
     * mirror carries the column and the comment. The FK is
     * `ON DELETE SET NULL` — a purged predecessor must not take its successor,
     * which is the site's *published* run, with it.
     */
    supersededRunId: idColumn('superseded_run_id'),
    /** When the sweeper's backstop last cleaned this run (migration 0031). Its
     * only job is to make that scan terminate; it is not a state. */
    sweptAt: instant('swept_at'),
    /** A safe category. It is rendered to the customer, so never a raw error. */
    errorCode: text('error_code'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: instant('finished_at'),
  },
  (t) => [
    // One non-terminal run per site (D3). The predicate is the source of the
    // repository's `IMPORT_RUN_LIVE_STATES`, not a copy of it.
    uniqueIndex('import_runs_live_site_key')
      .on(t.siteId)
      .where(
        sql`state IN ('uploading', 'uploaded', 'validating', 'processing', 'ready_for_review', 'publishing')`,
      ),
    index('import_runs_site_idx').on(t.siteId, t.createdAt.desc()),
    // The abandoned-upload sweep's own index; the predicate is the sweep's.
    index('import_runs_expiry_idx')
      .on(t.createdAt)
      .where(sql`state IN ('uploading', 'uploaded')`),
    // The terminal-run cleanup backstop's index (migration 0031); the predicate
    // is that sweep's, so the scan is bounded by what still needs cleaning.
    index('import_runs_sweep_idx')
      .on(t.updatedAt)
      .where(
        sql`swept_at IS NULL AND state IN ('failed', 'discarded', 'rolled_back', 'superseded')`,
      ),
    index('import_runs_superseded_idx')
      .on(t.supersededRunId)
      .where(sql`superseded_run_id IS NOT NULL`),
    // The publish-time cleanup scan: site first, then state, over unclaimed rows.
    index('import_runs_site_sweep_idx')
      .on(t.siteId, t.state)
      .where(sql`swept_at IS NULL`),
    check(
      'import_runs_state_check',
      sql`${t.state} IN ('uploading', 'uploaded', 'validating', 'processing', 'ready_for_review', 'publishing', 'published', 'failed', 'discarded', 'superseded', 'rolled_back')`,
    ),
  ],
)

export const importUploads = pgTable(
  'import_uploads',
  {
    id: primaryId(),
    importRunId: idColumn('import_run_id')
      .notNull()
      .references(() => importRuns.id, { onDelete: 'cascade' }),
    /** Id-addressed key; the deletion snapshot enumerates these (D9). */
    objectKey: text('object_key').notNull(),
    declaredBytes: bigint('declared_bytes', { mode: 'number' }).notNull(),
    contentType: text('content_type').notNull(),
    /** Observed at `complete` time and verified by the worker before parsing;
     * null until the upload is confirmed. */
    etag: text('etag'),
    createdAt: createdAt(),
    completedAt: instant('completed_at'),
  },
  // One upload row per run: `pinUploadEtag` writes *the* row of a run and
  // `readImportUpload` reads *the* row of a run, so a second row would make one
  // of them miss what the other wrote. It also serves as the run lookup index.
  (t) => [unique('import_uploads_run_key').on(t.importRunId)],
)
