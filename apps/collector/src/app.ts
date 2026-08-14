import { API_VERSION } from '@openanalytics/contracts'
import type { ServiceEnv } from '@openanalytics/domain'
import type { Logger, Metrics, ServiceMetadata } from '@openanalytics/observability'
import { createServiceApp } from '@openanalytics/observability/hono'
import { Hono } from 'hono'
import { publicIngestCors } from './cors.ts'
import type { CollectorDeps } from './deps.ts'
import { createEventRoutes } from './events.ts'
import { createHeartbeatRoutes } from './heartbeat.ts'
import { createIngestLimiter } from './limiter.ts'
import { createTrackerConfigRoutes, type TrackerConfigStore } from './tracker-config.ts'
import { createTrackerScriptRoutes, type TrackerScript } from './tracker-script.ts'

/**
 * Public event intake.
 *
 * The boundaries are fixed (docs snapshot 02 §7.1): the collector never inserts
 * into ClickHouse, never updates the Postgres usage hot row, never sends email
 * and never calls a provider API. It validates, resolves versioned site ingest
 * config, and hands the event to the durable queue — and only answers 202 once
 * that queue write is durable.
 *
 * The ingest routes are mounted only when their dependencies exist. A collector
 * with no queue is not a collector that accepts events optimistically; it is one
 * whose ingest endpoints are absent, which is a 404 an operator will notice
 * rather than a 202 for events nobody stored.
 */

export interface AppDeps {
  readonly service: ServiceMetadata
  readonly logger: Logger
  readonly env: ServiceEnv<'collector'>
  /** Combined G-006 sink — the same object the ingest limiter emits its domain
   * counters through, so the request path lands in one place. When present the
   * shared middleware meters every request; optional so the M4 contract tests
   * still build a bare app. */
  readonly metrics?: Metrics
  /**
   * Resolves a tracking key to its site configuration. Without one the config
   * route answers `SERVICE_UNAVAILABLE` rather than pretending the site does not
   * exist — an unwired deployment is an operator problem, and the tracker must
   * be able to tell "no such site" from "not ready".
   */
  readonly trackerConfigStore?: TrackerConfigStore
  /**
   * `PREVIEW_TOKEN_VERIFY_KEY` (ADR-0034, D6). Absent, `?preview=` on the config
   * endpoint is ignored and the published rule set is served — a preview that
   * cannot be authenticated is served as no preview, never as an
   * unauthenticated one.
   */
  readonly previewVerifyKey?: string | undefined
  /**
   * The browser bundle, read from the image at boot. Absent, `/oa.js` is not
   * mounted at all — a 404 an operator can see, rather than an empty 200 that
   * every visitor's browser would then cache for an hour. Where Caddy fronts
   * this service it serves the file itself and this route is never reached.
   */
  readonly trackerScript?: TrackerScript
  /** Queue, realtime cache, policy and identity key. Absent in a config-only
   * deployment and in the M4 contract tests. */
  readonly ingest?: CollectorDeps
}

export function createApp(deps: AppDeps) {
  const app = createServiceApp({
    service: deps.service,
    logger: deps.logger,
    ...(deps.metrics ? { metrics: deps.metrics } : {}),
  })

  /**
   * Public CORS for the browser-facing surface.
   *
   * A plain `use('*')` is enough here, and it is registered before the `/v1`
   * routes so Hono runs it ahead of them: a preflight is answered without any
   * route handler being reached, and every ingest response carries its origin
   * headers. The api needed a whole outer Hono wrapping `app.fetch` because its
   * CORS has to cover `/health` and `/api/auth/*`, and `createServiceApp` has
   * already registered `/health` by the time `createApp` gets the app back — a
   * middleware added afterwards never runs for a route registered before it.
   * The collector wants the opposite: `/health` is an operator endpoint that no
   * browser calls, so leaving it outside this middleware keeps its behaviour
   * byte-for-byte what it was. Same mechanism, opposite requirement, simpler
   * mounting.
   */
  app.use('*', publicIngestCors())

  // GET  /oa.js                 — the tracker itself, when the image carries it
  if (deps.trackerScript) {
    app.route('/', createTrackerScriptRoutes(deps.trackerScript))
  }

  const v1 = new Hono()

  // GET  /v1/tracker/config     — public, ETag-cached tracker configuration (M4)
  v1.route('/tracker', createTrackerConfigRoutes(deps.trackerConfigStore, deps.previewVerifyKey))

  if (deps.ingest) {
    const limiter = createIngestLimiter({
      realtime: deps.ingest.realtime,
      policy: deps.ingest.policy,
      metrics: deps.ingest.metrics,
      fallback: deps.ingest.fallbackLimiter,
    })

    // POST /v1/events             — historical batch, enqueued durably (M5)
    v1.route('/events', createEventRoutes(deps.ingest, limiter))
    // POST /v1/realtime/heartbeat — realtime only; never queued or billed (M5)
    v1.route('/realtime', createHeartbeatRoutes(deps.ingest, limiter))
  }

  app.route(`/${API_VERSION}`, v1)

  return app
}
