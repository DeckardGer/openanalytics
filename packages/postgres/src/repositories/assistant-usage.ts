import { sql } from 'drizzle-orm'
import type { Database, Executor } from '../client.ts'

/**
 * The assistant's per-user question ledger (ADR-0046 D5).
 *
 * The same shape as `read-cost.ts` one milestone later, and deliberately so:
 * hourly buckets, one indexed sum for the gate, an upsert for the charge, and a
 * sweeper that trims by age on the tick that already trims the other ledger.
 * What differs is what is counted and who it is counted against — questions per
 * *person* rather than milliseconds per credential — and that difference is the
 * whole reason this table is an account-deletion target and that one is not.
 *
 * **The check is before and the charge is at accept**, after validation and
 * before the provider call. Each edge has a reason (D5):
 *
 * - Validation failures are free: a malformed payload never reaches the
 *   provider, and charging it would make a client bug eat a day's allowance.
 * - Provider and downstream failures are charged: the slot was consumed. Not
 *   charging would make failure the cheapest way to farm free retries — the
 *   argument ADR-0043 D7 made when it put the read-cost charge in a `finally`.
 * - Tokens are updated as usage arrives, because they are not known at accept.
 *   They are a measurement, not a budget: nothing refuses on them in v1.
 * - The overshoot is bounded by one question. A user at 19 gets their twentieth
 *   even if it is the expensive one.
 *
 * Every statement reads the clock from the **database**. Two api instances with
 * a few milliseconds of skew would otherwise bucket the same instant
 * differently and each see a different rolling window — the class of defect M10
 * recorded when a job's `available_at` was written by Postgres and compared in
 * JavaScript.
 */

/**
 * The window predicate, shared by the gate read and the report so the two can
 * never disagree about which buckets are still inside it.
 *
 * `> date_trunc('hour', now()) - interval '23 hours'` is `read_cost_ledger`'s
 * own arithmetic, kept verbatim: the oldest bucket a window can reach opened 22
 * whole hours ago, and it leaves at the next hour tick.
 */
const WINDOW = sql`hour_bucket > date_trunc('hour', now()) - interval '23 hours'`

/** Questions this user has asked in the last rolling day — the gate's read. */
export async function assistantQuestionsSpent(db: Executor, userId: string): Promise<number> {
  const result = await db.execute(sql`
    SELECT coalesce(sum(question_count), 0)::bigint AS used
    FROM assistant_usage_ledger
    WHERE user_id = ${userId}::uuid
      AND ${WINDOW}
  `)
  const row = (result as unknown as { rows: { used: string | number }[] }).rows[0]
  return row === undefined ? 0 : Number(row.used)
}

/**
 * Charge one accepted question to the current hour.
 *
 * Upsert rather than read-then-write, so two questions accepted at the same
 * instant both land: the addition is evaluated by the database and neither
 * request holds a lock across the other's provider call.
 */
export async function chargeAssistantQuestion(
  db: Executor,
  input: { readonly userId: string },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO assistant_usage_ledger
      (user_id, hour_bucket, question_count, input_tokens, output_tokens)
    VALUES (${input.userId}::uuid, date_trunc('hour', now()), 1, 0, 0)
    ON CONFLICT (user_id, hour_bucket) DO UPDATE
      SET question_count = assistant_usage_ledger.question_count + 1
  `)
}

/**
 * Add the tokens a turn reported to the current hour, charging no question.
 *
 * The row it lands in may be one no question opened: the charge happens at
 * accept and the usage arrives when the stream ends, so an answer that crosses
 * an hour boundary reports into the next bucket. That row is a fact about spend
 * and reads as `question_count = 0`, which is exactly what it is.
 */
export async function recordAssistantTokens(
  db: Executor,
  input: {
    readonly userId: string
    readonly inputTokens: number
    readonly outputTokens: number
  },
): Promise<void> {
  // The numbers come from a third party. A negative, fractional or non-finite
  // value cannot be a token count, and one bad write would misreport a user's
  // spend for a full day with nothing on the row to show why — the same clamp,
  // and the same reasoning, as the read-cost charge's.
  const input_ = clampTokens(input.inputTokens)
  const output = clampTokens(input.outputTokens)
  await db.execute(sql`
    INSERT INTO assistant_usage_ledger
      (user_id, hour_bucket, question_count, input_tokens, output_tokens)
    VALUES (${input.userId}::uuid, date_trunc('hour', now()), 0, ${input_}, ${output})
    ON CONFLICT (user_id, hour_bucket) DO UPDATE
      SET input_tokens = assistant_usage_ledger.input_tokens + excluded.input_tokens,
          output_tokens = assistant_usage_ledger.output_tokens + excluded.output_tokens
  `)
}

function clampTokens(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

/** The window's whole state, as `GET /v1/assistant/usage` and the stream's
 * `done` event report it. */
export interface AssistantUsageWindow {
  /** Questions charged inside the window — what the limit is compared against. */
  readonly used: number
  readonly inputTokens: number
  readonly outputTokens: number
  /** The oldest bucket in the window that carries a question, or null when none
   * does. Token-only buckets are excluded on purpose: they free nothing. */
  readonly oldestBucketAt: Date | null
  /**
   * Seconds until that bucket leaves the window — the honest `Retry-After`, and
   * null when nothing has been charged.
   *
   * Computed in the database, from the same `now()` the buckets were written
   * against, and *not* through `costRetryAfterSeconds`. That helper answers
   * "when does the current hour end", which is right for the read-cost budget —
   * milliseconds accumulate across a whole day, so its oldest bucket is
   * routinely the one about to age out. The assistant's twenty questions can be
   * spent in a single sitting, and telling that user to come back in fifty
   * minutes when the truth is twenty-two hours would be precisely the lie D5
   * chose hourly buckets to avoid.
   */
  readonly retryAfterSeconds: number | null
}

/** The whole window in one round trip, so the report costs one query. */
export async function readAssistantUsage(
  db: Executor,
  userId: string,
): Promise<AssistantUsageWindow> {
  const result = await db.execute(sql`
    SELECT coalesce(sum(question_count), 0)::bigint AS used,
           coalesce(sum(input_tokens), 0)::bigint   AS input_tokens,
           coalesce(sum(output_tokens), 0)::bigint  AS output_tokens,
           min(hour_bucket) FILTER (WHERE question_count > 0) AS oldest_bucket,
           -- A bucket leaves the window when date_trunc('hour', now()) reaches
           -- bucket + 23 hours, which is the WINDOW predicate read backwards.
           ceil(extract(epoch FROM
             (min(hour_bucket) FILTER (WHERE question_count > 0) + interval '23 hours') - now()
           ))::bigint AS retry_after_seconds
    FROM assistant_usage_ledger
    WHERE user_id = ${userId}::uuid
      AND ${WINDOW}
  `)

  const row = (
    result as unknown as {
      rows: {
        used: string | number
        input_tokens: string | number
        output_tokens: string | number
        oldest_bucket: string | Date | null
        retry_after_seconds: string | number | null
      }[]
    }
  ).rows[0]

  if (row === undefined) {
    return {
      used: 0,
      inputTokens: 0,
      outputTokens: 0,
      oldestBucketAt: null,
      retryAfterSeconds: null,
    }
  }

  return {
    used: Number(row.used),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    // Raw `execute` bypasses drizzle's column mapping, so a timestamptz arrives
    // as the wire string and the declared `Date` has to be made true here.
    oldestBucketAt: row.oldest_bucket === null ? null : new Date(row.oldest_bucket),
    // Never zero, which a client reads as "immediately": a bucket in the window
    // always has time left, and a rounding that produced 0 would turn a wait
    // into a retry storm.
    retryAfterSeconds:
      row.retry_after_seconds === null ? null : Math.max(1, Number(row.retry_after_seconds)),
  }
}

/**
 * Drop buckets no rolling window can still reach.
 *
 * 48 hours rather than 24, for `sweepReadCostLedger`'s reason: the window is a
 * day and a bucket on its boundary is still summed, so trimming at 24 would
 * race the read. The extra day costs a handful of rows per user and removes the
 * race entirely.
 *
 * Returns how many rows went, which is what the trimmer logs.
 */
export async function sweepAssistantUsageLedger(db: Database): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM assistant_usage_ledger
    WHERE hour_bucket < now() - interval '48 hours'
  `)
  return (result as unknown as { rowCount?: number }).rowCount ?? 0
}
