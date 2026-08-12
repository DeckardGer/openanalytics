import { describe, expect, it } from 'vitest'
import { QueryCache, queryCacheKey } from '../../apps/query-gateway/src/query-cache.ts'

/**
 * The bounded query-result cache (plan Milestone 7 item 7).
 *
 * The two properties that matter for correctness rather than performance — a key
 * never mixes sites, and nothing is served past its TTL — are proven here with a
 * fake clock, so neither depends on wall time.
 */

const RESULT = (n: number) => ({ rows: [{ n }], truncated: false })

describe('queryCacheKey', () => {
  it('separates two sites with otherwise identical parameters', () => {
    const a = queryCacheKey('analytics.overview_hour', {
      site_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      from: '2026-07-01 00:00:00.000',
      to: '2026-07-08 00:00:00.000',
    })
    const b = queryCacheKey('analytics.overview_hour', {
      site_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      from: '2026-07-01 00:00:00.000',
      to: '2026-07-08 00:00:00.000',
    })
    expect(a).not.toBe(b)
  })

  it('is stable regardless of parameter insertion order', () => {
    const forward = queryCacheKey('op', { site_id: 's', from: 'f', to: 't' })
    const shuffled = queryCacheKey('op', { to: 't', from: 'f', site_id: 's' })
    expect(forward).toBe(shuffled)
  })

  it('changes when the operation id changes', () => {
    const params = { site_id: 's', from: 'f', to: 't' }
    expect(queryCacheKey('analytics.overview_hour', params)).not.toBe(
      queryCacheKey('analytics.overview_day', params),
    )
  })
})

describe('QueryCache', () => {
  it('never returns one site’s result under another site’s key', () => {
    const cache = new QueryCache({ maxEntries: 10, ttlMs: 30_000, now: () => 0 })
    const siteA = queryCacheKey('analytics.overview_hour', { site_id: 'A' })
    const siteB = queryCacheKey('analytics.overview_hour', { site_id: 'B' })

    cache.set(siteA, RESULT(1))
    expect(cache.get(siteB)).toBeUndefined()
    expect(cache.get(siteA)).toEqual(RESULT(1))
  })

  it('serves within the TTL and misses after it', () => {
    let now = 1_000
    const cache = new QueryCache({ maxEntries: 10, ttlMs: 30_000, now: () => now })

    cache.set('k', RESULT(1))
    now = 20_000
    expect(cache.get('k')).toEqual(RESULT(1))

    now = 31_001 // strictly past 1_000 + 30_000
    expect(cache.get('k')).toBeUndefined()
    // The expired entry is dropped, not merely hidden.
    expect(cache.size).toBe(0)
  })

  it('evicts the least-recently-used entry past the bound', () => {
    const cache = new QueryCache({ maxEntries: 2, ttlMs: 30_000, now: () => 0 })
    cache.set('a', RESULT(1))
    cache.set('b', RESULT(2))
    // Touch 'a' so 'b' becomes the coldest.
    expect(cache.get('a')).toEqual(RESULT(1))
    cache.set('c', RESULT(3))

    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toEqual(RESULT(1))
    expect(cache.get('c')).toEqual(RESULT(3))
    expect(cache.size).toBe(2)
  })
})
