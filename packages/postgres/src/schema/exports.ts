import { sql } from 'drizzle-orm'
import { check, index, jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import type { ExportManifest, ExportProgress, ExportRunState } from '@openanalytics/domain'
import { createdAt, idColumn, instant, primaryId } from './_shared.ts'
import { importRuns } from './imports.ts'
import { sites } from './sites.ts'
import { users } from './auth.ts'

/**
 * Export runs (mirror of migration 0032; ADR-0032 D8).
 *
 * The row is the export's durable state and it outlives the bytes: the objects
 * expire after seven days through the bucket's own lifecycle rule, and "this
 * customer exported their data" stays an auditable fact afterwards.
 *
 * `cutoff` has **no default here on purpose**. The migration does not give it
 * one either — it is written by `createExportRun` as a database-clock `now()`
 * inside the same snapshot that reads the import pointer, and a column default
 * would let a caller that forgot it still succeed with a value taken at a
 * different instant from the pointer it is supposed to agree with.
 */
export const exportRuns = pgTable(
  'export_runs',
  {
    id: primaryId(),
    siteId: idColumn('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** Nullable and `SET NULL`: account deletion scrubs the users row rather
     * than deleting it, so this normally survives as the tombstoned id. */
    requestedBy: idColumn('requested_by').references(() => users.id, { onDelete: 'set null' }),
    state: text('state').$type<ExportRunState>().notNull().default('queued'),
    /** Half one of the D8 consistency pin: every events query binds
     * `accepted_at <= cutoff`. */
    cutoff: instant('cutoff').notNull(),
    /** Half two: the site's published import pointer as it stood in the same
     * snapshot the cutoff was taken in. */
    pinnedImportRunId: idColumn('pinned_import_run_id').references(() => importRuns.id, {
      onDelete: 'set null',
    }),
    /** The chunk list, written once at success. Its presence means complete. */
    manifest: jsonb('manifest').$type<ExportManifest>(),
    /** The same records, appended as each object lands — what makes an
     * unfinished export's bytes addressable by a deletion (D9). */
    progress: jsonb('progress').$type<ExportProgress>(),
    /** `exports/{site_id}/{export_id}/`, recorded rather than recomputed. */
    objectPrefix: text('object_prefix').notNull(),
    /** A safe category. It is rendered to the customer, so never a raw error. */
    errorCode: text('error_code'),
    createdAt: createdAt(),
    startedAt: instant('started_at'),
    finishedAt: instant('finished_at'),
    /** Reserved for the lifecycle backstop, in `import_runs.swept_at`'s shape. */
    sweptAt: instant('swept_at'),
  },
  (t) => [
    index('export_runs_site_idx').on(t.siteId, t.createdAt.desc()),
    // Not unique: the jobs table's `(type, subject_id)` liveness index is the
    // serializer (D8), and this is only how the api names the run in the way.
    index('export_runs_live_idx')
      .on(t.siteId)
      .where(sql`state IN ('queued', 'running')`),
    index('export_runs_expiry_idx')
      .on(t.finishedAt)
      .where(sql`state = 'succeeded'`),
    check(
      'export_runs_state_check',
      sql`${t.state} IN ('queued', 'running', 'succeeded', 'failed', 'expired')`,
    ),
  ],
)
