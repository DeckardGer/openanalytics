import { createAuth, drizzleAuthDatabase, type Auth } from '@openanalytics/auth'
import { loadServiceEnv } from '@openanalytics/domain'
import { createServiceMetadata } from '@openanalytics/observability'
import {
  addMember,
  createDatabase,
  createPool,
  createSiteWithOwner,
  newId,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../apps/api/src/app.ts'

/**
 * The event-definition HTTP surface over a real Postgres (ADR-0034; CP2).
 *
 * What lives at the route and nowhere else, so no repository suite can prove it:
 *
 * - the capability split — a `viewer` may read every definition and may write
 *   none, and an `admin` may do both;
 * - the site-wide published-rule ceiling, which is checked at *publish* and not
 *   at save, and which no single version row can see;
 * - the two 409s having their own codes and carrying the value a client needs to
 *   recover (`published_version`).
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

const ORIGIN = 'http://localhost:3000'
const PASSWORD = 'sup3r-secret-pw'

function content(overrides: Record<string, unknown> = {}) {
  return {
    display_name: 'Pricing CTA clicked',
    property_schema: [{ key: 'button_label' }],
    display_template: 'Clicked “{{button_label}}”',
    rules: [
      {
        rule_id: newId(),
        trigger: 'click',
        selector: 'section.pricing > button.cta',
        properties: [{ key: 'button_label', source: 'text' }],
      },
    ],
    ...overrides,
  }
}

describeIfPostgres('event definition routes', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m13api_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database
  let app: ReturnType<typeof createApp>
  const tokens: string[] = []

  let ownerCookie: string
  let adminCookie: string
  let viewerCookie: string
  let siteId: string

  const req = (method: string, path: string, body?: unknown, cookie?: string) =>
    app.fetch(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN,
          ...(cookie ? { cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )

  const post = (path: string, body: unknown, cookie?: string) => req('POST', path, body, cookie)
  const get = (path: string, cookie?: string) => req('GET', path, undefined, cookie)

  const sessionCookie = (res: Response): string | null => {
    for (const raw of res.headers.getSetCookie()) {
      const pair = raw.split(';')[0] ?? ''
      if (pair.includes('oa_session')) return pair
    }
    return null
  }

  async function signUpVerifyLogin(email: string): Promise<{ userId: string; cookie: string }> {
    const created = await post('/api/auth/sign-up/email', { email, password: PASSWORD, name: 'U' })
    expect(created.ok, 'sign-up should succeed').toBe(true)
    const body = (await created.json()) as { user: { id: string } }
    const token = tokens[tokens.length - 1]
    await get(`/api/auth/verify-email?token=${encodeURIComponent(token ?? '')}`)
    const loggedIn = await post('/api/auth/sign-in/email', { email, password: PASSWORD })
    const cookie = sessionCookie(loggedIn)
    expect(cookie, 'sign-in should set a session cookie').not.toBeNull()
    return { userId: body.user.id, cookie: cookie as string }
  }

  /** A fresh definition, published or not, so tests do not share state. */
  async function makeDefinition(
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; publishedVersion: number | null }> {
    const created = await post(
      `/v1/sites/${siteId}/event-definitions`,
      { event_name: `ev_${newId().replace(/-/gu, '').slice(0, 12)}`, ...content(overrides) },
      ownerCookie,
    )
    expect(created.status, await created.clone().text()).toBe(201)
    const body = (await created.json()) as { id: string; published_version: number | null }
    return { id: body.id, publishedVersion: body.published_version }
  }

  beforeAll(async () => {
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`CREATE SCHEMA ${schemaName}`)
    } finally {
      await admin.end()
    }

    const url = new URL(connectionString)
    url.searchParams.set('options', `-c search_path=${schemaName}`)
    const scoped = url.toString()

    const { logger } = createCapturedLogger()
    await applyPostgresStreams({ connectionString: scoped, logger })

    pool = createPool(scoped)
    db = createDatabase(pool)

    const auth: Auth = createAuth({
      database: drizzleAuthDatabase(db),
      secret: 'test-secret-'.padEnd(32, 'x'),
      baseURL: ORIGIN,
      productName: 'Acme Metrics',
      trustedOrigins: [ORIGIN],
      sendVerificationEmail: async ({ token }) => {
        tokens.push(token)
      },
    })

    const env = loadServiceEnv('api', testEnv())
    const service = createServiceMetadata({
      name: 'api',
      version: '0.0.0-test',
      environment: 'test',
    })
    app = createApp({ service, logger, env, auth, db })

    const owner = await signUpVerifyLogin(`owner-${Date.now()}@example.com`)
    ownerCookie = owner.cookie
    const created = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'Acme',
      ownerUserId: owner.userId,
    })
    siteId = created.siteId

    const adminUser = await signUpVerifyLogin(`admin-${Date.now()}@example.com`)
    adminCookie = adminUser.cookie
    await addMember(db, { siteId, userId: adminUser.userId, role: 'admin' })

    const viewerUser = await signUpVerifyLogin(`viewer-${Date.now()}@example.com`)
    viewerCookie = viewerUser.cookie
    await addMember(db, { siteId, userId: viewerUser.userId, role: 'viewer' })
  }, 180_000)

  afterAll(async () => {
    await pool?.end()
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
    } finally {
      await admin.end()
    }
  })

  describe('authorization', () => {
    it('needs a session at all', async () => {
      expect((await get(`/v1/sites/${siteId}/event-definitions`)).status).toBe(401)
    })

    it('lets a viewer read but never write', async () => {
      expect((await get(`/v1/sites/${siteId}/event-definitions`, viewerCookie)).status).toBe(200)

      const created = await post(
        `/v1/sites/${siteId}/event-definitions`,
        { event_name: 'viewer_should_not', ...content() },
        viewerCookie,
      )
      expect(created.status).toBe(403)
    })

    it('lets an admin write, because a rule set is site settings', async () => {
      const created = await post(
        `/v1/sites/${siteId}/event-definitions`,
        { event_name: 'admin_may_write', ...content() },
        adminCookie,
      )
      expect(created.status).toBe(201)
    })
  })

  describe('create and validate', () => {
    it('creates a definition and its v1, unpublished', async () => {
      const created = await post(
        `/v1/sites/${siteId}/event-definitions`,
        { event_name: 'created_unpublished', ...content() },
        ownerCookie,
      )
      expect(created.status).toBe(201)
      const body = (await created.json()) as Record<string, unknown> & {
        version: { version: number }
      }
      expect(body['published_version']).toBeNull()
      expect(body.version.version).toBe(1)
    })

    it('refuses a duplicate name with its own code, not a generic conflict', async () => {
      await post(
        `/v1/sites/${siteId}/event-definitions`,
        { event_name: 'taken_name', ...content() },
        ownerCookie,
      )
      const second = await post(
        `/v1/sites/${siteId}/event-definitions`,
        { event_name: 'taken_name', ...content() },
        ownerCookie,
      )
      expect(second.status).toBe(409)
      const body = (await second.json()) as { error: { code: string } }
      expect(body.error.code).toBe('EVENT_DEFINITION_NAME_TAKEN')
    })

    it('refuses a hostile selector at the route, before it can ever be published', async () => {
      const created = await post(
        `/v1/sites/${siteId}/event-definitions`,
        {
          event_name: 'hostile_selector',
          ...content({
            rules: [{ rule_id: newId(), trigger: 'click', selector: 'div:has(a[href])' }],
          }),
        },
        ownerCookie,
      )
      expect(created.status).toBe(400)
      expect(JSON.stringify(await created.json())).toMatch(/unsupported_pseudo/u)
    })

    it('refuses a rule that would read an input value', async () => {
      const created = await post(
        `/v1/sites/${siteId}/event-definitions`,
        {
          event_name: 'reads_input',
          ...content({
            property_schema: [{ key: 'typed' }],
            display_template: null,
            rules: [
              {
                rule_id: newId(),
                trigger: 'click',
                selector: 'form > button',
                properties: [{ key: 'typed', source: 'attribute', argument: 'value' }],
              },
            ],
          }),
        },
        ownerCookie,
      )
      expect(created.status).toBe(400)
      expect(JSON.stringify(await created.json())).toMatch(/never readable/u)
    })
  })

  describe('publish and rollback', () => {
    it('publishes, and reports the config epoch the tracker ETag is built from', async () => {
      const def = await makeDefinition()
      const published = await post(
        `/v1/sites/${siteId}/event-definitions/${def.id}/publish`,
        { version: 1, expected_published_version: null },
        ownerCookie,
      )
      expect(published.status).toBe(200)
      const body = (await published.json()) as { published_version: number; config_version: number }
      expect(body.published_version).toBe(1)
      expect(body.config_version).toBeGreaterThan(0)
    })

    it('409s with the live version when someone else published first', async () => {
      const def = await makeDefinition()
      await post(
        `/v1/sites/${siteId}/event-definitions/${def.id}/versions`,
        content({ display_name: 'V2' }),
        ownerCookie,
      )
      await post(
        `/v1/sites/${siteId}/event-definitions/${def.id}/publish`,
        { version: 1, expected_published_version: null },
        ownerCookie,
      )

      const stale = await post(
        `/v1/sites/${siteId}/event-definitions/${def.id}/publish`,
        { version: 2, expected_published_version: null },
        ownerCookie,
      )
      expect(stale.status).toBe(409)
      const body = (await stale.json()) as {
        error: { code: string; details: { published_version: number } }
      }
      expect(body.error.code).toBe('EVENT_DEFINITION_VERSION_CONFLICT')
      // The value the client needs to re-render and retry.
      expect(body.error.details.published_version).toBe(1)
    })

    it('rolls back by publishing a new version, not by rewinding the pointer', async () => {
      const def = await makeDefinition()
      await post(
        `/v1/sites/${siteId}/event-definitions/${def.id}/publish`,
        { version: 1, expected_published_version: null },
        ownerCookie,
      )
      await post(
        `/v1/sites/${siteId}/event-definitions/${def.id}/versions`,
        content({ display_name: 'V2' }),
        ownerCookie,
      )
      await post(
        `/v1/sites/${siteId}/event-definitions/${def.id}/publish`,
        { version: 2, expected_published_version: 1 },
        ownerCookie,
      )

      const rolled = await post(
        `/v1/sites/${siteId}/event-definitions/${def.id}/rollback`,
        { version: 1, expected_published_version: 2 },
        ownerCookie,
      )
      expect(rolled.status).toBe(200)
      const body = (await rolled.json()) as {
        published_version: number
        source_version: number
        version: { display_name: string }
      }
      // A NEW version whose content is v1's.
      expect(body.published_version).toBe(3)
      expect(body.source_version).toBe(1)
      expect(body.version.display_name).toBe('Pricing CTA clicked')

      // History still reads as three entries, none rewritten.
      const history = await get(
        `/v1/sites/${siteId}/event-definitions/${def.id}/versions`,
        viewerCookie,
      )
      const list = (await history.json()) as {
        published_version: number
        items: { version: number }[]
      }
      expect(list.published_version).toBe(3)
      expect(list.items.map((v) => v.version)).toEqual([1, 2, 3])
    })
  })

  describe('the site-wide rule ceiling', () => {
    it('is checked at publish, not at save', async () => {
      // Earlier tests in this file have already published definitions, so the
      // headroom is measured rather than assumed -- the ceiling is a *site*
      // total, which is the whole reason it cannot be a per-version constraint.
      const alreadyPublished = await pool.query<{ n: string }>(
        `SELECT coalesce(sum(jsonb_array_length(v.rules)), 0)::text AS n
           FROM event_definitions d
           JOIN event_definition_versions v
             ON v.definition_id = d.id AND v.version = d.published_version
          WHERE d.site_id = $1 AND d.archived_at IS NULL`,
        [siteId],
      )
      const headroom = 50 - Number(alreadyPublished.rows[0]?.n ?? 0)
      expect(headroom).toBeGreaterThan(1)

      const rules = Array.from({ length: headroom }, () => ({
        rule_id: newId(),
        trigger: 'click' as const,
        selector: 'button.cta',
      }))

      // Saving is fine at any size the schema allows; a draft is in nobody's
      // browser, so bounding drafts would refuse work that costs nothing.
      const big = await post(
        `/v1/sites/${siteId}/event-definitions`,
        {
          event_name: 'fills_the_budget',
          ...content({ rules, property_schema: [], display_template: null }),
        },
        ownerCookie,
      )
      expect(big.status).toBe(201)
      const bigId = ((await big.json()) as { id: string }).id

      // Exactly at the ceiling still publishes.
      const publishedFirst = await post(
        `/v1/sites/${siteId}/event-definitions/${bigId}/publish`,
        { version: 1, expected_published_version: null },
        ownerCookie,
      )
      expect(publishedFirst.status, await publishedFirst.clone().text()).toBe(200)

      // A second published definition would take the site past 50.
      const extra = await makeDefinition()
      const refused = await post(
        `/v1/sites/${siteId}/event-definitions/${extra.id}/publish`,
        { version: 1, expected_published_version: null },
        ownerCookie,
      )
      expect(refused.status).toBe(400)
      expect(JSON.stringify(await refused.json())).toMatch(/rule_budget_exceeded/u)

      // Clean up so later tests are not living under a full budget.
      await req('DELETE', `/v1/sites/${siteId}/event-definitions/${bigId}`, undefined, ownerCookie)
    })
  })

  describe('archive', () => {
    it('unpublishes, and is idempotent on a repeat', async () => {
      const def = await makeDefinition()
      await post(
        `/v1/sites/${siteId}/event-definitions/${def.id}/publish`,
        { version: 1, expected_published_version: null },
        ownerCookie,
      )

      const first = await req(
        'DELETE',
        `/v1/sites/${siteId}/event-definitions/${def.id}`,
        undefined,
        ownerCookie,
      )
      expect(first.status).toBe(204)

      const read = await get(`/v1/sites/${siteId}/event-definitions/${def.id}`, ownerCookie)
      const body = (await read.json()) as { status: string; published_version: number | null }
      expect(body.status).toBe('archived')
      expect(body.published_version).toBeNull()

      const second = await req(
        'DELETE',
        `/v1/sites/${siteId}/event-definitions/${def.id}`,
        undefined,
        ownerCookie,
      )
      expect(second.status).toBe(204)
    })
  })
})
