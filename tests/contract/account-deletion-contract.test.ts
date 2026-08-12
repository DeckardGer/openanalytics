import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { statusForErrorCode } from '@openanalytics/contracts'
import type { components, paths } from '@openanalytics/contracts'
import { describe, expect, it } from 'vitest'

/**
 * `DELETE /v1/me` in the contract (ADR-0030, decision 8).
 *
 * The contract is edited before the implementation (AGENTS.md), so this asserts
 * the document — and, through the typed values below, that the *generated*
 * client agrees with it. A response shape the spec declares but the generator
 * did not produce is a contract nobody consumes.
 *
 * Two details are load-bearing. `202` says the erasure is a state machine: it
 * waits for site deletions and for Stripe to confirm, and a client that treated
 * a `200` as "gone" would tell somebody their data was deleted while it was
 * still there. And `blocking_sites` is a typed schema rather than prose in a
 * description, because the two block reasons need two entirely different
 * remedies and a frontend has to branch on them.
 */

const SPEC_PATH = fileURLToPath(
  new URL('../../packages/contracts/openapi/openapi.yaml', import.meta.url),
)

async function spec(): Promise<string> {
  return await readFile(SPEC_PATH, 'utf8')
}

/** The accepted response, typed by the generated client. */
const accepted: components['schemas']['AccountDeletionAccepted'] = {
  deletion_request_id: '7c1f2b04-0000-4000-8000-0000000012ab',
}

/** The request body. `confirm` is required — there is no shape of this request
 * that omits it. */
const request: components['schemas']['DeleteAccountRequest'] = { confirm: 'user@example.com' }

/** One entry of `details.blocking_sites` on the 409. */
const blocker: components['schemas']['AccountDeletionBlockingSite'] = {
  site_id: '11111111-0000-4000-8000-000000000001',
  slug: 'acme',
  reason: 'billing_owner',
}

describe('OpenAPI documents the account deletion', () => {
  it('declares deleteAccount exactly once, on the /v1/me path item', async () => {
    const text = await spec()
    expect(text.split('operationId: deleteAccount\n').length - 1).toBe(1)
    expect(text).toContain('/v1/me:')
  })

  it('answers 202, never 200 — the erasure is a state machine', async () => {
    type DeleteResponses = paths['/v1/me']['delete']['responses']
    const typed: DeleteResponses['202']['content']['application/json'] = accepted
    expect(typed.deletion_request_id).toBe('7c1f2b04-0000-4000-8000-0000000012ab')
    // …and there is no 200 in the generated type. `@ts-expect-error` fails the
    // build if one is ever added, which is the point.
    // @ts-expect-error deleteAccount must not declare a 200 response
    type _NoOk = DeleteResponses['200']
  })

  it('requires the email confirmation in the body', () => {
    expect(request.confirm).toBe('user@example.com')
  })

  it('types both block reasons, so a client can branch on the remedy', () => {
    expect(blocker.reason).toBe('billing_owner')
    const soleOwner: components['schemas']['AccountDeletionBlockingSite']['reason'] = 'sole_owner'
    expect(soleOwner).toBe('sole_owner')
    // @ts-expect-error the reason vocabulary is closed
    const invalid: components['schemas']['AccountDeletionBlockingSite']['reason'] = 'whatever'
    expect(invalid).toBe('whatever')
  })

  it('documents every refusal the route can produce', async () => {
    const text = await spec()
    const block = text.slice(
      text.indexOf('operationId: deleteAccount'),
      text.indexOf('/v1/me/preferences:'),
    )
    // 400 validation (a wrong confirmation), 401, 403 (REAUTH_REQUIRED),
    // 409 (blocked *or* idempotency).
    for (const status of ["'400'", "'401'", "'403'", "'409'"]) {
      expect(block, `deleteAccount is missing a ${status} response`).toContain(status)
    }
    // The 403 names its code: it is one status whose only remedy is to
    // re-authenticate, and a client that cannot tell it apart cannot prompt.
    expect(block).toContain('REAUTH_REQUIRED')
    // The 409 carries two codes with two different remedies, and both are named.
    expect(block).toContain('ACCOUNT_DELETION_BLOCKED')
    expect(block).toContain('IDEMPOTENCY_CONFLICT')
    expect(block).toContain('IdempotencyKey')
  })

  it('maps its error codes to the statuses the route returns', () => {
    expect(statusForErrorCode('ACCOUNT_DELETION_BLOCKED')).toBe(409)
    expect(statusForErrorCode('REAUTH_REQUIRED')).toBe(403)
    expect(statusForErrorCode('VALIDATION_FAILED')).toBe(400)
    expect(statusForErrorCode('IDEMPOTENCY_CONFLICT')).toBe(409)
  })
})
