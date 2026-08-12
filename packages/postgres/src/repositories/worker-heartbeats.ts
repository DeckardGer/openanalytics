import { eq } from 'drizzle-orm'
import type { Database } from '../client.ts'
import { workerHeartbeats } from '../schema/worker-heartbeats.ts'

/**
 * The pipeline liveness heartbeat (migration 0022; ADR-0025).
 *
 * Two operations, and no more: the worker writes its tick, the read API reads
 * the newest one. Nothing here is on a correctness path — a heartbeat that fails
 * to write must not stop ingest, and one that fails to read must not fail a
 * customer's analytics query. Both callers treat it as advisory, which is what
 * lets this be a single unconditional upsert with no lease, no version and no
 * conflict to resolve.
 */

/** The pipeline whose liveness the read API interprets. One name, two callers. */
export const INGEST_PIPELINE_ID = 'ingest'

export interface WorkerHeartbeat {
  /** The instance that wrote the row last. A diagnostic, never a key. */
  readonly consumer: string
  /** The tick instant, on the worker's clock. */
  readonly lastTickAt: Date
  /** Oldest unprocessed queue message at that tick; 0 when the queue was empty. */
  readonly queueOldestAgeMs: number
}

export interface UpsertWorkerHeartbeatInput {
  /** The pipeline name, e.g. `ingest` — see `INGEST_PIPELINE_ID`. */
  readonly id: string
  readonly consumer: string
  readonly lastTickAt: Date
  readonly queueOldestAgeMs: number
}

/**
 * Record a tick, creating the pipeline's row on the first one.
 *
 * Last writer wins, deliberately: several workers share one pipeline row, and
 * the freshest tick among them is precisely the answer the reader wants. There
 * is no ordering guard, because a heartbeat that briefly moves backwards (two
 * instances whose clocks disagree by milliseconds) is indistinguishable from a
 * healthy pipeline at the ten-minute scale the reader compares against.
 */
export async function upsertWorkerHeartbeat(
  db: Database,
  input: UpsertWorkerHeartbeatInput,
): Promise<void> {
  await db
    .insert(workerHeartbeats)
    .values({
      id: input.id,
      consumer: input.consumer,
      lastTickAt: input.lastTickAt,
      queueOldestAgeMs: input.queueOldestAgeMs,
      // The tick instant, not `now()`: the row describes when the worker was
      // alive, and both columns should agree about which moment that was.
      updatedAt: input.lastTickAt,
    })
    .onConflictDoUpdate({
      target: workerHeartbeats.id,
      set: {
        consumer: input.consumer,
        lastTickAt: input.lastTickAt,
        queueOldestAgeMs: input.queueOldestAgeMs,
        updatedAt: input.lastTickAt,
      },
    })
}

/** Read a pipeline's latest tick, or null when it has never written one. */
export async function getWorkerHeartbeat(
  db: Database,
  id: string,
): Promise<WorkerHeartbeat | null> {
  const [row] = await db.select().from(workerHeartbeats).where(eq(workerHeartbeats.id, id))
  if (!row) return null
  return {
    consumer: row.consumer,
    lastTickAt: row.lastTickAt,
    queueOldestAgeMs: row.queueOldestAgeMs,
  }
}
