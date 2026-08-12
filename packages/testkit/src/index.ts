import { createHmac } from 'node:crypto'
import {
  createLogger,
  createServiceMetadata,
  type LogLevel,
  type Logger,
  type ServiceMetadata,
} from '@openanalytics/observability'

/**
 * Test helpers shared by the unit, contract, integration and migration projects.
 */

export interface CapturedLogger {
  readonly logger: Logger
  /** Parsed log lines, in emission order. */
  readonly lines: Record<string, unknown>[]
  /** Every line whose `msg` matches. */
  find(message: string): Record<string, unknown>[]
  clear(): void
}

/**
 * Logger that captures structured lines instead of writing to stdout.
 *
 * Assertions about redaction need the parsed object, not a formatted string —
 * a test that greps text would pass on `"[redacted]"` appearing anywhere.
 */
export function createCapturedLogger(
  options: { level?: LogLevel; service?: ServiceMetadata } = {},
): CapturedLogger {
  const lines: Record<string, unknown>[] = []
  const service =
    options.service ??
    createServiceMetadata({ name: 'test', version: '0.0.0-test', environment: 'test' })

  const logger = createLogger({
    service,
    level: options.level ?? 'debug',
    sink: (line) => {
      lines.push(JSON.parse(line) as Record<string, unknown>)
    },
    // Fixed clock so log assertions do not depend on wall time.
    now: () => new Date('2026-07-21T00:00:00.000Z'),
  })

  return {
    logger,
    lines,
    find: (message) => lines.filter((line) => line['msg'] === message),
    clear: () => {
      lines.length = 0
    },
  }
}

/**
 * Minimal env source for `loadServiceEnv`.
 *
 * Tests pass an explicit record rather than mutating `process.env`, so parallel
 * test files cannot interfere with each other.
 */
export function testEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    NODE_ENV: 'test',
    ENVIRONMENT: 'test',
    LOG_LEVEL: 'debug',
    SERVICE_VERSION: '0.0.0-test',
    GIT_COMMIT: 'testcommit',
    PORT: '3000',
    ...overrides,
  }
}

/**
 * Builds a valid `Stripe-Signature` header for a raw body, so webhook tests can
 * exercise the real verifier with a test secret. Mirrors Stripe's scheme:
 * HMAC-SHA256 of `${timestamp}.${payload}` under the endpoint secret.
 */
export function signStripeWebhook(input: {
  payload: string
  secret: string
  timestamp?: number
}): string {
  const t = input.timestamp ?? Math.floor(new Date('2026-07-22T00:00:00.000Z').getTime() / 1000)
  const signature = createHmac('sha256', input.secret).update(`${t}.${input.payload}`).digest('hex')
  return `t=${t},v1=${signature}`
}
