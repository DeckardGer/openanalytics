import type { Auth } from '@openanalytics/auth'
import { loadServiceEnv } from '@openanalytics/domain'
import { createServiceMetadata } from '@openanalytics/observability'
import type { Database } from '@openanalytics/postgres'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../apps/api/src/app.ts'

/**
 * `POST /v1/auth/setup` — the way into a deployment nobody has claimed.
 *
 * The only route on this api that both writes and accepts no credential, so
 * the guard is the whole of its security: it is open exactly while the users
 * table is empty, and closed forever afterwards. These tests exist because
 * that guard is one line, and a route that lost it would keep passing every
 * happy-path test while handing the deployment to whoever asked next.
 *
 * No infrastructure: the users read, Better Auth and the verification write are
 * all stubbed, because what is under test is the ordering and the refusals, not
 * Postgres.
 */

/**
 * The two chains the route drives against the database: `hasAnyUser`'s
 * `select().from().limit()`, and `markUserEmailVerified`'s
 * `update().set().where()`. Nothing else is implemented, so a route that grew
 * a third query would fail here rather than pass by accident.
 */
const usersReturning = (rows: unknown[], record?: Recorded) =>
  ({
    select: () => ({ from: () => ({ limit: async () => rows }) }),
    update: () => ({
      set: () => ({
        where: async () => {
          record?.verified.push('marked')
        },
      }),
    }),
  }) as unknown as Database

interface Recorded {
  readonly signUps: { email: string; password: string; name: string }[]
  readonly signIns: { email: string; password: string }[]
  readonly verified: string[]
}

function stubAuth(record: Recorded, options: { signUpThrows?: boolean } = {}) {
  return {
    api: {
      getSession: async () => null,
      signUpEmail: async (input: { body: { email: string; password: string; name: string } }) => {
        if (options.signUpThrows) throw new Error('user already exists')
        record.signUps.push(input.body)
        return {}
      },
      signInEmail: async (input: { body: { email: string; password: string } }) => {
        record.signIns.push(input.body)
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'set-cookie': 'oa_session=stub; Path=/; HttpOnly' },
        })
      },
    },
    handler: async () => new Response(null),
  } as unknown as Auth
}

const oneUser = usersReturning([{ one: 1 }])

function buildApp(
  users: Database,
  record: Recorded,
  options: { signUpThrows?: boolean; overrides?: Record<string, string> } = {},
) {
  const { logger } = createCapturedLogger()
  return createApp({
    service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
    logger,
    env: loadServiceEnv('api', testEnv(options.overrides ?? {})),
    auth: stubAuth(record, options),
    db: users,
  })
}

const fresh = (): Recorded => ({ signUps: [], signIns: [], verified: [] })

/** An unclaimed deployment, wired to the recorder so the write is observable. */
const unclaimed = (record: Recorded) => usersReturning([], record)

const post = (app: ReturnType<typeof buildApp>, body: unknown) =>
  app.fetch(
    new Request('https://api.test/v1/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

const GOOD = { email: 'owner@example.test', password: 'a-long-enough-password' }

describe('POST /v1/auth/setup', () => {
  it('creates the first account and returns the session Better Auth minted', async () => {
    const record = fresh()
    const res = await post(buildApp(unclaimed(record), record), GOOD)

    expect(res.status).toBe(200)
    // The response is forwarded, not rebuilt: a hand-copied Set-Cookie is one
    // attribute away from a session that silently does not stick.
    expect(res.headers.get('set-cookie')).toContain('oa_session=')
    expect(record.signUps).toEqual([{ email: GOOD.email, password: GOOD.password, name: 'owner' }])
    expect(record.signIns).toEqual([{ email: GOOD.email, password: GOOD.password }])
    // Marked verified *before* the sign-in: `requireEmailVerification` refuses
    // a session to an unverified address, and this one can never be verified
    // the ordinary way — there is no mail transport, which is why the account
    // exists at all.
    expect(record.verified).toHaveLength(1)
  })

  it('refuses once the deployment has an account, and says so without leaking who', async () => {
    const record = fresh()
    const res = await post(buildApp(oneUser, record), GOOD)

    expect(res.status).toBe(409)
    expect(record.signUps).toEqual([])
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe('SETUP_COMPLETE')
    // The refusal names no address. An anonymous caller learns that the
    // deployment is claimed and nothing else about it.
    expect(JSON.stringify(body)).not.toContain('@')
  })

  it('checks the guard before it reads the body at all', async () => {
    // A claimed deployment owes an anonymous caller nothing, not even a
    // validation error: answering 400 here would confirm the route is live and
    // invite a caller to keep trying with better input.
    const record = fresh()
    const res = await post(buildApp(oneUser, record), { email: 'nonsense', password: 'x' })
    expect(res.status).toBe(409)
  })

  it('rejects a password shorter than the floor the login card states', async () => {
    const record = fresh()
    const res = await post(buildApp(unclaimed(record), record), { ...GOOD, password: 'short' })

    expect(res.status).toBe(400)
    expect(record.signUps).toEqual([])
  })

  it('rejects an address that is not one', async () => {
    const record = fresh()
    const res = await post(buildApp(unclaimed(record), record), { ...GOOD, email: 'owner' })

    expect(res.status).toBe(400)
    expect(record.signUps).toEqual([])
  })

  it('reads a duplicate from Better Auth as the deployment being claimed', async () => {
    // Reachable despite the guard if two requests race. It is not a crash, and
    // the caller is told the same thing the guard would have told them.
    const record = fresh()
    const res = await post(buildApp(unclaimed(record), record, { signUpThrows: true }), GOOD)

    expect(res.status).toBe(409)
    expect(record.signIns).toEqual([])
  })

  it('rate-limits the address that is spraying it', async () => {
    // The genuine action happens once per deployment, ever. The ceiling exists
    // so an unclaimed install is expensive to find by spraying.
    const record = fresh()
    const app = buildApp(unclaimed(record), record)
    const codes: number[] = []
    for (let attempt = 0; attempt < 8; attempt++) {
      codes.push((await post(app, { ...GOOD, password: 'short' })).status)
    }
    expect(codes).toContain(429)
  })
})
