import { loadPolicy } from '@openanalytics/domain'
import { createRecordingMetrics } from '@openanalytics/observability'
import { createCapturedLogger } from '@openanalytics/testkit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIngestLoop } from '../../apps/worker/src/ingest/index.ts'
import type { IngestDeps } from '../../apps/worker/src/ingest/index.ts'

/**
 * The ingest loop's error path backs off (plan Milestone 6, and the first-deploy
 * finding recorded in ADR-0010).
 *
 * A healthy iteration paces itself on the blocking `XREADGROUP`, so the loop is
 * self-throttling while things work. A *failing* iteration returns immediately —
 * a Postgres blip, or a fresh database with no `ingest_batches` table — and
 * without a delay the loop retries every few milliseconds, buries the log and
 * hammers the failing dependency. That is exactly what happened on the first
 * deploy against an un-migrated Neon database.
 *
 * The failure is injected at the earliest thing `tick()` touches: the manifest
 * recovery reads Postgres first, so a database that throws makes every iteration
 * fail before any queue work is attempted.
 */

/** A `db` whose every use throws, standing in for an unreachable Postgres. */
function throwingDb(): IngestDeps['db'] {
  return {
    select() {
      throw new Error('relation "ingest_batches" does not exist')
    },
  } as unknown as IngestDeps['db']
}

/** A `db` that answers every query with an empty result, for a healthy tick. */
function emptyDb(): IngestDeps['db'] {
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'from', 'where', 'orderBy', 'limit']) {
    chain[method] = () => chain
  }
  chain['then'] = (resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve([]))
  return chain as unknown as IngestDeps['db']
}

function buildDeps(overrides: Partial<IngestDeps>): IngestDeps {
  const { logger } = createCapturedLogger()
  const base = {
    db: throwingDb(),
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
    now: () => new Date('2026-07-23T00:00:00.000Z'),
  } as unknown as IngestDeps

  return { ...base, ...overrides }
}

describe('ingest loop backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('backs off exponentially instead of hot-looping on a persistent failure', async () => {
    const { logger, lines } = createCapturedLogger()
    const policy = loadPolicy({})
    const deps = buildDeps({ logger })

    const loop = createIngestLoop({ deps, recoveryLimit: 1 })
    const running = loop.run()

    const failures = () => lines.filter((line) => line['msg'] === 'ingest_loop_iteration_failed')

    // First iteration fails synchronously and parks in the first backoff.
    await vi.advanceTimersByTimeAsync(0)
    expect(failures()).toHaveLength(1)
    expect(failures()[0]?.['backoff_ms']).toBe(policy.WORKER_RETRY_BASE_MS)
    expect(failures()[0]?.['consecutive_failures']).toBe(1)

    // Each backoff is twice the last, and the failure counter keeps climbing.
    await vi.advanceTimersByTimeAsync(policy.WORKER_RETRY_BASE_MS)
    expect(failures()).toHaveLength(2)
    expect(failures()[1]?.['backoff_ms']).toBe(policy.WORKER_RETRY_BASE_MS * 2)
    expect(failures()[1]?.['consecutive_failures']).toBe(2)

    await vi.advanceTimersByTimeAsync(policy.WORKER_RETRY_BASE_MS * 2)
    expect(failures()).toHaveLength(3)
    expect(failures()[2]?.['backoff_ms']).toBe(policy.WORKER_RETRY_BASE_MS * 4)
    expect(failures()[2]?.['consecutive_failures']).toBe(3)

    // It is genuinely parked, not spinning: no time passing means no new failure.
    await vi.advanceTimersByTimeAsync(0)
    expect(failures()).toHaveLength(3)

    await loop.stop()
    await running
  })

  it('resets the backoff after a healthy iteration', async () => {
    const { logger, lines } = createCapturedLogger()
    const policy = loadPolicy({})

    // Fails twice, then the database recovers.
    let calls = 0
    const deps = buildDeps({
      logger,
      db: {
        select(...args: unknown[]) {
          calls += 1
          if (calls <= 2) throw new Error('temporary failure')
          return emptyDb().select(...(args as [])) as unknown
        },
      } as unknown as IngestDeps['db'],
      // A read that honours its block budget, so a healthy iteration parks on
      // the blocking read for the interval exactly as it would in production
      // rather than spinning — which is the whole reason a healthy loop needs no
      // backoff of its own.
      consumer: {
        ensureGroup: () => Promise.resolve(true),
        read: ({ blockMs }: { blockMs: number }) =>
          new Promise((resolve) => setTimeout(() => resolve([]), blockMs)),
        reclaim: () => Promise.resolve({ nextCursor: '0-0', messages: [], deletedIds: [] }),
        ack: () => Promise.resolve(0),
        pending: () => Promise.resolve({ count: 0, minId: null, maxId: null, consumers: [] }),
        fetchByIds: () => Promise.resolve({ messages: [], missingIds: [] }),
      } as unknown as IngestDeps['consumer'],
    })

    const loop = createIngestLoop({ deps, recoveryLimit: 1 })
    const running = loop.run()

    const failures = () => lines.filter((line) => line['msg'] === 'ingest_loop_iteration_failed')

    await vi.advanceTimersByTimeAsync(0)
    expect(failures()).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(policy.WORKER_RETRY_BASE_MS)
    expect(failures()).toHaveLength(2)
    expect(failures()[1]?.['consecutive_failures']).toBe(2)

    // The third iteration succeeds and the loop parks on the blocking read. No
    // further failures accrue however far time is advanced.
    await vi.advanceTimersByTimeAsync(policy.WORKER_RETRY_BASE_MS * 2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(failures()).toHaveLength(2)

    // Let the pending blocking read fire so the loop notices shutdown and exits.
    const stopping = loop.stop()
    await vi.runAllTimersAsync()
    await stopping
    await running
  })

  it('does not wait out a backoff before shutting down', async () => {
    const { logger, lines } = createCapturedLogger()
    const deps = buildDeps({ logger })

    const loop = createIngestLoop({ deps, recoveryLimit: 1 })
    const running = loop.run()

    // Park in the first backoff (500 ms by default).
    await vi.advanceTimersByTimeAsync(0)
    expect(lines.some((line) => line['msg'] === 'ingest_loop_iteration_failed')).toBe(true)

    // stop() cuts the in-progress sleep short rather than waiting it out; the
    // loop reaches its stopped log without any more time passing.
    const stopped = loop.stop()
    await vi.advanceTimersByTimeAsync(0)
    await stopped
    await running

    expect(lines.some((line) => line['msg'] === 'ingest_loop_stopped')).toBe(true)
  })
})
