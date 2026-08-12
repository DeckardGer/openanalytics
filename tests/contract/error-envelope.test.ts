import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  ApiError,
  ERROR_CODES,
  buildErrorEnvelope,
  errorEnvelopeSchema,
  isRetryableErrorCode,
  statusForErrorCode,
} from '@openanalytics/contracts'
import { describe, expect, it } from 'vitest'

const SPEC_PATH = fileURLToPath(
  new URL('../../packages/contracts/openapi/openapi.yaml', import.meta.url),
)

describe('error envelope', () => {
  it('matches the documented shape', () => {
    const envelope = buildErrorEnvelope({
      code: 'SITE_NOT_FOUND',
      message: 'Site not found',
      requestId: 'req_123',
    })

    expect(errorEnvelopeSchema.parse(envelope)).toEqual({
      error: {
        code: 'SITE_NOT_FOUND',
        message: 'Site not found',
        request_id: 'req_123',
        details: {},
      },
    })
  })

  it('keeps the OpenAPI enum and the runtime catalog in sync', async () => {
    // The generated client and the server must not disagree about which codes
    // exist. Drift here shows up as an unhandled error state in the frontend.
    const spec = await readFile(SPEC_PATH, 'utf8')

    for (const code of ERROR_CODES) {
      expect(spec, `openapi.yaml is missing error code ${code}`).toContain(`- ${code}`)
    }
  })

  it('maps each code to exactly one status', () => {
    for (const code of ERROR_CODES) {
      const status = statusForErrorCode(code)
      expect(Number.isInteger(status)).toBe(true)
      expect(status).toBeGreaterThanOrEqual(200)
      expect(status).toBeLessThan(600)
    }
  })

  it('marks queue and provider failures retryable', () => {
    // Docs snapshot 02 §7.2: a queue write failure must be a retryable 503, so a
    // tracker knows to send the event again rather than dropping it.
    expect(isRetryableErrorCode('SERVICE_UNAVAILABLE')).toBe(true)
    expect(isRetryableErrorCode('PROVIDER_UNAVAILABLE')).toBe(true)
    expect(isRetryableErrorCode('RATE_LIMITED')).toBe(true)

    // A rejected event must not be retried; it will be rejected again.
    expect(isRetryableErrorCode('VALIDATION_FAILED')).toBe(false)
    expect(isRetryableErrorCode('IDEMPOTENCY_CONFLICT')).toBe(false)
  })

  it('separates the three authorization answers', () => {
    // The frontend distinguishes "log in" (401) from "no permission" (403), and a
    // suspended site is the second of those: `SITE_SUSPENDED` replaced
    // `BILLING_BLOCKED` and its 402 in the open-core split, because a product
    // contract with no plans has nothing to charge for. The payment statuses the
    // hosted surface adds — including `QUOTA_EXCEEDED`, which the tracker must not
    // retry — are pinned in `tests/contract/cloud/error-envelope.test.ts`.
    expect(statusForErrorCode('UNAUTHENTICATED')).toBe(401)
    expect(statusForErrorCode('FORBIDDEN')).toBe(403)
    expect(statusForErrorCode('SITE_SUSPENDED')).toBe(403)
    expect(isRetryableErrorCode('SITE_SUSPENDED')).toBe(false)
  })
})

describe('ApiError', () => {
  it('carries the default status for its code', () => {
    expect(new ApiError('RATE_LIMITED', 'slow down').status).toBe(429)
  })

  it('can withhold an internal message from clients', () => {
    const error = new ApiError('INTERNAL_ERROR', 'pg: connection refused to 10.0.0.4', {
      expose: false,
    })
    expect(error.expose).toBe(false)
  })
})
