import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createEventStreamConsumer,
  createEventStreamQueue,
  createQueueClient,
  dedupKey,
  isEnqueueConflict,
} from '@openanalytics/redis'
import type {
  EnqueueAccepted,
  EnqueueResult,
  EventStreamConsumer,
  EventStreamQueue,
} from '@openanalytics/redis'

// Derived rather than imported from 'ioredis' directly: the driver is a
// dependency of @openanalytics/redis, not of the test project, so a direct
// specifier does not resolve from here.
type QueueClient = ReturnType<typeof createQueueClient>

/**
 * Milestone 1 gate, queue half (docs snapshot 04, Milestone 1 items 6-7).
 *
 * Every assertion here is one of the gate's bullet points, and each runs
 * against the real `valkey-queue` instance over the same TLS+AUTH public
 * endpoint the collector will use (D-206). Testing this against a local
 * in-memory double would prove nothing: what is in question is whether Valkey's
 * script atomicity, AOF and consumer-group semantics behave as D-205/D-209
 * assume under concurrency and restart, not whether our TypeScript is correct.
 *
 * Each run works inside its own stream/group so repeated runs cannot interfere.
 */

const QUEUE_URL = process.env['M1_VALKEY_QUEUE_URL']
const describeIfLive = QUEUE_URL ? describe : describe.skip

describeIfLive('M1 gate — durable queue against the deployed valkey-queue', () => {
  const streamKey = `m1_test_stream:${randomUUID()}`
  const groupName = 'm1_test_group'
  // Same field names as `Policy`, so the TTLs the gate measures are the ones
  // production reads from env rather than a parallel set invented here.
  const policy = { INGEST_DEDUP_TTL_DAYS: 7, SITE_QUEUE_INDEX_TTL_DAYS: 8 }

  let client: QueueClient
  let queue: EventStreamQueue
  let consumer: EventStreamConsumer

  // The result is a discriminated union: only the accepted arm carries a
  // streamId, because a conflict's stream id belongs to the *other* payload.
  // Asserting the arm here keeps that distinction visible in the tests instead
  // of casting it away.
  const accepted = (result: EnqueueResult): EnqueueAccepted => {
    if (isEnqueueConflict(result)) {
      throw new Error(`expected an accepted enqueue, got a conflict: ${JSON.stringify(result)}`)
    }
    return result
  }

  const event = (overrides: Partial<Parameters<EventStreamQueue['enqueue']>[0]> = {}) => ({
    siteId: `site-${randomUUID()}`,
    eventId: randomUUID(),
    payloadHash: 'a'.repeat(64),
    payload: JSON.stringify({ kind: 'pageview' }),
    acceptedAt: new Date().toISOString(),
    ...overrides,
  })

  beforeAll(async () => {
    client = createQueueClient({
      mode: 'collector',
      url: QUEUE_URL as string,
      connectionName: 'm1-gate-test',
    })
    queue = createEventStreamQueue({ client, policy, streamKey })
    consumer = createEventStreamConsumer({
      client,
      consumerName: 'm1-worker-a',
      streamKey,
      groupName,
    })
    await consumer.ensureGroup()
  })

  afterAll(async () => {
    await client.del(streamKey)
    client.disconnect()
  })

  it('creates exactly one stream entry for concurrent duplicates of the same event', async () => {
    // The gate bullet: "the Valkey atomic operation creates only one stream
    // entry for concurrent requests carrying the same (site, event_id)."
    const input = event()
    const CONCURRENCY = 25

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => queue.enqueue(input)),
    )

    const enqueued = results.filter((r) => r.outcome === 'enqueued')
    const duplicates = results.filter((r) => r.outcome === 'duplicate')

    expect(enqueued).toHaveLength(1)
    expect(duplicates).toHaveLength(CONCURRENCY - 1)

    // Every duplicate reports the winner's stream id and its acceptance time —
    // the retry must not be re-timestamped into a later usage window (D-015).
    const winner = accepted(enqueued[0] as EnqueueResult)
    for (const duplicate of duplicates) {
      const dup = accepted(duplicate)
      expect(dup.streamId).toBe(winner.streamId)
      expect(dup.firstAcceptedAt).toBe(winner.firstAcceptedAt)
    }

    // And the stream itself holds one row, which is the claim that actually
    // matters — the return values could agree while the stream had 25 entries.
    const entries = await client.xrange(streamKey, '-', '+')
    const withEvent = entries.filter(([, fields]: [string, string[]]) =>
      fields.includes(input.eventId),
    )
    expect(withEvent).toHaveLength(1)
  })

  it('reports a conflict when the same event id arrives with different bytes', async () => {
    const first = event()
    await queue.enqueue(first)
    const conflicting = await queue.enqueue({ ...first, payloadHash: 'b'.repeat(64) })

    expect(isEnqueueConflict(conflicting)).toBe(true)
    expect(conflicting.outcome).toBe('idempotency_conflict')
  })

  it('keeps an unacked message pending so a crash before ACK does not lose it', async () => {
    // The gate bullet: "a worker restart reclaims the pending message; no event
    // is lost before the ACK."
    const input = event()
    await queue.enqueue(input)

    const read = await consumer.read({ count: 10, blockMs: 100 })
    const mine = read.find((m) => m.eventId === input.eventId)
    expect(mine).toBeDefined()

    // Simulate the crash: the worker read the message and died before ACK.
    // Nothing is acked, so it must still be pending.
    const pending = await consumer.pending()
    expect(pending.count).toBeGreaterThan(0)

    // A second worker with a different identity reclaims it after the idle
    // window, which is what makes the crash recoverable rather than fatal.
    const other = createEventStreamConsumer({
      client,
      consumerName: 'm1-worker-b',
      streamKey,
      groupName,
    })
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    const reclaimed = await other.reclaim({ minIdleMs: 1_000, count: 50 })

    expect(reclaimed.messages.map((m) => m.eventId)).toContain(input.eventId)

    // Only now is it acked — D-209 step 6 order.
    await other.ack(reclaimed.messages.map((m) => m.id))
    const after = await consumer.pending()
    expect(after.count).toBe(0)
  })

  it('does not redeliver an acked message', async () => {
    const input = event()
    await queue.enqueue(input)

    const read = await consumer.read({ count: 10, blockMs: 100 })
    const mine = read.find((m) => m.eventId === input.eventId)
    expect(mine).toBeDefined()
    await consumer.ack([mine?.id as string])

    const pending = await consumer.pending()
    expect(pending.count).toBe(0)
  })

  it('retains the dedup record so a retry after commit is still deduplicated', async () => {
    // "request timeout-after-commit": the collector's write succeeded but the
    // response never reached the tracker, so the tracker retries. The dedup
    // record outlives the stream entry's consumption precisely so this retry
    // does not produce a second event.
    const input = event()
    const first = await queue.enqueue(input)
    expect(first.outcome).toBe('enqueued')

    const read = await consumer.read({ count: 10, blockMs: 100 })
    const mine = read.find((m) => m.eventId === input.eventId)
    await consumer.ack([mine?.id as string])

    const retry = await queue.enqueue(input)
    expect(retry.outcome).toBe('duplicate')
    expect(accepted(retry).streamId).toBe(accepted(first).streamId)

    // The dedup key must carry a bounded TTL, not live forever.
    const ttl = await client.ttl(dedupKey(input.siteId, input.eventId))
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(7 * 24 * 60 * 60)
  })

  it('accumulates a backlog without dropping entries', async () => {
    const BACKLOG = 200
    const inputs = Array.from({ length: BACKLOG }, () => event())
    // Enqueued in parallel batches rather than serially: this test asserts that
    // nothing is dropped, and serialising 200 public TLS round-trips measures
    // the tester's distance from Frankfurt instead. Latency is measured
    // separately, from a Vercel function in-region.
    const BATCH = 25
    for (let i = 0; i < inputs.length; i += BATCH) {
      await Promise.all(inputs.slice(i, i + BATCH).map((input) => queue.enqueue(input)))
    }

    let drained = 0
    for (let pass = 0; pass < 20 && drained < BACKLOG; pass++) {
      const batch = await consumer.read({ count: 50, blockMs: 200 })
      if (batch.length === 0) break
      await consumer.ack(batch.map((m) => m.id))
      drained += batch.filter((m) => inputs.some((i) => i.eventId === m.eventId)).length
    }

    // noeviction is what makes this assertion meaningful: under an eviction
    // policy a full instance would silently drop the oldest entries (D-205).
    expect(drained).toBe(BACKLOG)
  })
})
