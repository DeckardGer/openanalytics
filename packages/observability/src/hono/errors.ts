import { ApiError, buildErrorEnvelope, statusForErrorCode } from '@openanalytics/contracts'
import type { Context, ErrorHandler, NotFoundHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { RequestContextVariables } from './request-context.ts'

/**
 * Single place that turns a thrown value into the canonical error envelope.
 *
 * Docs snapshot 02 §18 and 03 §6.1. Two rules matter here:
 *
 * - An unexpected exception never leaks its message to a client. Legacy leaked
 *   internal error text through import and AI routes (docs snapshot 01 §11.5).
 * - A failure is logged once, with its code, so alert rules can key on `code`
 *   rather than on message substrings.
 */

type Env = { Variables: RequestContextVariables }

function requestIdOf(c: Context<Env>): string {
  // The context middleware always sets this; the fallback only covers a throw
  // that happens before it ran.
  return c.get('requestId') ?? 'req_unknown'
}

export const errorEnvelopeHandler: ErrorHandler<Env> = (err, c) => {
  const requestId = requestIdOf(c)
  const logger = c.get('logger')

  if (err instanceof ApiError) {
    logger?.warn('request_failed', {
      code: err.code,
      status: err.status,
      retryable: err.status >= 500,
      err,
    })
    return c.json(
      buildErrorEnvelope({
        code: err.code,
        message: err.expose ? err.message : 'Request failed',
        requestId,
        details: err.details,
      }),
      err.status as 400,
    )
  }

  if (err instanceof HTTPException) {
    const code = err.status === 404 ? 'NOT_FOUND' : 'VALIDATION_FAILED'
    logger?.warn('request_failed', { code, status: err.status, err })
    return c.json(buildErrorEnvelope({ code, message: err.message, requestId }), err.status)
  }

  logger?.error('unhandled_error', {
    code: 'INTERNAL_ERROR',
    retryable: false,
    err,
  })

  return c.json(
    buildErrorEnvelope({
      code: 'INTERNAL_ERROR',
      // Deliberately generic: the detail lives in the logs, keyed by request_id.
      message: 'Internal error',
      requestId,
    }),
    statusForErrorCode('INTERNAL_ERROR') as 500,
  )
}

export const notFoundHandler: NotFoundHandler<Env> = (c) =>
  c.json(
    buildErrorEnvelope({
      code: 'NOT_FOUND',
      message: 'Route not found',
      requestId: requestIdOf(c),
    }),
    404,
  )
