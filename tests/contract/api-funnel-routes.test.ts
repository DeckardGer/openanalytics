import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { funnelDefinitionFixture } from '@openanalytics/contracts'
import { loadServiceEnv } from '@openanalytics/domain'
import type { Auth } from '@openanalytics/auth'
import type { Database, FunnelDefinition } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Stored funnel definitions (migration 0024): the contract document, and the
 * server-side authorization on the four routes that serve it.
 *
 * The invariant this file exists to prove is the one AGENTS.md states as a hard
 * rule — every endpoint authorizes on the server. For funnels that means two
 * distinct answers: a non-member is told the *site* does not exist, and a member
 * who is only a `viewer` may read the list but is refused every mutation, with
 * the refusal landing before any repository call.
 *
 * The persistence surface is deliberately separate from the computation: nothing
 * here calls the query gateway, and `GET .../analytics/funnel` is untouched.
 */

const SPEC_PATH = fileURLToPath(
  new URL('../../packages/contracts/openapi/openapi.yaml', import.meta.url),
)

async function spec(): Promise<string> {
  return readFile(SPEC_PATH, 'utf8')
}

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const FUNNEL = '019f8740-2b3c-7a10-9c1d-4e5f6a7b8cc0'
const OWNER = 'u-owner'
const ADMIN = 'u-admin'
const VIEWER = 'u-viewer'
const STRANGER = 'u-stranger'

const memberships = new Map<string, { role: string; isBillingOwner: boolean }>([
  [OWNER, { role: 'owner', isBillingOwner: true }],
  [ADMIN, { role: 'admin', isBillingOwner: false }],
  [VIEWER, { role: 'viewer', isBillingOwner: false }],
])

const row: FunnelDefinition = {
  id: FUNNEL,
  siteId: SITE,
  name: 'Checkout',
  steps: ['/pricing', '/signup', '/checkout', 'purchase'],
  scope: 'visitor',
  windowMs: 604_800_000,
  createdByUserId: OWNER,
  createdAt: new Date('2026-07-20T10:30:00.000Z'),
  updatedAt: new Date('2026-07-20T10:30:00.000Z'),
  archivedAt: null,
}

/** Every repository call the routes can make, recorded so "refused before any
 * write" is provable rather than assumed. */
const calls = {
  list: [] as { siteId: string; includeArchived: boolean | undefined }[],
  create: [] as Record<string, unknown>[],
  update: [] as Record<string, unknown>[],
  archive: [] as { id: string; siteId: string }[],
}
const results = { update: true, archive: true }

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    getMembership: async (_db: unknown, params: { siteId: string; userId: string }) =>
      memberships.get(params.userId) ?? null,
    listFunnels: async (_db: unknown, siteId: string, options?: { includeArchived?: boolean }) => {
      calls.list.push({ siteId, includeArchived: options?.includeArchived })
      return [row]
    },
    createFunnel: async (_db: unknown, input: Record<string, unknown>) => {
      calls.create.push(input)
      return row
    },
    updateFunnel: async (_db: unknown, input: Record<string, unknown>) => {
      calls.update.push(input)
      return results.update ? row : null
    },
    archiveFunnel: async (_db: unknown, input: { id: string; siteId: string }) => {
      calls.archive.push({ id: input.id, siteId: input.siteId })
      return { archived: results.archive }
    },
  }
})

// After `vi.mock`, so the app is built against the mocked repository.
const { createApp } = await import('../../apps/api/src/app.ts')

/** The caller is chosen per request with a test header, so one app instance can
 * exercise every role. */
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

const send = (method: string, path: string, user?: string, body?: unknown) =>
  app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: {
        ...(user === undefined ? {} : { 'x-test-user': user }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )

const VALID_BODY = {
  name: 'Checkout',
  steps: ['/pricing', '/signup', '/checkout', 'purchase'],
  window_ms: 604_800_000,
}

beforeEach(() => {
  calls.list = []
  calls.create = []
  calls.update = []
  calls.archive = []
  results.update = true
  results.archive = true
})

describe('OpenAPI documents the stored funnel surface', () => {
  const operationIds = [
    'listSiteFunnels',
    'createSiteFunnel',
    'updateSiteFunnel',
    'archiveSiteFunnel',
  ]

  it('declares all four operationIds, each exactly once', async () => {
    const text = await spec()
    for (const operationId of operationIds) {
      expect(text, `openapi.yaml is missing operationId ${operationId}`).toContain(
        `operationId: ${operationId}`,
      )
      const occurrences = text.split(`operationId: ${operationId}\n`).length - 1
      expect(occurrences, operationId).toBe(1)
    }
  })

  it('routes the collection and the item at their own path items', async () => {
    const text = await spec()
    expect(text).toContain('/v1/sites/{site_id}/funnels:')
    expect(text).toContain('/v1/sites/{site_id}/funnels/{funnel_id}:')
  })

  it('tells the reader that computing a stored funnel is the analytics call', async () => {
    // The whole point of the checkpoint: this surface stores, it does not
    // compute. A frontend that could not find that sentence would look for a
    // "run" endpoint that does not exist.
    const text = await spec()
    const block = text.slice(
      text.indexOf('operationId: listSiteFunnels'),
      text.indexOf('operationId: createSiteFunnel'),
    )
    expect(block).toContain('/v1/sites/{site_id}/analytics/funnel')
    expect(block).toContain('include_archived')
  })

  it('bounds a stored definition exactly as the compute endpoint bounds a query', async () => {
    // A definition that saves but cannot be run would be a trap: the failure
    // would surface later, on a screen that only reads.
    const text = await spec()
    const block = text.slice(
      text.indexOf('    FunnelStepKeys:'),
      text.indexOf('    FunnelDefinition:'),
    )
    expect(block).toContain('minItems: 2')
    expect(block).toContain('maxItems: 8')
    expect(block).toContain('maxLength: 512')

    const definition = text.slice(
      text.indexOf('    FunnelDefinition:'),
      text.indexOf('    CreateFunnelRequest:'),
    )
    expect(definition).toContain('maximum: 2592000000')
    expect(definition).toContain('enum: [visitor, session]')
  })

  it('publishes archived_at, with null meaning live', async () => {
    const text = await spec()
    const definition = text.slice(
      text.indexOf('    FunnelDefinition:'),
      text.indexOf('    CreateFunnelRequest:'),
    )
    expect(definition).toContain('archived_at')
    expect(definition).toContain("type: 'null'")
    expect(funnelDefinitionFixture.archived_at).toBeNull()
    expect(funnelDefinitionFixture.steps).toHaveLength(4)
  })

  it('refuses an empty patch in the document, not only in the server', async () => {
    const text = await spec()
    const block = text.slice(
      text.indexOf('    UpdateFunnelRequest:'),
      text.indexOf('    RecentVisitorsMeta:'),
    )
    expect(block).toContain('minProperties: 1')
    expect(block).toContain('additionalProperties: false')
  })

  it('names site:settings on every mutation and on no read', async () => {
    const text = await spec()
    const list = text.slice(
      text.indexOf('operationId: listSiteFunnels'),
      text.indexOf('operationId: createSiteFunnel'),
    )
    expect(list).not.toContain('site:settings')

    for (const [from, to] of [
      ['operationId: createSiteFunnel', '/v1/sites/{site_id}/funnels/{funnel_id}:'],
      ['operationId: updateSiteFunnel', 'operationId: archiveSiteFunnel'],
      ['operationId: archiveSiteFunnel', 'components:'],
    ] as const) {
      const block = text.slice(text.indexOf(from), text.indexOf(to))
      expect(block, from).toContain('site:settings')
    }
  })

  it('documents the archive as an idempotent 204', async () => {
    const text = await spec()
    const block = text.slice(
      text.indexOf('operationId: archiveSiteFunnel'),
      text.indexOf('components:'),
    )
    expect(block).toContain("'204'")
    expect(block).toContain("'404'")
    expect(block).toContain('NOT_FOUND')
    expect(block).toContain('idempotent')
  })
})

describe('funnel routes authorize on the server', () => {
  it('401s without a session and touches no repository', async () => {
    const res = await send('GET', `/v1/sites/${SITE}/funnels`)
    expect(res.status).toBe(401)
    expect(calls.list).toEqual([])
  })

  it('404s a non-member rather than admitting the site exists', async () => {
    const list = await send('GET', `/v1/sites/${SITE}/funnels`, STRANGER)
    expect(list.status).toBe(404)
    expect((await list.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'SITE_NOT_FOUND' },
    })

    const create = await send('POST', `/v1/sites/${SITE}/funnels`, STRANGER, VALID_BODY)
    expect(create.status).toBe(404)
    expect(calls.list).toEqual([])
    expect(calls.create).toEqual([])
  })

  it('lets a viewer read the saved list', async () => {
    // A viewer can already compute an ad-hoc funnel, so withholding the saved
    // names would hide the labels, not the data.
    const res = await send('GET', `/v1/sites/${SITE}/funnels`, VIEWER)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      items: [
        {
          id: FUNNEL,
          name: 'Checkout',
          steps: ['/pricing', '/signup', '/checkout', 'purchase'],
          scope: 'visitor',
          window_ms: 604_800_000,
          created_by_user_id: OWNER,
          created_at: '2026-07-20T10:30:00.000Z',
          updated_at: '2026-07-20T10:30:00.000Z',
          archived_at: null,
        },
      ],
    })
  })

  it('refuses a viewer every mutation, before any write', async () => {
    const create = await send('POST', `/v1/sites/${SITE}/funnels`, VIEWER, VALID_BODY)
    const patch = await send('PATCH', `/v1/sites/${SITE}/funnels/${FUNNEL}`, VIEWER, {
      name: 'Renamed',
    })
    const archive = await send('DELETE', `/v1/sites/${SITE}/funnels/${FUNNEL}`, VIEWER)

    for (const res of [create, patch, archive]) {
      expect(res.status).toBe(403)
      expect((await res.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'FORBIDDEN' },
      })
    }
    expect(calls.create).toEqual([])
    expect(calls.update).toEqual([])
    expect(calls.archive).toEqual([])
  })
})

describe('listing stored funnels', () => {
  it('excludes archived definitions by default', async () => {
    await send('GET', `/v1/sites/${SITE}/funnels`, ADMIN)
    expect(calls.list).toEqual([{ siteId: SITE, includeArchived: false }])
  })

  it('includes them when asked', async () => {
    await send('GET', `/v1/sites/${SITE}/funnels?include_archived=true`, ADMIN)
    expect(calls.list).toEqual([{ siteId: SITE, includeArchived: true }])
  })

  it('treats any other value as the default rather than guessing', async () => {
    await send('GET', `/v1/sites/${SITE}/funnels?include_archived=1`, ADMIN)
    expect(calls.list).toEqual([{ siteId: SITE, includeArchived: false }])
  })
})

describe('saving a funnel definition', () => {
  it('creates one for an admin and answers 201 with the stored shape', async () => {
    const res = await send('POST', `/v1/sites/${SITE}/funnels`, ADMIN, VALID_BODY)
    expect(res.status).toBe(201)
    expect(calls.create[0]).toMatchObject({
      siteId: SITE,
      name: 'Checkout',
      steps: ['/pricing', '/signup', '/checkout', 'purchase'],
      // Absent from the body, defaulted by the shared domain schema.
      scope: 'visitor',
      windowMs: 604_800_000,
      createdByUserId: ADMIN,
    })
    expect((await res.json()) as { id: string }).toMatchObject({ id: FUNNEL, archived_at: null })
  })

  it('refuses a one-step funnel, which is not a funnel', async () => {
    const res = await send('POST', `/v1/sites/${SITE}/funnels`, OWNER, {
      ...VALID_BODY,
      steps: ['/pricing'],
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as {
      error: { code: string; details: { issues: { path: string }[] } }
    }
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.details.issues[0]?.path).toBe('steps')
    expect(calls.create).toEqual([])
  })

  it('refuses more steps than the gateway operation can express', async () => {
    const res = await send('POST', `/v1/sites/${SITE}/funnels`, OWNER, {
      ...VALID_BODY,
      steps: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
    })
    expect(res.status).toBe(400)
    expect(calls.create).toEqual([])
  })

  it('refuses a window past the 30-day ceiling the compute endpoint enforces', async () => {
    const res = await send('POST', `/v1/sites/${SITE}/funnels`, OWNER, {
      ...VALID_BODY,
      window_ms: 2_592_000_001,
    })
    expect(res.status).toBe(400)
    expect(calls.create).toEqual([])
  })

  it('refuses an unknown scope and an unknown field', async () => {
    const badScope = await send('POST', `/v1/sites/${SITE}/funnels`, OWNER, {
      ...VALID_BODY,
      scope: 'session_canonical',
    })
    expect(badScope.status).toBe(400)

    const extra = await send('POST', `/v1/sites/${SITE}/funnels`, OWNER, {
      ...VALID_BODY,
      from: '2026-07-01T00:00:00.000Z',
    })
    // A stored definition carries no range; accepting `from` would let a caller
    // believe the saved funnel had been pinned to one.
    expect(extra.status).toBe(400)
    expect(calls.create).toEqual([])
  })
})

describe('changing a funnel definition', () => {
  it('applies a partial update and returns the definition', async () => {
    const res = await send('PATCH', `/v1/sites/${SITE}/funnels/${FUNNEL}`, ADMIN, {
      name: 'Checkout v2',
    })
    expect(res.status).toBe(200)
    expect(calls.update[0]).toMatchObject({ id: FUNNEL, siteId: SITE, name: 'Checkout v2' })
    // Only what was sent is forwarded; the untouched fields are not overwritten.
    expect(calls.update[0]).not.toHaveProperty('steps')
    expect(calls.update[0]).not.toHaveProperty('scope')
    expect(calls.update[0]).not.toHaveProperty('windowMs')
  })

  it('refuses an update that changes nothing', async () => {
    const res = await send('PATCH', `/v1/sites/${SITE}/funnels/${FUNNEL}`, OWNER, {})
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    })
    expect(calls.update).toEqual([])
  })

  it('404s when no live funnel with that id is on this site', async () => {
    results.update = false
    const res = await send('PATCH', `/v1/sites/${SITE}/funnels/${FUNNEL}`, OWNER, { name: 'X' })
    expect(res.status).toBe(404)
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'NOT_FOUND' },
    })
  })
})

describe('archiving a funnel definition', () => {
  it('archives with a bodiless 204', async () => {
    const res = await send('DELETE', `/v1/sites/${SITE}/funnels/${FUNNEL}`, ADMIN)
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    expect(calls.archive).toEqual([{ id: FUNNEL, siteId: SITE }])
  })

  it('answers a replay with 204 rather than 404', async () => {
    // Unlike a credential revocation, archiving states an intent about the
    // funnel's place in the list. "Archive it again" is honestly answered by
    // "it is archived".
    const first = await send('DELETE', `/v1/sites/${SITE}/funnels/${FUNNEL}`, OWNER)
    const second = await send('DELETE', `/v1/sites/${SITE}/funnels/${FUNNEL}`, OWNER)
    expect(first.status).toBe(204)
    expect(second.status).toBe(204)
    expect(calls.archive).toHaveLength(2)
  })

  it('404s when the site has no funnel with that id at all', async () => {
    results.archive = false
    const res = await send('DELETE', `/v1/sites/${SITE}/funnels/${FUNNEL}`, OWNER)
    expect(res.status).toBe(404)
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'NOT_FOUND' },
    })
  })
})
