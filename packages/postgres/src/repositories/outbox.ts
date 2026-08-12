import { eq, sql } from 'drizzle-orm'
import type { Database, Executor } from '../client.ts'
import { newId } from '../ids.ts'
import { outbox, type OutboxStatus } from '../schema/outbox.ts'

/**
 * Outbox repository.
 *
 * The producer side (`enqueueOutbox`) is idempotent on `idempotency_key`: a
 * retried enqueue with the same key inserts nothing, which is what lets a caller
 * write the side effect in the same transaction as its state change without
 * fearing a duplicate on retry. The consumer side claims due rows with
 * `FOR UPDATE SKIP LOCKED` so two workers never deliver the same row.
 *
 * These are the only functions that touch the outbox table; the integrations
 * package holds the delivery orchestration and never imports this package, so
 * the worker composes the two.
 */

export interface EnqueueOutboxInput {
  readonly topic: string
  readonly payload: Record<string, unknown>
  readonly idempotencyKey: string
  /** Defaults to immediately due. */
  readonly availableAt?: Date
}

export interface EnqueueOutboxResult {
  readonly enqueued: boolean
  readonly id: string | null
}

export async function enqueueOutbox(
  db: Executor,
  input: EnqueueOutboxInput,
): Promise<EnqueueOutboxResult> {
  const inserted = await db
    .insert(outbox)
    .values({
      id: newId(),
      topic: input.topic,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
      ...(input.availableAt === undefined ? {} : { availableAt: input.availableAt }),
    })
    .onConflictDoNothing({ target: outbox.idempotencyKey })
    .returning({ id: outbox.id })

  const row = inserted[0]
  return { enqueued: row !== undefined, id: row?.id ?? null }
}

export interface ClaimedOutboxRow {
  readonly id: string
  readonly payload: unknown
}

/**
 * Atomically claims up to `limit` due rows of a topic, moving them to
 * `processing` and counting the attempt. `SKIP LOCKED` means concurrent workers
 * take disjoint rows instead of blocking.
 */
export async function claimDueOutbox(
  db: Database,
  params: { topic: string; limit: number },
): Promise<ClaimedOutboxRow[]> {
  const result = await db.execute(sql`
    UPDATE ${outbox} AS o
    SET status = 'processing', attempts = o.attempts + 1
    WHERE o.id IN (
      SELECT id FROM ${outbox}
      WHERE topic = ${params.topic} AND status = 'pending' AND available_at <= now()
      ORDER BY available_at
      LIMIT ${params.limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING o.id, o.payload
  `)

  const rows = (result as unknown as { rows: { id: string; payload: unknown }[] }).rows
  return rows.map((row) => ({ id: row.id, payload: row.payload }))
}

export interface OutboxBacklogRow {
  readonly topic: string
  readonly status: 'pending' | 'processing' | 'dead'
  readonly count: number
  /** Age of the oldest row in the group, by `created_at`. */
  readonly oldestAgeMs: number
}

/**
 * The undelivered backlog, per topic and status.
 *
 * `created_at` rather than `available_at`, deliberately: the question an alert
 * asks is "how long has this side effect been owed", and a row that has been
 * retried for an hour has an `available_at` a minute in the future. It would
 * report a backlog of ~0 while the customer's email has still not been sent.
 *
 * `processing` is included because a claimed row whose worker died stays in that
 * state until it is noticed — the one status with no self-healing path, and so
 * the one most worth seeing.
 */
export async function readOutboxBacklog(db: Database): Promise<OutboxBacklogRow[]> {
  const result = await db.execute(sql`
    SELECT topic,
           status,
           count(*)::int AS count,
           (extract(epoch FROM (now() - min(created_at))) * 1000)::bigint AS oldest_age_ms
      FROM ${outbox}
     WHERE status IN ('pending', 'processing', 'dead')
     GROUP BY topic, status
  `)

  const rows = (
    result as unknown as {
      rows: { topic: string; status: string; count: number; oldest_age_ms: string }[]
    }
  ).rows

  return rows.map((row) => ({
    topic: row.topic,
    status: row.status as OutboxBacklogRow['status'],
    count: Number(row.count),
    oldestAgeMs: Number(row.oldest_age_ms),
  }))
}

export interface OutboxDeliveryRow {
  readonly id: string
  readonly topic: string
  /**
   * The payload's `kind`, and deliberately nothing else from the payload.
   *
   * Every email this deployment sends shares one topic (`email.send`), so the
   * topic cannot tell a test send from a sign-in link — the `kind` can, and a
   * caller that serves one kind can refuse the rest. It is extracted here rather
   * than by handing the payload out, because the payload also holds the
   * recipient, the subject and the body, and none of those has any business
   * leaving this function.
   *
   * `null` when the payload is not an object or names no kind, which is a row no
   * caller should match on.
   */
  readonly kind: string | null
  readonly status: OutboxStatus
  readonly attempts: number
  /** The categorized reason a transport reported. Never a raw provider body —
   * `classifySmtpFailure` and the Resend adapter both narrow before this is
   * written, which is what makes it safe to render to an operator. */
  readonly lastError: string | null
  readonly deliveredAt: Date | null
}

/**
 * One outbox row, by id.
 *
 * The read behind "did my test email arrive?". Nothing else needs it: delivery
 * is otherwise a fire-and-forget side effect whose failures belong in the
 * worker's logs.
 *
 * `topic` and `kind` are both returned so the caller can refuse anything it does
 * not serve. Both, because neither is sufficient alone: every email in this
 * system shares the topic `email.send`, so the topic separates mail from future
 * non-mail topics and the `kind` separates a test send from a sign-in link.
 *
 * What this row deliberately does **not** carry is the payload itself — no
 * recipient, no subject, no body — so even a row a caller matches discloses only
 * whether it was delivered and, if not, the reason a transport had already
 * categorized.
 */
export async function readOutboxDelivery(
  db: Database,
  id: string,
): Promise<OutboxDeliveryRow | null> {
  const [row] = await db
    .select({
      id: outbox.id,
      topic: outbox.topic,
      payload: outbox.payload,
      status: outbox.status,
      attempts: outbox.attempts,
      lastError: outbox.lastError,
      deliveredAt: outbox.deliveredAt,
    })
    .from(outbox)
    .where(eq(outbox.id, id))
  if (!row) return null
  const { payload, ...rest } = row
  const kind =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? ((payload as Record<string, unknown>)['kind'] ?? null)
      : null
  return {
    ...rest,
    // Destructured out above and never spread, so no future field added to the
    // payload can reach a response by being carried along.
    kind: typeof kind === 'string' ? kind : null,
    deliveredAt: rest.deliveredAt ? new Date(rest.deliveredAt) : null,
  }
}

export async function markOutboxDelivered(db: Database, id: string): Promise<void> {
  await db
    .update(outbox)
    .set({ status: 'delivered', deliveredAt: new Date(), lastError: null })
    .where(eq(outbox.id, id))
}

export interface MarkOutboxFailedOptions {
  /** Attempts at or beyond this move the row to `dead` instead of retrying. */
  readonly maxAttempts?: number
  readonly retryDelaySeconds?: number
}

/**
 * Requeues a failed row for a later attempt, or moves it to `dead` once it has
 * exhausted its attempts. `attempts` was already incremented at claim time, so
 * it reflects the attempt that just failed.
 */
export async function markOutboxFailed(
  db: Database,
  id: string,
  error: string,
  options: MarkOutboxFailedOptions = {},
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? 5
  const retryDelaySeconds = options.retryDelaySeconds ?? 60
  await db.execute(sql`
    UPDATE ${outbox}
    SET status = CASE WHEN attempts >= ${maxAttempts} THEN 'dead' ELSE 'pending' END,
        available_at = now() + (${retryDelaySeconds} * interval '1 second'),
        last_error = ${error}
    WHERE id = ${id}
  `)
}
