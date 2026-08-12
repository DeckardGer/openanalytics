import type { MiddlewareHandler } from 'hono'
import { runWithRequestContext, withRequestContextFields } from '../context.ts'
import { isOwnId, newRequestId, newTraceId, traceIdFromTraceparent } from '../ids.ts'
import type { Logger } from '../logger.ts'
import type { Metrics } from '../metrics.ts'

/**
 * Establishes request/trace correlation for the whole request scope.
 *
 * An inbound `x-request-id` is only honoured when it matches an ID this system
 * mints. Client-controlled correlation keys otherwise become unbounded log
 * cardinality and let a caller forge another request's identifier.
 */

export interface RequestContextVariables {
  requestId: string
  traceId: string
  logger: Logger
}

export function requestContextMiddleware(
  logger: Logger,
  metrics?: Metrics,
): MiddlewareHandler<{ Variables: RequestContextVariables }> {
  return async (c, next) => {
    const inboundRequestId = c.req.header('x-request-id')
    const requestId =
      inboundRequestId && isOwnId(inboundRequestId) ? inboundRequestId : newRequestId()
    const traceId = traceIdFromTraceparent(c.req.header('traceparent')) ?? newTraceId()

    // Before routing resolves, `routePath` is this middleware's own mount (`/*`);
    // the matched pattern is only known once `next()` has run the router. The
    // seed value keeps nested log lines correlated until that pattern is known.
    const route = c.req.routePath
    const requestLogger = logger.child({})

    c.set('requestId', requestId)
    c.set('traceId', traceId)
    c.set('logger', requestLogger)
    c.header('x-request-id', requestId)

    const startedAt = performance.now()

    await runWithRequestContext({ requestId, traceId, route }, async () => {
      try {
        await next()
      } finally {
        // Post-await, `routePath` is the matched pattern (e.g.
        // `/v1/sites/:site_id/analytics/overview`), never the concrete path — so
        // the label stays low-cardinality. Unmatched requests keep `/*`.
        const matchedRoute = c.req.routePath
        const method = c.req.method
        const status = c.res.status
        const durationMs = Math.round(performance.now() - startedAt)

        // Logged in `finally` so a thrown request is still measured; the error
        // handler owns reporting the failure itself. The log and the metric both
        // read the matched pattern so the two stay consistent.
        withRequestContextFields({ route: matchedRoute }, () => {
          requestLogger.info('http_request', {
            method,
            route: matchedRoute,
            status,
            duration_ms: durationMs,
          })
        })

        // Generic per-request counters, when a sink is wired. The `Metrics` port
        // never throws (see metrics.ts), so this cannot break the request path,
        // and the `service` label comes from the exporter's default labels — not
        // from here. No duration gauge: a last-value gauge would misreport, and
        // the port has no histogram; duration stays on the log line above.
        //
        // `http_requests`/`http_errors`, not `http.requests`/`http.errors`: a
        // dot is not legal in a Prometheus metric name, and the dotted pair
        // never reached the backend from any service (the M18 audit).
        if (metrics) {
          const statusClass = `${Math.floor(status / 100)}xx`
          const labels = { route: matchedRoute, method, status_class: statusClass }
          metrics.increment('http_requests', labels)
          if (status >= 500) {
            metrics.increment('http_errors', labels)
          }
        }
      }
    })
  }
}
