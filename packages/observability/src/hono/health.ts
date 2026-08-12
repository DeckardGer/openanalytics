import {
  aggregateHealthStatus,
  type DependencyHealth,
  type HealthResponse,
} from '@openanalytics/contracts'
import { Hono } from 'hono'
import type { ServiceMetadata } from '../service.ts'
import type { RequestContextVariables } from './request-context.ts'

/**
 * Health endpoint shared by every HTTP service.
 *
 * A dependency check must not be able to hang the endpoint: a health probe that
 * blocks is indistinguishable from a dead process to a load balancer, so each
 * check is bounded and a timeout reports `unavailable` rather than throwing.
 */

export interface HealthCheck {
  readonly name: string
  /** Bounded by `timeoutMs`; must not throw for a normal failure. */
  check(): Promise<DependencyHealth>
}

const DEFAULT_TIMEOUT_MS = 2_000

async function runCheck(check: HealthCheck, timeoutMs: number): Promise<DependencyHealth> {
  const timeout = new Promise<DependencyHealth>((resolve) => {
    setTimeout(
      () => resolve({ name: check.name, status: 'unavailable', detail: 'timeout' }),
      timeoutMs,
    ).unref?.()
  })

  try {
    return await Promise.race([check.check(), timeout])
  } catch {
    // Detail is intentionally coarse: a health response is unauthenticated and
    // must not leak host names or driver error text.
    return { name: check.name, status: 'unavailable', detail: 'check failed' }
  }
}

export function createHealthRoute(options: {
  service: ServiceMetadata
  checks?: readonly HealthCheck[]
  timeoutMs?: number
  now?: () => Date
}): Hono<{ Variables: RequestContextVariables }> {
  const app = new Hono<{ Variables: RequestContextVariables }>()
  const checks = options.checks ?? []
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = options.now ?? (() => new Date())

  app.get('/health', async (c) => {
    const dependencies = await Promise.all(checks.map((check) => runCheck(check, timeoutMs)))
    const status = aggregateHealthStatus(dependencies)

    const body: HealthResponse = {
      status,
      service: options.service.name,
      version: options.service.version,
      commit: options.service.commit,
      environment: options.service.environment,
      time: now().toISOString(),
      dependencies,
    }

    return c.json(body, status === 'unavailable' ? 503 : 200)
  })

  return app
}
