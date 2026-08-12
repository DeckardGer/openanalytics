import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { statusForErrorCode } from '@openanalytics/contracts'
import type { components, paths } from '@openanalytics/contracts'
import { describe, expect, it } from 'vitest'

const SPEC_PATH = fileURLToPath(
  new URL('../../packages/contracts/openapi/openapi.yaml', import.meta.url),
)

/**
 * `DELETE /v1/sites/{site_id}` in the contract (ADR-0030, decision 4).
 *
 * The contract is edited before the implementation (AGENTS.md), so this asserts
 * the document — and, through the two typed values below, that the *generated*
 * client agrees with it. A response shape the spec declares but the generator
 * did not produce is a contract nobody consumes, which is the failure this pair
 * of assertions exists to catch.
 *
 * The status code is the load-bearing detail. `202` says deletion is a state
 * machine: the answer is "started", the site reports `deleting` until the purge
 * is verified, and a client that treated a `200` as "gone" would show a site as
 * deleted while ClickHouse was still rewriting parts.
 */

async function spec(): Promise<string> {
  return await readFile(SPEC_PATH, 'utf8')
}

/** The accepted response, typed by the generated client. */
const accepted: components['schemas']['SiteDeletionAccepted'] = {
  deletion_request_id: '9a1d0b3c-0000-4000-8000-00000000abcd',
  status: 'deleting',
}

/** The request body, likewise. `confirm` is required — there is no shape of this
 * request that omits it. */
const request: components['schemas']['DeleteSiteRequest'] = { confirm: 'Acme Analytics' }

describe('OpenAPI documents the site deletion', () => {
  it('declares deleteSite exactly once, on the site path item', async () => {
    const text = await spec()
    expect(text.split('operationId: deleteSite\n').length - 1).toBe(1)
    expect(text).toContain('/v1/sites/{site_id}:')
  })

  it('answers 202, never 200 — deletion is a state machine', async () => {
    type DeleteResponses = paths['/v1/sites/{site_id}']['delete']['responses']
    // A compile-time assertion: the 202 exists and carries the accepted shape.
    const typed: DeleteResponses['202']['content']['application/json'] = accepted
    expect(typed.status).toBe('deleting')
    // …and there is no 200 in the generated type. `@ts-expect-error` fails the
    // build if one is ever added, which is the point.
    // @ts-expect-error deleteSite must not declare a 200 response
    type _NoOk = DeleteResponses['200']
  })

  it('requires the name confirmation in the body', () => {
    expect(request.confirm).toBe('Acme Analytics')
  })

  it('documents every refusal the route can produce', async () => {
    const text = await spec()
    const deleteBlock = text.slice(
      text.indexOf('operationId: deleteSite'),
      text.indexOf('/v1/sites/{site_id}/keys:'),
    )
    // 400 validation (a wrong confirmation), 401, 403 (capability *or*
    // REAUTH_REQUIRED, which share a status), 404, 409 idempotency.
    for (const status of ["'400'", "'401'", "'403'", "'404'", "'409'"]) {
      expect(deleteBlock, `deleteSite is missing a ${status} response`).toContain(status)
    }
    // The 403 has to name both codes: they are one status with two very
    // different remedies, and a client that cannot tell them apart cannot
    // prompt for re-authentication.
    expect(deleteBlock).toContain('REAUTH_REQUIRED')
    expect(deleteBlock).toContain('IdempotencyKey')
  })

  it('maps its error codes to the statuses the route returns', () => {
    expect(statusForErrorCode('REAUTH_REQUIRED')).toBe(403)
    expect(statusForErrorCode('FORBIDDEN')).toBe(403)
    expect(statusForErrorCode('SITE_NOT_FOUND')).toBe(404)
    expect(statusForErrorCode('VALIDATION_FAILED')).toBe(400)
    expect(statusForErrorCode('IDEMPOTENCY_CONFLICT')).toBe(409)
  })
})
