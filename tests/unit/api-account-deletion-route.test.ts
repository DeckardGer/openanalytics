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
const app = createApp({
  service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
  logger,
  env: loadServiceEnv('api', testEnv()),
  auth,
  db: {} as Database,
})

const del = (user: string | null, body: unknown, sessionAgeSeconds = 0) =>
  app.fetch(
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

const errorCode = async (res: Response): Promise<string> =>
  ((await res.json()) as { error: { code: string } }).error.code

beforeEach(() => {
  calls.startAccountDeletion = []
  world.blocked = null
  world.started = true
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
