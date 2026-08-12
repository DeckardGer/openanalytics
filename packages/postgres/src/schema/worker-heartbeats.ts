import { sql } from 'drizzle-orm'
import { bigint, check, pgTable, text } from 'drizzle-orm/pg-core'
import { instant, updatedAt } from './_shared.ts'

/**
 * The ingest pipeline's liveness heartbeat (mirror of migration 0022; ADR-0025).
 *
 * One row per *pipeline*, not per worker instance: the reader's question is "is
 * ingest running at all", which the most recent tick across the fleet answers,
 * and a row per instance would instead answer "is instance-7 running" — which a
 * rescheduled container answers wrong forever after.
 *
 * It exists because the read API's freshness state used to be the age of a
 * site's newest rollup bucket, which is the age of that site's last visitor
 * rather than the age of the pipeline. The ingest loop ticks every ~1.5 seconds
 * whether or not anyone visits, so its tick — with the queue age it already
 * measures — is the signal that tells "nobody came" apart from "we are behind".
 */

export const workerHeartbeats = pgTable(
  'worker_heartbeats',
  {
    /** The pipeline name, e.g. `ingest`. Deliberately not an instance id. */
    id: text('id').primaryKey(),
    /** The instance that wrote this row last. A diagnostic, never a key. */
    consumer: text('consumer').notNull(),
    /** The tick instant, from the worker's own clock: its liveness is what is claimed. */
    lastTickAt: instant('last_tick_at').notNull(),
    /** Oldest unprocessed queue message at that tick; 0 when the queue was empty. */
    queueOldestAgeMs: bigint('queue_oldest_age_ms', { mode: 'number' }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    // An age is a duration; a negative one (clock skew) would read back as "the
    // queue is ahead of now" and pass the freshness comparison as healthy.
    check('worker_heartbeats_queue_age_check', sql`${t.queueOldestAgeMs} >= 0`),
  ],
)
