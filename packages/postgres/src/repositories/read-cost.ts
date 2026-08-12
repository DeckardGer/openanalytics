import { sql } from 'drizzle-orm'
import type { Database } from '../client.ts'

/**
 * The rolling-day cost ledger (ADR-0043 D7, second half).
 *
 * Two statements, and each is one round trip because this sits on the hot path
 * of every analytics read:
 *
 * - `readCostSpent` sums the last 24 hourly buckets, before the query runs.
 * - `chargeReadCost` upserts this request's milliseconds into the current
 *   bucket, after it ran.
 *
 * **The check is before and the charge is after, and the gap between them is
 * deliberate.** A caller under budget gets its query even if that query is the
 * one that takes it over — you cannot know a query's cost until you have paid
 * it, and refusing based on a prediction is exactly what D7 refused to build.
 * The overshoot is bounded by one request, and it is what makes the refusal
 * honest: every millisecond in this table was actually spent.
 *
 * Both statements read the clock from the **database**, never from the process.
 * Two api instances with a few milliseconds of skew would otherwise bucket the
 * same instant differently and each see a different rolling window — the class
 * of defect M10 recorded when a job's `available_at` was written by Postgres and
 * compared in JavaScript.
 */

/** Milliseconds this credential has spent on reads in the last rolling day. */
export async function readCostSpent(db: Database, credentialKey: string): Promise<number> {
  const result = await db.execute(sql`
    SELECT coalesce(sum(elapsed_ms), 0)::bigint AS spent
    FROM read_cost_ledger
    WHERE credential_key = ${credentialKey}
      AND hour_bucket > date_trunc('hour', now()) - interval '23 hours'
  `)
  const row = (result as unknown as { rows: { spent: string | number }[] }).rows[0]
  return row === undefined ? 0 : Number(row.spent)
}

/**
 * Charge a completed read.
 *
 * Upsert rather than read-then-write, so two concurrent reads by the same
 * credential both land: `elapsed_ms = read_cost_ledger.elapsed_ms + excluded…`
 * is evaluated by the database, and neither request has to hold a lock across
 * its own query.
 */
export async function chargeReadCost(
  db: Database,
  input: { readonly credentialKey: string; readonly elapsedMs: number },
): Promise<void> {
  // Negative or absurd values cannot come from a monotonic clock, but a clamp
  // here is cheaper than a poisoned bucket: one bad write would refuse a
  // legitimate caller for a full day with no way to see why.
  //
  // A completed read is never free. The ledger is denominated in milliseconds,
  // so rounding would charge nothing for anything under half of one — and the
  // cheapest reads are the failures, which is the class this gate exists to
  // price. Hence the ceiling, and the floor of one that the same `max` applies.
  const charged = Math.max(1, Math.min(Math.ceil(input.elapsedMs), 60_000))
  await db.execute(sql`
    INSERT INTO read_cost_ledger (credential_key, hour_bucket, elapsed_ms, request_count)
    VALUES (${input.credentialKey}, date_trunc('hour', now()), ${charged}, 1)
    ON CONFLICT (credential_key, hour_bucket) DO UPDATE
      SET elapsed_ms = read_cost_ledger.elapsed_ms + excluded.elapsed_ms,
          request_count = read_cost_ledger.request_count + 1
  `)
}

/**
 * Drop buckets no rolling window can still reach.
 *
 * 48 hours rather than 24: the window is 24 and a bucket exactly on the boundary
 * is still summed, so trimming at 24 would race the read. The extra day costs a
 * handful of rows per credential and removes the race entirely.
 *
 * Returns how many rows went, which is what the sweeper logs.
 */
export async function sweepReadCostLedger(db: Database): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM read_cost_ledger
    WHERE hour_bucket < now() - interval '48 hours'
  `)
  return (result as unknown as { rowCount?: number }).rowCount ?? 0
}
