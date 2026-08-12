import { ApiError } from '@openanalytics/contracts'
import type { MiddlewareHandler } from 'hono'
import type { SignedRequestVariables } from './auth.ts'

/**
 * Request limits required by docs snapshot 04, Milestone 1 item 2.
 *
 * Body size lives with the body reader in `auth.ts`, because the cap has to
 * apply before the bytes are hashed. The rest is here.
 *
 * Rate limiting is deliberately **not** given a default. G-005 in
 * docs snapshot 05 is an open GATE covering rate-limit values and windows, and
 * AGENTS.md forbids a gate value appearing as an invented default. The mechanism
 * is implemented and configurable, and stays disabled until the gate closes with
 * an ADR — concurrency, timeout and body size carry the load until then.
 */

export interface ConcurrencyLimitOptions {
  readonly maxConcurrent: number
}

/**
 * Bounds in-flight queries.
 *
 * Shedding at the door rather than queueing: a request that waits behind a full
 * gateway has already lost its caller's timeout budget, and an unbounded wait
 * queue converts a ClickHouse slowdown into a gateway memory problem. The
 * refusal is a retryable 503 so the caller can back off (docs snapshot 02 §7.2).
 */
export function concurrencyLimit(
  options: ConcurrencyLimitOptions,
): MiddlewareHandler<{ Variables: SignedRequestVariables }> {
  let inFlight = 0

  return async (c, next) => {
    if (inFlight >= options.maxConcurrent) {
      c.get('logger').warn('query_shed', { limit: options.maxConcurrent })
      throw new ApiError('SERVICE_UNAVAILABLE', 'Gateway is at capacity', {
        details: { max_concurrent: options.maxConcurrent },
      })
    }

    inFlight += 1
    try {
      await next()
    } finally {
      inFlight -= 1
    }
  }
}

export interface RateLimitOptions {
  readonly requestsPerMinute: number
  readonly now?: () => number
}

/**
 * Fixed-window limiter, keyed by signing key ID.
 *
 * Only constructed when a limit is configured. In-process state is enough for
 * one gateway instance; a multi-instance limit needs the shared `realtime-cache`
 * store named in G-005, which is also where the fail-open behaviour that gate
 * asks about will be decided.
 */
export function rateLimit(
  options: RateLimitOptions,
): MiddlewareHandler<{ Variables: SignedRequestVariables }> {
  const now = options.now ?? Date.now
  const windows = new Map<string, { windowStart: number; count: number }>()

  return async (c, next) => {
    const key = c.get('signingKeyId')
    const at = now()
    const windowStart = at - (at % 60_000)
    const current = windows.get(key)

    if (current === undefined || current.windowStart !== windowStart) {
      windows.set(key, { windowStart, count: 1 })
    } else if (current.count >= options.requestsPerMinute) {
      throw new ApiError('RATE_LIMITED', 'Too many gateway requests', {
        details: { limit_per_minute: options.requestsPerMinute },
      })
    } else {
      current.count += 1
    }

    await next()
  }
}

/**
 * Per-request deadline.
 *
 * The signal is handed to the ClickHouse reader rather than raced against it: a
 * `Promise.race` would resolve the request while the query kept running, which
 * is how a timeout turns into an unbounded pile of abandoned server-side work.
 */
export function withTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('query timeout')), timeoutMs)
  return run(controller.signal).finally(() => {
    clearTimeout(timer)
  })
}
