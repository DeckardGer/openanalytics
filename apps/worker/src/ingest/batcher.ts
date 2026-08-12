import { decideFlush, type FlushReason, type Policy } from '@openanalytics/domain'
import type { StreamMessage } from '@openanalytics/redis'

/**
 * The open batch (docs snapshot 02 §7.5).
 *
 * Accumulates messages between reads and asks `decideFlush` whether to close.
 * The rule itself lives in `@openanalytics/domain` so it is testable without a
 * queue; this is only the bookkeeping around it — the first event's arrival
 * time, the running byte count, and the ordering the manifest will freeze.
 *
 * Order is append order, which is stream order, which becomes the manifest's
 * `position` and therefore the insert's row order. Nothing sorts it: a
 * re-ordering here would change the `batch_id` a retry derives and turn a
 * deduplicated retry into new data.
 */
export class OpenBatch {
  #messages: StreamMessage[] = []
  #bytes = 0
  #firstAt: number | null = null
  readonly #policy: Policy
  readonly #now: () => Date

  constructor(policy: Policy, now: () => Date) {
    this.#policy = policy
    this.#now = now
  }

  add(messages: readonly StreamMessage[]): void {
    for (const message of messages) {
      this.#firstAt ??= this.#now().getTime()
      this.#messages.push(message)
      this.#bytes += Buffer.byteLength(message.payload, 'utf8')
    }
  }

  get size(): number {
    return this.#messages.length
  }

  get bytes(): number {
    return this.#bytes
  }

  get isEmpty(): boolean {
    return this.#messages.length === 0
  }

  /** Milliseconds since the batch's first event, zero while it is empty. */
  ageMs(): number {
    return this.#firstAt === null ? 0 : Math.max(0, this.#now().getTime() - this.#firstAt)
  }

  /**
   * How long the next blocking read may wait without overshooting the age
   * trigger.
   *
   * An empty batch may block for the full interval; a batch already holding
   * events may not, or a quiet moment after the first event would push the flush
   * past the SLO the section sets.
   */
  blockMsBudget(): number {
    if (this.#firstAt === null) return this.#policy.WORKER_BATCH_MAX_FLUSH_MS
    return Math.max(0, this.#policy.WORKER_BATCH_MAX_FLUSH_MS - this.ageMs())
  }

  /** Rows the next read may take before the row limit would be exceeded. */
  countBudget(): number {
    return Math.max(1, this.#policy.WORKER_BATCH_MAX_ROWS - this.#messages.length)
  }

  shouldFlush(shuttingDown: boolean): { flush: boolean; reason: FlushReason | null } {
    return decideFlush({
      rows: this.#messages.length,
      bytes: this.#bytes,
      ageMs: this.ageMs(),
      shuttingDown,
      policy: this.#policy,
    })
  }

  /** Hands over the accumulated messages and reopens empty. */
  drain(): readonly StreamMessage[] {
    const messages = this.#messages
    this.#messages = []
    this.#bytes = 0
    this.#firstAt = null
    return messages
  }
}
