import { z } from 'zod'
import { utcInstantSchema } from './time.ts'

/**
 * Health and readiness.
 *
 * Docs snapshot 01 §17 lists the absence of a health/readiness and dependency
 * degradation policy as a legacy gap. `live` means the process is up; `ready`
 * means it can serve. A dependency being degraded is reported, not hidden.
 */

export const HEALTH_STATUSES = ['ok', 'degraded', 'unavailable'] as const
export type HealthStatus = (typeof HEALTH_STATUSES)[number]
export const healthStatusSchema = z.enum(HEALTH_STATUSES)

export const dependencyHealthSchema = z.object({
  name: z.string().min(1),
  status: healthStatusSchema,
  /** Never carries host, credential or connection-string detail. */
  detail: z.string().nullable(),
})

export type DependencyHealth = z.infer<typeof dependencyHealthSchema>

export const healthResponseSchema = z.object({
  status: healthStatusSchema,
  service: z.string().min(1),
  version: z.string().min(1),
  commit: z.string().min(1),
  environment: z.string().min(1),
  time: utcInstantSchema,
  dependencies: z.array(dependencyHealthSchema),
})

export type HealthResponse = z.infer<typeof healthResponseSchema>

/**
 * Aggregate status: unavailable dominates degraded, degraded dominates ok.
 *
 * A single unavailable hard dependency must not average out to `ok`.
 */
export function aggregateHealthStatus(dependencies: readonly DependencyHealth[]): HealthStatus {
  if (dependencies.some((d) => d.status === 'unavailable')) return 'unavailable'
  if (dependencies.some((d) => d.status === 'degraded')) return 'degraded'
  return 'ok'
}
