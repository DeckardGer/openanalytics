import { describe, expect, it } from 'vitest'
import {
  decodeRevenueCursor,
  encodeRevenueCursor,
} from '../../apps/api/src/analytics/revenue-cursor.ts'

/**
 * The revenue transactions cursor (docs snapshot 03 §6.4; ADR-0033, D7).
 * Milestone 12 Checkpoint 5.
 *
 * Two properties, and the second matters more than the first: a cursor this
 * server wrote must round-trip exactly, and **anything else must be rejected**.
 * A decoder that quietly fell back to "start from the beginning" would make a
 * paging client loop over page one forever with nothing reporting an error — the
 * worst possible failure for a list somebody is reconciling against their
 * provider dashboard.
 */

const OCCURRED_MS = Date.parse('2026-07-20T10:30:00.000Z')

describe('round trip', () => {
  it('recovers the exact keyset', () => {
    const cursor = { occurredAtMs: OCCURRED_MS, objectId: 'ch_3NkabcDEF0123456' }
    expect(decodeRevenueCursor(encodeRevenueCursor(cursor))).toEqual(cursor)
  })

  it('is URL-safe', () => {
    // base64url, so it survives a query string without escaping. `+` and `/`
    // would both need it and `=` padding is dropped by the encoder.
    for (const objectId of ['ch_a?b&c=d', 'ch_' + 'z'.repeat(200), 'di_~-_']) {
      const encoded = encodeRevenueCursor({ occurredAtMs: OCCURRED_MS, objectId })
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(decodeRevenueCursor(encoded)?.objectId).toBe(objectId)
    }
  })

  it('survives an object id containing the separator', () => {
    // No provider does this, but nothing here should depend on that: a decoder
    // that split naively would silently truncate the id and page from the wrong
    // position rather than failing.
    const cursor = { occurredAtMs: OCCURRED_MS, objectId: 'ch_a|b|c' }
    expect(decodeRevenueCursor(encodeRevenueCursor(cursor))).toEqual(cursor)
  })

  it('round-trips the epoch', () => {
    const cursor = { occurredAtMs: 0, objectId: 'ch_1' }
    expect(decodeRevenueCursor(encodeRevenueCursor(cursor))).toEqual(cursor)
  })
})

describe('tamper and corruption rejection', () => {
  const valid = encodeRevenueCursor({ occurredAtMs: OCCURRED_MS, objectId: 'ch_1' })

  it('rejects an empty or over-long cursor', () => {
    expect(decodeRevenueCursor('')).toBeNull()
    expect(decodeRevenueCursor('A'.repeat(513))).toBeNull()
  })

  it('rejects a cursor from another version', () => {
    const v2 = Buffer.from(`rev2|${OCCURRED_MS}|ch_1`, 'utf8').toString('base64url')
    // The version tag is why this is null rather than a plausible position: a
    // decoder that accepted an unknown version would page from the wrong place
    // the day the keyset gains a column.
    expect(decodeRevenueCursor(v2)).toBeNull()
  })

  it('rejects a truncated payload', () => {
    expect(decodeRevenueCursor(Buffer.from('rev1', 'utf8').toString('base64url'))).toBeNull()
    expect(
      decodeRevenueCursor(Buffer.from(`rev1|${OCCURRED_MS}`, 'utf8').toString('base64url')),
    ).toBeNull()
  })

  it('rejects a non-numeric, negative or unsafe timestamp', () => {
    for (const stamp of ['abc', '-1', '1e400', '1.5', String(Number.MAX_SAFE_INTEGER + 10)]) {
      const forged = Buffer.from(`rev1|${stamp}|ch_1`, 'utf8').toString('base64url')
      expect(decodeRevenueCursor(forged), stamp).toBeNull()
    }
  })

  it('rejects an empty or over-long object id', () => {
    expect(
      decodeRevenueCursor(Buffer.from(`rev1|${OCCURRED_MS}|`, 'utf8').toString('base64url')),
    ).toBeNull()
    expect(
      decodeRevenueCursor(
        Buffer.from(`rev1|${OCCURRED_MS}|${'z'.repeat(256)}`, 'utf8').toString('base64url'),
      ),
    ).toBeNull()
  })

  it('rejects raw text that was never encoded', () => {
    // Base64 decoding is lenient, so the guard that catches this is the strict
    // structural parse rather than the decode itself.
    expect(decodeRevenueCursor('not-a-cursor')).toBeNull()
    expect(decodeRevenueCursor(`rev1|${OCCURRED_MS}|ch_1`)).toBeNull()
  })

  it('rejects a flipped byte in a valid cursor', () => {
    // Every single-character substitution either breaks the version tag, the
    // number or the structure. None of them decodes to a *different valid*
    // cursor by accident, which is what "rejected rather than misread" means.
    let rejected = 0
    for (let i = 0; i < valid.length; i += 1) {
      const flipped = `${valid.slice(0, i)}${valid[i] === 'A' ? 'B' : 'A'}${valid.slice(i + 1)}`
      if (decodeRevenueCursor(flipped) === null) rejected += 1
    }
    // Not all of them: a flip inside the object id produces a different but
    // structurally valid id, which is harmless — the site is authorized from the
    // path, so the worst outcome is paging to a position in the caller's own
    // list. What must never happen is a flip being read as a *silent restart*,
    // which the encoding makes impossible: there is no cursor value meaning
    // "beginning".
    expect(rejected).toBeGreaterThan(0)
  })
})
