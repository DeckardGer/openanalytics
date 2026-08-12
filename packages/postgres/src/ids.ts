import { randomFillSync } from 'node:crypto'

/**
 * Application-side UUIDv7 generation.
 *
 * ADR-0006: identifiers are minted here, not by the database. UUIDv7 embeds a
 * millisecond timestamp in its high bits, so primary keys sort by creation time
 * and stay index-local on insert without a companion column. Generation lives in
 * the app because the build-phase Postgres is 17 (no `uuidv7()`, that is
 * Postgres 18) and because app-side ids keep the design provider-agnostic
 * (docs snapshot 02 §1 item 14).
 *
 * There is deliberately no database default on id columns, so this is the single
 * source of ids: a row is inserted with an id this function produced, and a raw
 * insert that omits one fails rather than silently minting a non-sortable v4.
 */

/** RFC 9562 §5.7 UUIDv7: 48-bit unix-ms timestamp, version 7, variant 10. */
export function uuidv7(now: number = Date.now()): string {
  const buf = Buffer.alloc(16)
  randomFillSync(buf)

  // 48-bit big-endian millisecond timestamp in bytes 0..5.
  buf.writeUIntBE(now, 0, 6)

  // A DataView read returns a defined number, which keeps the bit-twiddling
  // clear of `noUncheckedIndexedAccess` on typed-array element access.
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  view.setUint8(6, (view.getUint8(6) & 0x0f) | 0x70) // version 7
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80) // variant 10

  const hex = buf.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The id generator every repository and the Better Auth adapter share. */
export function newId(): string {
  return uuidv7()
}
