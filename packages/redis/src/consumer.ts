import type { Redis } from 'ioredis'
import { EVENT_STREAM_GROUP, EVENT_STREAM_KEY } from './keys.ts'
import type {
  EventStreamConsumer,
  FetchByIdResult,
  PendingSummary,
  ReclaimResult,
  StreamMessage,
} from './queue.ts'

/**
 * Worker side of the durable queue (docs snapshot 05, D-206 and D-209 step 6).
 *
 * A consumer group, not a plain `XREAD`, because delivery has to survive the
 * consumer: an entry stays in the pending list until it is `XACK`ed, and the ack
 * only happens after ClickHouse and the usage ledger have committed. A worker
 * that dies mid-batch therefore leaves its messages claimable rather than
 * consumed, which is what makes the pipeline at-least-once end to end.
 */

/** Field names the enqueue script writes; the worker's contract with it. */
type EntryField = 'site_id' | 'event_id' | 'payload_hash' | 'accepted_at' | 'payload'

export class StreamMessageParseError extends Error {
  readonly messageId: string

  constructor(messageId: string, detail: string) {
    super(`Malformed stream entry ${messageId}: ${detail}`)
    this.name = 'StreamMessageParseError'
    this.messageId = messageId
  }
}

function toText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value instanceof Buffer) return value.toString('utf8')
  return null
}

function toCount(value: unknown): number {
  if (typeof value === 'number') return value
  const text = toText(value)
  const parsed = text === null ? Number.NaN : Number(text)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Parses the `[id, [field, value, …]]` pairs shared by `XREADGROUP`,
 * `XAUTOCLAIM` and `XCLAIM`.
 *
 * Throws on a malformed entry instead of skipping it. A silently dropped entry
 * is an event that was acknowledged as accepted and then never stored — the
 * legacy failure the whole durable path exists to rule out (docs snapshot 01
 * §4.3).
 */
export function parseStreamEntries(raw: unknown): StreamMessage[] {
  if (raw === null || raw === undefined) return []
  if (!Array.isArray(raw)) throw new StreamMessageParseError('(unknown)', 'expected an array')

  return raw.map((entry) => {
    if (!Array.isArray(entry) || entry.length < 2) {
      throw new StreamMessageParseError('(unknown)', 'expected an [id, fields] pair')
    }

    const id = toText(entry[0])
    if (id === null) throw new StreamMessageParseError('(unknown)', 'entry ID is not a string')

    const rawFields = entry[1]
    if (!Array.isArray(rawFields) || rawFields.length % 2 !== 0) {
      throw new StreamMessageParseError(id, 'field list is not an even-length array')
    }

    const fields = new Map<string, string>()
    for (let index = 0; index < rawFields.length; index += 2) {
      const name = toText(rawFields[index])
      const value = toText(rawFields[index + 1])
      if (name === null || value === null) {
        throw new StreamMessageParseError(id, 'field name or value is not a string')
      }
      fields.set(name, value)
    }

    const required = (name: EntryField): string => {
      const value = fields.get(name)
      if (value === undefined) throw new StreamMessageParseError(id, `missing field "${name}"`)
      return value
    }

    return {
      id,
      siteId: required('site_id'),
      eventId: required('event_id'),
      payloadHash: required('payload_hash'),
      acceptedAt: required('accepted_at'),
      payload: required('payload'),
    }
  })
}

/**
 * `XREADGROUP` answers `[[stream, entries], …]`, or nil when `BLOCK` expired
 * with nothing to deliver. An idle poll is normal, not an error.
 */
export function parseReadGroupReply(raw: unknown): StreamMessage[] {
  if (raw === null || raw === undefined) return []
  if (!Array.isArray(raw)) throw new StreamMessageParseError('(unknown)', 'expected an array')

  return raw.flatMap((stream) => {
    if (!Array.isArray(stream) || stream.length < 2) {
      throw new StreamMessageParseError('(unknown)', 'expected a [stream, entries] pair')
    }
    return parseStreamEntries(stream[1])
  })
}

/**
 * `XAUTOCLAIM` answers `[cursor, entries, deleted]`. The third element exists
 * from Redis 7 onward and lists pending IDs whose stream entry is already gone;
 * the server drops them from the PEL, so the worker must not wait for them.
 */
export function parseAutoClaimReply(raw: unknown): ReclaimResult {
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new StreamMessageParseError('(unknown)', 'expected an XAUTOCLAIM reply')
  }

  const nextCursor = toText(raw[0])
  if (nextCursor === null) {
    throw new StreamMessageParseError('(unknown)', 'XAUTOCLAIM cursor is not a string')
  }

  const deletedIds = Array.isArray(raw[2])
    ? raw[2].map((id) => toText(id)).filter((id): id is string => id !== null)
    : []

  return { nextCursor, messages: parseStreamEntries(raw[1]), deletedIds }
}

/** Summary form of `XPENDING`: `[count, minId, maxId, [[consumer, count], …]]`. */
export function parsePendingSummary(raw: unknown): PendingSummary {
  if (!Array.isArray(raw) || raw.length < 4) {
    throw new StreamMessageParseError('(unknown)', 'expected an XPENDING summary reply')
  }

  const consumers = Array.isArray(raw[3])
    ? raw[3].flatMap((entry) => {
        if (!Array.isArray(entry) || entry.length < 2) return []
        const name = toText(entry[0])
        return name === null ? [] : [{ name, count: toCount(entry[1]) }]
      })
    : []

  return {
    count: toCount(raw[0]),
    minId: toText(raw[1]),
    maxId: toText(raw[2]),
    consumers,
  }
}

/** `XGROUP CREATE` on an existing group is a `BUSYGROUP` error, not a failure. */
export function isBusyGroupError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('BUSYGROUP')
}

export interface EventStreamConsumerOptions {
  readonly client: Redis
  /** Must be stable per process; it is the identity the pending list records. */
  readonly consumerName: string
  readonly streamKey?: string
  readonly groupName?: string
}

export function createEventStreamConsumer(
  options: EventStreamConsumerOptions,
): EventStreamConsumer {
  const { client, consumerName } = options
  const streamKey = options.streamKey ?? EVENT_STREAM_KEY
  const groupName = options.groupName ?? EVENT_STREAM_GROUP

  return {
    async ensureGroup(): Promise<boolean> {
      try {
        // `0`, not `$`: the group must own everything already in the stream.
        // Starting at `$` would abandon every entry the collector enqueued
        // before the first worker booted — accepted events, silently never
        // delivered. MKSTREAM covers the first-boot case where no XADD has run.
        await client.xgroup('CREATE', streamKey, groupName, '0', 'MKSTREAM')
        return true
      } catch (error) {
        if (isBusyGroupError(error)) return false
        throw error
      }
    },

    async read(readOptions): Promise<readonly StreamMessage[]> {
      // `>` delivers only entries never handed to any consumer. Anything already
      // delivered belongs to `reclaim`, which is the only path that may take a
      // message away from a consumer that might still be working on it.
      const reply = await client.call(
        'XREADGROUP',
        'GROUP',
        groupName,
        consumerName,
        'COUNT',
        String(readOptions.count),
        'BLOCK',
        String(readOptions.blockMs),
        'STREAMS',
        streamKey,
        '>',
      )
      return parseReadGroupReply(reply)
    },

    async ack(ids: readonly string[]): Promise<number> {
      if (ids.length === 0) return 0
      return await client.xack(streamKey, groupName, ...ids)
    },

    async reclaim(reclaimOptions): Promise<ReclaimResult> {
      // `minIdleMs` is the whole safety argument: it must exceed the longest
      // legitimate time a worker holds a batch, or a healthy worker's messages
      // get stolen mid-flight and processed twice. Idempotency downstream makes
      // that survivable (D-209 steps 3-5), but it is still wasted work.
      const reply = await client.call(
        'XAUTOCLAIM',
        streamKey,
        groupName,
        consumerName,
        String(reclaimOptions.minIdleMs),
        reclaimOptions.cursor ?? '0-0',
        'COUNT',
        String(reclaimOptions.count),
      )
      return parseAutoClaimReply(reply)
    },

    async pending(): Promise<PendingSummary> {
      return parsePendingSummary(await client.call('XPENDING', streamKey, groupName))
    },

    async fetchByIds(ids: readonly string[]): Promise<FetchByIdResult> {
      if (ids.length === 0) return { messages: [], missingIds: [] }

      // One `XRANGE id id` per entry rather than a single span: the ids a
      // manifest names are not contiguous, and a span would read — and hold in
      // memory — every unrelated entry between the first and the last.
      const pipeline = client.pipeline()
      for (const id of ids) pipeline.call('XRANGE', streamKey, id, id)
      const replies = await pipeline.exec()

      const messages: StreamMessage[] = []
      const missingIds: string[] = []

      ids.forEach((id, index) => {
        const entry = replies?.[index]
        if (!entry) {
          missingIds.push(id)
          return
        }
        const [error, reply] = entry
        if (error) throw error

        const parsed = parseStreamEntries(reply)
        // An `XDEL`ed entry answers as an empty range, not as an error. That is
        // the deletion case (D-210) and it is reported rather than skipped, so
        // the caller can drop it with an audit trail instead of waiting for a
        // payload that will never arrive.
        if (parsed.length === 0) missingIds.push(id)
        else messages.push(...parsed)
      })

      return { messages, missingIds }
    },
  }
}
