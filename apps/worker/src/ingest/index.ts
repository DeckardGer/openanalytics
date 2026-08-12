import { createEventsIngest, createSessionFactsStore } from '@openanalytics/clickhouse'
import { loadSessionConfig, type ServiceEnv } from '@openanalytics/domain'
import {
  createServiceMetrics,
  type Logger,
  type Metrics,
  type ServiceMetrics,
} from '@openanalytics/observability'
import { filterFinalizableSites, type Database } from '@openanalytics/postgres'
import {
  createEventStreamConsumer,
  createQueueClient,
  createQueueMaintenance,
  createRealtimeCache,
} from '@openanalytics/redis'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { IngestDeps } from './deps.ts'
import { createIngestLoop, type IngestLoop } from './loop.ts'
import { startOperationsJobs, type OperationsJobHandle } from './operations-job.ts'
import { startRetentionTrimmer, type TrimmerHandle } from './trimmer.ts'
import {
  createPostgresFinalizerState,
  startSessionFinalizer,
  type FinalizerDeps,
  type SessionFinalizerHandle,
} from '../sessions/index.ts'

/**
 * Wiring for the batch ingest pipeline.
 *
 * Started only when the worker actually holds every credential the path needs.
 * A partially-configured ingest is worse than none: a consumer group that reads
 * messages it cannot insert would take delivery of events and hold them pending
 * until its lease expired, over and over.
 */

export interface IngestRuntime {
  readonly loop: IngestLoop
  stop(): Promise<void>
}

export interface StartIngestOptions {
  readonly env: ServiceEnv<'worker'>
  readonly logger: Logger
  readonly db: Database
  /**
   * Injected when the process already owns a metrics pipeline — the worker's
   * other jobs need one too, and two pushers from one process would report the
   * same worker under two instance labels.
   */
  readonly metrics?: Metrics
  /** Injected alongside `metrics`, so the instance label and the consumer identity stay the same string. */
  readonly consumerName?: string
}

/**
 * Identity for the pending list and the manifest lease.
 *
 * Distinct per process, deliberately: a restarted worker must *not* inherit its
 * predecessor's consumer identity, or its predecessor's un-ACKed messages would
 * stay attributed to a consumer that is making no progress. They are recovered
 * through `XAUTOCLAIM` and the manifest lease instead, both of which are driven
 * by idle time rather than by a name.
 */
export function consumerNameFor(env: ServiceEnv<'worker'>): string {
  return `${hostname()}-${env.SERVICE_VERSION}-${randomUUID().slice(0, 8)}`
}

export function ingestCredentialsPresent(env: ServiceEnv<'worker'>): boolean {
  return Boolean(
    env.EVENT_STREAM_REDIS_URL &&
    env.CLICKHOUSE_URL &&
    env.CLICKHOUSE_INGEST_USER &&
    env.CLICKHOUSE_INGEST_PASSWORD,
  )
}

export function startIngest(options: StartIngestOptions): IngestRuntime | null {
  const { env, logger, db } = options
  if (!ingestCredentialsPresent(env)) {
    logger.warn('ingest_not_started', {
      reason: 'queue or ClickHouse credentials missing',
    })
    return null
  }

  const consumerName = options.consumerName ?? consumerNameFor(env)

  // G-006: the vendor sits behind the port, and the logging sink stays the floor
  // underneath it (see `createServiceMetrics`). The instance label is the
  // consumer name — stable per process and already unique per worker. Created
  // only when the caller has no pipeline of its own; a second one would push a
  // second series for the same process.
  const serviceMetrics: ServiceMetrics | null = options.metrics
    ? null
    : createServiceMetrics({ env, logger, service: 'worker', instance: consumerName })

  const metrics = options.metrics ?? (serviceMetrics as ServiceMetrics).metrics
  // `worker` mode: this hop is inside the provider's private network, so it is
  // a native connection rather than the TLS+AUTH public hop D-206 requires of
  // the collector. The mode describes the hop, not the instance.
  const queueClient = createQueueClient({
    mode: 'worker',
    url: env.EVENT_STREAM_REDIS_URL as string,
    connectionName: `worker-ingest-${consumerName}`,
    onError: (error) => logger.warn('queue_socket_error', { err: error, retryable: true }),
  })

  // Optional: the near-realtime counter is reconstructible state, and its
  // absence degrades the reconciliation rather than the ingest (ADR-0009).
  const cacheClient = env.REALTIME_CACHE_REDIS_URL
    ? createQueueClient({
        mode: 'worker',
        url: env.REALTIME_CACHE_REDIS_URL,
        connectionName: `worker-usage-${consumerName}`,
        onError: (error) =>
          logger.warn('usage_counter_socket_error', { err: error, retryable: true }),
      })
    : null

  const clickhouse = createEventsIngest({
    url: env.CLICKHOUSE_URL as string,
    username: env.CLICKHOUSE_INGEST_USER as string,
    password: env.CLICKHOUSE_INGEST_PASSWORD as string,
    database: env.CLICKHOUSE_DB,
  })

  const deps: IngestDeps = {
    db,
    consumer: createEventStreamConsumer({ client: queueClient, consumerName }),
    maintenance: createQueueMaintenance({ client: queueClient }),
    clickhouse,
    cache: cacheClient
      ? createRealtimeCache({
          client: cacheClient,
          eventMaxLatenessHours: env.EVENT_MAX_LATENESS_HOURS,
          ceilingHistoryDays: env.SITE_CEILING_ALERT_CONSECUTIVE_DAYS,
        })
      : null,
    logger,
    metrics,
    policy: env,
    consumerName,
    streamName: 'event_stream',
    consumerGroup: 'ingest_workers',
    now: () => new Date(),
  }

  const loop = createIngestLoop({ deps })
  const trimmer: TrimmerHandle = startRetentionTrimmer(deps)
  const operations: OperationsJobHandle = startOperationsJobs(deps)

  // The M8 session finalizer shares the ingest credential — ADR-0005 widened
  // oa_ingest to SELECT ON analytics.* beside its INSERT, which is exactly what
  // recompute needs — and the same Postgres pool for its per-site lease.
  const sessionStore = createSessionFactsStore({
    url: env.CLICKHOUSE_URL as string,
    username: env.CLICKHOUSE_INGEST_USER as string,
    password: env.CLICKHOUSE_INGEST_PASSWORD as string,
    database: env.CLICKHOUSE_DB,
  })
  const finalizerDeps: FinalizerDeps = {
    store: sessionStore,
    state: createPostgresFinalizerState({
      db,
      claimedBy: consumerName,
      leaseTtlMs: env.WORKER_LEASE_TTL_MS,
      now: () => new Date(),
    }),
    // The lifecycle fence (ADR-0030, decision 7). Postgres is the authority on
    // whether a site discovered in ClickHouse may still be written to.
    filterFinalizable: (siteIds) => filterFinalizableSites(db, siteIds),
    sessionConfig: loadSessionConfig(),
    latenessMs: env.EVENT_MAX_LATENESS_HOURS * 60 * 60 * 1000,
    logger,
    metrics,
    now: () => new Date(),
  }
  const finalizer: SessionFinalizerHandle = startSessionFinalizer(finalizerDeps)

  void loop.run()
  logger.info('ingest_started', { consumer: consumerName })

  return {
    loop,
    async stop(): Promise<void> {
      // Order matters on the way out too: stop consuming and let the in-flight
      // batch reach a decided state before any connection it needs is closed.
      await loop.stop()
      await trimmer.stop()
      await operations.stop()
      await finalizer.stop()
      // After the loop, so the final batch's counters are in the last push and
      // the seconds before a deploy are not a blind spot. Null when the caller
      // owns the pipeline; then it stops it after this returns, for the same
      // reason.
      await serviceMetrics?.stop()
      await clickhouse.close()
      await sessionStore.close()
      queueClient.disconnect()
      cacheClient?.disconnect()
    },
  }
}

export { createIngestLoop, processMessages, recoverManifests, type IngestLoop } from './loop.ts'
export { runManifest, type BatchOutcome } from './pipeline.ts'
export {
  createFirstEventFill,
  firstEventCandidatesFor,
  type FirstEventFill,
  type FirstEventFillDeps,
} from './first-event.ts'
export { runRetentionTrim, startRetentionTrimmer } from './trimmer.ts'
export {
  runCeilingDayCheck,
  runUsageReconciliation,
  type CeilingAlert,
  type ReconciliationReport,
} from './operations.ts'
export {
  afterUsageApplied,
  computeUsageAttribution,
  registerUsageAttributionExtension,
  type UsageAttribution,
  type UsageAttributionExtension,
  type UsageWindowFacts,
} from './usage.ts'
export { startOperationsJobs, type OperationsJobHandle } from './operations-job.ts'
export { OpenBatch } from './batcher.ts'
export { WORKER_METRICS } from './metrics.ts'
export type { IngestDeps } from './deps.ts'
