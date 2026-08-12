import type { Auth } from '@openanalytics/auth'
import { loadServiceEnv } from '@openanalytics/domain'
import { createCredentialVault } from '@openanalytics/integrations'
import type { Database } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `/v1/deployment/settings` — what an operator may configure from the dashboard,
 * and everything that must stay closed around it (migration 0043).
 *
 * The surface stores two secrets a deployment is worth attacking for: the relay
 * that sends its sign-in links, and a model provider key that spends money. So
 * the tests here are mostly refusals, and each pins a different one:
 *
 * - the surface is closed three ways (`disabled`, `no_keyring`, `not_operator`),
 *   and a closed read discloses **nothing** — not the relay, not whether one
 *   exists;
 * - a secret goes in and never comes back out, on any path;
 * - the three-way password semantics, because getting them wrong is silent: a
 *   merge that read absence as removal would wipe the relay credential every
 *   time somebody corrected the port.
 *
 * No infrastructure. The repository is mocked, so what is under test is the
 * ordering, the refusals and the shape of what crosses the boundary.
 */

const OPERATOR = 'u-oldest'
const MEMBER = 'u-later'

/** A 32-byte key, base64, so the ring parses and the vault really encrypts. */
const KEYRING = JSON.stringify({
  active: 'k1',
  keys: { k1: Buffer.alloc(32, 3).toString('base64') },
})

interface StoredRow {
  scope: string
  settings: Record<string, unknown>
  encryptedSecret: string | null
  keyVersion: string | null
  secretLast4: string
  updatedByUserId: string | null
  updatedAt: Date
}

const world = {
  rows: new Map<string, StoredRow>(),
  writes: [] as PostgresModule.WriteDeploymentSettingInput[],
  cleared: [] as string[],
  enqueued: [] as { topic: string; payload: Record<string, unknown> }[],
  delivery: null as PostgresModule.OutboxDeliveryRow | null,
}

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    deploymentOperatorUserId: async () => OPERATOR,
    readDeploymentSetting: async (_db: unknown, scope: string) => world.rows.get(scope) ?? null,
    writeDeploymentSetting: async (
      _db: unknown,
      input: PostgresModule.WriteDeploymentSettingInput,
    ) => {
      world.writes.push(input)
      const row: StoredRow = {
        scope: input.scope,
        settings: input.settings,
        encryptedSecret: input.encryptedSecret,
        keyVersion: input.keyVersion,
        secretLast4: input.secretLast4,
        updatedByUserId: input.updatedByUserId,
        updatedAt: new Date('2026-08-12T00:00:00.000Z'),
      }
      world.rows.set(input.scope, row)
      return row
    },
    clearDeploymentSetting: async (_db: unknown, scope: string) => {
      world.cleared.push(scope)
      return world.rows.delete(scope)
    },
    enqueueOutbox: async (
      _db: unknown,
      input: { topic: string; payload: Record<string, unknown> },
    ) => {
      world.enqueued.push(input)
      return { enqueued: true, id: 'outbox-1' }
    },
    readOutboxDelivery: async () => world.delivery,
  }
})

const { createApp } = await import('../../apps/api/src/app.ts')

/** The caller is chosen with a test header, so one app serves both principals. */
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
        session: { createdAt: new Date() },
      }
    },
  },
  handler: async () => new Response(null),
} as unknown as Auth

function buildApp(overrides: Record<string, string> = {}, options: { keyring?: boolean } = {}) {
  const { logger } = createCapturedLogger()
  const withKeyring = options.keyring ?? true
  return createApp({
    service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
    logger,
    env: loadServiceEnv('api', testEnv(overrides)),
    auth,
    db: {} as Database,
    ...(withKeyring ? { vault: createCredentialVault(KEYRING) } : {}),
  })
}

const call = (
  app: ReturnType<typeof buildApp>,
  method: string,
  path: string,
  options: { user?: string; body?: unknown } = {},
) =>
  app.fetch(
    new Request(`https://api.test${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(options.user === undefined ? {} : { 'x-test-user': options.user }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  )

beforeEach(() => {
  world.rows.clear()
  world.writes.length = 0
  world.cleared.length = 0
  world.enqueued.length = 0
  world.delivery = null
})

const GOOD_RELAY = {
  host: 'smtp.example.test',
  port: 587,
  user: 'postbox',
  password: 'hunter2-and-then-some',
}

describe('GET /v1/deployment/settings', () => {
  it('answers the operator with the stored settings and no secret anywhere in them', async () => {
    world.rows.set('email', {
      scope: 'email',
      settings: { host: 'smtp.example.test', port: 465, secure: true, user: 'postbox' },
      encryptedSecret: 'k1.nonce.cipher',
      keyVersion: 'k1',
      secretLast4: 'some',
      updatedByUserId: OPERATOR,
      updatedAt: new Date('2026-08-12T00:00:00.000Z'),
    })

    const res = await call(buildApp(), 'GET', '/v1/deployment/settings', { user: OPERATOR })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>

    expect(body['editable']).toBe(true)
    const email = (body['email'] as { stored: Record<string, unknown> }).stored
    expect(email['host']).toBe('smtp.example.test')
    expect(email['secret_set']).toBe(true)
    expect(email['secret_last4']).toBe('some')
    // The ciphertext is as much of the secret as this surface may carry, and it
    // carries none of it: there is no path from a read to a stored credential.
    expect(JSON.stringify(body)).not.toContain('k1.nonce.cipher')
  })

  it('closes for everyone but the account that claimed the deployment', async () => {
    const res = await call(buildApp(), 'GET', '/v1/deployment/settings', { user: MEMBER })
    const body = (await res.json()) as Record<string, unknown>

    expect(res.status).toBe(200)
    expect(body).toEqual({ editable: false, reason: 'not_operator' })
  })

  it('closes with no values at all when the deployment is configured from its environment', async () => {
    world.rows.set('email', {
      scope: 'email',
      settings: { host: 'smtp.example.test' },
      encryptedSecret: null,
      keyVersion: null,
      secretLast4: '',
      updatedByUserId: OPERATOR,
      updatedAt: new Date(),
    })

    const res = await call(
      buildApp({ DEPLOYMENT_SETTINGS: 'disabled' }),
      'GET',
      '/v1/deployment/settings',
      {
        user: OPERATOR,
      },
    )
    const body = (await res.json()) as Record<string, unknown>

    // A deployment that turned this off has not agreed to disclose its relay to
    // anybody — not even to say that one is stored.
    expect(body).toEqual({ editable: false, reason: 'disabled' })
    expect(JSON.stringify(body)).not.toContain('smtp.example.test')
  })

  it('closes when there is no keyring, rather than offering the half with no secret in it', async () => {
    const res = await call(buildApp({}, { keyring: false }), 'GET', '/v1/deployment/settings', {
      user: OPERATOR,
    })
    expect((await res.json()) as unknown).toEqual({ editable: false, reason: 'no_keyring' })
  })

  it('refuses an anonymous caller before any of that', async () => {
    const res = await call(buildApp(), 'GET', '/v1/deployment/settings')
    expect(res.status).toBe(401)
  })
})

describe('PUT /v1/deployment/settings/email', () => {
  it('encrypts the password, stores a tail, and puts neither in the response', async () => {
    const res = await call(buildApp(), 'PUT', '/v1/deployment/settings/email', {
      user: OPERATOR,
      body: GOOD_RELAY,
    })

    expect(res.status).toBe(200)
    const written = world.writes[0] as PostgresModule.WriteDeploymentSettingInput
    expect(written.settings).toEqual({
      host: 'smtp.example.test',
      port: 587,
      secure: false,
      user: 'postbox',
    })
    // What lands in the row is a ciphertext under the active key version, and
    // the plaintext appears in neither the row nor the answer.
    expect(written.keyVersion).toBe('k1')
    expect(written.encryptedSecret).toContain('k1.')
    expect(written.encryptedSecret).not.toContain('hunter2')
    expect(written.secretLast4).toBe('some')
    expect(await res.text()).not.toContain('hunter2')
  })

  it('keeps the stored password when the field is absent, and clears it on null', async () => {
    await call(buildApp(), 'PUT', '/v1/deployment/settings/email', {
      user: OPERATOR,
      body: GOOD_RELAY,
    })
    const stored = (world.writes[0] as PostgresModule.WriteDeploymentSettingInput).encryptedSecret

    // A form cannot resend a value it was never given, so absence has to mean
    // "keep" — the alternative wipes the credential on every unrelated edit.
    await call(buildApp(), 'PUT', '/v1/deployment/settings/email', {
      user: OPERATOR,
      body: { host: 'smtp.example.test', port: 2525 },
    })
    expect((world.writes[1] as PostgresModule.WriteDeploymentSettingInput).encryptedSecret).toBe(
      stored,
    )

    await call(buildApp(), 'PUT', '/v1/deployment/settings/email', {
      user: OPERATOR,
      body: { host: 'smtp.example.test', password: null },
    })
    const cleared = world.writes[2] as PostgresModule.WriteDeploymentSettingInput
    expect(cleared.encryptedSecret).toBeNull()
    expect(cleared.keyVersion).toBeNull()
    // A tail with no secret would be a display value describing nothing, and
    // the table's CHECK refuses it — so the route must not send one.
    expect(cleared.secretLast4).toBe('')
  })

  it('defaults implicit TLS from the port rather than leaving it undecided', async () => {
    await call(buildApp(), 'PUT', '/v1/deployment/settings/email', {
      user: OPERATOR,
      body: { host: 'smtp.example.test', port: 465 },
    })
    expect((world.writes[0] as PostgresModule.WriteDeploymentSettingInput).settings['secure']).toBe(
      true,
    )
  })

  it('refuses a hostless relay and an impossible port', async () => {
    const app = buildApp()
    expect(
      (await call(app, 'PUT', '/v1/deployment/settings/email', { user: OPERATOR, body: {} }))
        .status,
    ).toBe(400)
    expect(
      (
        await call(app, 'PUT', '/v1/deployment/settings/email', {
          user: OPERATOR,
          body: { host: 'smtp.example.test', port: 70_000 },
        })
      ).status,
    ).toBe(400)
    expect(world.writes).toEqual([])
  })

  it('refuses a caller who is not the operator, before writing anything', async () => {
    const res = await call(buildApp(), 'PUT', '/v1/deployment/settings/email', {
      user: MEMBER,
      body: GOOD_RELAY,
    })
    expect(res.status).toBe(403)
    expect(world.writes).toEqual([])
  })
})

describe('PUT /v1/deployment/settings/assistant', () => {
  it('requires a key the first time, because a provider without one is not a configuration', async () => {
    const res = await call(buildApp(), 'PUT', '/v1/deployment/settings/assistant', {
      user: OPERATOR,
      body: { model: 'gpt-5.5' },
    })
    expect(res.status).toBe(400)
    expect(world.writes).toEqual([])
  })

  it('stores the key and the model, and refuses a base URL that is not a URL', async () => {
    const app = buildApp()
    const ok = await call(app, 'PUT', '/v1/deployment/settings/assistant', {
      user: OPERATOR,
      body: { api_key: 'sk-not-a-real-key', model: 'gpt-5.5' },
    })
    expect(ok.status).toBe(200)
    const written = world.writes[0] as PostgresModule.WriteDeploymentSettingInput
    expect(written.settings).toEqual({ model: 'gpt-5.5' })
    expect(written.encryptedSecret).not.toContain('sk-not-a-real-key')

    const bad = await call(app, 'PUT', '/v1/deployment/settings/assistant', {
      user: OPERATOR,
      body: { api_key: 'sk-not-a-real-key', base_url: 'ftp://models.example' },
    })
    expect(bad.status).toBe(400)
  })
})

describe('the test send', () => {
  it('queues to the caller’s own address, and there is no field to redirect it', async () => {
    const res = await call(buildApp(), 'POST', '/v1/deployment/settings/email/test', {
      user: OPERATOR,
      body: { to: 'somebody-else@example.test' },
    })

    expect(res.status).toBe(202)
    const queued = world.enqueued[0] as { payload: Record<string, unknown> }
    // A deployment-wide send button that honoured an address would be an open
    // relay for one message.
    expect(queued.payload['to']).toBe(`${OPERATOR}@example.test`)
    expect(queued.payload['kind']).toBe('deployment_test')
  })

  it('reports the relay’s categorized reason, and only for its own topic', async () => {
    const app = buildApp()
    world.delivery = {
      id: 'outbox-1',
      topic: 'email.send',
      status: 'pending',
      attempts: 1,
      lastError: 'unauthorized',
      deliveredAt: null,
    }
    const pending = await call(app, 'GET', '/v1/deployment/settings/email/test/outbox-1', {
      user: OPERATOR,
    })
    const body = (await pending.json()) as Record<string, unknown>
    // Carried on a *pending* row too: a send that failed once and is waiting to
    // retry is the most informative state this surface has, and hiding the
    // reason for four minutes helps nobody.
    expect(body).toMatchObject({ status: 'pending', attempts: 1, reason: 'unauthorized' })

    world.delivery = { ...world.delivery, topic: 'telegram.send' }
    const foreign = await call(app, 'GET', '/v1/deployment/settings/email/test/outbox-1', {
      user: OPERATOR,
    })
    // The topic check is what keeps this from being a status endpoint over every
    // message the deployment has ever sent.
    expect(foreign.status).toBe(404)
  })

  it('refuses a caller who is not the operator', async () => {
    const res = await call(buildApp(), 'POST', '/v1/deployment/settings/email/test', {
      user: MEMBER,
    })
    expect(res.status).toBe(403)
    expect(world.enqueued).toEqual([])
  })
})

describe('DELETE', () => {
  it('removes the row and answers 204 even when there was none', async () => {
    const app = buildApp()
    const first = await call(app, 'DELETE', '/v1/deployment/settings/email', { user: OPERATOR })
    expect(first.status).toBe(204)
    // The state the caller asked for is the state that now holds; a 404 would
    // make a screen offering "use the environment instead" branch on history.
    expect(world.cleared).toEqual(['email'])
  })

  it('refuses a caller who is not the operator', async () => {
    const res = await call(buildApp(), 'DELETE', '/v1/deployment/settings/assistant', {
      user: MEMBER,
    })
    expect(res.status).toBe(403)
    expect(world.cleared).toEqual([])
  })
})
