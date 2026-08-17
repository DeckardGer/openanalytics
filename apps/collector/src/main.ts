import { serve } from '@hono/node-server'
import { createServiceMetrics } from '@openanalytics/observability'
import { createDatabase, createPool } from '@openanalytics/postgres'
import {
  createEventStreamQueue,
  createQueueClient,
  createRealtimeCache,
  createRealtimeCacheClient,
} from '@openanalytics/redis'
import { bootstrapService } from './bootstrap.ts'
import { createApp } from './app.ts'
import type { CollectorDeps } from './deps.ts'
import { createFallbackLimiter } from './fallback-limiter.ts'
import { createGeoLookupFromFile } from './geoip.ts'
import { createIngestConfigStore, createTrackerConfigStore } from './ingest-config-store.ts'
import { readTrackerScript } from './tracker-script.ts'
import { collectorCloudExtension } from './cloud-extension.ts'

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
 * Every dependency is optional and every absence is loud. A collector missing
 * its queue does not accept events optimistically — its ingest routes are simply
 * not mounted, which surfaces as a 404 an operator notices, rather than as a 202
 * for events nobody stored (docs snapshot 01 §4.3).
 */
const pool = env.DATABASE_URL === undefined ? null : createPool(env.DATABASE_URL)
const db = pool === null ? null : createDatabase(pool)

const realtimeClient =
  env.REALTIME_CACHE_REDIS_URL === undefined
    ? null
    : createRealtimeCacheClient({
        url: env.REALTIME_CACHE_REDIS_URL,
        connectionName: `collector-rt-${service.version}`,
        // Same reasoning as the queue client below, and more so: this store's
        // failure is a *degradation* (G-005's bounded fail-open), and a
        // degradation that hangs the request is indistinguishable from an outage.
        enableOfflineQueue: false,
        onError: (error) =>
          logger.warn('realtime_cache_socket_error', { err: error, retryable: true }),
      })

const realtimeCache =
  realtimeClient === null
    ? null
    : createRealtimeCache({
        client: realtimeClient,
        eventMaxLatenessHours: env.EVENT_MAX_LATENESS_HOURS,
        // The collector writes the daily ceiling counter; the worker reads it
        // back as the streak memory the G-005 alert needs, so the retention
        // has to be decided here where the key is created.
        ceilingHistoryDays: env.SITE_CEILING_ALERT_CONSECUTIVE_DAYS,
      })

/**
 * The hosted quota and suspension gates (`cloud-extension.ts`), when this build
 * registered them — which is `main.cloud.ts` and nothing else.
 *
 * Built here rather than at import time because it needs exactly what the ingest
 * routes need, and it must be the *same* objects: the pool the config read uses
 * and the counter instance presence writes to. It is built before the config
 * store so the store can hand it a cache miss to decorate.
 */
const cloudFactory = collectorCloudExtension()
const cloud =
  cloudFactory && db && realtimeCache
    ? cloudFactory.create({ db, realtime: realtimeCache, metrics, policy: env })
    : undefined
if (cloudFactory && cloud === undefined) {
  logger.warn('cloud_extension_unmounted', {
    reason: 'DATABASE_URL or REALTIME_CACHE_REDIS_URL missing',
    extension: cloudFactory.name,
  })
} else if (cloud) {
  logger.info('cloud_extension_mounted', { extension: cloud.name })
}

const configStore =
  db === null
    ? null
    : createIngestConfigStore({
        db,
        policy: env,
        // The facts the hosted gates read, resolved on a cache miss and cached
        // with the config so no per-event round trip is added.
        ...(cloud ? { decorate: (resolved) => cloud.decorateConfig(resolved) } : {}),
      })

const trackerConfigStore =
  configStore === null ? undefined : createTrackerConfigStore(configStore)

const queueClient =
  env.EVENT_STREAM_REDIS_URL === undefined
    ? null
    : createQueueClient({
        mode: 'collector',
        url: env.EVENT_STREAM_REDIS_URL,
        connectionName: `collector-${service.version}`,
        // A queue write that hangs burns the whole invocation and answers
        // nothing. Failing fast is what turns an outage into the 503 the tracker
        // retries (docs snapshot 02 §7.2).
        enableOfflineQueue: false,
        // A socket error is a degradation, never a reason to stop serving. The
        // factory attaches the listener regardless; this decides where it lands.
        onError: (error) => logger.warn('queue_socket_error', { err: error, retryable: true }),
      })

// Loaded eagerly so a configured-but-unreadable database fails startup loudly
// (a deployment mistake), while an unset path is an honest degradation: every
// event simply carries null geo (ADR-0015 addendum).
const geo = env.GEOIP_DB_PATH === undefined ? undefined : createGeoLookupFromFile(env.GEOIP_DB_PATH)
logger.info(geo === undefined ? 'geoip_not_configured' : 'geoip_loaded', {
  configured: geo !== undefined,
})

const ingest: CollectorDeps | undefined =
  configStore && queueClient && realtimeCache && env.ANONYMOUS_IDENTITY_SECRET
    ? {
        configStore,
        queue: createEventStreamQueue({ client: queueClient, policy: env }),
        realtime: realtimeCache,
        policy: env,
        identityKey: {
          secret: env.ANONYMOUS_IDENTITY_SECRET,
          keyVersion: env.ANONYMOUS_IDENTITY_KEY_VERSION,
        },
        metrics,
        fallbackLimiter: createFallbackLimiter({
          perMinute: env.LIMITER_FALLBACK_IP_PER_MINUTE,
          maxEntries: env.LIMITER_FALLBACK_LRU_ENTRIES,
        }),
        ...(geo === undefined ? {} : { geo }),
        ...(cloud ? { cloud } : {}),
      }
    : undefined

if (ingest === undefined) {
  logger.warn('ingest_routes_unmounted', {
    code: 'SERVICE_UNAVAILABLE',
    // Which dependency, never its value.
    database: pool !== null,
    queue: queueClient !== null,
    realtime: realtimeClient !== null,
    identity_key: env.ANONYMOUS_IDENTITY_SECRET !== undefined,
  })
}

// The browser bundle, read once. Where Caddy fronts this service it serves the
// file itself and this is never reached; on a platform install there is no Caddy
// and this is the only thing that answers the URL in every install snippet.
const trackerScript = readTrackerScript()
if (trackerScript === undefined) {
  logger.warn('tracker_script_unmounted', {
    reason: 'no bundle at apps/tracker/bundle/oa.js — run `pnpm run tracker:build`',
  })
} else {
  logger.info('tracker_script_mounted', {
    bytes: trackerScript.body.byteLength,
    gzipped_bytes: trackerScript.gzipped.byteLength,
  })
}

const app = createApp({
  env,
  logger,
  service,
  // The same combined sink the ingest limiter already emits through, so the
  // request path flows into one place (ADR-0016).
  metrics,
  ...(trackerConfigStore === undefined ? {} : { trackerConfigStore }),
  ...(trackerScript === undefined ? {} : { trackerScript }),
  ...(ingest === undefined ? {} : { ingest }),
})

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info('service_started', { port: info.port })
})

function shutdown(signal: string): void {
  logger.info('service_stopping', { signal })
  server.close(() => {
    void Promise.allSettled([
      // First, so the final counters reach the last push before the sockets go.
      serviceMetrics.stop(),
      pool?.end(),
      queueClient?.quit(),
      realtimeClient?.quit(),
    ]).finally(() => process.exit(0))
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
