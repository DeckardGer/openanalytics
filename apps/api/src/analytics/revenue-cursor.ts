/**
 * The revenue transactions cursor (docs snapshot 03 §6.4; ADR-0033, D7).
 * Milestone 12 Checkpoint 5.
 *
 * `packages/contracts/src/pagination.ts` has defined `{ items, next_cursor,
 * has_more }` and the over-fetch-by-one rule since M0 and has had **zero call
 * sites** until this endpoint. This module is the missing half: the encoding of
 * the keyset itself.
 *
 * ## What is in it, and what it therefore is not
 *
 * The keyset is `(occurred_at, object_id)` descending — the same tie-break every
 * ordered read here uses, because `occurred_at` alone is not unique (a backfill
 * lands many charges on one second) and an ambiguous order makes a cursor skip
 * or repeat rows silently.
 *
 * **It carries no authority and is deliberately not signed.** The site comes
 * from the path and is checked by `siteMembership` → `requireAnalyticsAccess` →
 * `requireCapability('revenue:read')` on every request; the range comes from the
 * query. A cursor that has been edited can only move the caller to a different
 * position in *their own* site's list — the same thing they can do by editing
 * the range. An HMAC here would protect nothing and would mean a signing secret,
 * a key rotation story, and cursors that stop working across a key change.
 *
 * What it must do instead is **fail loudly on anything malformed**, which is
 * what `decodeRevenueCursor` does: an unparseable, truncated, over-long or
 * wrong-version cursor is `null`, and the route turns that into a typed 400
 * rather than silently starting from the top. Silently restarting is the
 * dangerous behaviour — a client paging through a customer's transactions would
 * loop over page one forever without anything reporting an error.
 *
 * ## The format
 *
 * `base64url("rev1|<occurred_at ms>|<object_id>")`. Base64url rather than raw
 * text because §6.4 calls the cursor opaque and a client that can read
 * `ch_3Nk…` out of a query string will eventually construct one; base64url
 * rather than base64 because it travels in a URL. The `rev1` prefix is a version
 * tag, so the day the keyset gains a column, old cursors are rejected rather
 * than misread — a v2 decoder that accepted a v1 cursor would page from the
 * wrong position with no error.
 */

const VERSION = 'rev1'
const SEPARATOR = '|'

/** The contract's own bound (`cursorSchema`), enforced before any decoding. */
const MAX_CURSOR_LENGTH = 512

export interface RevenueCursor {
  readonly occurredAtMs: number
  readonly objectId: string
}

export function encodeRevenueCursor(cursor: RevenueCursor): string {
  const payload = [VERSION, String(cursor.occurredAtMs), cursor.objectId].join(SEPARATOR)
  return Buffer.from(payload, 'utf8').toString('base64url')
}

/**
 * Decodes a cursor, or null if it is anything other than one this server wrote.
 *
 * Every branch below is a rejection rather than a repair. The object id is
 * allowed to contain nothing in particular — provider ids are opaque — but it is
 * length-bound, because it reaches ClickHouse as a bound parameter of a
 * `strictObject` schema that caps it at 255 and a longer one should be refused
 * at the edge with a message about the cursor rather than deep in the gateway
 * with a message about parameters.
 */
export function decodeRevenueCursor(raw: string): RevenueCursor | null {
  if (raw.length === 0 || raw.length > MAX_CURSOR_LENGTH) return null

  let decoded: string
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8')
  } catch {
    return null
  }

  // Split with a limit of three so an object id containing the separator (no
  // provider does, but nothing here should depend on that) rejoins rather than
  // being silently truncated to its first segment.
  const firstSep = decoded.indexOf(SEPARATOR)
  if (firstSep === -1) return null
  const secondSep = decoded.indexOf(SEPARATOR, firstSep + 1)
  if (secondSep === -1) return null

  const version = decoded.slice(0, firstSep)
  if (version !== VERSION) return null

  const occurredAtMs = Number(decoded.slice(firstSep + 1, secondSep))
  if (!Number.isSafeInteger(occurredAtMs) || occurredAtMs < 0) return null

  const objectId = decoded.slice(secondSep + 1)
  if (objectId.length === 0 || objectId.length > 255) return null

  return { occurredAtMs, objectId }
}
