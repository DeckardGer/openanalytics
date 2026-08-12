import { gunzipSync, inflateSync } from 'node:zlib'
import { ApiError, EVENT_LIMITS, SUPPORTED_CONTENT_ENCODINGS } from '@openanalytics/contracts'
import type { Context } from 'hono'

/**
 * Reading an ingest request body (ADR-0008; docs snapshot 02 §7.1 items 1–2).
 *
 * The first thing the collector does, and the first place a hostile client can
 * make it do unbounded work. Three rules, in this order:
 *
 * 1. **The compressed body is checked before it is inflated.** A 64 KiB payload
 *    of zeroes expands to gigabytes; checking only the decoded size would mean
 *    allocating those gigabytes to discover the request was too large.
 * 2. **The decoded body is checked after inflation, against its own limit.** The
 *    contract's real cost is what a payload expands to, not what it arrived as.
 * 3. **Nothing is parsed until both hold.** `JSON.parse` on an attacker-sized
 *    string is the same unbounded work by another route.
 *
 * Both content types carry the same JSON. `sendBeacon` cannot set a content type
 * beyond a small allowlist, and an `application/json` cross-origin POST would
 * preflight every batch, so the collector reads the body as text either way.
 */

/** Ratio past which an inflating payload is refused mid-stream. */
const MAX_DECOMPRESSION_RATIO = EVENT_LIMITS.maxBatchBytes

export type IngestContentEncoding = (typeof SUPPORTED_CONTENT_ENCODINGS)[number]

function normalizeEncoding(header: string | undefined): IngestContentEncoding {
  const value = (header ?? 'identity').trim().toLowerCase()
  if (value === '') return 'identity'
  if ((SUPPORTED_CONTENT_ENCODINGS as readonly string[]).includes(value)) {
    return value as IngestContentEncoding
  }
  throw new ApiError('VALIDATION_FAILED', 'Unsupported Content-Encoding.', {
    details: { reason: 'unsupported_content_encoding', supported: SUPPORTED_CONTENT_ENCODINGS },
  })
}

function decompress(raw: Buffer, encoding: IngestContentEncoding): Buffer {
  try {
    if (encoding === 'gzip') return gunzipSync(raw, { maxOutputLength: MAX_DECOMPRESSION_RATIO })
    if (encoding === 'deflate')
      return inflateSync(raw, { maxOutputLength: MAX_DECOMPRESSION_RATIO })
    return raw
  } catch (error) {
    // `maxOutputLength` makes zlib throw rather than allocate, so a zip bomb is
    // a 413 that cost one buffer instead of an out-of-memory kill.
    const message = error instanceof Error ? error.message : ''
    if (message.includes('maxOutputLength') || message.includes('Buffer')) {
      throw new ApiError('PAYLOAD_TOO_LARGE', 'The decoded body is too large.', {
        details: { reason: 'decoded_body_too_large', limit: EVENT_LIMITS.maxBatchBytes },
      })
    }
    throw new ApiError('VALIDATION_FAILED', 'The body could not be decoded.', {
      details: { reason: 'malformed_content_encoding' },
    })
  }
}

export interface ReadBodyResult {
  readonly json: unknown
  readonly encoding: IngestContentEncoding
  readonly compressedBytes: number
  readonly decodedBytes: number
}

/**
 * Reads, size-checks, decodes and parses an ingest body.
 *
 * Every failure here is a client error with a stable code and no queue effect —
 * docs snapshot 02 §7.2: a request rejected for schema, size or encoding writes
 * nothing, not even partially.
 */
export async function readIngestBody(c: Context): Promise<ReadBodyResult> {
  const encoding = normalizeEncoding(c.req.header('content-encoding'))
  const raw = Buffer.from(await c.req.arrayBuffer())

  if (raw.byteLength === 0) {
    throw new ApiError('VALIDATION_FAILED', 'The request body is empty.', {
      details: { reason: 'empty_body' },
    })
  }

  // Checked before inflation: a compressed payload's cost on the wire is its own
  // limit, and a bomb must be refused without being expanded first.
  const wireLimit =
    encoding === 'identity' ? EVENT_LIMITS.maxBatchBytes : EVENT_LIMITS.maxCompressedBytes
  if (raw.byteLength > wireLimit) {
    throw new ApiError('PAYLOAD_TOO_LARGE', 'The request body is too large.', {
      details: {
        reason: encoding === 'identity' ? 'body_too_large' : 'compressed_body_too_large',
        limit: wireLimit,
      },
    })
  }

  const decoded = decompress(raw, encoding)

  if (decoded.byteLength > EVENT_LIMITS.maxBatchBytes) {
    throw new ApiError('PAYLOAD_TOO_LARGE', 'The decoded body is too large.', {
      details: { reason: 'decoded_body_too_large', limit: EVENT_LIMITS.maxBatchBytes },
    })
  }

  let json: unknown
  try {
    json = JSON.parse(decoded.toString('utf8'))
  } catch {
    throw new ApiError('VALIDATION_FAILED', 'The body is not valid JSON.', {
      details: { reason: 'malformed_json' },
    })
  }

  return {
    json,
    encoding,
    compressedBytes: raw.byteLength,
    decodedBytes: decoded.byteLength,
  }
}
