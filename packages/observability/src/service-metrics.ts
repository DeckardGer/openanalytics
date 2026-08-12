import type { Logger } from './logger.ts'
import { createLoggingMetrics, type Metrics } from './metrics.ts'
import {
  combineMetrics,
  createRemoteWriteMetrics,
  type RemoteWriteMetrics,
} from './remote-write.ts'

/**
 * The G-006 service-metrics wiring, once, for every long-lived service.
 *
 * Docs snapshot 05, G-006; ADR-0010. The worker proved the shape — build the
 * Prometheus remote-write exporter only when all three credentials are present,
 * combine it with the structured-log floor, and stop it last on shutdown so the
 * final seconds before a deploy are not a blind spot. ADR-0015 unblocked the
 * other services (a serverless collector had nowhere to flush from; every service
 * is a long-lived process now), so the block moved here rather than being copied
 * four more times.
 *
 * The logging sink stays the floor everywhere: stdout is collected on every host,
 * so a limit trigger is queryable even when the remote backend is unreachable —
 * which is exactly when it matters. A deployment with no remote-write credentials
 * keeps the floor and loses nothing else, and says so once at startup.
 */

/** The env fields this reads. Every `ServiceEnv` satisfies it structurally. */
export interface ServiceMetricsEnv {
  readonly METRICS_REMOTE_WRITE_URL?: string | undefined
  readonly METRICS_REMOTE_WRITE_USER?: string | undefined
  readonly METRICS_REMOTE_WRITE_TOKEN?: string | undefined
  readonly METRICS_FLUSH_INTERVAL_SECONDS: number
  readonly ENVIRONMENT: string
  readonly SERVICE_VERSION: string
}

export interface ServiceMetricsOptions {
  readonly env: ServiceMetricsEnv
  readonly logger: Logger
  /** The `service` label — the service name (`collector`, `api`, …). */
  readonly service: string
  /**
   * The `instance` label. Stable per process and low-cardinality — never a
   * per-request value, which would make every series unbounded. Callers pass a
   * per-process identity (e.g. `${service}-${GIT_COMMIT}` or the worker's
   * consumer name), mirroring the worker's own approach.
   */
  readonly instance: string
}

export interface ServiceMetrics {
  /** Combined sink: the logging floor, plus remote-write when configured. */
  readonly metrics: Metrics
  /** The exporter, or `null` when no remote-write credentials were present. */
  readonly remoteWrite: RemoteWriteMetrics | null
  /** Flushes and stops the exporter. A no-op when it was never built. */
  stop(): Promise<void>
}

/**
 * Builds the combined metrics sink for a service.
 *
 * When `METRICS_REMOTE_WRITE_URL`/`_USER`/`_TOKEN` are all present the returned
 * `metrics` fans every counter to both the logging floor and the remote-write
 * exporter; otherwise it is the logging floor alone and a single
 * `metrics_remote_write_disabled` line records the degradation.
 */
export function createServiceMetrics(options: ServiceMetricsOptions): ServiceMetrics {
  const { env, logger, service, instance } = options

  const remoteWrite: RemoteWriteMetrics | null =
    env.METRICS_REMOTE_WRITE_URL && env.METRICS_REMOTE_WRITE_USER && env.METRICS_REMOTE_WRITE_TOKEN
      ? createRemoteWriteMetrics({
          url: env.METRICS_REMOTE_WRITE_URL,
          username: env.METRICS_REMOTE_WRITE_USER,
          password: env.METRICS_REMOTE_WRITE_TOKEN,
          defaultLabels: {
            service,
            environment: env.ENVIRONMENT,
            version: env.SERVICE_VERSION,
            instance,
          },
          flushIntervalMs: env.METRICS_FLUSH_INTERVAL_SECONDS * 1_000,
          logger,
        })
      : null

  if (remoteWrite === null) {
    logger.warn('metrics_remote_write_disabled', { reason: 'no remote-write credentials' })
  }

  const logging = createLoggingMetrics(logger)
  const metrics = remoteWrite === null ? logging : combineMetrics(logging, remoteWrite)

  return {
    metrics,
    remoteWrite,
    async stop(): Promise<void> {
      await remoteWrite?.stop()
    },
  }
}
