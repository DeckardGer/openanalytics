/**
 * Minimal fixed-window rate limiter for the public read surface (docs snapshot 02
 * §20: "public routes ... use a rate limit").
 *
 * Interface-first so a Redis-backed limiter on the shared `realtime-cache`
 * instance is a drop-in for a multi-instance deployment — the in-process default
 * is a per-instance best-effort guard (the same trade-off the query gateway's
 * nonce store documents). The public surface is anonymous, so the key is the
 * caller's IP plus the share slug: one noisy client cannot exhaust another
 * slug's budget.
 */

export interface RateLimitDecision {
  readonly allowed: boolean
  /** Seconds until the current window resets — the `Retry-After` value. */
  readonly retryAfterSeconds: number
}

export interface RateLimiter {
  check(key: string): RateLimitDecision
}

export interface InProcessRateLimiterOptions {
  readonly requestsPerMinute: number
  /** Short-term burst allowance above the steady rate. */
  readonly burst: number
  readonly now?: () => number
  /** Cap on tracked keys, so an attacker cycling keys cannot grow the map. */
  readonly maxKeys?: number
  /**
   * A different ceiling for keys carrying a given prefix (ADR-0043 D6).
   *
   * The read surface has two credential classes on **one limiter object** —
   * D9's condition, met literally — and they need different budgets: a plugin
   * polling an admin screen and an assistant fanning out a dozen tool calls in
   * one turn are not the same traffic shape, and ADR-0042 D6's argument for
   * reusing a number was precisely that the shapes matched.
   *
   * A prefix map rather than a second limiter, because the alternative is two
   * objects with two window maps and two sweeps, and "which one did this request
   * charge" becomes a question. The prefixes in use are `key:`, `oauth:`, `ip:`,
   * `device:` (one device code's polling budget) and `device-ip:` (the address
   * ceiling behind it); anything unmatched gets the constructed limit, so adding
   * a class without a decision about its budget lands on the conservative one.
   */
  readonly limitsByPrefix?: Readonly<Record<string, { requestsPerMinute: number; burst: number }>>
}

interface Window {
  count: number
  resetAt: number
}

export class InProcessRateLimiter implements RateLimiter {
  readonly #limit: number
  readonly #windowMs = 60_000
  readonly #now: () => number
  readonly #maxKeys: number
  readonly #windows = new Map<string, Window>()
  readonly #prefixLimits: readonly (readonly [string, number])[]

  constructor(options: InProcessRateLimiterOptions) {
    // The burst is the ceiling within a single window; the per-minute rate is the
    // steady allowance. Using the larger of the two as the window cap keeps a
    // legitimate burst from tripping while still bounding a sustained flood.
    this.#limit = Math.max(options.requestsPerMinute, options.burst)
    this.#now = options.now ?? (() => Date.now())
    this.#maxKeys = options.maxKeys ?? 100_000
    // Longest prefix first, so a future `oauth:mcp:` would win over `oauth:`
    // rather than depending on object key order.
    this.#prefixLimits = Object.entries(options.limitsByPrefix ?? {})
      .map(([prefix, limit]) => [prefix, Math.max(limit.requestsPerMinute, limit.burst)] as const)
      .sort((a, b) => b[0].length - a[0].length)
  }

  /** The ceiling this key draws on — its prefix's, or the constructed default. */
  #limitFor(key: string): number {
    for (const [prefix, limit] of this.#prefixLimits) {
      if (key.startsWith(prefix)) return limit
    }
    return this.#limit
  }

  check(key: string): RateLimitDecision {
    const now = this.#now()
    const limit = this.#limitFor(key)
    let window = this.#windows.get(key)
    if (!window || now >= window.resetAt) {
      // Opportunistically drop expired windows so the map does not grow without
      // bound; only sweep when it is getting large, to keep the hot path cheap.
      if (this.#windows.size >= this.#maxKeys) this.#sweep(now)
      window = { count: 0, resetAt: now + this.#windowMs }
      this.#windows.set(key, window)
    }

    window.count += 1
    if (window.count > limit) {
      return { allowed: false, retryAfterSeconds: Math.ceil((window.resetAt - now) / 1000) }
    }
    return { allowed: true, retryAfterSeconds: 0 }
  }

  #sweep(now: number): void {
    for (const [key, window] of this.#windows) {
      if (now >= window.resetAt) this.#windows.delete(key)
    }
  }
}
