import type { KeyObject } from 'node:crypto'
import { serve } from '@hono/node-server'
import { loadRealtimeVerifyKey } from '@openanalytics/auth'
import { createServiceMetrics } from '@openanalytics/observability'
import { createRealtimeCache, createRealtimeCacheClient } from '@openanalytics/redis'
import { bootstrapService } from './bootstrap.ts'
import { createApp } from './app.ts'
import { createIoRedisSubscriber } from './subscriber.ts'

const { env, logger, service } = bootstrapService()
// G-006 remote-write, with the structured-log floor underneath (ADR-0010,
// ADR-0015). Instance is stable per process and hostname-free.
const serviceMetrics = createServiceMetrics({
  env,
  logger,
  service: service.name,
  instance: `${service.name}-${service.commit}`,
})
const metrics = serviceMetrics.metrics

/**
 * Wiring.
 *
 * The stream needs three things and mounts only with all of them: a command
 * connection (presence snapshots + epoch reads), a dedicated subscriber
 * connection (a subscribed ioredis socket cannot run commands), and the token
 * verify key. Each absence is loud — the route is not mounted and an operator
 * sees a 404, never a stream that cannot authenticate.
 */
const commandClient =
  env.REALTIME_CACHE_REDIS_URL === undefined
    ? null
    : createRealtimeCacheClient({
        url: env.REALTIME_CACHE_REDIS_URL,
        connectionName: `realtime-cmd-${service.version}`,
        // A hung command must fail fast rather than wedge a connection; the
        // stream degrades or fail-closes on the error, it never hangs.
        enableOfflineQueue: false,
        onError: (error) =>
          logger.warn('realtime_cache_socket_error', { err: error, retryable: true }),
      })

const subscriberClient =
  env.REALTIME_CACHE_REDIS_URL === undefined
    ? null
    : createRealtimeCacheClient({
        url: env.REALTIME_CACHE_REDIS_URL,
        connectionName: `realtime-sub-${service.version}`,
        enableOfflineQueue: false,
        onError: (error) =>
          logger.warn('realtime_subscriber_socket_error', { err: error, retryable: true }),
      })

// Loaded eagerly so a configured-but-invalid key is a loud startup failure (a
// deployment mistake), matching the GEOIP precedent — while an unset key is an
// honest degradation that leaves the stream unmounted.
let verifyKey: KeyObject | undefined
if (env.REALTIME_TOKEN_VERIFY_KEY !== undefined) {
  try {
    verifyKey = loadRealtimeVerifyKey(env.REALTIME_TOKEN_VERIFY_KEY)
  } catch (error) {
    process.stderr.write(
      `REALTIME_TOKEN_VERIFY_KEY is not a valid Ed25519 public key: ${String(error)}\n`,
    )
    process.exit(78) // EX_CONFIG
  }
}

const cache =
  commandClient === null
    ? undefined
    : createRealtimeCache({
        client: commandClient,
        eventMaxLatenessHours: env.EVENT_MAX_LATENESS_HOURS,
      })

const subscriber = subscriberClient === null ? undefined : createIoRedisSubscriber(subscriberClient)

const { app, hubs } = createApp({
  env,
  logger,
  service,
  metrics,
  ...(cache === undefined ? {} : { cache }),
  ...(subscriber === undefined ? {} : { subscriber }),
  ...(verifyKey === undefined ? {} : { verifyKey }),
})

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info('service_started', { port: info.port })
})

function shutdown(signal: string): void {
  logger.info('service_stopping', { signal })
  // End every open stream with a reconnect-inviting control disconnect before
  // the sockets go away, so clients back off rather than seeing a bare EOF.
  hubs?.shutdown()
  server.close(() => {
    void Promise.allSettled([
      // First, so the final counters reach the last push before the sockets go.
      serviceMetrics.stop(),
      subscriber?.close(),
      commandClient?.quit(),
    ]).finally(() => process.exit(0))
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
