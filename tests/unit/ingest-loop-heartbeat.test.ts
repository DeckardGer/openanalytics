import { loadPolicy } from '@openanalytics/domain'
import { createRecordingMetrics } from '@openanalytics/observability'
import { createCapturedLogger } from '@openanalytics/testkit'
import { describe, expect, it } from 'vitest'
import { createIngestLoop } from '../../apps/worker/src/ingest/index.ts'
import type { IngestDeps } from '../../apps/worker/src/ingest/index.ts'

/**
 * The ingest loop's pipeline heartbeat (ADR-0025).
 *
 * The row exists so the read API can tell "this site had no visitors" apart from
 * "we are not processing", and the only thing that makes it able to is *when*
 * the loop writes it: on the loop's own schedule, whether or not the queue had
 * anything in it. A heartbeat written only when a batch flushed would carry the
 * same ambiguity as the watermark it replaces, so the empty tick is the case
 * under test.
 *
 * `tick()` is driven directly rather than through `run()`, so no timers are
 * needed and the throttle can be walked one controlled instant at a time.
 */

interface HeartbeatWrite {
  id: string
  consumer: string
  lastTickAt: Date
  queueOldestAgeMs: number
  updatedAt: Date
}

/**
 * A `db` that records heartbeat upserts and answers every read with no rows.
 *
 * `onWrite` is the injection point for the failure case: the loop must survive a
 * database that refuses this write, because bookkeeping about ingest must never
 * be able to stop ingest.
 */
function heartbeatDb(onWrite?: () => void): {
  db: IngestDeps['db']
  writes: HeartbeatWrite[]
} {
  const writes: HeartbeatWrite[] = []

  // The read chain the manifest recovery walks, resolving to no rows.
  const readChain: Record<string, unknown> = {}
  for (const method of ['from', 'where', 'orderBy', 'limit']) {
    readChain[method] = () => readChain
  }
  readChain['then'] = (resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve([]))

  const db = {
    select: () => readChain,
    insert: () => ({
      values: (values: HeartbeatWrite) => ({
        onConflictDoUpdate: () => {
          writes.push(values)
          onWrite?.()
          return Promise.resolve()
        },
      }),
    }),
  }

  return { db: db as unknown as IngestDeps['db'], writes }
}

function buildDeps(overrides: Partial<IngestDeps>): IngestDeps {
  const { logger } = createCapturedLogger()
  const base = {
    consumer: {
      ensureGroup: () => Promise.resolve(true),
      read: () => Promise.resolve([]),
      reclaim: () => Promise.resolve({ nextCursor: '0-0', messages: [], deletedIds: [] }),
      ack: () => Promise.resolve(0),
      pending: () => Promise.resolve({ count: 0, minId: null, maxId: null, consumers: [] }),
      fetchByIds: () => Promise.resolve({ messages: [], missingIds: [] }),
    },
    maintenance: {
      publishDeadLetter: () => Promise.resolve(0),
      trimAcked: () => Promise.resolve({ trimmed: 0, minId: '0-0' }),
      // An empty queue: the case where nothing at all happened this tick.
      oldestPendingAgeMs: () => Promise.resolve(null),
    },
    clickhouse: {
      insertEvents: () => Promise.reject(new Error('unused')),
      countBillableByBatch: () => Promise.resolve(new Map()),
      ping: () => Promise.resolve(true),
      close: () => Promise.resolve(),
    },
    cache: null,
    logger,
    metrics: createRecordingMetrics(),
    policy: loadPolicy({}),
    consumerName: 'test-worker',
    streamName: 'event_stream',
    consumerGroup: 'ingest_workers',
  } as unknown as IngestDeps

  return { ...base, ...overrides }
}

/** A clock the test advances by hand, in the loop's own `deps.now()` idiom. */
function clock(startIso: string): { now: () => Date; advance: (ms: number) => void } {
  let ms = Date.parse(startIso)
  return {
    now: () => new Date(ms),
    advance: (delta: number) => {
      ms += delta
    },
  }
}

describe('ingest loop pipeline heartbeat', () => {
  it('writes a heartbeat on a tick where nothing arrived', async () => {
    const { db, writes } = heartbeatDb()
    const time = clock('2026-07-23T00:00:00.000Z')
    const deps = buildDeps({ db, now: time.now })

    await createIngestLoop({ deps, recoveryLimit: 1 }).tick()

    expect(writes).toHaveLength(1)
    expect(writes[0]).toEqual({
      id: 'ingest',
      consumer: 'test-worker',
      lastTickAt: new Date('2026-07-23T00:00:00.000Z'),
      queueOldestAgeMs: 0,
      // The row's own bookkeeping column travels with the tick instant.
      updatedAt: new Date('2026-07-23T00:00:00.000Z'),
    })
  })

  it('carries the queue age the same tick measured', async () => {
    const { db, writes } = heartbeatDb()
    const time = clock('2026-07-23T00:00:00.000Z')
    const deps = buildDeps({
      db,
      now: time.now,
      maintenance: {
        publishDeadLetter: () => Promise.resolve(0),
        trimAcked: () => Promise.resolve({ trimmed: 0, minId: '0-0' }),
        oldestPendingAgeMs: () => Promise.resolve(90_000),
      } as unknown as IngestDeps['maintenance'],
    })

    await createIngestLoop({ deps, recoveryLimit: 1 }).tick()

    expect(writes[0]?.queueOldestAgeMs).toBe(90_000)
  })

  it('throttles: two ticks 1.5s apart write once, and a later one writes again', async () => {
    const { db, writes } = heartbeatDb()
    const time = clock('2026-07-23T00:00:00.000Z')
    const loop = createIngestLoop({ deps: buildDeps({ db, now: time.now }), recoveryLimit: 1 })

    await loop.tick()
    time.advance(1_500)
    await loop.tick()

    // The loop wakes every ~1.5s; the reader compares against ten minutes. One
    // write per five seconds is the whole point of the throttle.
    expect(writes).toHaveLength(1)

    time.advance(5_000)
    await loop.tick()
    expect(writes).toHaveLength(2)
    expect(writes[1]?.lastTickAt).toEqual(new Date('2026-07-23T00:00:06.500Z'))
  })

  it('survives a database that refuses the heartbeat write', async () => {
    const { logger, lines } = createCapturedLogger()
    const { db, writes } = heartbeatDb(() => {
      throw new Error('relation "worker_heartbeats" does not exist')
    })
    const time = clock('2026-07-23T00:00:00.000Z')
    const loop = createIngestLoop({
      deps: buildDeps({ db, logger, now: time.now }),
      recoveryLimit: 1,
    })

    // The tick completes; the failure is a warning and nothing more.
    await expect(loop.tick()).resolves.toBeUndefined()
    expect(writes).toHaveLength(1)
    expect(lines.some((line) => line['msg'] === 'worker_heartbeat_unwritten')).toBe(true)

    // And the failure is not retried on the very next tick either: a database
    // that is refusing writes must not be hammered at the loop's own rate.
    time.advance(1_500)
    await loop.tick()
    expect(writes).toHaveLength(1)
  })
})
