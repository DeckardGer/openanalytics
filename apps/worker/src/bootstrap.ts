import { EnvValidationError, loadServiceEnv, type ServiceEnv } from '@openanalytics/domain'
import {
  createLogger,
  createServiceMetadata,
  type Logger,
  type ServiceMetadata,
} from '@openanalytics/observability'

/**
 * Startup.
 *
 * A configuration problem must fail here, loudly and completely, rather than
 * surfacing as a 500 on the first request that happens to need the missing
 * value (docs snapshot 04, Milestone 0 acceptance criteria).
 */
export function bootstrapService(): {
  env: ServiceEnv<'worker'>
  logger: Logger
  service: ServiceMetadata
} {
  let env: ServiceEnv<'worker'>
  try {
    env = loadServiceEnv('worker')
  } catch (error) {
    if (error instanceof EnvValidationError) {
      // Written directly to stderr: the logger itself is configured from env, so
      // it is not trustworthy at this point.
      process.stderr.write(`${error.message}\n`)
      process.exit(78) // EX_CONFIG
    }
    throw error
  }

  const service = createServiceMetadata({
    name: 'worker',
    version: env.SERVICE_VERSION,
    commit: env.GIT_COMMIT,
    environment: env.ENVIRONMENT,
  })

  const logger = createLogger({ service, level: env.LOG_LEVEL })
  return { env, logger, service }
}
