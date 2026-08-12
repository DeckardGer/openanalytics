/**
 * The last rung of G-005's limiter ladder.
 *
 * When `realtime-cache` has been unreachable for longer than the bounded
 * fail-open window, the collector stops accepting unlimited traffic and falls
 * back to this: a coarse per-IP limiter inside the process, so that "the system
 * is never wholly undefended".
 *
 * It is deliberately worse than the real limiter, and the ways it is worse are
 * the ways G-005 already accepts:
 *
 * - **Per instance, not per site.** Every serverless instance keeps its own
 *   counts, so the effective global limit is the configured rate times however
 *   many instances are warm. That is the price of not having shared state — and
 *   the alternative during an outage is no limit at all.
 * - **Coarse LRU, bounded.** An eviction loses a counter, which lets the evicted
 *   caller start over. A flood of distinct addresses is exactly the traffic that
 *   causes evictions, so the bound is what keeps a memory exhaustion from
 *   turning a degraded collector into a dead one.
 *
 * Neither weakness can lose an event: this only rejects with `429`, which the
 * tracker retries.
 */

export interface FallbackLimiter {
  /** True when this request is over the limit and should be throttled. */
  isLimited(key: string, cost: number, at: Date): boolean
  /** Entries currently held. For the degradation metric and for tests. */
  size(): number
}

interface Bucket {
  minute: string
  count: number
}

export interface FallbackLimiterOptions {
  readonly perMinute: number
  readonly maxEntries: number
}

export function createFallbackLimiter(options: FallbackLimiterOptions): FallbackLimiter {
  // Insertion-ordered Map as the LRU: a touched key is re-inserted, so the
  // oldest is always the first the iterator yields.
  const buckets = new Map<string, Bucket>()

  return {
    isLimited(key: string, cost: number, at: Date): boolean {
      const minute = at.toISOString().slice(0, 16)
      const existing = buckets.get(key)

      const bucket: Bucket =
        existing === undefined || existing.minute !== minute ? { minute, count: 0 } : existing

      bucket.count += cost
      buckets.delete(key)
      buckets.set(key, bucket)

      while (buckets.size > options.maxEntries) {
        const oldest = buckets.keys().next()
        if (oldest.done === true) break
        buckets.delete(oldest.value)
      }

      return bucket.count > options.perMinute
    },

    size(): number {
      return buckets.size
    },
  }
}
