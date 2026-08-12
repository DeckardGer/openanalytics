import {
  createQueueMaintenance,
  lastDeliveredIdFor,
  type QueueMaintenanceOptions,
} from '@openanalytics/redis'
import { describe, expect, it } from 'vitest'

type ClientStub = QueueMaintenanceOptions['client']

const NOW = new Date('2026-07-27T09:00:00.000Z')

/** An XPENDING summary reply: [count, minId, maxId, consumers]. */
function pendingReply(minId: string | null): unknown {
  return minId === null ? [0, null, null, null] : [1, minId, minId, [['worker-1', '1']]]
}

/** An XINFO GROUPS reply with a single group at the given delivery cursor. */
function groupsReply(lastDeliveredId: string): unknown {
  return [
    ['name', 'ingest_workers', 'consumers', 1, 'pending', 0, 'last-delivered-id', lastDeliveredId],
  ]
}

/**
 * A client stub that answers the three commands `oldestPendingAgeMs` may issue
 * and records the XRANGE start bound it was asked for.
 */
function stubClient(replies: { pending: unknown; groups?: unknown; range?: unknown }): {
  client: ClientStub
  calls: string[][]
} {
  const calls: string[][] = []
  const client = {
    call: (...args: unknown[]) => {
      const command = args.map(String)
      calls.push(command)
      if (command[0] === 'XPENDING') return Promise.resolve(replies.pending)
      if (command[0] === 'XINFO') return Promise.resolve(replies.groups ?? null)
      if (command[0] === 'XRANGE') return Promise.resolve(replies.range ?? null)
      return Promise.reject(new Error(`unexpected command ${command[0]}`))
    },
  } as unknown as ClientStub
  return { client, calls }
}

/**
 * The G-006 gauge must distinguish work that is *waiting* from work that is
 * merely *retained*. ACKed entries stay in the stream for the D-216 replay
 * window, so "oldest stream entry" is days old on a perfectly healthy queue —
 * the miscount that kept the queue-age alert firing on a drained pipeline.
 */
describe('oldestPendingAgeMs', () => {
  it('measures from the oldest pending entry when the PEL is not empty', async () => {
    const { client, calls } = stubClient({
      pending: pendingReply(`${NOW.getTime() - 30_000}-0`),
    })
    const maintenance = createQueueMaintenance({ client })

    expect(await maintenance.oldestPendingAgeMs(NOW)).toBe(30_000)
    // The stream itself is never consulted; pending age is authoritative.
    expect(calls.map((c) => c[0])).toEqual(['XPENDING'])
  })

  it('reports null on a drained queue even when ACKed entries are retained', async () => {
    const lastDelivered = `${NOW.getTime() - 60_000}-0`
    const { client, calls } = stubClient({
      pending: pendingReply(null),
      groups: groupsReply(lastDelivered),
      // Nothing past the delivery cursor: the days-old ACKed entries below it
      // must not be offered by the stub, because the query must exclude them.
      range: [],
    })
    const maintenance = createQueueMaintenance({ client })

    expect(await maintenance.oldestPendingAgeMs(NOW)).toBeNull()
    const range = calls.find((c) => c[0] === 'XRANGE')
    expect(range?.[2]).toBe(`(${lastDelivered}`)
  })

  it('measures from the first undelivered entry when the worker has stopped reading', async () => {
    const lastDelivered = `${NOW.getTime() - 600_000}-0`
    const undelivered = `${NOW.getTime() - 300_000}-0`
    const { client } = stubClient({
      pending: pendingReply(null),
      groups: groupsReply(lastDelivered),
      range: [[undelivered, ['payload', '{}']]],
    })
    const maintenance = createQueueMaintenance({ client })

    expect(await maintenance.oldestPendingAgeMs(NOW)).toBe(300_000)
  })

  it('treats the whole stream as undelivered when the group cannot be found', async () => {
    const oldest = `${NOW.getTime() - 120_000}-0`
    const { client, calls } = stubClient({
      pending: pendingReply(null),
      groups: [],
      range: [[oldest, ['payload', '{}']]],
    })
    const maintenance = createQueueMaintenance({ client })

    expect(await maintenance.oldestPendingAgeMs(NOW)).toBe(120_000)
    const range = calls.find((c) => c[0] === 'XRANGE')
    expect(range?.[2]).toBe('-')
  })

  it('reports null on an empty stream', async () => {
    const { client } = stubClient({
      pending: pendingReply(null),
      groups: groupsReply('0-0'),
      range: [],
    })
    const maintenance = createQueueMaintenance({ client })

    expect(await maintenance.oldestPendingAgeMs(NOW)).toBeNull()
  })
})

describe('lastDeliveredIdFor', () => {
  it('finds the named group in an XINFO GROUPS reply', () => {
    const reply = [
      ['name', 'other_group', 'last-delivered-id', '1-1'],
      ['name', 'ingest_workers', 'last-delivered-id', '2-2'],
    ]
    expect(lastDeliveredIdFor(reply, 'ingest_workers')).toBe('2-2')
  })

  it('reads Buffer field names and values', () => {
    const reply = [
      [
        Buffer.from('name'),
        Buffer.from('ingest_workers'),
        Buffer.from('last-delivered-id'),
        Buffer.from('3-0'),
      ],
    ]
    expect(lastDeliveredIdFor(reply, 'ingest_workers')).toBe('3-0')
  })

  it('answers null for a missing group or a malformed reply', () => {
    expect(lastDeliveredIdFor([], 'ingest_workers')).toBeNull()
    expect(lastDeliveredIdFor(null, 'ingest_workers')).toBeNull()
    expect(lastDeliveredIdFor('OK', 'ingest_workers')).toBeNull()
  })
})
