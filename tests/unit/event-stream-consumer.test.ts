import {
  StreamMessageParseError,
  isBusyGroupError,
  parseAutoClaimReply,
  parsePendingSummary,
  parseReadGroupReply,
  parseStreamEntries,
} from '@openanalytics/redis'
import { describe, expect, it } from 'vitest'

const fields = [
  'site_id',
  '018f2a1b-0000-7000-8000-000000000001',
  'event_id',
  '018f2a1b-0000-7000-8000-0000000000ff',
  'payload_hash',
  'sha256:9f2c',
  'accepted_at',
  '2026-07-21T10:15:00.000Z',
  'payload',
  '{"t":"pageview"}',
]

/**
 * The worker's read path is where an at-least-once guarantee is easiest to lose
 * quietly: a reply mis-shaped by one element parses into an empty batch, and an
 * empty batch is indistinguishable from an idle queue.
 */
describe('stream entry parsing', () => {
  it('reads an entry into the fields the manifest is keyed on', () => {
    const [message] = parseStreamEntries([['1753092900000-0', fields]])

    expect(message).toEqual({
      id: '1753092900000-0',
      siteId: '018f2a1b-0000-7000-8000-000000000001',
      eventId: '018f2a1b-0000-7000-8000-0000000000ff',
      payloadHash: 'sha256:9f2c',
      acceptedAt: '2026-07-21T10:15:00.000Z',
      payload: '{"t":"pageview"}',
    })
  })

  it('accepts buffer field names and values', () => {
    const [message] = parseStreamEntries([
      [Buffer.from('1-0'), fields.map((value) => Buffer.from(value))],
    ])

    expect(message?.id).toBe('1-0')
    expect(message?.payload).toBe('{"t":"pageview"}')
  })

  it('throws on a malformed entry rather than dropping it from the batch', () => {
    // A silently skipped entry is an event that was answered 202 and then never
    // stored — docs snapshot 01 §4.3, the defect the durable path rules out.
    expect(() => parseStreamEntries([['1-0', fields.slice(0, 8)]])).toThrow(StreamMessageParseError)
    expect(() => parseStreamEntries([['1-0', fields.slice(0, 9)]])).toThrow(StreamMessageParseError)
    expect(() => parseStreamEntries([['1-0']])).toThrow(StreamMessageParseError)

    try {
      parseStreamEntries([['1753092900000-0', fields.slice(0, 8)]])
      expect.unreachable('expected a parse error')
    } catch (error) {
      expect(error).toBeInstanceOf(StreamMessageParseError)
      expect((error as StreamMessageParseError).messageId).toBe('1753092900000-0')
    }
  })
})

describe('XREADGROUP reply parsing', () => {
  it('flattens the per-stream grouping', () => {
    const messages = parseReadGroupReply([
      [
        'event_stream',
        [
          ['1-0', fields],
          ['2-0', fields],
        ],
      ],
    ])

    expect(messages.map((message) => message.id)).toEqual(['1-0', '2-0'])
  })

  it('treats a nil reply as an idle poll, not an error', () => {
    // BLOCK expiring with nothing to deliver is the normal steady state.
    expect(parseReadGroupReply(null)).toEqual([])
    expect(parseReadGroupReply(undefined)).toEqual([])
  })
})

describe('XAUTOCLAIM reply parsing', () => {
  it('returns the cursor so the reclaimer keeps walking the pending list', () => {
    // One call does not necessarily drain the PEL; `0-0` is the only signal that
    // the walk is complete.
    const result = parseAutoClaimReply(['5-0', [['1-0', fields]], ['9-0']])

    expect(result.nextCursor).toBe('5-0')
    expect(result.messages.map((message) => message.id)).toEqual(['1-0'])
    expect(result.deletedIds).toEqual(['9-0'])
  })

  it('tolerates a server that omits the deleted-ID list', () => {
    const result = parseAutoClaimReply(['0-0', []])

    expect(result.nextCursor).toBe('0-0')
    expect(result.messages).toEqual([])
    expect(result.deletedIds).toEqual([])
  })

  it('throws on a reply that is not an XAUTOCLAIM shape', () => {
    expect(() => parseAutoClaimReply(['0-0'])).toThrow(StreamMessageParseError)
    expect(() => parseAutoClaimReply(null)).toThrow(StreamMessageParseError)
  })
})

describe('XPENDING summary parsing', () => {
  it('reports the backlog and who is holding it', () => {
    const summary = parsePendingSummary([
      3,
      '1-0',
      '3-0',
      [
        ['worker-a', '2'],
        ['worker-b', '1'],
      ],
    ])

    expect(summary).toEqual({
      count: 3,
      minId: '1-0',
      maxId: '3-0',
      consumers: [
        { name: 'worker-a', count: 2 },
        { name: 'worker-b', count: 1 },
      ],
    })
  })

  it('reads an empty pending list without inventing a consumer', () => {
    expect(parsePendingSummary([0, null, null, null])).toEqual({
      count: 0,
      minId: null,
      maxId: null,
      consumers: [],
    })
  })
})

describe('consumer group creation', () => {
  it('treats BUSYGROUP as "already exists", not as a failure', () => {
    // Group creation runs on every worker boot; only the first one creates it.
    expect(isBusyGroupError(new Error('BUSYGROUP Consumer Group name already exists'))).toBe(true)
    expect(isBusyGroupError(new Error('NOGROUP No such key'))).toBe(false)
    expect(isBusyGroupError('BUSYGROUP')).toBe(false)
  })
})
