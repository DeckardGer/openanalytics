import { Hono } from 'hono'
import type { Logger } from '../logger.ts'
import type { Metrics } from '../metrics.ts'
import type { ServiceMetadata } from '../service.ts'
import { errorEnvelopeHandler, notFoundHandler } from './errors.ts'
import { createHealthRoute, type HealthCheck } from './health.ts'
import { requestContextMiddleware, type RequestContextVariables } from './request-context.ts'

/**
 * Wires the request-context, error-envelope and health concerns every HTTP
 * service needs, so a new service cannot accidentally ship without them.
 */

export interface ServiceAppOptions {
  readonly service: ServiceMetadata
  readonly logger: Logger
  readonly checks?: readonly HealthCheck[]
  readonly now?: () => Date
  /**
   * Optional counter sink. When present, every request increments
   * `http_requests` (and `http_errors` on a 5xx) labelled by matched route,
   * method and status class — so a service's request path is visible in the
   * same G-006 pipeline its domain counters already reach. Optional so a bare
   * app (tests, a store-less boot) still constructs without a metrics backend.
   */
  readonly metrics?: Metrics
}

export function createServiceApp(
  options: ServiceAppOptions,
): Hono<{ Variables: RequestContextVariables }> {
  const app = new Hono<{ Variables: RequestContextVariables }>()

  app.use('*', requestContextMiddleware(options.logger, options.metrics))
  app.onError(errorEnvelopeHandler)
  app.notFound(notFoundHandler)

  app.route(
    '/',
    createHealthRoute({
      service: options.service,
      ...(options.checks ? { checks: options.checks } : {}),
      ...(options.now ? { now: options.now } : {}),
    }),
  )

  return app
}
