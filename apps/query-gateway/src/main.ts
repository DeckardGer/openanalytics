import { serve } from '@hono/node-server'
import { createServiceMetrics } from '@openanalytics/observability'
import { Redis } from 'ioredis'
import { bootstrapService } from './bootstrap.ts'
import { createApp } from './app.ts'
import { ValkeyNonceStore, type NonceStore } from './nonce-store.ts'

const { env, logger, service } = bootstrapService()

// G-006 remote-write, with the structured-log floor underneath (ADR-0010,
// ADR-0015). Instance is stable per process and hostname-free.
const serviceMetrics = createServiceMetrics({
  env,
  logger,
  service: service.name,
  instance: `${service.name}-${service.commit}`,
})

/**
 * Replay defence needs state shared across instances.
 *
 * The in-memory store is only correct for a single process, and this app runs
 * more than one machine. Measured against the deployed pair, 7 of 10 replayed
 * requests were ACCEPTED, because the replay reached the instance that had not
 * seen the nonce. So the shared store is not a refinement here; without it the
 * gate item "signed gateway request passes the replay test" is simply false.
 *
 * When the URL is absent the gateway still starts, but says so loudly — the
 * single-instance case is legitimate for local development.
 */
let nonceStore: NonceStore | undefined
let redis: Redis | undefined

if (env.REALTIME_CACHE_REDIS_URL) {
  const url = env.REALTIME_CACHE_REDIS_URL
  redis = new Redis(url, {
    // ioredis enables TLS from the rediss:// scheme but leaves the SNI
    // servername unset, which weakens hostname verification on a public
    // endpoint — the same reason packages/redis pins it for the collector.
    ...(url.startsWith('rediss://') ? { tls: { servername: new URL(url).hostname } } : {}),
    maxRetriesPerRequest: 2,
  })
  redis.on('error', (error: Error) => {
    logger.error('nonce_store_connection_error', { err: error })
  })
  nonceStore = new ValkeyNonceStore({ client: redis })
  logger.info('nonce_store_shared', { backend: 'valkey' })
} else {
  logger.warn('nonce_store_in_memory', {
    code: 'REPLAY_DEFENCE_PER_INSTANCE',
    detail:
      'REALTIME_CACHE_REDIS_URL is unset, so nonces are per-process. Replay defence is only correct with a single instance.',
  })
}

const app = createApp({
  env,
  logger,
  service,
  // The already-built combined sink, so the gateway's request path reaches the
  // same G-006 pipeline the exporter lifecycle already flushes.
  metrics: serviceMetrics.metrics,
  ...(nonceStore ? { nonceStore } : {}),
})

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info('service_started', { port: info.port })
})

function shutdown(signal: string): void {
  logger.info('service_stopping', { signal })
  server.close(() => {
    // Stop the exporter (a final flush) before the sockets go, then exit.
    void serviceMetrics.stop().finally(() => {
      redis?.disconnect()
      process.exit(0)
    })
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
