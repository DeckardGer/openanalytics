import { getRequestContext } from './context.ts'
import { REDACTED, isSensitiveKey, redact } from './redact.ts'
import type { ServiceMetadata } from './service.ts'

/**
 * Structured JSON logger.
 *
 * Dependency-free on purpose: the logger is imported by every service including
 * the collector hot path, and a logging library is not worth a supply-chain or
 * startup-cost surface at this boundary. One line of JSON per event, redacted.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

const LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value)
}

/** Structured fields attached to a single log line. */
export interface LogFields {
  /** Stable machine-readable error code, matching the API error catalog. */
  code?: string
  /** Whether the caller may retry; makes alert rules expressible. */
  retryable?: boolean
  err?: unknown
  [key: string]: unknown
}

export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  /** Returns a logger that merges `fields` into every subsequent line. */
  child(fields: LogFields): Logger
}

export interface LoggerOptions {
  readonly service: ServiceMetadata
  readonly level?: LogLevel
  /** Injectable sink; tests capture lines instead of writing to stdout. */
  readonly sink?: (line: string) => void
  /** Injectable clock, so log assertions are deterministic. */
  readonly now?: () => Date
}

function defaultSink(line: string): void {
  process.stdout.write(`${line}\n`)
}

export function createLogger(options: LoggerOptions): Logger {
  const minSeverity = LEVEL_SEVERITY[options.level ?? 'info']
  const sink = options.sink ?? defaultSink
  const now = options.now ?? (() => new Date())

  function emit(level: LogLevel, message: string, bound: LogFields, fields?: LogFields): void {
    if (LEVEL_SEVERITY[level] < minSeverity) return

    const context = getRequestContext()
    const merged = { ...bound, ...fields }

    const line: Record<string, unknown> = {
      time: now().toISOString(),
      level,
      msg: message,
      service: options.service.name,
      version: options.service.version,
      commit: options.service.commit,
      env: options.service.environment,
    }

    if (context) {
      line['request_id'] = context.requestId
      line['trace_id'] = context.traceId
      if (context.route !== undefined) line['route'] = context.route
      if (context.siteId !== undefined) line['site_id'] = context.siteId
      if (context.userId !== undefined) line['user_id'] = context.userId
      // Present only on a grant-authenticated request (ADR-0051 D10). A client
      // id and a grant id are opaque identifiers, never credentials — the token
      // itself is neither here nor anywhere a log line can reach it.
      if (context.clientId !== undefined) line['client_id'] = context.clientId
      if (context.grantId !== undefined) line['grant_id'] = context.grantId
    }

    for (const [key, value] of Object.entries(merged)) {
      if (value === undefined) continue
      // Reserved keys stay owned by the logger so alert queries stay stable.
      if (key in line) continue
      // The top-level key needs the same check as a nested one. `redact` only
      // inspects keys it walks *into*, so a caller passing `{ token: '...' }`
      // would otherwise be logged verbatim.
      line[key] = isSensitiveKey(key) ? REDACTED : redact(value)
    }

    try {
      sink(JSON.stringify(line))
    } catch {
      // A logger that throws converts an observable failure into a silent one.
      // Fall back to the minimum viable line rather than propagating.
      sink(
        JSON.stringify({ time: now().toISOString(), level: 'error', msg: 'log_serialize_failed' }),
      )
    }
  }

  function build(bound: LogFields): Logger {
    return {
      debug: (message, fields) => emit('debug', message, bound, fields),
      info: (message, fields) => emit('info', message, bound, fields),
      warn: (message, fields) => emit('warn', message, bound, fields),
      error: (message, fields) => emit('error', message, bound, fields),
      child: (fields) => build({ ...bound, ...fields }),
    }
  }

  return build({})
}
