import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'
import type { Database } from '../client.ts'
import { sessionFinalizerState } from '../schema/session-finalizer.ts'

/**
 * The session finalizer's control-state repository (migration 0017; docs
 * snapshot 02 §10, §15, 05 D-211). Milestone 8 Checkpoint B.
 *
 * Three operations, and no more: claim a site, read its watermark, advance it.
 * The finalizer never re-implements session logic and it never derives a version
 * from anything here — this table records only how far a site has been finalized
 * and who is working it, so the worst a stale read can do is redo idempotent
 * work, never mint a duplicate.
 */

export interface FinalizerClaim {
  /** Watermark: sessions with session_start before this are final. Epoch on a fresh site. */
  readonly finalizedThrough: Date
  readonly runSeq: number
}

/**
 * Claim a site for finalization, taking or creating its control row.
 *
 * The claim is a single conditional upsert, the batch-manifest idiom: the row is
 * inserted if absent, and updated only when it is unclaimed or its lease has
 * expired. Two workers racing on one site cannot both come out holding it — the
 * loser's `ON CONFLICT` predicate matches nothing and it gets no row back. That
 * is the whole mutual-exclusion mechanism; the recompute's purity is the second
 * line of defence, not the only one.
 *
 * Returns the site's current watermark and run counter when claimed, or null
 * when another worker holds a live lease.
 */
export async function claimFinalizerSite(
  db: Database,
  input: { siteId: string; claimedBy: string; leaseTtlMs: number; now?: Date },
): Promise<FinalizerClaim | null> {
  const now = input.now ?? new Date()
  const leaseExpiresAt = new Date(now.getTime() + input.leaseTtlMs)

  // Only a free or an expired lease may be taken. Non-null because the operands
  // are concrete conditions, so `or` always yields a clause.
  const takeableLease = or(
    isNull(sessionFinalizerState.claimedBy),
    eq(sessionFinalizerState.claimedBy, input.claimedBy),
    lt(sessionFinalizerState.leaseExpiresAt, now),
  )!

  const rows = await db
    .insert(sessionFinalizerState)
    .values({
      siteId: input.siteId,
      claimedBy: input.claimedBy,
      leaseExpiresAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: sessionFinalizerState.siteId,
      set: { claimedBy: input.claimedBy, leaseExpiresAt, updatedAt: now },
      // A live lease held by another worker leaves the predicate unsatisfied and
      // the update affects no row, which is how the losing racer learns it lost.
      setWhere: takeableLease,
    })
    .returning({
      finalizedThrough: sessionFinalizerState.finalizedThrough,
      runSeq: sessionFinalizerState.runSeq,
    })

  const row = rows[0]
  if (!row) return null
  return { finalizedThrough: row.finalizedThrough, runSeq: Number(row.runSeq) }
}

/**
 * Advance the watermark and release the lease at the end of a run.
 *
 * `finalized_through` moves forward only — the caller passes a value it has
 * already clamped to be monotonic, and the guard here (`GREATEST`) is a
 * belt-and-braces refusal to ever move it backwards even if a caller regressed.
 * `run_seq` increments so the advance is durably counted, and the lease is
 * cleared so the site is immediately available to the next scheduled run.
 */
export async function advanceFinalizerWatermark(
  db: Database,
  input: {
    siteId: string
    claimedBy: string
    finalizedThrough: Date
    now?: Date
  },
): Promise<void> {
  const now = input.now ?? new Date()
  await db
    .update(sessionFinalizerState)
    .set({
      finalizedThrough: sql`GREATEST(${sessionFinalizerState.finalizedThrough}, ${input.finalizedThrough})`,
      runSeq: sql`${sessionFinalizerState.runSeq} + 1`,
      claimedBy: null,
      leaseExpiresAt: null,
      lastRunAt: now,
      updatedAt: now,
    })
    // Only the lease holder may advance and release. A run whose lease was
    // stolen after it started (its work took longer than the lease) must not
    // clobber the newer holder's state.
    .where(
      and(
        eq(sessionFinalizerState.siteId, input.siteId),
        eq(sessionFinalizerState.claimedBy, input.claimedBy),
      ),
    )
}

/** Release a claimed site without advancing, for a run that failed before it wrote. */
export async function releaseFinalizerSite(
  db: Database,
  input: { siteId: string; claimedBy: string; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date()
  await db
    .update(sessionFinalizerState)
    .set({ claimedBy: null, leaseExpiresAt: null, updatedAt: now })
    .where(
      and(
        eq(sessionFinalizerState.siteId, input.siteId),
        eq(sessionFinalizerState.claimedBy, input.claimedBy),
      ),
    )
}

export interface FinalizerStateRow {
  readonly siteId: string
  readonly finalizedThrough: Date
  readonly runSeq: number
  readonly lastRunAt: Date | null
}

/** Read a site's control row, for the read API's finalized_through metadata (Checkpoint C). */
export async function getFinalizerState(
  db: Database,
  siteId: string,
): Promise<FinalizerStateRow | null> {
  const [row] = await db
    .select()
    .from(sessionFinalizerState)
    .where(eq(sessionFinalizerState.siteId, siteId))
  if (!row) return null
  return {
    siteId: row.siteId,
    finalizedThrough: row.finalizedThrough,
    runSeq: Number(row.runSeq),
    lastRunAt: row.lastRunAt,
  }
}
