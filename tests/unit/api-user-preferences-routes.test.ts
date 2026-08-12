import { loadServiceEnv } from '@openanalytics/domain'
import type { Auth } from '@openanalytics/auth'
import type { Database, SetUserTimezoneInput } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The `/v1/me/preferences` routes' own authorization and validation, without
 * Postgres (ADR-0026).
 *
 * These are the rules that live at the route and nowhere else, so the repository
 * suite cannot prove them:
 *
 * - the session guard, and that a refusal never reaches the repository;
 * - self-only, which here means the *absence* of any way to name another
 *   subject — the assertion is that the id written is always the session's;
 * - the IANA check on write, which is the whole point of validating: a
 *   well-formed but unknown zone must be refused rather than stored and then
 *   failing every analytics read afterwards;
 * - the difference between `null` (clear the preference) and an absent field
 *   (a client bug), which no schema-shaped test elsewhere states.
 */

const ALICE = 'u-alice'
const BOB = 'u-bob'

const stored = new Map<string, string | null>()
const calls = {
  get: [] as string[],
  set: [] as { userId: string; timezone: string | null }[],
}
/** Lets one test drive the "session resolved, row is gone" branch. */
const missingUsers = new Set<string>()

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    getUserPreferences: async (_db: unknown, userId: string) => {
      calls.get.push(userId)
      if (missingUsers.has(userId)) return null
      return { timezone: stored.get(userId) ?? null }
    },
    setUserTimezone: async (_db: unknown, input: SetUserTimezoneInput) => {
      calls.set.push({ userId: input.userId, timezone: input.timezone })
      if (missingUsers.has(input.userId)) return null
      stored.set(input.userId, input.timezone)
      return { timezone: input.timezone }
    },
  }
})

const { createApp } = await import('../../apps/api/src/app.ts')

/** The caller is chosen per request with a test header, so one app instance can
 * exercise several accounts and the anonymous case. */
const auth = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const id = headers.get('x-test-user')
      if (id === null) return null
      return {
        user: {
          id,
          email: `${id}@example.test`,
          emailVerified: true,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        session: { createdAt: new Date('2026-01-01T00:00:00.000Z') },
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

const send = (method: string, path: string, user: string | null, body?: unknown) =>
  app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: {
        ...(user === null ? {} : { 'x-test-user': user }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )

interface PreferencesBody {
  timezone: string | null
}
interface ErrorBody {
  error: { code: string; details?: { issues?: { field: string }[] } }
}

beforeEach(() => {
  stored.clear()
  calls.get = []
  calls.set = []
  missingUsers.clear()
})

describe('GET /v1/me/preferences', () => {
  it('401 without a session, and never reads the row', async () => {
    const res = await send('GET', '/v1/me/preferences', null)
    expect(res.status).toBe(401)
    expect((await res.json()) as ErrorBody).toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
    expect(calls.get).toHaveLength(0)
  })

  it('reports null for an account that has never chosen a zone', async () => {
    const res = await send('GET', '/v1/me/preferences', ALICE)
    expect(res.status).toBe(200)
    // Null, not 'UTC' and not an absent key: the frontend distinguishes "never
    // chosen" (fall back to the browser) from a stored value, and it can only do
    // that if the server never guesses (ADR-0026 decision 3).
    expect((await res.json()) as PreferencesBody).toEqual({ timezone: null })
  })

  it('reads the session user, never a subject from the request', async () => {
    stored.set(ALICE, 'Asia/Baku')
    stored.set(BOB, 'America/New_York')
    const res = await send('GET', '/v1/me/preferences', BOB)
    expect((await res.json()) as PreferencesBody).toEqual({ timezone: 'America/New_York' })
    expect(calls.get).toEqual([BOB])
  })

  it('401 rather than 500 when the session outlives the account', async () => {
    missingUsers.add(ALICE)
    const res = await send('GET', '/v1/me/preferences', ALICE)
    expect(res.status).toBe(401)
  })
})

describe('PATCH /v1/me/preferences', () => {
  it('401 without a session, and never writes', async () => {
    const res = await send('PATCH', '/v1/me/preferences', null, { timezone: 'Asia/Baku' })
    expect(res.status).toBe(401)
    expect(calls.set).toHaveLength(0)
  })

  it('stores a valid zone and echoes it back', async () => {
    const res = await send('PATCH', '/v1/me/preferences', ALICE, { timezone: 'Asia/Baku' })
    expect(res.status).toBe(200)
    expect((await res.json()) as PreferencesBody).toEqual({ timezone: 'Asia/Baku' })

    const read = await send('GET', '/v1/me/preferences', ALICE)
    expect((await read.json()) as PreferencesBody).toEqual({ timezone: 'Asia/Baku' })
  })

  it('writes against the session user id, not anything in the body', async () => {
    // Self-only is structural: there is no path segment for a subject, so the
    // only thing left to try is smuggling one through the body. It must be
    // ignored entirely rather than merely refused.
    const res = await send('PATCH', '/v1/me/preferences', ALICE, {
      timezone: 'Asia/Baku',
      user_id: BOB,
      userId: BOB,
    })
    expect(res.status).toBe(200)
    expect(calls.set).toEqual([{ userId: ALICE, timezone: 'Asia/Baku' }])
    expect(stored.get(BOB)).toBeUndefined()
  })

  it('clears the preference on an explicit null', async () => {
    stored.set(ALICE, 'Asia/Baku')
    const res = await send('PATCH', '/v1/me/preferences', ALICE, { timezone: null })
    expect(res.status).toBe(200)
    expect((await res.json()) as PreferencesBody).toEqual({ timezone: null })
    expect(calls.set).toEqual([{ userId: ALICE, timezone: null }])
  })

  it('400 VALIDATION_FAILED for a well-formed but unknown zone, before any write', async () => {
    // The point of validating against the runtime's tz database rather than a
    // pattern: this string is shaped exactly like a real identifier.
    const res = await send('PATCH', '/v1/me/preferences', ALICE, { timezone: 'Europe/Atlantis' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as ErrorBody
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.details?.issues?.[0]?.field).toBe('timezone')
    expect(calls.set).toHaveLength(0)
  })

  it.each(['+05:00', '-08:00', '+0500'])(
    '400 VALIDATION_FAILED for the UTC offset %s, before any write',
    async (offset) => {
      // `Intl` accepts these as time zones, so the runtime check alone lets them
      // through — and the column's CHECK then refuses them, which would surface
      // as an unhandled database error rather than a caller mistake. The wire
      // validator carries the same identifier shape for exactly this reason, and
      // an offset is not a timezone anyway (ADR-0026 alternatives): it is one
      // evaluated at a single instant, so it is wrong after every DST change.
      const res = await send('PATCH', '/v1/me/preferences', ALICE, { timezone: offset })
      expect(res.status).toBe(400)
      const body = (await res.json()) as ErrorBody
      expect(body.error.code).toBe('VALIDATION_FAILED')
      expect(body.error.details?.issues?.[0]?.field).toBe('timezone')
      expect(calls.set).toHaveLength(0)
    },
  )

  it('400 VALIDATION_FAILED for a non-string zone, before any write', async () => {
    const res = await send('PATCH', '/v1/me/preferences', ALICE, { timezone: 42 })
    expect(res.status).toBe(400)
    expect(((await res.json()) as ErrorBody).error.code).toBe('VALIDATION_FAILED')
    expect(calls.set).toHaveLength(0)
  })

  it('400 VALIDATION_FAILED when the field is absent — an empty patch is a bug', async () => {
    // Distinct from `{ timezone: null }`, which is a deliberate clear. Answering
    // 200 here would report success for a change nobody asked for.
    const res = await send('PATCH', '/v1/me/preferences', ALICE, {})
    expect(res.status).toBe(400)
    const body = (await res.json()) as ErrorBody
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.details?.issues?.[0]?.field).toBe('timezone')
    expect(calls.set).toHaveLength(0)
  })

  it('400 VALIDATION_FAILED for a body that is not a JSON object', async () => {
    const res = await app.fetch(
      new Request('http://api.test/v1/me/preferences', {
        method: 'PATCH',
        headers: { 'x-test-user': ALICE, 'content-type': 'application/json' },
        body: 'not json',
      }),
    )
    expect(res.status).toBe(400)
    expect(calls.set).toHaveLength(0)
  })

  it('accepts a bare zone name with no region prefix', async () => {
    // `UTC` is a valid IANA identifier and the one a CI-pinned browser reports;
    // a slash-requiring pattern check would have rejected it.
    const res = await send('PATCH', '/v1/me/preferences', ALICE, { timezone: 'UTC' })
    expect(res.status).toBe(200)
    expect((await res.json()) as PreferencesBody).toEqual({ timezone: 'UTC' })
  })
})
