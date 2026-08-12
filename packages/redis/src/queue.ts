/**
 * Durable queue contract (docs snapshot 05, D-205/D-209).
 *
 * The types live apart from the ioredis implementation so a caller — and the
 * managed-provider fallback D-206 allows if the Milestone 1 proof fails — can
 * depend on the shape of an acceptance without depending on the transport.
 */

export const ENQUEUE_OUTCOMES = ['enqueued', 'duplicate', 'idempotency_conflict'] as const

export type EnqueueOutcome = (typeof ENQUEUE_OUTCOMES)[number]

/**
 * The event reached the stream, either on this call (`enqueued`) or on an
 * earlier one (`duplicate`).
 *
 * `duplicate` is a *success*: docs snapshot 02 §7.2 item 15 answers `202` both
 * when the queue takes an event and when it confirms it already holds it. The
 * distinction is kept anyway because only `enqueued` may increment usage — a
 * retry billed a second time is the legacy defect D-209 exists to prevent.
 */
export interface EnqueueAccepted {
  readonly outcome: 'enqueued' | 'duplicate'
  /** False for `duplicate`: no new stream entry was created. */
  readonly enqueued: boolean
  readonly streamId: string
  /** Acceptance time of the *first* delivery, not of this retry. */
  readonly firstAcceptedAt: string
}

/**
 * The same `(site_id, event_id)` was already accepted carrying a different
 * payload hash — a client reused an event ID for new data, which is a caller
 * bug rather than a retry. Rejecting is the only safe answer: accepting would
 * store two different events under one identity and make the dedup record
 * meaningless for the rest of its TTL.
 */
export interface EnqueueConflict {
  readonly outcome: 'idempotency_conflict'
  readonly enqueued: false
  /** Stream entry the *original* payload was written to, for diagnosis. */
  readonly conflictingStreamId: string
  /** Acceptance time of the original payload. */
  readonly firstAcceptedAt: string
}

/** Result of the atomic dedup + XADD script (docs snapshot 05, D-209 step 1). */
export type EnqueueResult = EnqueueAccepted | EnqueueConflict

export function isEnqueueConflict(result: EnqueueResult): result is EnqueueConflict {
  return result.outcome === 'idempotency_conflict'
}

/**
 * Result of enqueuing a whole client batch.
 *
 * Deliberately not an array of per-event results: docs snapshot 02 §7.3 makes
 * batch acceptance all-or-nothing, so a conflict is a property of the *request*,
 * not of one event in it. Modelling it as a per-event outcome would let a caller
 * write the loop that answers 202 for the events before the conflict — the exact
 * partial enqueue §7.3 forbids.
 *
 * The conflicting event's position is carried so the error can name it.
 */
export type EnqueueBatchResult =
  | { readonly outcome: 'accepted'; readonly results: readonly EnqueueResult[] }
  | {
      readonly outcome: 'idempotency_conflict'
      /** Zero-based position of the conflicting event in the submitted batch. */
      readonly index: number
      readonly conflictingStreamId: string
      readonly firstAcceptedAt: string
    }

export interface EnqueueInput {
  readonly siteId: string
  readonly eventId: string
  readonly payloadHash: string
  readonly payload: string
  readonly acceptedAt: string
}

export interface EventStreamQueue {
  /**
   * Atomically deduplicates a whole batch on `(siteId, eventId)` and appends the
   * new events to the stream.
   *
   * Must be one server-side script. A check-then-append leaves a window where
   * two concurrent requests each create a stream entry for the same event, and a
   * per-event round trip cannot honour §7.3's all-or-nothing rule: a conflict
   * discovered on the fifth event would find the first four already enqueued.
   *
   * A matching ID with a *different* payload hash is an `IDEMPOTENCY_CONFLICT`
   * for the request, not a duplicate — it means a client reused an event ID for
   * new data.
   */
  enqueueBatch(inputs: readonly EnqueueInput[]): Promise<EnqueueBatchResult>

  /** One event, through the same script. Convenience for callers with one. */
  enqueue(input: EnqueueInput): Promise<EnqueueResult>
}

/** One entry read back out of the event stream by the worker. */
export interface StreamMessage {
  /** Valkey stream ID; half of the `(stream_name, message_id)` manifest key. */
  readonly id: string
  readonly siteId: string
  readonly eventId: string
  readonly payloadHash: string
  readonly acceptedAt: string
  readonly payload: string
}

export interface PendingSummary {
  readonly count: number
  readonly minId: string | null
  readonly maxId: string | null
  readonly consumers: readonly { readonly name: string; readonly count: number }[]
}

export interface ReclaimResult {
  /**
   * Cursor to pass to the next `reclaim` call. `XAUTOCLAIM` returns `0-0` when
   * it has walked the whole pending list, so a reclaimer loops until it sees it
   * rather than assuming one pass drained everything.
   */
  readonly nextCursor: string
  readonly messages: readonly StreamMessage[]
  /** Pending IDs whose stream entry is gone; already evicted from the PEL. */
  readonly deletedIds: readonly string[]
}

/**
 * Entries fetched back by id, and the ids that are no longer in the stream.
 *
 * A missing id is not a bug: deletion `XDEL`s a site's entries without waiting
 * for their retention to elapse (docs snapshot 05, D-210), so a manifest can
 * legitimately name a message whose payload is gone. Plan Milestone 6 item 13
 * makes that a safe drop with an audit trail rather than a stall.
 */
export interface FetchByIdResult {
  readonly messages: readonly StreamMessage[]
  readonly missingIds: readonly string[]
}

export interface EventStreamConsumer {
  /** Idempotent; safe on every worker boot and on every reconnect. */
  ensureGroup(): Promise<boolean>
  read(options: { count: number; blockMs: number }): Promise<readonly StreamMessage[]>
  /** Called only after ClickHouse and usage committed (docs snapshot 05, D-209 step 6). */
  ack(ids: readonly string[]): Promise<number>
  reclaim(options: { minIdleMs: number; count: number; cursor?: string }): Promise<ReclaimResult>
  pending(): Promise<PendingSummary>
  /**
   * Read specific entries back by id.
   *
   * Crash recovery needs this: the manifest records which messages a batch holds
   * but not their payloads, so a worker resuming someone else's batch fetches
   * exactly that batch's entries — in the manifest's order, never the stream's.
   */
  fetchByIds(ids: readonly string[]): Promise<FetchByIdResult>
}

/**
 * Queue operations that are not part of consuming: the dead-letter stream and
 * the retention trimmer (plan Milestone 6 items 9 and 10).
 */
export interface QueueMaintenance {
  /**
   * Copy a batch's entries to the dead-letter stream.
   *
   * A copy, not a move: the manifest and the audit survive a dead-letter
   * (docs snapshot 02 §7.4), and the original entries are removed by the
   * ordinary retention trim rather than by the failure path.
   */
  publishDeadLetter(input: {
    readonly batchId: string
    readonly reason: string
    readonly messages: readonly StreamMessage[]
  }): Promise<number>

  /**
   * Trim ACKed entries older than the retention horizon.
   *
   * Never trims past the oldest still-pending entry, whatever the horizon says:
   * a pending entry is an event that has not been stored yet, and the retention
   * rule is about how long *ACKed* payloads are kept for disaster replay
   * (docs snapshot 05, D-216), not a licence to discard unfinished work.
   */
  trimAcked(input: { readonly before: Date }): Promise<{ trimmed: number; minId: string }>

  /**
   * Age of the oldest undelivered or unacknowledged entry, in milliseconds.
   *
   * The G-006 queue alert reads this. Null when the queue is empty and there is
   * nothing waiting — which is different from zero, and an alert rule that
   * conflated them would page on an idle system.
   */
  oldestPendingAgeMs(now: Date): Promise<number | null>
}
