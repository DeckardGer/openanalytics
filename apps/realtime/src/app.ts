import type { KeyObject } from 'node:crypto'
import { API_VERSION } from '@openanalytics/contracts'
import type { ServiceEnv } from '@openanalytics/domain'
import {
  createLoggingMetrics,
  type Logger,
  type Metrics,
  type ServiceMetadata,
} from '@openanalytics/observability'
import { createServiceApp } from '@openanalytics/observability/hono'
import type { RealtimeCache } from '@openanalytics/redis'
import { Hono } from 'hono'
import { publicStreamCors } from './cors.ts'
import { HubManager } from './hub.ts'
import { createStreamRoute } from './stream.ts'
import type { RealtimeSubscriber } from './subscriber.ts'

/**
 * Realtime SSE gateway.
 *
 * Docs snapshot 05, D-213: the browser authenticates with a short-lived scoped
 * bearer token over `fetch` streaming, not with a native `EventSource` query
 * token. The gateway re-checks the access epoch on connect and at least every
 * keepalive, and closes fail-closed when auth state is unreachable.
 *
 * The stream mounts only when its dependencies are all present — the realtime
 * cache (command + subscriber connections) and the token verify key. Absent any
 * of them the route is simply not mounted, which an operator sees as a 404
 * rather than as a stream that cannot authenticate anyone (mirrors the collector
 * refusing to mount ingest without its queue).
 */

export interface AppDeps {
  readonly service: ServiceMetadata
  readonly logger: Logger
  readonly env: ServiceEnv<'realtime'>
  /** Command-capable realtime cache: `readPresenceSnapshot` + `getEpoch`. */
  readonly cache?: RealtimeCache
  /** The single process-wide Pub/Sub connection (a separate socket). */
  readonly subscriber?: RealtimeSubscriber
  /** Loaded Ed25519 verify key; the gateway can verify but never mint (D-213). */
  readonly verifyKey?: KeyObject
  /** Defaults to the logging sink; a test injects a recording implementation. */
  readonly metrics?: Metrics
  readonly now?: () => Date
  readonly clock?: () => number
}

export interface RealtimeApp {
  readonly app: ReturnType<typeof createServiceApp>
  /** Non-null when the stream mounted; drives graceful shutdown. */
  readonly hubs: HubManager | null
}

export function createApp(deps: AppDeps): RealtimeApp {
  // The stream's domain counters and the shared request middleware share one
  // sink, so everything flows through the same G-006 pipeline (ADR-0016).
  const metrics = deps.metrics ?? createLoggingMetrics(deps.logger)

  const app = createServiceApp({ service: deps.service, logger: deps.logger, metrics })

  // After `/health` (which stays an operator endpoint, untouched), before the
  // stream: every browser connection preflights, because the scoped token rides
  // in an `Authorization` header. See `cors.ts` for why the answer is `*`.
  app.use('*', publicStreamCors())

  const v1 = new Hono()

  const now = deps.now ?? ((): Date => new Date())
  const clock = deps.clock ?? ((): number => Date.now())

  let hubs: HubManager | null = null

  if (deps.cache !== undefined && deps.subscriber !== undefined && deps.verifyKey !== undefined) {
    hubs = new HubManager({
      subscriber: deps.subscriber,
      cache: deps.cache,
      maxVisitors: deps.env.REALTIME_SNAPSHOT_MAX_VISITORS,
      cacheSeconds: deps.env.REALTIME_SNAPSHOT_CACHE_SECONDS,
      refreshSeconds: deps.env.REALTIME_SNAPSHOT_REFRESH_SECONDS,
      metrics,
      logger: deps.logger,
      clock,
    })

    v1.route(
      '/',
      createStreamRoute({
        hubs,
        cache: deps.cache,
        verifyKey: deps.verifyKey,
        env: deps.env,
        metrics,
        logger: deps.logger,
        now,
      }),
    )
  } else {
    // Which dependency, never its value.
    deps.logger.warn('stream_routes_unmounted', {
      code: 'SERVICE_UNAVAILABLE',
      cache: deps.cache !== undefined,
      subscriber: deps.subscriber !== undefined,
      verify_key: deps.verifyKey !== undefined,
    })
  }

  app.route(`/${API_VERSION}`, v1)

  return { app, hubs }
}
