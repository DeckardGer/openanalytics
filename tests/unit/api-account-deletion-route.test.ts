import { loadServiceEnv } from '@openanalytics/domain'
import type { Auth } from '@openanalytics/auth'
import type { Database } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `DELETE /v1/me` — the guards and the refusal shape (ADR-0030, decision 8).
 *
 * The gate itself is a transaction with a live-Postgres suite; what lives only
 * at this route is the chain in front of it and the translation of the gate's
 * refusal into something a frontend can act on. Each link answers a different
 * question:
 *
 * - the session: is anyone signed in. The subject is the session and nothing
 *   else — there is no user id anywhere in the request for a caller to swap;
 * - `isRecentReauth`: was the session recently *proven*, not merely valid;
 * - the confirmation: the caller typed their own address, compared against the
 *   session this request resolved rather than anything else the client sent.
 *
 * Every guard is asserted to run *before* the repository, because a guard that
 * only runs after the write has already lost. The 409 is asserted structurally —
 * a refusal that does not name the blocking sites and their reasons leaves the
 * user with no way to find out what to do next.
 */

const USER = 'u-1'
const EMAIL = 'u-1@example.test'
const OTHER = 'u-2'

const REQUEST_ID = '7c1f2b04-0000-4000-8000-0000000012ab'

const calls = { startAccountDeletion: [] as { userId: string }[] }

const world = {
  blocked: null as
    { siteId: string; slug: string; reason: 'billing_owner' | 'sole_owner' }[] | null,
  started: true,
  /** Who `deploymentOperatorUserId` reports. `null` is a deployment with nobody
   * in it, and is the default so every test above is unaffected by the guard. */
  operator: null as string | null,
}

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    startAccountDeletion: async (_db: unknown, input: { userId: string }) => {
      calls.startAccountDeletion.push(input)
      if (world.blocked !== null) {
        throw new actual.AccountDeletionBlockedError(world.blocked)
      }
      return { deletionRequestId: REQUEST_ID, jobId: 'job-1', started: world.started }
    },
    deploymentOperatorUserId: async () => world.operator,
  }
})

const { createApp } = await import('../../apps/api/src/app.ts')

/** The caller is chosen with a test header; the session's age with a second one,
 * so one app instance exercises both the fresh and the stale-session paths. */
const auth = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const id = headers.get('x-test-user')
      if (id === null) return null
      const staleSeconds = Number(headers.get('x-test-session-age') ?? '0')
      return {
        user: {
          id,
          email: `${id}@example.test`,
          emailVerified: true,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        session: { createdAt: new Date(Date.now() - staleSeconds * 1000) },
      }
    },
  },
  handler: async () => new Response(null),
} as unknown as Auth

const { logger } = createCapturedLogger()

function buildApp(overrides: Record<string, string> = {}) {
  return createApp({
    service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
    logger,
    env: loadServiceEnv('api', testEnv(overrides)),
    auth,
    db: {} as Database,
  })
}

/**
 * A self-hosted deployment: `DEPLOYMENT_SETTINGS` defaults to `enabled`, which
 * is what a fresh install gets and therefore what every test here runs against.
 */
const app = buildApp()

/**
 * A multi-tenant deployment, which sets the flag `disabled`.
 *
 * A second instance rather than a mutable env, because the guard reads the
 * parsed environment at construction and the whole point of the pair is that one
 * deployment shape must behave exactly as it did before this guard existed.
 */
const hostedApp = buildApp({ DEPLOYMENT_SETTINGS: 'disabled' })

const delOn = (
  target: ReturnType<typeof buildApp>,
  user: string | null,
  body: unknown,
  sessionAgeSeconds = 0,
) =>
  target.fetch(
    new Request('http://api.test/v1/me', {
      method: 'DELETE',
      headers: {
        ...(user === null ? {} : { 'x-test-user': user }),
        'x-test-session-age': String(sessionAgeSeconds),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  )

const del = (user: string | null, body: unknown, sessionAgeSeconds = 0) =>
  delOn(app, user, body, sessionAgeSeconds)

const errorCode = async (res: Response): Promise<string> =>
  ((await res.json()) as { error: { code: string } }).error.code

beforeEach(() => {
  calls.startAccountDeletion = []
  world.blocked = null
  world.started = true
  world.operator = null
})

describe('DELETE /v1/me', () => {
  it('refuses an unauthenticated caller', async () => {
    const res = await del(null, { confirm: EMAIL })
    expect(res.status).toBe(401)
    expect(calls.startAccountDeletion).toEqual([])
  })

  it('refuses a session that is not recent enough, before any write', async () => {
    // Well past SENSITIVE_ACTION_MAX_SESSION_AGE_SECONDS (300). A live cookie on
    // a stolen laptop must not be able to erase its owner's account.
    const res = await del(USER, { confirm: EMAIL }, 3_600)
    expect(res.status).toBe(403)
    expect(await errorCode(res)).toBe('REAUTH_REQUIRED')
    expect(calls.startAccountDeletion).toEqual([])
  })

  it('refuses a confirmation that is not the caller’s own email', async () => {
    // Somebody else's address is the interesting case, not a typo: the
    // confirmation is compared against the session, so this can never pass.
    const res = await del(USER, { confirm: `${OTHER}@example.test` })
    expect(res.status).toBe(400)
    const body = (await res.json()) as {
      error: { code: string; details: { issues: unknown[] } }
    }
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.details.issues).toEqual([{ field: 'confirm', code: 'email_mismatch' }])
    expect(calls.startAccountDeletion).toEqual([])
  })

  it('refuses a missing confirmation', async () => {
    expect((await del(USER, {})).status).toBe(400)
    expect(calls.startAccountDeletion).toEqual([])
  })

  it('refuses a confirmation that differs only in case', async () => {
    // Exact, deliberately. The address is on the screen the button lives on, so
    // an exact match costs nothing and makes the act deliberate.
    expect((await del(USER, { confirm: EMAIL.toUpperCase() })).status).toBe(400)
    expect(calls.startAccountDeletion).toEqual([])
  })

  it('answers 409 naming every blocking site and why each blocks', async () => {
    world.blocked = [
      { siteId: '11111111-0000-4000-8000-000000000001', slug: 'acme', reason: 'billing_owner' },
      { siteId: '22222222-0000-4000-8000-000000000002', slug: 'beta', reason: 'sole_owner' },
    ]

    const res = await del(USER, { confirm: EMAIL })
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      error: { code: string; details: { blocking_sites: unknown[] } }
    }
    expect(body.error.code).toBe('ACCOUNT_DELETION_BLOCKED')
    // Every site, in the snake_case contract shape — a refusal that named one at
    // a time would make deleting an account with four sites a guessing game, and
    // the two reasons need two entirely different remedies.
    expect(body.error.details.blocking_sites).toEqual([
      { site_id: '11111111-0000-4000-8000-000000000001', slug: 'acme', reason: 'billing_owner' },
      { site_id: '22222222-0000-4000-8000-000000000002', slug: 'beta', reason: 'sole_owner' },
    ])
  })

  it('accepts a fresh session with the exact email, answering 202', async () => {
    const res = await del(USER, { confirm: EMAIL })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ deletion_request_id: REQUEST_ID })
    expect(calls.startAccountDeletion).toEqual([{ userId: USER }])
  })

  it('answers 202 with the same request id when a deletion is already running', async () => {
    // The repository found the live request rather than minting a second one; a
    // double-click and a retry converge on one erasure.
    world.started = false
    const res = await del(USER, { confirm: EMAIL })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ deletion_request_id: REQUEST_ID })
  })
})

/**
 * The deployment operator, and the deployment shape the refusal must not reach.
 *
 * Since migration 0043 a self-hosted deployment keeps its SMTP password and its
 * model-provider key in `deployment_settings`, and the account authorized to
 * read and rewrite them is *derived* — the oldest live one. Nothing grants or
 * moves that role, so it cannot be handed over. Deleting it would not transfer
 * it either: an erasure scrubs the `users` row into a tombstone rather than
 * removing it, so the role would stick to an identity nobody can sign into and
 * the deployment's own settings would become permanently uneditable.
 *
 * Both directions are pinned here because getting either wrong is invisible.
 * A missing guard locks a deployment out of its own credentials; a guard that
 * fires where the role does not exist denies a paying customer the erasure
 * ADR-0057 committed to — which is the worse of the two, and the reason the flag
 * is checked before the identity is even looked up.
 */
describe('DELETE /v1/me — the deployment operator', () => {
  it('refuses the operator on a self-hosted deployment, before any write', async () => {
    world.operator = USER

    const res = await del(USER, { confirm: EMAIL })
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      error: { code: string; message: string; details: Record<string, unknown> }
    }
    expect(body.error.code).toBe('ACCOUNT_DELETION_BLOCKED')
    // The distinguishing detail, and the absence of the other one: a client that
    // only understands `blocking_sites` reads no sites and falls through to the
    // message rather than rendering an empty "these sites are blocking" list.
    expect(body.error.details['reason']).toBe('deployment_operator')
    expect(body.error.details['blocking_sites']).toBeUndefined()
    // The refusal must not name a remedy that does not work. It used to tell
    // the caller to clear the stored mail and assistant settings first — but
    // this guard compares identities and never reads `deployment_settings`, so
    // clearing them changes nothing and the next attempt is refused
    // identically. A false next step is worse than none: it sends somebody to
    // delete their own mail configuration for an answer that will not move.
    expect(body.error.message).not.toMatch(/clear/iu)
    expect(body.error.message).not.toMatch(/settings/iu)
    // What it does say: which account this is, and that the dashboard is not
    // where it changes hands.
    expect(body.error.message).toMatch(/claimed this deployment/iu)
    expect(body.error.message).toMatch(/cannot be deleted/iu)
    expect(calls.startAccountDeletion).toEqual([])
  })

  it('refuses the operator even with a fresh session and the exact email', async () => {
    // The two guards below it prove *intent*, and no amount of proven intent
    // changes this answer — so it is checked ahead of both rather than being a
    // refusal somebody can reach by confirming harder.
    world.operator = USER
    expect((await del(USER, { confirm: EMAIL }, 0)).status).toBe(409)
    expect(calls.startAccountDeletion).toEqual([])
  })

  it('lets every other account delete itself on the same deployment', async () => {
    // The guard is about one identity, not about the feature being on.
    world.operator = OTHER

    const res = await del(USER, { confirm: EMAIL })
    expect(res.status).toBe(202)
    expect(calls.startAccountDeletion).toEqual([{ userId: USER }])
  })

  it('does not fire on a deployment configured from its environment', async () => {
    // `DEPLOYMENT_SETTINGS=disabled` is the multi-tenant shape. The same account
    // that is refused above — oldest, and the operator by the same derivation —
    // is erased here, because there is nothing stored against it and no role to
    // inherit. A guard that fired here would be a defect, not a safety measure.
    world.operator = USER

    const res = await delOn(hostedApp, USER, { confirm: EMAIL })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ deletion_request_id: REQUEST_ID })
    expect(calls.startAccountDeletion).toEqual([{ userId: USER }])
  })

  it('still refuses a stale session on a deployment where the guard is off', async () => {
    // The control for the test above: `disabled` removes exactly one refusal and
    // leaves the rest of the chain where it was.
    world.operator = USER

    const res = await delOn(hostedApp, USER, { confirm: EMAIL }, 3_600)
    expect(res.status).toBe(403)
    expect(await errorCode(res)).toBe('REAUTH_REQUIRED')
    expect(calls.startAccountDeletion).toEqual([])
  })
})
