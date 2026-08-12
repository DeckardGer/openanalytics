/**
 * Replay defence for signed gateway requests (docs snapshot 05, D-208).
 *
 * A signature bound to method/path/body/audience is still replayable inside its
 * validity window, so each request carries a single-use nonce. The store is an
 * interface because the in-memory implementation is only correct for a single
 * gateway process: with more than one instance behind the proxy, a replay would
 * land on a different machine and be accepted. The Milestone 1 gate is proven on
 * one instance; the shared-state implementation is a Redis-backed drop-in, which
 * is why `consume` is async even though the in-memory version never awaits.
 */

export interface NonceStore {
  /**
   * Records first use of a nonce.
   *
   * Resolves `true` when the nonce was previously unseen, `false` when it is a
   * replay. Must be atomic: a check followed by a separate write lets two
   * concurrent replays both observe "unseen".
   *
   * `expiresAt` is the signature's own expiry — the store only has to remember a
   * nonce for as long as the signature carrying it could still verify.
   */
  consume(nonce: string, expiresAt: Date): Promise<boolean>
}

export interface InMemoryNonceStoreOptions {
  readonly now?: () => number
  /** Entry count that triggers a prune sweep. */
  readonly pruneThreshold?: number
}

export class InMemoryNonceStore implements NonceStore {
  readonly #seen = new Map<string, number>()
  readonly #now: () => number
  readonly #pruneThreshold: number

  constructor(options: InMemoryNonceStoreOptions = {}) {
    this.#now = options.now ?? Date.now
    this.#pruneThreshold = options.pruneThreshold ?? 10_000
  }

  consume(nonce: string, expiresAt: Date): Promise<boolean> {
    const now = this.#now()

    // Pruning is amortised rather than timer-driven: a timer would keep the
    // process alive during shutdown for state that is safe to lose.
    if (this.#seen.size >= this.#pruneThreshold) this.#prune(now)

    const seenUntil = this.#seen.get(nonce)
    if (seenUntil !== undefined && seenUntil > now) return Promise.resolve(false)

    this.#seen.set(nonce, expiresAt.getTime())
    return Promise.resolve(true)
  }

  /** Entries currently retained. Exposed for tests asserting the prune sweep. */
  get size(): number {
    return this.#seen.size
  }

  #prune(now: number): void {
    for (const [nonce, expiresAt] of this.#seen) {
      if (expiresAt <= now) this.#seen.delete(nonce)
    }
  }
}

/**
 * Shared-state implementation, required whenever more than one gateway
 * instance is behind the proxy.
 *
 * This is not a theoretical improvement over the in-memory store. Measured
 * against the deployed gateway running two machines, 7 of 10 replayed requests
 * were ACCEPTED: the replay simply landed on the instance that had not seen the
 * nonce. Replay defence is not per-process state.
 *
 * `SET key NX PX` is the whole mechanism, and it is atomic in exactly the way
 * the interface demands — two concurrent replays cannot both observe "unseen",
 * because only one `SET NX` can succeed.
 *
 * It runs on valkey-realtime rather than valkey-queue: D-205 puts short-lived
 * shared state (rate limits, caches) there and keeps the durable queue for
 * events only. The tradeoff is that realtime runs `allkeys-lru`, so under
 * memory pressure a nonce could in principle be evicted before its signature
 * expires, permitting one replay inside that window. Nonces are tiny and live
 * for at most the signature lifetime (60s ceiling), so this needs the instance
 * to be under real pressure; it is recorded here rather than papered over.
 */
export interface ValkeyNonceStoreOptions {
  readonly client: {
    set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<string | null>
  }
  readonly keyPrefix?: string
  readonly now?: () => number
}

export class ValkeyNonceStore implements NonceStore {
  readonly #client: ValkeyNonceStoreOptions['client']
  readonly #prefix: string
  readonly #now: () => number

  constructor(options: ValkeyNonceStoreOptions) {
    this.#client = options.client
    this.#prefix = options.keyPrefix ?? 'oa:gw:nonce:'
    this.#now = options.now ?? Date.now
  }

  async consume(nonce: string, expiresAt: Date): Promise<boolean> {
    // The store only has to outlive the signature carrying the nonce. A floor
    // of 1ms keeps an already-expired signature from being sent as PX 0, which
    // Valkey rejects; such a request is refused by the expiry check anyway.
    const ttlMs = Math.max(1, expiresAt.getTime() - this.#now())
    const reply = await this.#client.set(`${this.#prefix}${nonce}`, '1', 'PX', ttlMs, 'NX')
    return reply === 'OK'
  }
}
