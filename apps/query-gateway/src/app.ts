import { API_VERSION } from '@openanalytics/contracts'
import type { ServiceEnv } from '@openanalytics/domain'
import type { Logger, Metrics, ServiceMetadata } from '@openanalytics/observability'
import { createServiceApp } from '@openanalytics/observability/hono'
import { Hono } from 'hono'
import { boundedBody, signedRequestAuth, type SignedRequestVariables } from './auth.ts'
import type { ClickHouseReader } from './clickhouse.ts'
import { createHttpClickHouseReader, createUnconfiguredReader } from './clickhouse-http.ts'
import { concurrencyLimit, rateLimit } from './limits.ts'
import { InMemoryNonceStore, type NonceStore } from './nonce-store.ts'
import { QueryCache } from './query-cache.ts'
import { createQueryRoute } from './route.ts'
import { loadVerifyKey } from '@openanalytics/auth'

/**
 * Host-side query gateway.
 *
 * The only path from an outside caller to private ClickHouse (docs snapshot 05,
 * D-208).
 * It accepts a versioned operation ID with typed parameters — never raw SQL, a
 * table name or a free-form filter — verifies a short-lived service signature
 * bound to method, path, body hash and audience, and connects to ClickHouse with
 * a read-only credential.
 *
 * Middleware order on `/v1/query` is load-bearing:
 *
 * 1. `boundedBody` — cap and capture the bytes before anything hashes or parses
 *    them, so an oversized payload is cheap to refuse.
 * 2. `signedRequestAuth` — no unauthenticated request may consume a query slot.
 * 3. `rateLimit` (only when configured) — keyed by the now-known signing key ID.
 * 4. `concurrencyLimit` — held for the duration of the ClickHouse call only.
 */

export interface AppDeps {
  readonly service: ServiceMetadata
  readonly logger: Logger
  readonly env: ServiceEnv<'query-gateway'>
  /** Combined G-006 sink. When present, the shared middleware meters every
   * request (`http_requests`/`http_errors`); optional so the request-path tests
   * still build a bare app. */
  readonly metrics?: Metrics
  /** Injectable so tests exercise the request path without infrastructure. */
  readonly reader?: ClickHouseReader
  /** In-memory by default; a Redis-backed store is the multi-instance answer. */
  readonly nonceStore?: NonceStore
  /** Injectable so a test can disable caching or drive it with a fake clock. */
  readonly cache?: QueryCache | null
  readonly now?: () => Date
}

function readerFor(deps: AppDeps): ClickHouseReader {
  if (deps.reader) return deps.reader

  const { CLICKHOUSE_URL, CLICKHOUSE_READ_USER, CLICKHOUSE_READ_PASSWORD, CLICKHOUSE_DB } = deps.env
  if (!CLICKHOUSE_URL || !CLICKHOUSE_READ_USER || !CLICKHOUSE_READ_PASSWORD) {
    return createUnconfiguredReader()
  }

  return createHttpClickHouseReader({
    url: CLICKHOUSE_URL,
    database: CLICKHOUSE_DB,
    username: CLICKHOUSE_READ_USER,
    password: CLICKHOUSE_READ_PASSWORD,
  })
}

export function createApp(deps: AppDeps) {
  const app = createServiceApp({
    service: deps.service,
    logger: deps.logger,
    ...(deps.metrics ? { metrics: deps.metrics } : {}),
  })

  const v1 = new Hono<{ Variables: SignedRequestVariables }>()

  const publicKey = deps.env.QUERY_SIGNING_PUBLIC_KEY
  if (publicKey === undefined) {
    // Refusing to mount is safer than mounting an endpoint that cannot
    // authenticate anyone: there is no configuration mistake that turns this
    // into an open query surface.
    deps.logger.warn('query_route_disabled', { reason: 'QUERY_SIGNING_PUBLIC_KEY is not set' })
  } else {
    v1.use(
      '/query',
      boundedBody({ maxBytes: deps.env.QUERY_MAX_BODY_BYTES }),
      signedRequestAuth({
        verifyKey: loadVerifyKey(publicKey),
        audience: deps.env.QUERY_GATEWAY_AUDIENCE ?? `query-gateway:${deps.env.ENVIRONMENT}`,
        ...(deps.env.QUERY_SIGNING_KEY_ID ? { keyId: deps.env.QUERY_SIGNING_KEY_ID } : {}),
        nonceStore: deps.nonceStore ?? new InMemoryNonceStore(),
        maxLifetimeMs: deps.env.QUERY_SIGNATURE_MAX_LIFETIME_MS,
        ...(deps.now ? { now: deps.now } : {}),
      }),
    )

    if (deps.env.QUERY_RATE_LIMIT_PER_MINUTE !== undefined) {
      v1.use('/query', rateLimit({ requestsPerMinute: deps.env.QUERY_RATE_LIMIT_PER_MINUTE }))
    } else {
      // Stated once at startup so "no rate limit" is an observed configuration,
      // not an assumption. Gate G-005 in docs snapshot 05 owns the values.
      deps.logger.warn('query_rate_limit_unconfigured', { gate: 'G-005' })
    }

    v1.use('/query', concurrencyLimit({ maxConcurrent: deps.env.QUERY_MAX_CONCURRENCY }))

    // `null` disables the cache explicitly; `undefined` gets the default bounded
    // in-process cache sized from typed config.
    const cache =
      deps.cache === null
        ? undefined
        : (deps.cache ??
          new QueryCache({
            maxEntries: deps.env.QUERY_CACHE_MAX_ENTRIES,
            ttlMs: deps.env.QUERY_CACHE_TTL_MS,
          }))

    v1.route(
      '/',
      createQueryRoute({
        reader: readerFor(deps),
        timeoutMs: deps.env.QUERY_TIMEOUT_MS,
        clickhouseSettings: {
          max_execution_time: deps.env.QUERY_CH_MAX_EXECUTION_SECONDS,
          max_result_rows: deps.env.QUERY_CH_MAX_RESULT_ROWS,
          // With a hard result cap set, refuse rather than silently truncate;
          // each operation's own LIMIT/maxRows keeps well under the cap, so
          // hitting it means something unexpected produced too many rows.
          result_overflow_mode: 'throw',
        },
        finalizedCacheTtlMs: deps.env.QUERY_CACHE_FINALIZED_TTL_MS,
        ...(cache ? { cache } : {}),
      }),
    )
  }

  app.route(`/${API_VERSION}`, v1)

  return app
}
