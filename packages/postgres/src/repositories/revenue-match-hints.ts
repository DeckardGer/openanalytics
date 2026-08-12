import type { RevenueMatchHint } from '@openanalytics/domain'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Executor } from '../client.ts'
import { newId } from '../ids.ts'
import { revenueMatchHints } from '../schema/revenue.ts'

/**
 * Checkout match hints (ADR-0033, D6; migration 0035). Milestone 12 CP3.
 *
 * The whole module exists to keep a *matching signal* away from the *money
 * state*. `checkout.session.completed` carries the two strongest non-event
 * matching signals in D6 — the Checkout Session id and the site's own
 * `client_reference_id` — and carries no amount at all; the charge it eventually
 * produces carries the amount and neither signal. Something has to hold them,
 * and the object head is the wrong thing to hold them in:
 *
 * - The head's three-way decision compares `(snapshot_at, payload_hash)` under
 *   the premise that one hash describes one *complete* state. A hint payload has
 *   no money fields, so applying it would either zero the amounts or need a
 *   partial merge — and a partial merge dissolves the invariant every later
 *   comparison rests on.
 * - The hint's snapshot time ties the charge's in the ordinary case, because the
 *   charge is created *by* the checkout. That is the equal-timestamp branch,
 *   which answers "re-fetch the object from the provider" — so every checkout
 *   would cost a provider request to resolve a tie that is not about money.
 *
 * Here, nothing can go wrong in the direction that matters: this table has no
 * money column, so a hint that is wrong, duplicated, late or absent changes
 * which journey a charge is attributed to and can never change what the charge
 * was worth.
 *
 * ## No hashing happens here
 *
 * `client_reference_id` and `customer_id` are stored in their raw provider form
 * — the same form `revenue_objects.normalized` has stored them in since CP2, and
 * the same class of value: a site's own opaque user id and a provider's opaque
 * customer handle, never an email. Hashing needs `ANONYMOUS_IDENTITY_SECRET`,
 * which the **worker** holds as of the ADR-0033 D6 amendment and the **api**
 * deliberately does not, so the derivation happens once at projection time
 * rather than at every write.
 */

export interface RecordRevenueMatchHintsInput {
  readonly siteId: string
  readonly provider: string
  readonly hints: readonly RevenueMatchHint[]
  readonly now?: Date
}

export interface RecordRevenueMatchHintsResult {
  /** Rows written or refreshed. Equal to the input length — a conflict is an
   * update, not a skip, because a redelivered session may legitimately carry a
   * PaymentIntent the first delivery did not yet have. */
  readonly written: number
}

/**
 * Upsert hints, keyed on `(site, provider, checkout_session_id)`, **fill-forward
 * only**.
 *
 * `ON CONFLICT DO UPDATE` rather than `DO NOTHING`, and the difference is a real
 * case rather than tidiness: an async payment method (SEPA, iDEAL, bank
 * transfer) completes a session *before* the PaymentIntent has a charge, so the
 * first delivery carries no `order_id` and a later one does. `DO NOTHING` would
 * pin the first, emptiest version of the row forever.
 *
 * But a plain `SET x = excluded.x` is wrong in the *other* direction, and that
 * direction loses data: provider payloads are not monotone. A redelivery of an
 * older event, a reconcile re-observation of a trimmed object, or simply an
 * event whose `client_reference_id` the account has since cleared, all arrive
 * with an empty field where the stored row has a real one — and the plain form
 * would overwrite a matched hint with a blank. The match would then silently
 * stop working for a charge that had been attributable a moment earlier.
 *
 * So every field is `COALESCE(NULLIF(excluded.x, ''), stored.x)`: a populated
 * value replaces anything, and an empty one replaces nothing. The columns are
 * `NOT NULL DEFAULT ''`, so the empty string is the only "absent" there is and
 * `NULLIF` is what turns it into one for `COALESCE`'s purposes.
 *
 * `occurred_at` takes the **later** of the two rather than fill-forward: it is
 * not an identifier that can be blank, it is "when this match became true", and
 * an async payment's match becomes true when it settles. `GREATEST` also makes
 * an out-of-order redelivery a no-op on it rather than a rewind.
 *
 * The uniqueness key is the *session*, which is what bounds the table: a session
 * completes once per site, so a provider retry storm updates one row rather than
 * inserting a row per delivery. Keying on a payload hash — the shape the
 * disabled-credential ledger note warns about — would have made the row count a
 * function of how many distinct bodies somebody could produce.
 *
 * One statement for the whole batch. In practice the batch is one hint, because
 * one event carries one session, but the shape composes into the webhook
 * transaction without a loop of round trips.
 */
export async function recordRevenueMatchHints(
  db: Executor,
  input: RecordRevenueMatchHintsInput,
): Promise<RecordRevenueMatchHintsResult> {
  if (input.hints.length === 0) return { written: 0 }
  const now = input.now ?? new Date()

  await db
    .insert(revenueMatchHints)
    .values(
      input.hints.map((hint) => ({
        id: newId(),
        siteId: input.siteId,
        provider: input.provider,
        checkoutSessionId: hint.checkoutSessionId,
        orderId: hint.orderId,
        clientReferenceId: hint.clientReferenceId,
        customerId: hint.customerId,
        occurredAt: hint.occurredAt,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [
        revenueMatchHints.siteId,
        revenueMatchHints.provider,
        revenueMatchHints.checkoutSessionId,
      ],
      set: {
        // Fill-forward: a populated incoming value replaces anything, an empty
        // one replaces nothing. See the doc comment — a plain
        // `excluded.x` here would let a redelivery blank out a hint that was
        // already matching a charge.
        orderId: fillForward('order_id'),
        clientReferenceId: fillForward('client_reference_id'),
        customerId: fillForward('customer_id'),
        // Not an identifier and never blank, so the later of the two wins.
        occurredAt: sql.raw(`GREATEST(excluded.occurred_at, ${HINTS_TABLE}.occurred_at)`),
        updatedAt: now,
      },
    })

  return { written: input.hints.length }
}

export interface RevenueMatchHintRow {
  readonly checkoutSessionId: string
  readonly orderId: string
  readonly clientReferenceId: string
  readonly customerId: string
  readonly occurredAt: Date
}

/**
 * Hints for a batch of order ids — the projection's left join, as one query.
 *
 * A batched `IN` rather than a lookup per row: a projection tick handles up to a
 * few hundred heads, and one round trip per head would make the loop's cost a
 * function of the network rather than of the work. Empty input returns an empty
 * map rather than issuing a query with an empty `IN`, which Postgres would
 * accept and which would still cost a round trip.
 *
 * Keyed by `order_id`, because that is the only field a charge and a checkout
 * session share. A hint with an empty `order_id` — a session that completed
 * without a payment — is deliberately excluded: it can match nothing, and
 * including it would mean every charge with no PaymentIntent silently adopting
 * the first such hint.
 */
export async function readRevenueMatchHintsByOrder(
  db: Executor,
  input: {
    readonly siteId: string
    readonly provider: string
    readonly orderIds: readonly string[]
  },
): Promise<Map<string, RevenueMatchHintRow>> {
  const wanted = [...new Set(input.orderIds.filter((id) => id !== ''))]
  if (wanted.length === 0) return new Map()

  const rows = await db
    .select({
      checkoutSessionId: revenueMatchHints.checkoutSessionId,
      orderId: revenueMatchHints.orderId,
      clientReferenceId: revenueMatchHints.clientReferenceId,
      customerId: revenueMatchHints.customerId,
      occurredAt: revenueMatchHints.occurredAt,
    })
    .from(revenueMatchHints)
    .where(
      and(
        eq(revenueMatchHints.siteId, input.siteId),
        eq(revenueMatchHints.provider, input.provider),
        inArray(revenueMatchHints.orderId, wanted),
      ),
    )

  const byOrder = new Map<string, RevenueMatchHintRow>()
  for (const row of rows) {
    // First writer wins on a duplicate order id. Two sessions naming one
    // PaymentIntent is not something Stripe produces, and picking arbitrarily
    // between them would make the projection non-deterministic — which would
    // break the "same head projects to an identical row" property the insert
    // token depends on. Deterministic by lowest session id.
    const existing = byOrder.get(row.orderId)
    if (existing && existing.checkoutSessionId <= row.checkoutSessionId) continue
    byOrder.set(row.orderId, row)
  }
  return byOrder
}

/** Test and reconciliation helper: one hint by its session id. */
export async function readRevenueMatchHint(
  db: Executor,
  input: {
    readonly siteId: string
    readonly provider: string
    readonly checkoutSessionId: string
  },
): Promise<RevenueMatchHintRow | null> {
  const [row] = await db
    .select({
      checkoutSessionId: revenueMatchHints.checkoutSessionId,
      orderId: revenueMatchHints.orderId,
      clientReferenceId: revenueMatchHints.clientReferenceId,
      customerId: revenueMatchHints.customerId,
      occurredAt: revenueMatchHints.occurredAt,
    })
    .from(revenueMatchHints)
    .where(
      and(
        eq(revenueMatchHints.siteId, input.siteId),
        eq(revenueMatchHints.provider, input.provider),
        eq(revenueMatchHints.checkoutSessionId, input.checkoutSessionId),
      ),
    )
  return row ?? null
}

/** The unqualified table name, which an `ON CONFLICT DO UPDATE` uses to refer to
 * the **stored** row (`excluded` refers to the proposed one). Named once so the
 * fill-forward expressions below cannot drift from the table they update. */
const HINTS_TABLE = 'revenue_match_hints'

/**
 * `COALESCE(NULLIF(excluded.<column>, ''), revenue_match_hints.<column>)`.
 *
 * The fill-forward rule as one expression. Drizzle's `set` takes values rather
 * than SQL, so the column name has to be written out — done through a named
 * helper for the reason `currency-rates.ts` gives: the name appears once per
 * field, so a rename that missed an occurrence fails loudly instead of silently
 * writing the stored value back over itself.
 *
 * The `NULLIF` is what makes it fill-forward rather than a plain overwrite:
 * these columns are `NOT NULL DEFAULT ''`, so the empty string is the only
 * "absent" the schema has, and `COALESCE` needs it as a NULL to fall through.
 */
function fillForward(column: string) {
  return sql.raw(`COALESCE(NULLIF(excluded.${column}, ''), ${HINTS_TABLE}.${column})`)
}
