import { randomUUID } from 'node:crypto'

/**
 * Request and trace identifiers.
 *
 * Docs snapshot 02 §18: every response carries a request ID, and 02 §26 requires
 * request/trace correlation on every log line.
 */

const REQUEST_ID_PREFIX = 'req_'
const TRACE_ID_PREFIX = 'trc_'

/** Accepts only IDs this system minted; client-supplied values are not trusted verbatim. */
const OWN_ID_PATTERN = /^(req|trc)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** W3C `traceparent`: version-traceid-parentid-flags. */
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/

export function newRequestId(): string {
  return `${REQUEST_ID_PREFIX}${randomUUID()}`
}

export function newTraceId(): string {
  return `${TRACE_ID_PREFIX}${randomUUID()}`
}

export function isOwnId(value: string): boolean {
  return OWN_ID_PATTERN.test(value)
}

/**
 * Extracts the trace ID from a W3C `traceparent` header.
 *
 * An inbound header is only honoured when it is well-formed; a malformed or
 * hostile value must not become log cardinality or a spoofed correlation key.
 */
export function traceIdFromTraceparent(header: string | null | undefined): string | null {
  if (!header) return null
  const match = TRACEPARENT_PATTERN.exec(header.trim())
  if (!match) return null
  const traceId = match[1]
  if (traceId === undefined) return null
  // An all-zero trace ID is explicitly invalid per the W3C spec.
  if (/^0{32}$/.test(traceId)) return null
  return traceId
}
