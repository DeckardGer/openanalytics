import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Database } from '../client.ts'
import { newId } from '../ids.ts'
import { idempotencyKeys } from '../schema/idempotency.ts'

/**
 * The inbound request idempotency ledger (migration 0019; docs snapshot 02 §18).
 *
 * Endpoint-agnostic on purpose: `scope` names the operation, so every later
 * create endpoint reuses this rather than growing its own table. Nothing here
 * knows what a site is.
 *
 * The claim is an `INSERT ... ON CONFLICT DO NOTHING` followed by a read of
 * whoever won, exactly as `computeOrCreateUsageWindow` does. A read-then-insert
 * would race: two retries arriving together would both find no row, both decide
 * they were first, and both run the handler — which is the precise failure the
 * ledger exists to prevent. The unique constraint is the arbiter, and the loser
 * needs the winner's row rather than an error.
 *
 * The four outcomes are a discriminated union rather than exceptions because all
 * four are ordinary, expected states the route maps onto different responses:
 *
 *   claimed      no row existed; the caller owns the claim and runs the handler.
 *   replay       same key, same payload, response already stored — return it
 *                verbatim.
 *   conflict     same key, different payload. A client bug; answering with the
 *                stored response would hand back the answer to a question they
 *                did not ask.
 *   in_progress  same key, same payload, no response yet: a concurrent request
 *                is still running. Deterministic and safe — the client retries
 *                once the first finishes and then gets the replay.
 *
 * A handler that fails releases its claim (`releaseIdempotencyKey`), so a caller
 * can correct the payload and retry with the same key.
 */

export interface IdempotencyKeyRef {
  readonly userId: string
  /** The operation the key was presented to, e.g. `sites.create`. */
  readonly scope: string
  /** The client-supplied `Idempotency-Key` header value, verbatim. */
  readonly key: string
}

export type IdempotencyClaim =
  | { readonly status: 'claimed' }
  | {
      readonly status: 'replay'
      readonly responseStatus: number
      readonly responseBody: Record<string, unknown> | null
    }
  | { readonly status: 'conflict' }
  | { readonly status: 'in_progress' }

export interface ClaimIdempotencyKeyInput extends IdempotencyKeyRef {
  /** SHA-256 over the canonical request. Never the request itself. */
  readonly requestHash: string
}

function keyPredicate(ref: IdempotencyKeyRef) {
  return and(
    eq(idempotencyKeys.userId, ref.userId),
    eq(idempotencyKeys.scope, ref.scope),
    eq(idempotencyKeys.key, ref.key),
  )
}

/**
 * Claim a key, or report what the existing claim says.
 *
 * The bounded retry covers one genuinely reachable interleaving: our insert
 * loses the race, and the winner's request fails and releases its claim before
 * we read the row. Then there is no row to report on and the right answer is to
 * try to claim it again, not to invent an outcome.
 */
export async function claimIdempotencyKey(
  db: Database,
  input: ClaimIdempotencyKeyInput,
): Promise<IdempotencyClaim> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const inserted = await db
      .insert(idempotencyKeys)
      .values({
        id: newId(),
        userId: input.userId,
        scope: input.scope,
        key: input.key,
        requestHash: input.requestHash,
      })
      .onConflictDoNothing({
        target: [idempotencyKeys.userId, idempotencyKeys.scope, idempotencyKeys.key],
      })
      .returning({ id: idempotencyKeys.id })

    if (inserted.length > 0) return { status: 'claimed' }

    const [row] = await db
      .select({
        requestHash: idempotencyKeys.requestHash,
        responseStatus: idempotencyKeys.responseStatus,
        responseBody: idempotencyKeys.responseBody,
        completedAt: idempotencyKeys.completedAt,
      })
      .from(idempotencyKeys)
      .where(keyPredicate(input))

    // Released between our failed insert and this read — go round again.
    if (!row) continue

    if (row.requestHash !== input.requestHash) return { status: 'conflict' }
    if (row.completedAt === null || row.responseStatus === null) return { status: 'in_progress' }
    return {
      status: 'replay',
      responseStatus: row.responseStatus,
      responseBody: row.responseBody ?? null,
    }
  }

  throw new Error('idempotency claim did not settle after three attempts')
}

export interface CompleteIdempotencyKeyInput extends IdempotencyKeyRef {
  readonly responseStatus: number
  readonly responseBody?: Record<string, unknown> | null
}

/**
 * Store the response a claimed key's handler produced, making it replayable.
 *
 * Scoped to a claim that is still in flight (`completed_at IS NULL`), so a
 * second completion of the same key cannot overwrite the answer already handed
 * to a client.
 */
export async function completeIdempotencyKey(
  db: Database,
  input: CompleteIdempotencyKeyInput,
): Promise<void> {
  await db
    .update(idempotencyKeys)
    .set({
      responseStatus: input.responseStatus,
      responseBody: input.responseBody ?? null,
      completedAt: new Date(),
    })
    .where(and(keyPredicate(input), isNull(idempotencyKeys.completedAt)))
}

/**
 * Release a claim so the same key may be used again.
 *
 * The failure path: a handler that answered 4xx/5xx stored nothing worth
 * replaying, and holding the key would leave the caller unable to retry with it
 * after correcting the payload. Deleting rather than marking failed keeps the
 * claim a single, unambiguous state.
 */
export async function releaseIdempotencyKey(db: Database, ref: IdempotencyKeyRef): Promise<void> {
  await db.delete(idempotencyKeys).where(keyPredicate(ref))
}

export interface SweepIdempotencyKeysInput {
  /** Completed rows created before this are past their replay horizon. */
  readonly completedBefore: Date
  /** In-flight claims created before this are orphaned by construction. */
  readonly claimedBefore: Date
  /** Rows removed in one pass. */
  readonly limit: number
}

/**
 * Remove idempotency rows nothing can still use (ADR-0019 known gap 4).
 *
 * Two horizons, one statement, because the states they retire fail differently
 * and the policy carries the argument for each number:
 *
 *   * a **completed** row past `completedBefore` is a stored response no client
 *     will ask for again;
 *   * an **in-flight** row past `claimedBefore` is a claim whose handler died
 *     before it could complete or release it. Nothing else in the system
 *     deletes that row, so without this disjunct the key it holds is refused
 *     `in_progress` for the rest of the table's life.
 *
 * `claimedBefore` is the later instant of the two (the policy refuses any other
 * ordering), so the disjuncts overlap rather than leaving a gap: a completed row
 * is only ever retired by the first, an in-flight one by whichever it crosses
 * first.
 *
 * Bounded like the manifest trim beside it, and for the same reason: a delete
 * that takes the whole table in one statement holds locks for as long as it
 * takes, on a path that runs unattended. The horizons are days and hours wide,
 * so a pass that leaves rows behind simply takes them on the next one.
 *
 * Both disjuncts are ranges on `created_at`, which is what
 * `idempotency_keys_created_idx` (migration 0019) exists to serve — the index
 * was added in the same pass that recorded this gap.
 */
export async function sweepIdempotencyKeys(
  db: Database,
  input: SweepIdempotencyKeysInput,
): Promise<number> {
  const removed = await db
    .delete(idempotencyKeys)
    .where(
      sql`${idempotencyKeys.id} IN (
        SELECT id FROM ${idempotencyKeys}
        WHERE ${idempotencyKeys.createdAt} < ${input.completedBefore}
           OR (${idempotencyKeys.completedAt} IS NULL
               AND ${idempotencyKeys.createdAt} < ${input.claimedBefore})
        ORDER BY ${idempotencyKeys.createdAt}
        LIMIT ${input.limit}
      )`,
    )
    .returning({ id: idempotencyKeys.id })

  return removed.length
}
