import {
  BATCH_ID_VERSION,
  EmptyBatchError,
  INGEST_BATCH_STATES,
  canTransitionIngestBatch,
  decideFlush,
  deriveBatchId,
  derivePayloadHash,
  isTerminalIngestBatchState,
  loadPolicy,
  nextIngestBatchStates,
  recoveryActionFor,
  retryDelayMs,
  retryHorizonBlocks,
  retryHorizonMs,
  type IngestBatchState,
  type Policy,
} from '@openanalytics/domain'
import { schema } from '@openanalytics/postgres'
import { describe, expect, it } from 'vitest'

/**
 * Batch identity, the flush rule and the manifest state machine (docs snapshot
 * 02 §7.5; 05 D-209 step 3, D-216).
 *
 * These are the parts of Milestone 6 that decide correctness before any
 * infrastructure is involved: which messages form a batch, what token they are
 * inserted under, when the batch closes, and what a worker that woke up after a
 * crash is supposed to redo.
 */

const policy = (overrides: Record<string, string> = {}): Policy => loadPolicy(overrides)

const STREAM = { streamName: 'event_stream', consumerGroup: 'ingest_workers' }

describe('deterministic batch id', () => {
  it('is stable for the same stream identity and the same ordered messages', () => {
    const messageIds = ['1721000000000-0', '1721000000000-1', '1721000000001-0']

    expect(deriveBatchId({ ...STREAM, messageIds })).toBe(
      deriveBatchId({ ...STREAM, messageIds: [...messageIds] }),
    )
  })

  it('changes when the order changes', () => {
    // Order is part of the insert: the ClickHouse token only recognises a retry
    // that re-issues the same rows in the same order (02 §7.5).
    const forward = deriveBatchId({ ...STREAM, messageIds: ['1-0', '1-1'] })
    const reversed = deriveBatchId({ ...STREAM, messageIds: ['1-1', '1-0'] })

    expect(forward).not.toBe(reversed)
  })

  it('separates two consumer groups reading the same stream', () => {
    // Two groups are delivered the same message ids. Without the group in the
    // identity they would share a deduplication token and one batch's rows
    // would be silently discarded as a duplicate of the other's.
    const first = deriveBatchId({ ...STREAM, messageIds: ['1-0'] })
    const second = deriveBatchId({ ...STREAM, consumerGroup: 'backfill', messageIds: ['1-0'] })

    expect(first).not.toBe(second)
  })

  it('cannot be confused by a separator inside a component', () => {
    // Length-prefixed hashing: a delimiter-joined derivation would collide here,
    // and a collision means two different batches share one token.
    const first = deriveBatchId({ ...STREAM, messageIds: ['a', 'b'] })
    const second = deriveBatchId({ ...STREAM, messageIds: ['a:b'] })
    const third = deriveBatchId({
      ...STREAM,
      streamName: 'event_stream:ingest_workers',
      messageIds: ['a', 'b'],
    })

    expect(new Set([first, second, third]).size).toBe(3)
  })

  it('carries a version prefix so a future derivation cannot collide with this one', () => {
    expect(deriveBatchId({ ...STREAM, messageIds: ['1-0'] })).toMatch(
      new RegExp(`^${BATCH_ID_VERSION}_[0-9a-f]{64}$`),
    )
  })

  it('refuses an empty batch', () => {
    expect(() => deriveBatchId({ ...STREAM, messageIds: [] })).toThrow(EmptyBatchError)
    expect(() => derivePayloadHash([])).toThrow(EmptyBatchError)
  })

  it('hashes payload content separately from message identity', () => {
    // A payload substituted underneath a reclaim must be detectable, and the
    // message ids alone cannot see it.
    expect(derivePayloadHash(['h1', 'h2'])).not.toBe(derivePayloadHash(['h2', 'h1']))
    expect(derivePayloadHash(['h1', 'h2'])).toBe(derivePayloadHash(['h1', 'h2']))
  })
})

describe('flush rule', () => {
  const base = { rows: 1, bytes: 10, ageMs: 0, shuttingDown: false, policy: policy() }

  it('holds an empty batch, even on shutdown', () => {
    // An insert of no rows still consumes a deduplication token and produces a
    // manifest describing nothing.
    expect(decideFlush({ ...base, rows: 0, shuttingDown: true, ageMs: 10_000 })).toEqual({
      flush: false,
      reason: null,
    })
  })

  it('holds a young, small batch', () => {
    expect(decideFlush(base).flush).toBe(false)
  })

  it('flushes on the row limit', () => {
    expect(decideFlush({ ...base, rows: base.policy.WORKER_BATCH_MAX_ROWS })).toEqual({
      flush: true,
      reason: 'row_limit',
    })
  })

  it('flushes on the byte limit', () => {
    expect(decideFlush({ ...base, bytes: base.policy.WORKER_BATCH_MAX_BYTES })).toEqual({
      flush: true,
      reason: 'byte_limit',
    })
  })

  it('flushes at the maximum age', () => {
    expect(decideFlush({ ...base, ageMs: base.policy.WORKER_BATCH_MAX_FLUSH_MS })).toEqual({
      flush: true,
      reason: 'max_age',
    })
  })

  it('flushes a non-empty batch on shutdown', () => {
    expect(decideFlush({ ...base, shuttingDown: true })).toEqual({
      flush: true,
      reason: 'shutdown',
    })
  })

  it('does not hold a full batch back to the SLO band lower bound', () => {
    // §7.5 says the opposite of a floor: under high traffic a full batch may
    // flush before 0.5 s. A minimum age here would turn the band's lower end
    // into a latency guarantee and cost throughput at exactly the moment the
    // system is busiest.
    const full = { ...base, rows: base.policy.WORKER_BATCH_MAX_ROWS, ageMs: 1 }
    expect(decideFlush(full)).toEqual({ flush: true, reason: 'row_limit' })
  })

  it('reports the size trigger rather than the shutdown when both apply', () => {
    const decision = decideFlush({
      ...base,
      rows: base.policy.WORKER_BATCH_MAX_ROWS,
      shuttingDown: true,
    })
    expect(decision.reason).toBe('row_limit')
  })
})

describe('manifest state machine', () => {
  it('agrees with the vocabulary migration 0015 and the Drizzle mirror declare', () => {
    // packages/postgres deliberately does not import @openanalytics/domain, so
    // the two lists are written twice. This is what stops them drifting.
    expect([...schema.INGEST_BATCH_STATES]).toEqual([...INGEST_BATCH_STATES])
  })

  it('walks the happy path exactly once through each stage', () => {
    const path: IngestBatchState[] = [
      'pending',
      'inserting',
      'inserted',
      'usage_recorded',
      'completed',
    ]
    for (let index = 0; index < path.length - 1; index += 1) {
      expect(
        canTransitionIngestBatch(
          path[index] as IngestBatchState,
          path[index + 1] as IngestBatchState,
        ),
      ).toBe(true)
    }
  })

  it('lets an ambiguous insert retry itself without leaving the state', () => {
    // The ambiguous timeout is the case the stable token exists for: the same
    // manifest is retried with the same token, never a new one.
    expect(canTransitionIngestBatch('inserting', 'inserting')).toBe(true)
    expect(canTransitionIngestBatch('inserting', 'pending')).toBe(true)
  })

  it('never lets a batch skip the ClickHouse insert or the usage ledger', () => {
    expect(canTransitionIngestBatch('pending', 'inserted')).toBe(false)
    expect(canTransitionIngestBatch('pending', 'completed')).toBe(false)
    expect(canTransitionIngestBatch('inserting', 'usage_recorded')).toBe(false)
    expect(canTransitionIngestBatch('inserted', 'completed')).toBe(false)
  })

  it('refuses to dead-letter a batch whose usage already committed', () => {
    // Everything that can permanently fail has already succeeded; the remaining
    // XACK is safe to repeat forever. Dead-lettering here would abandon a batch
    // whose data and usage are both already correct.
    expect(canTransitionIngestBatch('usage_recorded', 'dead_lettered')).toBe(false)
    expect(nextIngestBatchStates('usage_recorded')).toEqual(['completed'])
  })

  it('leaves completed terminal and dead-lettered replayable', () => {
    expect(nextIngestBatchStates('completed')).toEqual([])
    expect(nextIngestBatchStates('dead_lettered')).toEqual(['pending'])
    expect(isTerminalIngestBatchState('completed')).toBe(true)
    expect(isTerminalIngestBatchState('dead_lettered')).toBe(true)
    expect(isTerminalIngestBatchState('inserted')).toBe(false)
  })

  it('never transitions out of completed', () => {
    for (const state of INGEST_BATCH_STATES) {
      expect(canTransitionIngestBatch('completed', state)).toBe(false)
    }
  })
})

describe('crash recovery', () => {
  it('redoes exactly the step that had not finished', () => {
    // The crash matrix in one table. A reclaimer decides from the manifest, not
    // from the messages it happens to hold.
    expect(recoveryActionFor('pending')).toBe('insert')
    expect(recoveryActionFor('inserting')).toBe('insert')
    expect(recoveryActionFor('inserted')).toBe('record_usage')
    expect(recoveryActionFor('usage_recorded')).toBe('ack')
    expect(recoveryActionFor('completed')).toBe('none')
    expect(recoveryActionFor('dead_lettered')).toBe('none')
  })

  it('has an action for every state', () => {
    for (const state of INGEST_BATCH_STATES) {
      expect(recoveryActionFor(state)).toBeTruthy()
    }
  })
})

describe('retry schedule', () => {
  it('backs off exponentially from the base delay', () => {
    const p = policy()
    expect(retryDelayMs(1, p)).toBe(p.WORKER_RETRY_BASE_MS)
    expect(retryDelayMs(2, p)).toBe(p.WORKER_RETRY_BASE_MS * 2)
    expect(retryDelayMs(3, p)).toBe(p.WORKER_RETRY_BASE_MS * 4)
  })

  it('caps at the maximum delay', () => {
    const p = policy()
    expect(retryDelayMs(30, p)).toBe(p.WORKER_RETRY_MAX_MS)
  })

  it('keeps the retry horizon inside the ClickHouse deduplication window', () => {
    // Docs snapshot 02 §7.5. This is the relationship that makes the stable
    // token mean anything: a retry landing outside the window is not
    // deduplicated, it is a duplicate.
    const p = policy()
    expect(retryHorizonMs(p)).toBeGreaterThan(0)
    expect(retryHorizonBlocks(p)).toBeLessThan(p.CLICKHOUSE_DEDUP_WINDOW_BLOCKS)
  })

  it('refuses a configuration whose retries outlive the deduplication window', () => {
    expect(() =>
      loadPolicy({
        WORKER_BATCH_MAX_ATTEMPTS: '20',
        WORKER_RETRY_MAX_MS: '600000',
        CLICKHOUSE_DEDUP_WINDOW_BLOCKS: '10',
      }),
    ).toThrow(/CLICKHOUSE_DEDUP_WINDOW_BLOCKS/)
  })

  it('refuses a claim timeout a live lease would not survive', () => {
    expect(() =>
      loadPolicy({ WORKER_LEASE_TTL_MS: '120000', WORKER_CLAIM_MIN_IDLE_MS: '60000' }),
    ).toThrow(/WORKER_CLAIM_MIN_IDLE_MS/)
  })

  it('refuses an inverted flush band', () => {
    expect(() =>
      loadPolicy({ WORKER_BATCH_MIN_FLUSH_MS: '2000', WORKER_BATCH_MAX_FLUSH_MS: '1500' }),
    ).toThrow(/WORKER_BATCH_MIN_FLUSH_MS/)
  })
})
