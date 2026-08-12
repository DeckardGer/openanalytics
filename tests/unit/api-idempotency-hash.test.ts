import { describe, expect, it } from 'vitest'
import { canonicalRequestHash } from '../../apps/api/src/http/idempotency.ts'

/**
 * The request fingerprint behind `Idempotency-Key`.
 *
 * The ledger answers "same key, same payload → replay" and "same key, different
 * payload → 409" by comparing this hash, so what counts as "the same request"
 * is decided entirely here. Two properties matter and neither is obvious:
 *
 * - Key order must not change the hash, at every nesting depth. A retry that
 *   serialized its fields in a different order is the same create, and telling
 *   the caller it conflicts would make the key useless for the exact case it
 *   exists for.
 * - Array order must, because `['a.example.com','b.example.com']` and its
 *   reverse are different lists a caller could legitimately mean.
 */

describe('canonicalRequestHash', () => {
  const base = { method: 'POST', path: '/v1/sites' }

  it('is stable across object key order, recursively', () => {
    const a = canonicalRequestHash({
      ...base,
      body: { slug: 'acme', name: 'Acme', meta: { b: 2, a: 1, deep: { y: false, x: true } } },
    })
    const b = canonicalRequestHash({
      ...base,
      body: { meta: { deep: { x: true, y: false }, a: 1, b: 2 }, name: 'Acme', slug: 'acme' },
    })
    expect(a).toBe(b)
  })

  it('changes when a value changes', () => {
    const a = canonicalRequestHash({ ...base, body: { slug: 'acme', name: 'Acme' } })
    const b = canonicalRequestHash({ ...base, body: { slug: 'acme', name: 'Acme Inc' } })
    expect(a).not.toBe(b)
  })

  it('changes when a nested value changes', () => {
    const a = canonicalRequestHash({ ...base, body: { meta: { deep: { x: true } } } })
    const b = canonicalRequestHash({ ...base, body: { meta: { deep: { x: false } } } })
    expect(a).not.toBe(b)
  })

  it('distinguishes the method and the path', () => {
    const body = { slug: 'acme', name: 'Acme' }
    expect(canonicalRequestHash({ method: 'POST', path: '/v1/sites', body })).not.toBe(
      canonicalRequestHash({ method: 'PUT', path: '/v1/sites', body }),
    )
    expect(canonicalRequestHash({ method: 'POST', path: '/v1/sites', body })).not.toBe(
      canonicalRequestHash({ method: 'POST', path: '/v1/other', body }),
    )
    // The method is compared case-insensitively; HTTP methods are uppercase.
    expect(canonicalRequestHash({ method: 'post', path: '/v1/sites', body })).toBe(
      canonicalRequestHash({ method: 'POST', path: '/v1/sites', body }),
    )
  })

  it('keeps array order significant', () => {
    const a = canonicalRequestHash({
      ...base,
      body: { domains: ['a.example.com', 'b.example.com'] },
    })
    const b = canonicalRequestHash({
      ...base,
      body: { domains: ['b.example.com', 'a.example.com'] },
    })
    expect(a).not.toBe(b)
  })

  it('sorts keys inside array elements too', () => {
    const a = canonicalRequestHash({ ...base, body: { items: [{ b: 2, a: 1 }] } })
    const b = canonicalRequestHash({ ...base, body: { items: [{ a: 1, b: 2 }] } })
    expect(a).toBe(b)
  })

  it('produces a hex SHA-256 and never echoes the payload', () => {
    const hash = canonicalRequestHash({ ...base, body: { slug: 'acme', name: 'Acme' } })
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toContain('acme')
  })
})
