import { loadPolicy } from '@openanalytics/domain'
import {
  DAY_IN_SECONDS,
  ENQUEUE_SCRIPT,
  EmptyBatchError,
  EnqueueReplyError,
  InvalidKeyComponentError,
  QueueConnectionError,
  buildConnectionOptions,
  buildEnqueueCall,
  createQueueClient,
  daysToSeconds,
  decodeSiteQueueIndexEntry,
  dedupKey,
  encodeSiteQueueIndexEntry,
  isEnqueueConflict,
  isNoScriptError,
  MalformedSiteQueueIndexEntryError,
  parseEnqueueReply,
  siteQueueIndexKey,
  utcDayOf,
} from '@openanalytics/redis'
import { describe, expect, it } from 'vitest'

const policy = loadPolicy({})

const input = {
  siteId: '018f2a1b-0000-7000-8000-000000000001',
  eventId: '018f2a1b-0000-7000-8000-0000000000ff',
  payloadHash: 'sha256:9f2c',
  payload: '{"t":"pageview"}',
  acceptedAt: '2026-07-21T10:15:00.000Z',
}

/**
 * Everything here is the part of D-209 step 1 that can be wrong without Valkey
 * ever noticing: a key that names the wrong bucket, a TTL that is off by a
 * factor, or a reply read as an acceptance when it was a conflict.
 */
describe('durable queue key naming', () => {
  it('buckets the queue index by the UTC day of accepted_at', () => {
    // Not a string slice of the input: an offset-bearing timestamp belongs to a
    // different day in UTC, and deletion looks in the UTC bucket (D-210).
    expect(utcDayOf('2026-07-21T23:30:00+05:00')).toBe('2026-07-21')
    expect(utcDayOf('2026-07-22T02:30:00+05:00')).toBe('2026-07-21')
    expect(utcDayOf('2026-07-21T23:30:00Z')).toBe('2026-07-21')
  })

  it('rejects an unparseable accepted_at rather than bucketing it as epoch', () => {
    expect(() => utcDayOf('yesterday')).toThrow(RangeError)
  })

  it('uses the key shapes the deletion job and the worker also compute', () => {
    expect(dedupKey('site-1', 'event-1')).toBe('ingest_dedup:site-1:event-1')
    expect(siteQueueIndexKey('site-1', '2026-07-21')).toBe('site_queue_index:site-1:2026-07-21')
  })

  it('packs both ids into a day-bucket entry and reads them back', () => {
    // The bucket has to name the dedup record as well as the stream entry:
    // `ingest_dedup:{site}:{event}` is not derivable from a stream id, and
    // without it M10 deletion could only find those keys by scanning.
    const entry = encodeSiteQueueIndexEntry('1721000000000-0', 'ev-1')
    expect(entry).toBe('1721000000000-0|ev-1')
    expect(decodeSiteQueueIndexEntry(entry)).toEqual({
      streamId: '1721000000000-0',
      eventId: 'ev-1',
    })
  })

  it('refuses a separator-less entry instead of guessing at it', () => {
    // Until 2026-08-06 this decoded to `{streamId: entry, eventId: null}` — the
    // ADR-0021 legacy form, whose branch ADR-0030 follow-up 2 authorised
    // deleting once the 8-day bucket TTL had passed the 2026-07-27 deploy. The
    // permission was taken after reading all 26 production buckets end to end:
    // 3 291 entries, every one carrying the separator.
    //
    // What the shape means changed with the branch. A bare stream id is no
    // longer an old entry but a corrupt one, and it must not decode into a
    // purge that reports success over a bucket it could not read.
    expect(() => decodeSiteQueueIndexEntry('1721000000000-0')).toThrow(
      MalformedSiteQueueIndexEntryError,
    )
    // The stream id itself is in the message, so an operator reading a stuck
    // `deletion_targets` row can find the entry.
    expect(() => decodeSiteQueueIndexEntry('1721000000000-0')).toThrow(/1721000000000-0/)
  })

  it('refuses an identifier that could address another site key', () => {
    // A `:` in a site ID would let one tenant construct another tenant's key.
    expect(() => dedupKey('site:1', 'event-1')).toThrow(InvalidKeyComponentError)
    expect(() => siteQueueIndexKey('', '2026-07-21')).toThrow(InvalidKeyComponentError)
  })

  it('converts whole days to seconds and rejects anything else', () => {
    expect(daysToSeconds(7)).toBe(7 * DAY_IN_SECONDS)
    expect(() => daysToSeconds(0)).toThrow(RangeError)
    expect(() => daysToSeconds(1.5)).toThrow(RangeError)
  })
})

describe('enqueue script invocation', () => {
  it('declares every key it touches: the stream, then a dedup/index pair per event', () => {
    // The pairing is what lets the script address event `i` as KEYS[2i] and
    // KEYS[2i+1]. Building the keys inside Lua instead would hide every key the
    // script writes from the call site and from cluster analysis.
    const call = buildEnqueueCall([input], { policy })

    expect(call.keys).toEqual([
      'event_stream',
      `ingest_dedup:${input.siteId}:${input.eventId}`,
      `site_queue_index:${input.siteId}:2026-07-21`,
    ])
  })

  it('buckets each event by the UTC day of its own accepted_at', () => {
    const second = { ...input, eventId: 'e2', acceptedAt: '2026-07-22T01:00:00.000Z' }
    const call = buildEnqueueCall([input, second], { policy })

    expect(call.keys).toEqual([
      'event_stream',
      `ingest_dedup:${input.siteId}:${input.eventId}`,
      `site_queue_index:${input.siteId}:2026-07-21`,
      `ingest_dedup:${input.siteId}:e2`,
      `site_queue_index:${input.siteId}:2026-07-22`,
    ])
  })

  it('takes both TTLs from policy rather than from a literal', () => {
    // AGENTS.md: a policy value is never restated as a bare number in an
    // adapter. D-209 pairs a 7-day dedup window with an 8-day index window.
    const call = buildEnqueueCall([input], { policy })

    expect(call.argv).toEqual([
      '1',
      String(7 * DAY_IN_SECONDS),
      String(8 * DAY_IN_SECONDS),
      input.siteId,
      input.eventId,
      input.payloadHash,
      input.payload,
      input.acceptedAt,
    ])

    const longer = buildEnqueueCall([input], {
      policy: { INGEST_DEDUP_TTL_DAYS: 14, SITE_QUEUE_INDEX_TTL_DAYS: 15 },
    })
    expect(longer.argv[1]).toBe(String(14 * DAY_IN_SECONDS))
    expect(longer.argv[2]).toBe(String(15 * DAY_IN_SECONDS))
  })

  it('refuses an empty batch rather than issuing a no-op EVAL', () => {
    expect(() => buildEnqueueCall([], { policy })).toThrow(EmptyBatchError)
  })

  it('does the dedup check and the XADD in one script', () => {
    // The atomicity claim in D-209 rests on there being a single round trip.
    // A second EVAL, or an XADD issued from TypeScript, reopens the window two
    // concurrent retries race through.
    expect(ENQUEUE_SCRIPT).toContain("redis.call('HMGET', dedup_key")
    expect(ENQUEUE_SCRIPT).toContain("'XADD', stream_key, '*'")
    expect(ENQUEUE_SCRIPT).toContain("redis.call('EXPIRE', dedup_key, dedup_ttl_seconds)")
    expect(ENQUEUE_SCRIPT).toContain("redis.call('RPUSH', index_key, stream_id .. '|' .. event_id)")
    // Refreshed on every append, not only when the bucket opens: the bucket must
    // outlive every dedup record it names, and a record written late in the day
    // carries a fresh full-length TTL of its own.
    expect(ENQUEUE_SCRIPT).toContain("redis.call('EXPIRE', index_key, index_ttl_seconds)")
    expect(ENQUEUE_SCRIPT).not.toContain("redis.call('TTL', index_key)")
  })

  it('reads every dedup record before it writes any of them', () => {
    // Docs snapshot 02 7.3: one conflict rejects the whole request and nothing
    // from it may already be enqueued. A single loop that checked and appended
    // per event would answer 409 having stored everything before the conflict.
    const conflictReturn = ENQUEUE_SCRIPT.indexOf("return { 'idempotency_conflict'")
    const firstWrite = ENQUEUE_SCRIPT.indexOf("'XADD', stream_key")

    expect(conflictReturn).toBeGreaterThan(-1)
    expect(firstWrite).toBeGreaterThan(conflictReturn)
  })
})

describe('enqueue reply parsing', () => {
  const accepted = (reply: unknown, expected: number) => {
    const parsed = parseEnqueueReply(reply, expected)
    if (parsed.outcome !== 'accepted') expect.unreachable('expected an accepted batch')
    return parsed.results
  }

  it('reads a first acceptance', () => {
    const results = accepted(['ok', 'enqueued', '1753092900000-0', input.acceptedAt], 1)

    expect(results[0]).toEqual({
      outcome: 'enqueued',
      enqueued: true,
      streamId: '1753092900000-0',
      firstAcceptedAt: input.acceptedAt,
    })
  })

  it('reports a same-hash retry as accepted but not newly enqueued', () => {
    // Only `enqueued` may increment usage; a retry counted again is the
    // double-billing D-209 exists to prevent.
    const results = accepted(['ok', 'duplicate', '1753092900000-0', '2026-07-21T10:15:00.000Z'], 1)
    const first = results[0]

    expect(first?.outcome).toBe('duplicate')
    expect(first?.enqueued).toBe(false)
    expect(first ? isEnqueueConflict(first) : true).toBe(false)
    expect(first?.firstAcceptedAt).toBe('2026-07-21T10:15:00.000Z')
  })

  it('reads a mixed batch position by position', () => {
    const results = accepted(
      ['ok', 'enqueued', '1-0', input.acceptedAt, 'duplicate', '0-1', '2026-07-20T00:00:00.000Z'],
      2,
    )

    expect(results.map((result) => result.outcome)).toEqual(['enqueued', 'duplicate'])
    // The duplicate keeps the *original* acceptance time, not this request's.
    expect(results[1]?.firstAcceptedAt).toBe('2026-07-20T00:00:00.000Z')
  })

  it('surfaces a different-hash reuse as a conflict for the whole batch', () => {
    // Not a per-event outcome: 7.3 makes the conflict a property of the
    // request. A per-event shape would let a caller enqueue the events before it.
    const parsed = parseEnqueueReply(
      ['idempotency_conflict', '2', '1753092900000-0', '2026-07-21T10:15:00.000Z'],
      3,
    )

    if (parsed.outcome !== 'idempotency_conflict') expect.unreachable('expected a conflict')
    // Lua counts from one; the caller counts from zero.
    expect(parsed.index).toBe(1)
    expect(parsed.conflictingStreamId).toBe('1753092900000-0')
    expect(parsed.firstAcceptedAt).toBe('2026-07-21T10:15:00.000Z')
  })

  it('decodes a buffer reply from a binary-mode client', () => {
    const results = accepted(
      [
        Buffer.from('ok'),
        Buffer.from('enqueued'),
        Buffer.from('1-0'),
        Buffer.from(input.acceptedAt),
      ],
      1,
    )

    expect(results[0]?.outcome).toBe('enqueued')
  })

  it('throws on a reply it does not recognise instead of assuming acceptance', () => {
    // An unknown reply means the deployed script is not this build's script.
    // Guessing "accepted" would answer 202 for an event nobody stored.
    expect(() => parseEnqueueReply(['ok', 'weird', '1-0', 'now'], 1)).toThrow(EnqueueReplyError)
    expect(() => parseEnqueueReply(['ok', 'enqueued', '1-0'], 1)).toThrow(EnqueueReplyError)
    expect(() => parseEnqueueReply(null, 1)).toThrow(EnqueueReplyError)
    expect(() => parseEnqueueReply(['ok', 'enqueued', 1, 'now'], 1)).toThrow(EnqueueReplyError)
  })

  it('refuses a reply reporting fewer results than the batch had events', () => {
    // A short reply means some event has no outcome at all. There is no safe way
    // to guess which, and guessing "enqueued" answers 202 for an event nobody
    // stored.
    expect(() => parseEnqueueReply(['ok', 'enqueued', '1-0', input.acceptedAt], 2)).toThrow(
      EnqueueReplyError,
    )
  })

  it('treats only NOSCRIPT as a reason to resend the script body', () => {
    expect(isNoScriptError(new Error('NOSCRIPT No matching script'))).toBe(true)
    expect(isNoScriptError(new Error('READONLY You cannot write'))).toBe(false)
    expect(isNoScriptError('NOSCRIPT')).toBe(false)
  })
})

describe('queue connection modes (D-206)', () => {
  it('requires TLS and AUTH on the collector hop', () => {
    // The collector reaches the queue over the public internet because Vercel
    // cannot enter the private network (D-208).
    expect(() =>
      buildConnectionOptions({ mode: 'collector', url: 'redis://queue.example.com:6379' }),
    ).toThrow(QueueConnectionError)

    expect(() =>
      buildConnectionOptions({ mode: 'collector', url: 'rediss://queue.example.com:6379' }),
    ).toThrow(QueueConnectionError)

    const options = buildConnectionOptions({
      mode: 'collector',
      url: 'rediss://default:secret@queue.example.com:6379',
    })
    expect(options.tls).toEqual({ servername: 'queue.example.com' })
  })

  it('allows plaintext to loopback/private destinations, still requiring AUTH (ADR-0015)', () => {
    // The colocated deployment dials the queue on the same host: D-206's rule
    // is about the wire, and 127.0.0.1/10.x never touch the public wire.
    for (const host of ['127.0.0.1', 'localhost', '10.0.0.3', '192.168.1.9', '172.16.0.2']) {
      const options = buildConnectionOptions({
        mode: 'collector',
        url: `redis://default:secret@${host}:6379`,
      })
      expect(options.tls).toBeUndefined()
    }

    // A password-less loopback URL is still refused: the credential is what
    // keeps a neighbouring container from becoming a queue writer.
    expect(() =>
      buildConnectionOptions({ mode: 'collector', url: 'redis://127.0.0.1:6379' }),
    ).toThrow(QueueConnectionError)

    // A public-looking name without TLS is still refused.
    expect(() =>
      buildConnectionOptions({ mode: 'collector', url: 'redis://default:s@172.32.0.1:6379' }),
    ).toThrow(QueueConnectionError)
  })

  it('pins SNI so the public endpoint is verified against its own name', () => {
    const options = buildConnectionOptions({
      mode: 'collector',
      url: 'rediss://default:secret@queue.example.com:6379',
      connectionName: 'collector-1',
    })

    expect(options.connectionName).toBe('collector-1')
    expect(options.family).toBeUndefined()
  })

  it('connects the worker natively over 6PN, asking for IPv6', () => {
    // Fly `.internal` names publish AAAA records only; ioredis defaults to IPv4
    // and would fail to resolve a name that is in fact resolvable.
    const options = buildConnectionOptions({
      mode: 'worker',
      url: 'redis://openanalytics-queue.internal:6379',
    })

    expect(options.family).toBe(6)
    expect(options.tls).toBeUndefined()
    // A blocking XREADGROUP must survive a reconnect rather than be failed by a
    // finite per-request retry budget.
    expect(options.maxRetriesPerRequest).toBeNull()
  })

  it('never puts a command timeout on a connection unless asked', () => {
    // A blocking read legitimately waits; an invented timeout would abort it.
    const worker = buildConnectionOptions({ mode: 'worker', url: 'redis://localhost:6379' })
    expect(worker.commandTimeout).toBeUndefined()

    const collector = buildConnectionOptions({
      mode: 'collector',
      url: 'rediss://default:secret@queue.example.com:6379',
      commandTimeoutMs: 1_500,
    })
    expect(collector.commandTimeout).toBe(1_500)
  })

  it('rejects a URL that is not a redis URL at all', () => {
    expect(() =>
      buildConnectionOptions({ mode: 'worker', url: 'https://queue.example.com' }),
    ).toThrow(QueueConnectionError)
    expect(() => buildConnectionOptions({ mode: 'worker', url: 'not a url' })).toThrow(
      QueueConnectionError,
    )
  })
})

describe('socket errors never kill the process', () => {
  /**
   * An `EventEmitter` that emits `error` with no listener throws, and for a
   * socket error that means the whole process dies. That is the opposite of
   * every failure rule the collector has: an unreachable queue is a `503` and a
   * degradation metric (docs snapshot 02 §7.2), not a crash — and a worker whose
   * queue blipped should keep serving `/health` while ioredis reconnects.
   *
   * This was not hypothetical: it presented as a CI flake where a service's
   * health endpoint never became reachable and an unhandled ioredis
   * AggregateError was the only clue.
   */
  it('attaches an error listener whether or not the caller supplies a handler', () => {
    const silent = createQueueClient({
      mode: 'worker',
      url: 'redis://127.0.0.1:1',
      lazyConnect: true,
    })
    try {
      expect(silent.listenerCount('error')).toBeGreaterThan(0)
      // Would throw if the listener were missing.
      expect(() => silent.emit('error', new Error('ECONNREFUSED'))).not.toThrow()
    } finally {
      silent.disconnect()
    }
  })

  it('hands the error to the caller’s hook when there is one', () => {
    const seen: string[] = []
    const client = createQueueClient({
      mode: 'worker',
      url: 'redis://127.0.0.1:1',
      lazyConnect: true,
      onError: (error) => seen.push(error.message),
    })
    try {
      client.emit('error', new Error('connect ETIMEDOUT'))
      expect(seen).toEqual(['connect ETIMEDOUT'])
    } finally {
      client.disconnect()
    }
  })
})
