import { deriveBatchId, derivePayloadHash, retryDelayMs } from '@openanalytics/domain'
import {
  INGEST_PIPELINE_ID,
  claimManifest,
  createOrContinueManifest,
  listRunnableManifests,
  upsertWorkerHeartbeat,
  type Manifest,
} from '@openanalytics/postgres'
import type { StreamMessage } from '@openanalytics/redis'
import { OpenBatch } from './batcher.ts'
import type { IngestDeps } from './deps.ts'
import { WORKER_METRICS } from './metrics.ts'
import { runManifest, type BatchOutcome } from './pipeline.ts'

/**
 * The consumer loop (docs snapshot 02 §7.4/§7.5).
 *
 * One iteration does three things, in this order and for this reason:
 *
 * 1. **Recover.** Manifests left behind by a crashed worker are finished before
 *    anything new is read. A batch already holding a lease on stream messages
 *    blocks nothing else, but its events are the oldest in the system and
 *    freshness is measured from acceptance.
 * 2. **Reclaim.** Pending messages idle longer than a healthy worker would ever
 *    hold them are claimed. This is what makes a dead worker's un-manifested
 *    messages someone else's problem rather than nobody's.
 * 3. **Read.** New messages are accumulated into the open batch until the flush
 *    rule closes it.
 *
 * Shutdown drains rather than abandons: `stop()` sets the flag, the open batch
 * flushes on the `shutdown` trigger, and the loop exits after the in-flight
 * batch reaches a decided state (02 §7.5).
 */

export interface IngestLoop {
  /** Runs until `stop()`. Resolves once the final batch has been decided. */
  run(): Promise<void>
  stop(): Promise<void>
  /** One iteration. Exposed so tests can drive the loop deterministically. */
  tick(): Promise<void>
}

/** Turns a set of stream messages into a manifest and runs it to a decision. */
export async function processMessages(
  deps: IngestDeps,
  messages: readonly StreamMessage[],
): Promise<BatchOutcome[]> {
  const outcomes: BatchOutcome[] = []
  let pending = messages

  // A read can contain messages that already belong to a manifest — a reclaim
  // of a crashed worker's batch, most often. Those are not folded into a new
  // batch: the manifest's message list is what the deduplication token is
  // derived from, so widening it would produce a different token for the same
  // rows. The owning manifest is run, and whatever the read still holds is
  // planned again.
  while (pending.length > 0) {
    const batchId = deriveBatchId({
      streamName: deps.streamName,
      consumerGroup: deps.consumerGroup,
      messageIds: pending.map((message) => message.id),
    })

    const plan = await createOrContinueManifest(deps.db, {
      batchId,
      streamName: deps.streamName,
      consumerGroup: deps.consumerGroup,
      payloadHash: derivePayloadHash(pending.map((message) => message.payloadHash)),
      byteSize: pending.reduce(
        (total, message) => total + Buffer.byteLength(message.payload, 'utf8'),
        0,
      ),
      messages: pending.map((message) => ({
        messageId: message.id,
        siteId: message.siteId,
        eventId: message.eventId,
        payloadHash: message.payloadHash,
        acceptedAt: new Date(message.acceptedAt),
      })),
      claimedBy: deps.consumerName,
      leaseTtlMs: deps.policy.WORKER_LEASE_TTL_MS,
    })

    if (plan.outcome === 'created') {
      deps.metrics.increment(WORKER_METRICS.manifestCreated)
      deps.metrics.increment(WORKER_METRICS.batchRows, {}, plan.manifest.messageCount)
      deps.metrics.increment(WORKER_METRICS.batchBytes, {}, plan.manifest.byteSize)
      outcomes.push(await runManifest(deps, plan.manifest))
      return outcomes
    }

    deps.metrics.increment(WORKER_METRICS.manifestContinued)
    outcomes.push(await runManifest(deps, plan.manifest))

    const remaining = new Set(plan.remaining)
    const next = pending.filter((message) => remaining.has(message.id))
    // Guard against a plan that consumed nothing: without it a manifest that
    // somehow contains none of the read's messages would spin here forever.
    if (next.length === pending.length) return outcomes
    pending = next
  }

  return outcomes
}

/** Finish manifests a previous process left in a non-terminal state. */
export async function recoverManifests(deps: IngestDeps, limit: number): Promise<BatchOutcome[]> {
  const manifests: Manifest[] = await listRunnableManifests(deps.db, { limit, now: deps.now() })
  const outcomes: BatchOutcome[] = []

  for (const manifest of manifests) {
    const claimed = await claimManifest(deps.db, {
      batchId: manifest.batchId,
      claimedBy: deps.consumerName,
      leaseTtlMs: deps.policy.WORKER_LEASE_TTL_MS,
      now: deps.now(),
    })
    // Another worker took it between the list and the claim. Ordinary, and the
    // conditional update is what makes it harmless.
    if (!claimed) continue

    deps.metrics.increment(WORKER_METRICS.manifestRecovered, { state: manifest.state })
    outcomes.push(await runManifest(deps, manifest))
  }

  return outcomes
}

/**
 * Floor between two heartbeat writes (ADR-0025).
 *
 * The loop ticks roughly every 1.5 seconds, and the reader compares the tick
 * against a ten-minute threshold — so writing on every tick would spend three
 * Postgres round-trips per second to sharpen a signal nobody reads that finely.
 * Five seconds keeps the write rate flat regardless of how fast the queue makes
 * the loop spin, and still leaves ~120 ticks of margin before the reader would
 * call the pipeline stale.
 */
const HEARTBEAT_MIN_INTERVAL_MS = 5_000

export interface IngestLoopOptions {
  readonly deps: IngestDeps
  /** Manifests recovered per iteration. Bounded so recovery cannot starve reads. */
  readonly recoveryLimit?: number
}

export function createIngestLoop(options: IngestLoopOptions): IngestLoop {
  const { deps } = options
  const recoveryLimit = options.recoveryLimit ?? 16
  const batch = new OpenBatch(deps.policy, deps.now)

  let shuttingDown = false
  let running = false
  let finished: Promise<void> | null = null

  // Wakers for an in-progress backoff sleep, so `stop()` does not have to wait
  // out a 30-second backoff before the loop notices it should exit.
  const wakers = new Set<() => void>()

  const backoffSleep = (ms: number): Promise<void> => {
    if (shuttingDown) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const waker = (): void => {
        clearTimeout(timer)
        wakers.delete(waker)
        resolve()
      }
      const timer = setTimeout(waker, ms)
      timer.unref?.()
      wakers.add(waker)
    })
  }

  // Wall-clock of the last heartbeat write, so the throttle survives across
  // ticks. Starts at -Infinity so the first tick always writes: a worker that
  // has just come up is exactly when someone wants to see a fresh row.
  let lastHeartbeatMs = Number.NEGATIVE_INFINITY

  /**
   * Records that ingest is alive, independently of whether anyone visited
   * (ADR-0025).
   *
   * This is the whole point of the row: the read API cannot tell a quiet site
   * from a stalled pipeline by looking at the site's own data, because both look
   * like "no recent bucket". The loop ticks on a traffic-independent schedule,
   * so its tick is the signal — carried with the queue age, because a loop that
   * ticks in front of a growing backlog is alive but not fresh.
   *
   * Best-effort, like the queue-age gauge beside it: a Postgres blip must cost a
   * warning, never an iteration.
   */
  const writeHeartbeat = async (tickAt: Date, queueOldestAgeMs: number): Promise<void> => {
    const tickMs = tickAt.getTime()
    if (tickMs - lastHeartbeatMs < HEARTBEAT_MIN_INTERVAL_MS) return
    // Marked before the write, not after: a database that is refusing writes
    // would otherwise be retried on every tick, turning one failure into a
    // few-hundred-millisecond hammer on the thing that is already unwell.
    lastHeartbeatMs = tickMs

    try {
      await upsertWorkerHeartbeat(deps.db, {
        id: INGEST_PIPELINE_ID,
        consumer: deps.consumerName,
        lastTickAt: tickAt,
        queueOldestAgeMs,
      })
    } catch (err) {
      deps.logger.warn('worker_heartbeat_unwritten', { err, retryable: true })
    }
  }

  const reportQueueAge = async (): Promise<void> => {
    const tickAt = deps.now()
    let age: number | null = null
    try {
      age = await deps.maintenance.oldestPendingAgeMs(tickAt)
      // Reported as 0 when the queue is empty rather than skipped: a metric that
      // stops being emitted looks identical to a metric that cannot be scraped,
      // and an alert on "no data" is not the alert G-006 asked for.
      deps.metrics.gauge(WORKER_METRICS.queueOldestAgeMs, age ?? 0)
    } catch (err) {
      deps.logger.warn('queue_age_unavailable', { err, retryable: true })
    }
    // Written even when the age could not be read: the tick still happened, and
    // liveness is the primary thing this row carries. An unknown age records as
    // 0 — the same convention the gauge uses for an empty queue — because the
    // alternative, skipping the heartbeat, would make a Valkey blip look
    // identical to a dead ingest.
    await writeHeartbeat(tickAt, age ?? 0)
  }

  const tick = async (): Promise<void> => {
    await recoverManifests(deps, recoveryLimit)

    const reclaimed = await deps.consumer.reclaim({
      minIdleMs: deps.policy.WORKER_CLAIM_MIN_IDLE_MS,
      count: deps.policy.WORKER_BATCH_MAX_ROWS,
    })
    if (reclaimed.messages.length > 0) {
      deps.metrics.increment(WORKER_METRICS.reclaimed, {}, reclaimed.messages.length)
      await processMessages(deps, reclaimed.messages)
    }
    if (reclaimed.deletedIds.length > 0) {
      // XAUTOCLAIM already dropped these from the pending list; the stream entry
      // is gone (the D-210 deletion path). Recorded so a deletion that removes
      // in-flight work is visible rather than silent (plan M6 item 13).
      deps.metrics.increment(WORKER_METRICS.messageMissing, {}, reclaimed.deletedIds.length)
      deps.logger.warn('ingest_pending_entry_deleted', {
        count: reclaimed.deletedIds.length,
        message_ids: reclaimed.deletedIds,
      })
    }

    const messages = await deps.consumer.read({
      count: batch.countBudget(),
      blockMs: batch.blockMsBudget(),
    })
    batch.add(messages)

    const decision = batch.shouldFlush(shuttingDown)
    if (decision.flush) {
      deps.metrics.increment(WORKER_METRICS.batchFlushed, { reason: decision.reason ?? 'unknown' })
      await processMessages(deps, batch.drain())
    }

    await reportQueueAge()
  }

  return {
    tick,

    async run(): Promise<void> {
      if (running) return finished ?? undefined
      running = true

      finished = (async () => {
        await deps.consumer.ensureGroup()
        // Consecutive failing iterations, reset on the first success. This is
        // what turns a persistent error into a backoff rather than a hot loop:
        // a healthy `tick()` paces itself on the blocking XREADGROUP, but a
        // failure — a Postgres blip, a missing table on a fresh database — makes
        // `tick()` return immediately, and without a delay the loop would retry
        // every few milliseconds and bury the log (observed on the first deploy
        // against an un-migrated Neon database).
        let consecutiveFailures = 0
        while (!shuttingDown || !batch.isEmpty) {
          try {
            await tick()
            consecutiveFailures = 0
          } catch (err) {
            // The loop itself must not die on one bad iteration: a queue blip
            // that killed the consumer would stop ingest until someone noticed.
            // Individual batches carry their own retry and dead-letter path.
            consecutiveFailures += 1
            const backoffMs = retryDelayMs(consecutiveFailures, deps.policy)
            deps.logger.error('ingest_loop_iteration_failed', {
              err,
              retryable: true,
              consecutive_failures: consecutiveFailures,
              backoff_ms: backoffMs,
            })

            // On the way out, a failing drain is not retried: the in-flight
            // messages are unacknowledged in the queue and another worker will
            // reclaim them (at-least-once), so giving up is safe and a tight
            // loop before `process.exit` is not.
            if (shuttingDown) break
            await backoffSleep(backoffMs)
          }
        }
        deps.logger.info('ingest_loop_stopped', {})
      })()

      await finished
    },

    async stop(): Promise<void> {
      shuttingDown = true
      // Cut short any in-progress backoff so shutdown is not held for the length
      // of the current delay.
      for (const waker of [...wakers]) waker()
      await finished
    },
  }
}
