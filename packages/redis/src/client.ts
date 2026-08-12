import { Redis, type RedisOptions } from 'ioredis'

/**
 * Connection factory for the two Valkey instances (docs snapshot 05, D-205).
 *
 * D-206 gives them callers with genuinely different transports, and the
 * difference is not cosmetic:
 *
 * - `collector` historically ran on Vercel, which cannot route into the private
 *   network (D-208). It reaches the queue over a *public* endpoint, so TLS and
 *   AUTH are the only thing standing between the open internet and the instance
 *   that holds the sole copy of a customer event. Both are required here rather
 *   than recommended.
 * - `realtime-cache` is the collector's other hop — presence, abuse counters and
 *   the D-103 usage counter — and crosses the same public internet, so it
 *   carries the same requirement. The state behind it is losable; the
 *   credential protecting it is not.
 * - `worker` runs inside the same private network and connects natively. Fly 6PN
 *   `.internal` names resolve to AAAA records only, so the socket has to be
 *   asked for IPv6 explicitly — ioredis otherwise defaults to IPv4 and the
 *   connection fails with ENOTFOUND against a name that resolves fine.
 *
 * ioredis speaks RESP, so it drives Valkey unchanged; the provider can be
 * swapped behind this factory without the collector contract moving (D-205).
 */

export const VALKEY_CONNECTION_MODES = ['collector', 'realtime-cache', 'worker'] as const

export type ValkeyConnectionMode = (typeof VALKEY_CONNECTION_MODES)[number]

/**
 * Modes whose hop MAY cross the public internet and therefore require TLS and
 * AUTH — unless the destination is provably not public. ADR-0015 colocated the
 * collector with the queue, so the same service now legitimately dials
 * 127.0.0.1/10.x in plaintext: D-206's rule was always about the wire, not the
 * caller's name.
 */
const PUBLIC_HOP_MODES: ReadonlySet<ValkeyConnectionMode> = new Set<ValkeyConnectionMode>([
  'collector',
  'realtime-cache',
])

/** Loopback, RFC1918 and provider-private destinations: never the public wire. */
function isPrivateHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true
  if (hostname.startsWith('127.')) return true
  if (hostname.startsWith('10.')) return true
  if (hostname.startsWith('192.168.')) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true
  return hostname.endsWith(FLY_PRIVATE_SUFFIX)
}

export interface ValkeyConnectionOptions {
  readonly mode: ValkeyConnectionMode
  /** `rediss://` for the collector, `redis://<app>.internal:6379` for the worker. */
  readonly url: string
  /** Shows up in `CLIENT LIST`, which is how a stuck consumer is identified. */
  readonly connectionName?: string
  readonly connectTimeoutMs?: number
  /**
   * Left unset by default. The collector should supply one — a serverless
   * invocation that hangs on a queue write burns the request budget and returns
   * nothing — but the value is a deployment measurement, not a constant this
   * package may invent. It must never be set on a worker connection, where a
   * blocking `XREADGROUP` legitimately waits.
   */
  readonly commandTimeoutMs?: number
  readonly lazyConnect?: boolean
  /**
   * Whether commands wait in memory while the socket is down.
   *
   * ioredis defaults this on, which is right for a long-lived worker riding out
   * a failover. It is wrong for the collector: a command queued against a dead
   * socket burns the whole serverless invocation and returns nothing, where
   * failing immediately produces the `503` the tracker retries. Losing the
   * request is not on the table either way — the difference is whether the
   * client learns that in milliseconds or not at all.
   */
  readonly enableOfflineQueue?: boolean
  /**
   * Called on every socket-level error the client reports.
   *
   * Optional, but a listener is *always* attached whether one is supplied or
   * not — see `createQueueClient`. This hook only decides whether the error is
   * also recorded somewhere a human will see it.
   */
  readonly onError?: (error: Error) => void
}

export class QueueConnectionError extends Error {
  readonly mode: ValkeyConnectionMode

  constructor(mode: ValkeyConnectionMode, message: string) {
    super(`Invalid ${mode} Valkey connection: ${message}`)
    this.name = 'QueueConnectionError'
    this.mode = mode
  }
}

const FLY_PRIVATE_SUFFIX = '.internal'

/**
 * Derives ioredis options from a URL plus the caller's role.
 *
 * Split out from `createQueueClient` so the transport rules D-206 actually
 * depends on are assertable without opening a socket.
 */
export function buildConnectionOptions(options: ValkeyConnectionOptions): RedisOptions {
  let url: URL
  try {
    url = new URL(options.url)
  } catch {
    throw new QueueConnectionError(options.mode, 'URL could not be parsed')
  }

  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new QueueConnectionError(
      options.mode,
      `expected a redis:// or rediss:// URL, received "${url.protocol}//"`,
    )
  }

  const tls = url.protocol === 'rediss:'

  if (PUBLIC_HOP_MODES.has(options.mode)) {
    if (!tls && !isPrivateHost(url.hostname)) {
      throw new QueueConnectionError(
        options.mode,
        'this hop crosses the public internet and must use rediss:// (D-206)',
      )
    }
    // AUTH is required even on a loopback hop: the credential is what keeps a
    // neighbouring container from becoming a queue writer.
    if (url.password === '') {
      throw new QueueConnectionError(
        options.mode,
        'a queue/cache endpoint must carry AUTH credentials (D-206)',
      )
    }
  }

  const resolved: RedisOptions = {
    ...(options.connectionName === undefined ? {} : { connectionName: options.connectionName }),
    ...(options.connectTimeoutMs === undefined ? {} : { connectTimeout: options.connectTimeoutMs }),
    ...(options.commandTimeoutMs === undefined ? {} : { commandTimeout: options.commandTimeoutMs }),
    ...(options.lazyConnect === undefined ? {} : { lazyConnect: options.lazyConnect }),
    ...(options.enableOfflineQueue === undefined
      ? {}
      : { enableOfflineQueue: options.enableOfflineQueue }),

    // Enforce certificate and hostname verification on the public hop. ioredis
    // turns TLS on for `rediss://` but leaves SNI unset, and a TLS session
    // without a servername validates against whatever the peer presents.
    ...(tls ? { tls: { servername: url.hostname } } : {}),

    ...(url.hostname.endsWith(FLY_PRIVATE_SUFFIX) ? { family: 6 } : {}),

    // A blocking read outlives a reconnect. With a finite per-request retry
    // budget ioredis fails the in-flight XREADGROUP instead of re-issuing it,
    // which surfaces as spurious consumer errors during a Valkey failover.
    ...(options.mode === 'worker' ? { maxRetriesPerRequest: null } : {}),
  }

  return resolved
}

/**
 * Creates the client, and always attaches an `error` listener.
 *
 * Not optional, and not the caller's to remember. An `EventEmitter` that emits
 * `error` with no listener throws, and for a socket error that means the whole
 * process dies — so an unreachable Valkey at boot would take down a collector
 * that was carefully designed to *degrade* when its queue is unavailable
 * (docs snapshot 02 §7.2), and a worker that should have kept serving `/health`
 * while the queue recovered.
 *
 * ioredis already owns the retry behaviour; the `error` event is informational.
 * The listener therefore does nothing except hand the error to `onError`, and a
 * caller that supplies none has deliberately chosen for reconnection to be
 * silent rather than fatal.
 */
export function createQueueClient(options: ValkeyConnectionOptions): Redis {
  const client = new Redis(options.url, buildConnectionOptions(options))
  client.on('error', (error: Error) => options.onError?.(error))
  return client
}

/**
 * The collector's connection to the realtime-cache instance.
 *
 * A separate client from the queue's, not a second database on one connection:
 * D-205 keeps the two instances apart so an eviction storm in losable state
 * cannot reach durable state, and sharing a socket would quietly undo that by
 * making one instance's stall the other's too.
 */
export function createRealtimeCacheClient(options: Omit<ValkeyConnectionOptions, 'mode'>): Redis {
  return createQueueClient({ ...options, mode: 'realtime-cache' })
}
