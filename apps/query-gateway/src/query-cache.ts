import type { QueryParameterValue } from './clickhouse.ts'

/**
 * Bounded in-process query-result cache (plan Milestone 7 item 7: "bounded
 * query cache").
 *
 * Placement: in-process LRU on the gateway. For this milestone the gateway is
 * the only reader of ClickHouse and the build phase runs a small fixed set of
 * instances, so a per-instance cache is enough — the same reasoning the nonce
 * store uses for its in-memory default (`nonce-store.ts`). A shared cache is the
 * multi-instance refinement, and it lands with the same shared store G-005
 * names, not before it is needed.
 *
 * Two properties are load-bearing and tested:
 *
 * - **A cache entry never mixes sites.** The key includes the operation ID and
 *   the fully-bound parameter map, and `site_id` is always part of that map for
 *   an analytics operation (`operations.ts`). Two sites with otherwise identical
 *   parameters therefore hash to different keys. This is the cache's half of the
 *   cross-site isolation the registry enforces at bind time.
 * - **Nothing is served stale beyond a short TTL.** "Today" buckets are still
 *   filling, so a long TTL would show numbers that silently lag ingest. The TTL
 *   is short and uniform (typed config, `QUERY_CACHE_TTL_MS`); a longer TTL for
 *   provably-finalized historical ranges is a Checkpoint C refinement once the
 *   response carries a finalized watermark.
 */

export interface CachedQueryResult {
  readonly rows: readonly Record<string, unknown>[]
  readonly truncated: boolean
}

interface CacheEntry {
  readonly value: CachedQueryResult
  readonly expiresAt: number
}

/**
 * Canonical cache key.
 *
 * The parameter map is serialised with its keys sorted, so two requests that
 * differ only in key order — or in nothing at all — collapse to one entry, and
 * two requests that differ in any bound value (a different `site_id` above all)
 * never do.
 */
export function queryCacheKey(
  operationId: string,
  parameters: Readonly<Record<string, QueryParameterValue>>,
): string {
  const canonical = Object.keys(parameters)
    .sort()
    .map((name) => `${name}=${String(parameters[name])}`)
    .join('&')
  return `${operationId}\u0000${canonical}`
}

export interface QueryCacheOptions {
  readonly maxEntries: number
  readonly ttlMs: number
  /** Injectable clock; production passes `Date.now`. */
  readonly now?: () => number
}

export class QueryCache {
  readonly #entries = new Map<string, CacheEntry>()
  readonly #maxEntries: number
  readonly #ttlMs: number
  readonly #now: () => number

  constructor(options: QueryCacheOptions) {
    this.#maxEntries = options.maxEntries
    this.#ttlMs = options.ttlMs
    this.#now = options.now ?? Date.now
  }

  get size(): number {
    return this.#entries.size
  }

  /** Returns a live entry, or undefined on a miss or an expired entry. */
  get(key: string): CachedQueryResult | undefined {
    const entry = this.#entries.get(key)
    if (entry === undefined) return undefined

    if (this.#now() >= entry.expiresAt) {
      this.#entries.delete(key)
      return undefined
    }

    // Touch: move to the most-recent position so eviction sheds cold entries.
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    return entry.value
  }

  /**
   * Caches a result. `ttlMs` overrides the default TTL for this entry — the
   * gateway passes the long finalized-range TTL for an operation whose result is
   * over a provably-finalized session range, and the short default otherwise
   * (ADR-0011's finalized-range refinement).
   */
  set(key: string, value: CachedQueryResult, ttlMs?: number): void {
    const ttl = ttlMs ?? this.#ttlMs
    // Overwrite in place keeps insertion order honest for the LRU.
    this.#entries.delete(key)
    this.#entries.set(key, { value, expiresAt: this.#now() + ttl })

    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value
      if (oldest === undefined) break
      this.#entries.delete(oldest)
    }
  }
}
