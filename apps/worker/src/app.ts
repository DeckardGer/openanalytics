import type { ServiceEnv } from '@openanalytics/domain'
import type { Logger, ServiceMetadata } from '@openanalytics/observability'
import { createServiceApp } from '@openanalytics/observability/hono'

/**
 * Batch worker health surface.
 *
 * The worker is a long-running hosted process, not a request handler — it is
 * the only component allowed to insert into ClickHouse (docs snapshot 02 §7.5).
 * It still serves `/health` so orchestration can tell "process is up" apart
 * from "queue consumer is making progress".
 *
 * Milestone 0 ships the health surface and the graceful-shutdown contract; the
 * consumer loop lands in Milestone 6.
 */

export interface AppDeps {
  readonly service: ServiceMetadata
  readonly logger: Logger
  readonly env: ServiceEnv<'worker'>
}

export function createApp(deps: AppDeps) {
  const app = createServiceApp({ service: deps.service, logger: deps.logger })

  // The worker exposes no business routes; its work is queue-driven.

  return app
}
