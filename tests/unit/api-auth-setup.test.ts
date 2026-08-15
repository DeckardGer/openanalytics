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

/**
 * A deployment that is empty when the guard reads it and claimed by the time
 * the write fails — the race the duplicate branch exists for. Modelled rather
 * than asserted from a thrown message, because which answer that branch owes
 * is a question about the table and not about the error.
 */
const usersRacing = (record?: Recorded) => {
  let reads = 0
  return {
    select: () => ({
      from: () => ({
        limit: async () => {
          reads += 1
          return reads === 1 ? [] : [{ one: 1 }]
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => {
          record?.verified.push('marked')
        },
      }),
    }),
  } as unknown as Database
}

/** The most recent app's log lines, so a test can assert what was written. */
let captured = createCapturedLogger()

function buildApp(
  users: Database,
  record: Recorded,
  options: { signUpThrows?: boolean; overrides?: Record<string, string> } = {},
) {
  captured = createCapturedLogger()
  const { logger } = captured
  return createApp({
    service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
    logger,
    // The account this route writes signs in with a password, so every test but
    // the two that turn it off runs the configuration the route is documented
    // for. `testEnv` leaves the variable unset, which is `disabled` — the
    // hosted default — and before the guard below existed that meant the whole
    // suite exercised a route whose write could not have worked on a real
    // deployment.
    env: loadServiceEnv('api', testEnv({ AUTH_PASSWORD_SIGNIN: 'enabled', ...options.overrides })),
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
    // the caller is told the same thing the guard would have told them — but
    // only because the table says so by the time the answer is chosen.
    const record = fresh()
    const res = await post(buildApp(usersRacing(record), record, { signUpThrows: true }), GOOD)

    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('SETUP_COMPLETE')
    expect(record.signIns).toEqual([])
  })

  it('does not claim an account exists when the write failed and none does', async () => {
    // The branch above used to answer `409 SETUP_COMPLETE` for every failure,
    // so a deployment with no account at all told the person claiming it that
    // it already had one. The table is still empty here, and the answer says
    // so.
    const record = fresh()
    const res = await post(buildApp(unclaimed(record), record, { signUpThrows: true }), GOOD)

    expect(res.status).toBe(503)
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe('SETUP_FAILED')
    expect(body.message).not.toContain('already')
    // The reason stays server-side: this route is unauthenticated and the
    // failure can name an address.
    expect(captured.find('setup_signup_refused')).toHaveLength(1)
    expect(JSON.stringify(body)).not.toContain('@')
    expect(record.signIns).toEqual([])
  })

  it('refuses before anything else where the password door is not mounted', async () => {
    // `signUpEmail` throws when Better Auth has not mounted the password
    // endpoints, which is what `AUTH_PASSWORD_SIGNIN=disabled` means — and the
    // default, because the same schema serves a hosted deployment where the
    // doors are OAuth and the magic link. Self-host turns it on
    // (`infra/selfhost/env/api.env.example`, `docker-compose.coolify.yml`), so
    // reaching this is an install that wrote its own environment.
    const record = fresh()
    const res = await post(
      buildApp(unclaimed(record), record, { overrides: { AUTH_PASSWORD_SIGNIN: 'disabled' } }),
      GOOD,
    )

    expect(res.status).toBe(503)
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe('PASSWORD_SIGNIN_DISABLED')
    // The message names the variable to set. An operator reading it should not
    // have to find this file.
    expect(body.message).toContain('AUTH_PASSWORD_SIGNIN')
    expect(record.signUps).toEqual([])
  })

  it('does not offer the password door it just refused', async () => {
    // The refusal and the provider list have to agree: a login screen that
    // draws the form from `/v1/auth/providers` must not be told the door
    // exists by one endpoint and that it does not by the other.
    const record = fresh()
    const app = buildApp(unclaimed(record), record, {
      overrides: { AUTH_PASSWORD_SIGNIN: 'disabled' },
    })
    const res = await app.fetch(new Request('https://api.test/v1/auth/providers'))
    const body = (await res.json()) as { items: { id: string }[] }

    expect(body.items.map((item) => item.id)).not.toContain('password')
  })

  /**
   * The claim is announced loudly and identifies nobody.
   *
   * Claiming a deployment is worth a `warn` — it is the one unauthenticated
   * write on this api. What it must not do is write down who claimed it: this
   * repository's rule is that a raw address, postal or network, never reaches a
   * log line. `apps/api/src/http/routes.ts` says an invitee's email "never
   * reaches the audit trail or a log", and `credential-source.ts` HMACs client
   * addresses rather than recording them.
   *
   * Asserted over the whole serialized line rather than field by field, because
   * the failure this guards against is a field somebody adds later.
   */
  it('announces the claim without writing down who made it', async () => {
    const record = fresh()
    const app = buildApp(unclaimed(record), record)
    await post(app, GOOD)

    const lines = captured.find('setup_first_account_created')
    expect(lines).toHaveLength(1)
    const line = lines[0] as Record<string, unknown>
    expect(line['level']).toBe('warn')

    const serialized = JSON.stringify(line)
    // The address that claimed it, and the address it came from.
    expect(serialized).not.toContain(GOOD.email)
    expect(serialized).not.toContain('owner@')
    expect(line['address']).toBeUndefined()
    // The domain is what the log transport already records for every message it
    // handles, and it is enough to recognise the claim.
    expect(line['email_domain']).toBe('example.test')
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
