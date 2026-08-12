import { eq, sql } from 'drizzle-orm'
import type { Database } from '../client.ts'
import type { Executor } from './sites.ts'
import { newId } from '../ids.ts'
import { usageBatchDeltas, usageBatches } from '../schema/usage.ts'

/**
 * The exactly-once batch ledger (migration 0007, regrained by 0022; docs
 * snapshot 05, D-015, D-209 step 5).
 *
 * Two rules run through it:
 *
 * 1. **`accepted_at` decides the grouping, always.** Not `now()`, not the flush
 *    time, not the retry time. The worker may process a batch seconds or days
 *    after the collector accepted it — after a queue backlog, a crash, or a
 *    dead-letter replay — and none of that may move an event into a different
 *    period (D-015). No function in this file reads a clock.
 * 2. **Usage increments once per batch.** The
 *    `(batch_id, billing_user_id, usage_window_id, site_id)` unique constraint
 *    is the guard, and anything derived from a delta is only moved when that
 *    insert actually inserted.
 *
 * The ledger is a traffic counter and stops there. Windows, limits and the
 * counter they roll up into belong to whichever surface sells something, and
 * live in `../cloud/repositories/usage-windows.ts` — which contributes the
 * per-window bookkeeping through `UsageLedgerExtension` so that it still runs
 * inside this transaction. Splitting the transaction instead would have made a
 * crash between the delta insert and the counter update a permanent undercount:
 * the retry sees the delta already there, reports `applied: false`, and nothing
 * ever moves the counter.
 */

export interface UsageDelta {
  readonly billingUserId: string
  /** The window this delta bills into, when something is keeping windows. */
  readonly usageWindowId: string | null
  /** The site whose events this delta counts (per-site grain since 0022). */
  readonly siteId: string
  readonly delta: number
}

export interface AppliedUsage {
  readonly delta: UsageDelta
  /** False when this batch had already been applied to this (user, window). */
  readonly applied: boolean
  /** The authoritative window total after this call; 0 when nothing keeps one. */
  readonly billableCount: number
}

/**
 * What a surface that keeps running totals does inside the ledger transaction.
 *
 * One method, and it is called for every delta rather than only the applied
 * ones, because the caller needs the *total* back either way — a retried batch
 * still has to report where the window stands.
 */
export interface UsageLedgerExtension {
  readonly name: string
  readonly applyDelta: (
    tx: Executor,
    input: { readonly delta: UsageDelta; readonly applied: boolean },
  ) => Promise<number>
}

const usageLedgerExtensions: UsageLedgerExtension[] = []

export function registerUsageLedgerExtension(extension: UsageLedgerExtension): void {
  if (usageLedgerExtensions.some((registered) => registered.name === extension.name)) return
  usageLedgerExtensions.push(extension)
}

/**
 * Apply a batch's usage exactly once (docs snapshot 05, D-209 step 5).
 *
 * One transaction, and the ordering inside it is the guarantee: the delta row is
 * inserted with `ON CONFLICT DO NOTHING`, and anything derived from it is only
 * moved when that insert actually inserted a row. A retried batch therefore adds
 * nothing — not because the caller remembered it was a retry, but because the
 * database refused the second delta.
 *
 * Several deltas per batch is normal, not an edge case: a batch routinely spans
 * several sites, and where funding can move between owners it may also span two
 * of them mid-batch. Which is why the ledger's grain is (batch, user, window,
 * site) rather than one row per batch.
 */
export async function applyBatchUsage(
  db: Database,
  input: { batchId: string; deltas: readonly UsageDelta[] },
): Promise<AppliedUsage[]> {
  return await db.transaction(async (tx) => {
    /**
     * **The batch row is the idempotency guard, and the delta index is the
     * second one.** It used to be the other way round, and the reason it
     * changed is that `usage_window_id` became nullable: a unique index treats
     * two NULLs as distinct, so `ON CONFLICT DO NOTHING` over a tuple whose
     * fourth column is NULL never conflicts, and a replayed batch would have
     * added its deltas a second time. `usage_batches.batch_id` is unique with
     * no nullable column in it, and the whole apply is one transaction, so
     * "this batch has been applied" is exactly what the row's presence means.
     */
    const claimed = await tx
      .insert(usageBatches)
      .values({ id: newId(), batchId: input.batchId })
      .onConflictDoNothing({ target: usageBatches.batchId })
      .returning({ id: usageBatches.id })
    const firstApply = claimed.length > 0

    const results: AppliedUsage[] = []

    for (const delta of input.deltas) {
      if (delta.delta <= 0) continue

      const inserted = firstApply
        ? await tx
            .insert(usageBatchDeltas)
            .values({
              id: newId(),
              batchId: input.batchId,
              billingUserId: delta.billingUserId,
              usageWindowId: delta.usageWindowId,
              siteId: delta.siteId,
              delta: delta.delta,
            })
            .onConflictDoNothing({
              target: [
                usageBatchDeltas.batchId,
                usageBatchDeltas.billingUserId,
                usageBatchDeltas.usageWindowId,
                usageBatchDeltas.siteId,
              ],
            })
            .returning({ id: usageBatchDeltas.id })
        : []

      const applied = inserted.length > 0

      let billableCount = 0
      for (const extension of usageLedgerExtensions) {
        billableCount = await extension.applyDelta(tx, { delta, applied })
      }

      results.push({ delta, applied, billableCount })
    }

    return results
  })
}

/** Billable units this batch contributed, summed across its deltas. */
export async function readBatchLedgerTotal(db: Database, batchId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${usageBatchDeltas.delta}), 0)::int` })
    .from(usageBatchDeltas)
    .where(eq(usageBatchDeltas.batchId, batchId))

  return row?.total ?? 0
}
