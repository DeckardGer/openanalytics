/**
 * Service identity carried on every log line and error envelope.
 *
 * Docs snapshot 02 §26: each log must identify the service name and version so
 * a failure can be attributed to a specific deploy without correlating by hand.
 */

export const SERVICE_NAMES = [
  'api',
  'collector',
  'worker',
  'query-gateway',
  'realtime',
  'migrator',
  'test',
] as const

export type ServiceName = (typeof SERVICE_NAMES)[number]

export interface ServiceMetadata {
  readonly name: ServiceName
  /** Semver of the deployed artifact. */
  readonly version: string
  /** Commit SHA of the deployed artifact, when the build injected one. */
  readonly commit: string
  /** Deploy environment: local, ci, staging, production. */
  readonly environment: string
}

export function isServiceName(value: unknown): value is ServiceName {
  return typeof value === 'string' && (SERVICE_NAMES as readonly string[]).includes(value)
}

export function createServiceMetadata(input: {
  name: ServiceName
  version?: string | undefined
  commit?: string | undefined
  environment?: string | undefined
}): ServiceMetadata {
  return {
    name: input.name,
    version: input.version ?? '0.0.0',
    commit: input.commit ?? 'unknown',
    environment: input.environment ?? 'local',
  }
}
