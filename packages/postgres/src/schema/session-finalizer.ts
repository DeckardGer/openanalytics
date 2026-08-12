import { sql } from 'drizzle-orm'
import { bigint, check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { createdAt, instant, updatedAt } from './_shared.ts'
import { sites } from './sites.ts'

/**
 * The session finalizer's per-site control state (mirror of migration 0017).
 *
 * The versioned session facts and rollups live in ClickHouse (migrations 0013,
 * 0014); this is the small, mutating, leased control row that says how far each
 * site has been finalized (docs snapshot 02 §10, §15; 05 D-211). Its
 * `finalized_through` watermark is both the lower bound of the next recompute
 * window and the API's finalized_through metadata — every session with
 * session_start before it is final and never recomputed again.
 *
 * The lease is the batch-manifest idiom (`ingest_batches`): a run claims a site
 * with a conditional update and releases on completion; a crashed run's lease
 * expires and the next run reclaims, which is safe because the whole recompute
 * is a pure function of the events.
 */

export const sessionFinalizerState = pgTable(
  'session_finalizer_state',
  {
    // The site's own id is the primary key: exactly one control row per site.
    // The reference is migration 0028's (ADR-0030, decision 3): integrity only,
    // no cascade — the sites row is never hard-deleted (it becomes a tombstone),
    // and the deletion job's `postgres_purge` removes this row explicitly.
    siteId: uuid('site_id')
      .primaryKey()
      .references(() => sites.id),
    /** Watermark: sessions with session_start < this are finalized. Epoch default. */
    finalizedThrough: timestamp('finalized_through', { withTimezone: true })
      .notNull()
      .default(sql`'epoch'`),
    /** Monotonic run counter; a durable, race-free advance proof, never the version source. */
    runSeq: bigint('run_seq', { mode: 'number' }).notNull().default(0),
    claimedBy: text('claimed_by'),
    leaseExpiresAt: instant('lease_expires_at'),
    lastRunAt: instant('last_run_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'session_finalizer_state_lease_check',
      sql`(${t.claimedBy} IS NULL) = (${t.leaseExpiresAt} IS NULL)`,
    ),
    index('session_finalizer_state_lease_idx').on(t.leaseExpiresAt),
  ],
)
