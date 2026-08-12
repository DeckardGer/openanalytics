import { createHash } from 'node:crypto'
import type { Policy } from './policy.ts'

/**
 * Batch identity, the flush rule and the manifest state machine — as pure
 * functions over values the worker has already read.
 *
 * Docs snapshot 02 §7.5 and 05 D-209 step 3. Nothing here touches a clock, a
 * queue or a database: the worker supplies the message list, the counters and
 * the age, and asks these functions what they mean. That split is what makes the
 * crash matrix testable without infrastructure, and it is why the batch id a
 * test computes is the same value production sends to ClickHouse.
 */

/**
 * Version prefix on every derived id.
 *
 * The id is a ClickHouse `insert_deduplication_token` and a Postgres key, both
 * of which outlive a deployment. If the derivation ever changes, the prefix
 * makes old and new ids provably non-colliding instead of silently equal for
 * some inputs — and a batch whose token changed meaning would be re-inserted as
 * new data.
 */
export const BATCH_ID_VERSION = 'b1'

function sha256Hex(parts: readonly string[]): string {
  // Length-prefixed rather than delimiter-joined: a separator inside a component
  // would otherwise let two different message lists hash to one value, and two
  // different batches sharing a deduplication token means one of them is
  // silently discarded.
  const hash = createHash('sha256')
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part, 'utf8')))
    hash.update(':')
    hash.update(part, 'utf8')
  }
  return hash.digest('hex')
}

export interface BatchIdentityInput {
  readonly streamName: string
  readonly consumerGroup: string
  /** Stream message ids **in the order the rows will be inserted**. */
  readonly messageIds: readonly string[]
}

export class EmptyBatchError extends Error {
  constructor() {
    super('A batch must contain at least one message')
    this.name = 'EmptyBatchError'
  }
}

/**
 * The deterministic `batch_id` (docs snapshot 05, D-209 step 3).
 *
 * Derived from the stream identity and the ordered message list, so the same
 * batch computed by a reclaimer on another machine, after a crash, or a day
 * later is the same id — which is the whole point: it is simultaneously the
 * ClickHouse insert deduplication token, the `usage_batches` key and the
 * manifest primary identity, so one value makes a retry a no-op in all three.
 *
 * The consumer group is part of the identity because a second group over the
 * same stream would be delivered the same message ids, and two genuinely
 * different batches sharing a token would have one of them silently dropped.
 *
 * Order matters. A different order is a different insert, and the ClickHouse
 * token only recognises a retry that re-issues the same rows in the same order.
 */
export function deriveBatchId(input: BatchIdentityInput): string {
  if (input.messageIds.length === 0) throw new EmptyBatchError()
  return `${BATCH_ID_VERSION}_${sha256Hex([
    input.streamName,
    input.consumerGroup,
    ...input.messageIds,
  ])}`
}

/**
 * Hash over the ordered payload hashes of a batch.
 *
 * The message list decides the id. This proves the *content* behind those
 * message ids is the same content on a retry, so a payload substituted
 * underneath a reclaim is detectable rather than re-inserted under a token that
 * asserts nothing changed.
 */
export function derivePayloadHash(payloadHashes: readonly string[]): string {
  if (payloadHashes.length === 0) throw new EmptyBatchError()
  return sha256Hex(payloadHashes)
}

// ---------------------------------------------------------------------------
// The flush rule (docs snapshot 02 §7.5)
// ---------------------------------------------------------------------------

export const FLUSH_REASONS = ['row_limit', 'byte_limit', 'max_age', 'shutdown'] as const
export type FlushReason = (typeof FLUSH_REASONS)[number]

export type FlushDecision =
  | { readonly flush: false; readonly reason: null }
  | { readonly flush: true; readonly reason: FlushReason }

const HOLD: FlushDecision = { flush: false, reason: null }

export interface FlushInput {
  readonly rows: number
  /** Decoded payload bytes accumulated so far. */
  readonly bytes: number
  /** Milliseconds since the batch's **first** event, not since the last one. */
  readonly ageMs: number
  readonly shuttingDown: boolean
  readonly policy: Policy
}

/**
 * Whether the open batch should be flushed now.
 *
 * §7.5 lists four triggers and nothing else: the maximum age since the first
 * event, the row limit, the byte limit, and a graceful shutdown signal. The
 * "0.5 seconds" in the same section is not a fifth trigger and not a floor — it
 * is the lower end of the SLO band, and the sentence around it says the opposite
 * of a floor: under high traffic a full batch *may* flush before it. So there is
 * no minimum age here. Adding one would hold a full batch back and turn the
 * band's lower bound into a latency guarantee nobody asked for.
 *
 * An empty batch never flushes, including on shutdown: an insert of no rows
 * would still consume a deduplication token and produce a manifest describing
 * nothing.
 *
 * The reason is returned rather than inferred, because it is the label on the
 * flush metric: a worker flushing on `max_age` at every batch is idle, and one
 * flushing on `byte_limit` at every batch is undersized. Those are different
 * operational stories that a bare flush count cannot tell apart.
 */
export function decideFlush(input: FlushInput): FlushDecision {
  const { rows, bytes, ageMs, shuttingDown, policy } = input

  if (rows <= 0) return HOLD

  if (rows >= policy.WORKER_BATCH_MAX_ROWS) return { flush: true, reason: 'row_limit' }
  if (bytes >= policy.WORKER_BATCH_MAX_BYTES) return { flush: true, reason: 'byte_limit' }
  if (ageMs >= policy.WORKER_BATCH_MAX_FLUSH_MS) return { flush: true, reason: 'max_age' }
  if (shuttingDown) return { flush: true, reason: 'shutdown' }

  return HOLD
}

// ---------------------------------------------------------------------------
// The manifest state machine (docs snapshot 02 §7.5, 05 D-209 step 6, D-216)
// ---------------------------------------------------------------------------

/**
 * The canonical state vocabulary. Migration 0015's CHECK constraint and the
 * Drizzle mirror inline the same list — `packages/postgres` does not import
 * `@openanalytics/domain` (the convention the plan-tier column already follows),
 * and `tests/unit/ingest-batch.test.ts` fails if the two ever disagree.
 *
 * Each state names one crash point from plan Milestone 6's acceptance criteria:
 *
 * - `pending`        the manifest is durable and nothing downstream has been
 *                    written. Recovery issues the insert.
 * - `inserting`      the insert was issued and its outcome is unknown — the
 *                    ambiguous timeout the stable token exists for. Recovery
 *                    retries the SAME manifest with the SAME token, because a
 *                    new token would insert the rows a second time.
 * - `inserted`       ClickHouse confirmed. Recovery continues at the usage ledger.
 * - `usage_recorded` the usage transaction committed. Recovery only has to XACK.
 * - `completed`      XACKed. Terminal, and what bounded disaster replay selects
 *                    on (D-216).
 * - `dead_lettered`  retries exhausted. Terminal but not successful — the
 *                    manifest and its audit survive, which is what makes manual
 *                    replay possible (02 §7.4).
 */
export const INGEST_BATCH_STATES = [
  'pending',
  'inserting',
  'inserted',
  'usage_recorded',
  'completed',
  'dead_lettered',
] as const

export type IngestBatchState = (typeof INGEST_BATCH_STATES)[number]

/**
 * Allowed transitions.
 *
 * Three of these are worth stating out loud:
 *
 * - `inserting -> pending` is the *definite* failure — the request never
 *   reached ClickHouse, so nothing can have landed and the next attempt starts
 *   clean. An ambiguous failure stays in `inserting`, which is the self
 *   transition below, and is retried with the same token.
 * - `usage_recorded` cannot be dead-lettered. Everything that can permanently
 *   fail has already succeeded, and the one remaining step — the XACK — is safe
 *   to repeat indefinitely: an un-ACKed message is redelivered, finds a
 *   `usage_recorded` manifest and acknowledges it. Allowing a DLQ here would
 *   mean abandoning a batch whose data and usage are already correct.
 * - `dead_lettered -> pending` is the manual replay hook (plan item 10). It is
 *   the only way out of the dead-letter state, and it deliberately re-enters the
 *   machine at the start rather than jumping to `inserted`: the token still
 *   protects whatever already landed.
 */
const TRANSITIONS: Readonly<Record<IngestBatchState, readonly IngestBatchState[]>> = {
  pending: ['inserting', 'dead_lettered'],
  inserting: ['inserting', 'inserted', 'pending', 'dead_lettered'],
  inserted: ['usage_recorded', 'dead_lettered'],
  usage_recorded: ['completed'],
  completed: [],
  dead_lettered: ['pending'],
}

export function nextIngestBatchStates(state: IngestBatchState): readonly IngestBatchState[] {
  return TRANSITIONS[state]
}

export function canTransitionIngestBatch(from: IngestBatchState, to: IngestBatchState): boolean {
  return TRANSITIONS[from].includes(to)
}

/** A batch in a terminal state is never claimed, retried or reclaimed again. */
export function isTerminalIngestBatchState(state: IngestBatchState): boolean {
  return state === 'completed' || state === 'dead_lettered'
}

/**
 * The work a recovering worker has to do, given the state it found.
 *
 * This is the crash matrix as a single function. A reclaimer never decides what
 * to redo from the messages it holds — it decides from the manifest, which is
 * the only record that survives the crash.
 */
export const RECOVERY_ACTIONS = ['insert', 'record_usage', 'ack', 'none'] as const
export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number]

export function recoveryActionFor(state: IngestBatchState): RecoveryAction {
  switch (state) {
    case 'pending':
    case 'inserting':
      return 'insert'
    case 'inserted':
      return 'record_usage'
    case 'usage_recorded':
      return 'ack'
    case 'completed':
    case 'dead_lettered':
      return 'none'
  }
}

// ---------------------------------------------------------------------------
// Retry scheduling (plan Milestone 6 item 10)
// ---------------------------------------------------------------------------

/**
 * Backoff before attempt number `attempt` (1-based), capped.
 *
 * Deterministic and jitter-free so the retry horizon is a computable number
 * rather than a distribution — the policy invariant that keeps the horizon
 * inside the ClickHouse deduplication window depends on being able to compute
 * it. A caller that wants jitter adds it, and the cap makes the worst case the
 * number this function returns.
 *
 * The parameter is narrowed to the two values the formula reads so a caller that
 * is not the batch pipeline — the M10 job runner, which shares the schedule but
 * not the rest of the batch policy — can pass exactly what it uses.
 */
export function retryDelayMs(
  attempt: number,
  policy: Pick<Policy, 'WORKER_RETRY_BASE_MS' | 'WORKER_RETRY_MAX_MS'>,
): number {
  const exponent = Math.max(0, Math.floor(attempt) - 1)
  const delay = policy.WORKER_RETRY_BASE_MS * 2 ** exponent
  return Math.min(delay, policy.WORKER_RETRY_MAX_MS)
}

/**
 * Total wall-clock a batch may spend between its first attempt and the
 * dead-letter decision.
 *
 * Docs snapshot 02 §7.5 requires the ClickHouse deduplication window to exceed
 * this, because a retry that lands outside the window is not deduplicated — it
 * is a second copy of the data. `policySchema` enforces the relationship, and
 * this is the number it enforces it against.
 */
export function retryHorizonMs(policy: Policy): number {
  let total = 0
  for (let attempt = 1; attempt < policy.WORKER_BATCH_MAX_ATTEMPTS; attempt += 1) {
    total += retryDelayMs(attempt, policy)
  }
  return total
}

/**
 * Worst-case count of blocks a single ClickHouse table can receive while one
 * batch is working through its retry horizon.
 *
 * `non_replicated_deduplication_window` is measured in *blocks*, not in time:
 * the server remembers the last N inserted block hashes per table, and a retry
 * is recognised only while its hash is still among them. The worker's fastest
 * sustainable cadence is one flush per `WORKER_BATCH_MAX_FLUSH_MS` — a smaller
 * batch flushes sooner but a batch cannot be *held* longer — so this converts
 * the time horizon into the unit the setting is actually expressed in.
 */
export function retryHorizonBlocks(policy: Policy): number {
  return Math.ceil(retryHorizonMs(policy) / policy.WORKER_BATCH_MAX_FLUSH_MS)
}
