import { createAuth, drizzleAuthDatabase, type Auth } from '@openanalytics/auth'
import { loadServiceEnv } from '@openanalytics/domain'
import { createServiceMetadata } from '@openanalytics/observability'
import {
  addMember,
  createDatabase,
  createPool,
  createSiteWithOwner,
  issueOAuthAccessToken,
  newId,
  resolveOAuthAccessToken,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../apps/api/src/app.ts'

/**
 * ADR-0048 D2: the grant arm and its default-deny allowlist, end to end.
 *
 * The claim under test is a boundary, so it is tested at its edges: a grant
 * with the right scope and role writes; the same grant with the wrong scope,
 * or the wrong role, or against a route that has no allowlist row, is refused
 * — and the never-writable operations are probed one by one to prove they
 * carry no row whatever the token's scope string says. A session request must
 * be provably unchanged, so the same writes are driven through a cookie too.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

const ORIGIN = 'http://localhost:3000'
const PASSWORD = 'sup3r-secret-pw'

const ALL_WRITE_SCOPES =
  'site:read analytics:read team:read billing:read sites:write funnels:write events:write widgets:write share:write'

describeIfPostgres('the OAuth grant arm on the business subtree (ADR-0048 D2)', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `garm_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database
  let app: ReturnType<typeof createApp>
  let captured: ReturnType<typeof createCapturedLogger>
  const tokens: string[] = []

  let ownerId: string
  let ownerCookie: string
  let siteA: string
  let viewerId: string

  const request = (path: string, init: RequestInit = {}) =>
    app.fetch(
      new Request(`${ORIGIN}${path}`, {
        ...init,
        headers: { origin: ORIGIN, ...((init.headers as Record<string, string>) ?? {}) },
      }),
    )

  const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })

  const withMethod =
    (method: string) =>
    (path: string, body: unknown, headers: Record<string, string> = {}) =>
      request(path, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
  const patchJson = withMethod('PATCH')
  const putJson = withMethod('PUT')

  async function signUpVerifyLogin(email: string): Promise<{ userId: string; cookie: string }> {
    const created = await postJson('/api/auth/sign-up/email', {
      email,
      password: PASSWORD,
      name: 'U',
    })
    const body = (await created.json()) as { user: { id: string } }
    await request(`/api/auth/verify-email?token=${encodeURIComponent(tokens.at(-1) ?? '')}`)
    const loggedIn = await postJson('/api/auth/sign-in/email', { email, password: PASSWORD })
    const cookie = loggedIn.headers
      .getSetCookie()
      .map((raw) => raw.split(';')[0] ?? '')
      .find((pair) => pair.includes('oa_session'))
    return { userId: body.user.id, cookie: cookie as string }
  }

  /** Mint a live OAuth grant for a user with a given scope string. */
  const grant = async (userId: string, scope: string): Promise<string> =>
    (
      await issueOAuthAccessToken(db, {
        userId,
        clientId: `dcr_${newId().replace(/-/gu, '').slice(0, 22)}`,
        scope,
        accessTokenExpiresInSeconds: 3600,
        refreshTokenExpiresInSeconds: 7200,
      })
    ).accessToken

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

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

    captured = createCapturedLogger()
    const { logger } = captured
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

    const owner = await signUpVerifyLogin(`garm-owner-${Date.now()}@example.com`)
    ownerId = owner.userId
    ownerCookie = owner.cookie
    siteA = (
      await createSiteWithOwner(db, { slug: `a-${newId()}`, name: 'Alpha', ownerUserId: ownerId })
    ).siteId

    const viewer = await signUpVerifyLogin(`garm-viewer-${Date.now()}@example.com`)
    viewerId = viewer.userId
    await addMember(db, { siteId: siteA, userId: viewerId, role: 'viewer' })
  }, 60_000)

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

  describe('a matched write with the right scope and role', () => {
    it('creates a funnel through the real route, and the session does the same', async () => {
      const token = await grant(ownerId, 'analytics:read funnels:write')
      const funnelBody = {
        name: 'Signup',
        steps: ['/pricing', '/signup'],
        window_ms: 86_400_000,
      }
      const viaGrant = await postJson(`/v1/sites/${siteA}/funnels`, funnelBody, bearer(token))
      expect(viaGrant.status, await viaGrant.clone().text()).toBe(201)

      const viaSession = await postJson(`/v1/sites/${siteA}/funnels`, funnelBody, {
        cookie: ownerCookie,
      })
      expect(viaSession.status).toBe(201)

      // The grant can read the list it just wrote to (analytics:read row).
      const list = await request(`/v1/sites/${siteA}/funnels`, { headers: bearer(token) })
      expect(list.status).toBe(200)
    })

    it('creates a site with sites:write', async () => {
      const token = await grant(ownerId, 'sites:write')
      const res = await postJson(
        '/v1/sites',
        { slug: `g-${newId()}`, name: 'Grant made this' },
        bearer(token),
      )
      expect(res.status, await res.clone().text()).toBe(201)
    })

    it('changes only the allowed fields on PATCH /sites', async () => {
      const token = await grant(ownerId, 'sites:write')
      const ok = await patchJson(`/v1/sites/${siteA}`, { name: 'Renamed by grant' }, bearer(token))
      expect(ok.status, await ok.clone().text()).toBe(200)

      // The domain allowlist is the field a prompt injection must never reach.
      const domains = await patchJson(`/v1/sites/${siteA}`, { domains: [] }, bearer(token))
      expect(domains.status).toBe(403)
      expect(((await domains.json()) as { error: { message: string } }).error.message).toContain(
        'domains',
      )
    })

    // `GET /v1/billing/usage` with `billing:read` was a case here until the
    // open-core split. Both halves of it — the scope and the allowlist row — are
    // registered by the hosted surface, so a build without that surface has
    // neither, and what they are is pinned in `tests/unit/cloud/oauth-scopes.test.ts`.

    it('reads the member list (with emails) with team:read', async () => {
      const token = await grant(ownerId, 'team:read')
      const res = await request(`/v1/sites/${siteA}/members`, { headers: bearer(token) })
      expect(res.status).toBe(200)
      // team:read exists precisely because this body carries emails.
      expect(await res.text()).toContain('@example.com')
    })
  })

  describe('the scope is a ceiling and the role is the authority', () => {
    it('refuses a viewer a write at the capability, not at the allowlist or the scope', async () => {
      const token = await grant(viewerId, ALL_WRITE_SCOPES)
      const res = await postJson(
        `/v1/sites/${siteA}/funnels`,
        { name: 'Nope', steps: ['/a', '/b'], window_ms: 86_400_000 },
        bearer(token),
      )
      // Three different refusals on this path answer 403, so the status alone
      // proves nothing — and the claim being made is precisely *which* of them
      // fired. Asserted by message, the way the revenue ceiling/floor pair is
      // (`tests/contract/api-read-session-routes.test.ts`): if this ever
      // becomes the allowlist's or the scope's refusal, the role stopped being
      // the authority and the intersection of ADR-0042 D3 and ADR-0043 D4
      // collapsed to a scope check that a wider token would walk through.
      expect(res.status).toBe(403)
      const error = ((await res.json()) as { error: { code: string; message: string } }).error
      expect(error.code).toBe('FORBIDDEN')
      expect(error.message).toBe('Insufficient capability for this operation')
      expect(error.message).not.toContain('scope')
      expect(error.message).not.toContain('not permitted to perform')
    })

    it('refuses a write when the grant lacks that write’s scope', async () => {
      const token = await grant(ownerId, 'analytics:read widgets:write')
      const res = await postJson(
        `/v1/sites/${siteA}/funnels`,
        { name: 'Nope', steps: ['/a', '/b'], window_ms: 86_400_000 },
        bearer(token),
      )
      expect(res.status).toBe(403)
      expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
        'funnels:write',
      )
    })
  })

  /**
   * `events:write` and the four routes it reaches (ADR-0048 D2 and D3).
   *
   * There was no test here at all until the 2026-08-08 audit, which is how the
   * five MCP tools that spend this scope could be missing while the scope was
   * advertised, consented to and granted. The allowlist rows existed and were
   * never exercised: an approved permission with nothing behind it.
   *
   * The matrix is the same three-way one the funnels writes get — right scope
   * passes, wrong scope is refused by name, viewer is refused by capability —
   * driven over the whole lifecycle, because publish and rollback are the two
   * mutations on this API that carry an optimistic-concurrency token and would
   * be the ones to break quietly.
   */
  describe('event definitions ride the grant arm on events:write', () => {
    const eventName = () => `e${newId().replace(/-/gu, '')}`

    const createDefinition = async (token: string, name = eventName()) =>
      postJson(
        `/v1/sites/${siteA}/event-definitions`,
        { event_name: name, display_name: 'Signup clicked' },
        bearer(token),
      )

    it('creates, drafts, publishes and rolls back with events:write', async () => {
      const token = await grant(ownerId, 'analytics:read events:write')

      const created = await createDefinition(token)
      expect(created.status, await created.clone().text()).toBe(201)
      const definitionId = ((await created.json()) as { id: string }).id

      // A second version, saved as a draft: in nobody's browser yet.
      const drafted = await postJson(
        `/v1/sites/${siteA}/event-definitions/${definitionId}/versions`,
        { display_name: 'Signup clicked (v2)' },
        bearer(token),
      )
      expect(drafted.status, await drafted.clone().text()).toBe(201)
      expect(((await drafted.json()) as { version: number }).version).toBe(2)

      // Publishing states what it expects to replace — `null`, since nothing is
      // live yet.
      const published = await postJson(
        `/v1/sites/${siteA}/event-definitions/${definitionId}/publish`,
        { version: 2, expected_published_version: null },
        bearer(token),
      )
      expect(published.status, await published.clone().text()).toBe(200)
      expect(((await published.json()) as { published_version: number }).published_version).toBe(2)

      // A stale expectation is the 409 D3 is for, over a bearer exactly as over
      // a cookie — the concurrency token is not a session-only courtesy.
      const stale = await postJson(
        `/v1/sites/${siteA}/event-definitions/${definitionId}/publish`,
        { version: 1, expected_published_version: null },
        bearer(token),
      )
      expect(stale.status).toBe(409)

      // Rollback publishes v1's content forward as v3 rather than rewinding.
      const rolledBack = await postJson(
        `/v1/sites/${siteA}/event-definitions/${definitionId}/rollback`,
        { version: 1, expected_published_version: 2 },
        bearer(token),
      )
      expect(rolledBack.status, await rolledBack.clone().text()).toBe(200)
      const rollbackBody = (await rolledBack.json()) as {
        published_version: number
        source_version: number
      }
      expect(rollbackBody.published_version).toBe(3)
      expect(rollbackBody.source_version).toBe(1)

      // And the read row that publish's `expected_published_version` comes from.
      const list = await request(`/v1/sites/${siteA}/event-definitions`, { headers: bearer(token) })
      expect(list.status).toBe(200)
      expect(
        ((await list.json()) as { items: { id: string; published_version: number }[] }).items.find(
          (item) => item.id === definitionId,
        )?.published_version,
      ).toBe(3)
    })

    it('refuses every event-definition write to a grant without events:write, by name', async () => {
      // Every *other* write scope, so the refusal is this scope's absence and
      // not a bare token.
      const token = await grant(
        ownerId,
        'analytics:read sites:write funnels:write widgets:write share:write',
      )

      const created = await createDefinition(token)
      expect(created.status).toBe(403)
      expect(((await created.json()) as { error: { message: string } }).error.message).toContain(
        'events:write',
      )

      for (const path of ['versions', 'publish', 'rollback'] as const) {
        const res = await postJson(
          `/v1/sites/${siteA}/event-definitions/${newId()}/${path}`,
          { version: 1, expected_published_version: null, display_name: 'x' },
          bearer(token),
        )
        // 403 before the handler ever looks the definition up, so a made-up id
        // is still a scope refusal and not a 404.
        expect(res.status, path).toBe(403)
        expect(
          ((await res.json()) as { error: { message: string } }).error.message,
          path,
        ).toContain('events:write')
      }

      // The list stays open on analytics:read — reading a definition is part of
      // analyzing the site, and a viewer already sees these events in charts.
      const list = await request(`/v1/sites/${siteA}/event-definitions`, { headers: bearer(token) })
      expect(list.status).toBe(200)
    })

    it('refuses a viewer with events:write at the capability, not at the scope', async () => {
      const token = await grant(viewerId, ALL_WRITE_SCOPES)
      const res = await createDefinition(token)
      expect(res.status).toBe(403)
      const error = ((await res.json()) as { error: { code: string; message: string } }).error
      expect(error.code).toBe('FORBIDDEN')
      // `site:settings` refused it after the allowlist and the scope both let
      // it through — the ceiling did not do the role's job.
      expect(error.message).toBe('Insufficient capability for this operation')
      expect(error.message).not.toContain('scope')
    })
  })

  describe('the never-writable operations carry no allowlist row', () => {
    // Each is probed with a grant holding *every* scope, so a refusal proves the
    // absence of a row, not a missing scope. All are 403 — a real principal
    // that simply lacks the door.
    const omnipotent = () => grant(ownerId, ALL_WRITE_SCOPES)

    it('site deletion', async () => {
      const token = await omnipotent()
      const res = await withMethod('DELETE')(`/v1/sites/${siteA}`, undefined, bearer(token))
      expect(res.status).toBe(403)
    })

    it('member management', async () => {
      const token = await omnipotent()
      const res = await patchJson(
        `/v1/sites/${siteA}/members/${viewerId}`,
        { role: 'admin' },
        bearer(token),
      )
      expect(res.status).toBe(403)
    })

    it('invite creation', async () => {
      const token = await omnipotent()
      const res = await postJson(
        `/v1/sites/${siteA}/invites`,
        { email: 'x@example.com', role: 'viewer' },
        bearer(token),
      )
      expect(res.status).toBe(403)
    })

    it('API key creation', async () => {
      const token = await omnipotent()
      const res = await postJson(`/v1/sites/${siteA}/keys`, { type: 'private_read' }, bearer(token))
      expect(res.status).toBe(403)
    })

    it('widget deletion', async () => {
      const token = await omnipotent()
      const res = await withMethod('DELETE')(
        `/v1/sites/${siteA}/widgets/${newId()}`,
        undefined,
        bearer(token),
      )
      expect(res.status).toBe(403)
    })

    it('event definition deletion', async () => {
      const token = await omnipotent()
      const res = await withMethod('DELETE')(
        `/v1/sites/${siteA}/event-definitions/${newId()}`,
        undefined,
        bearer(token),
      )
      expect(res.status).toBe(403)
    })

    it('account deletion', async () => {
      const token = await omnipotent()
      const res = await withMethod('DELETE')('/v1/me', undefined, bearer(token))
      expect(res.status).toBe(403)
    })

    it('the assistant', async () => {
      const token = await omnipotent()
      const res = await postJson('/v1/assistant/questions', { question: 'hi' }, bearer(token))
      expect(res.status).toBe(403)
    })
  })

  describe('the MCP write tools dispatch through the grant arm (ADR-0048 CP3)', () => {
    const mcp = (token: string, method: string, params?: Record<string, unknown>) =>
      postJson('/mcp', { jsonrpc: '2.0', id: 1, method, params }, bearer(token))

    it('lists the write tools with not-read-only annotations', async () => {
      const token = await grant(ownerId, 'analytics:read funnels:write')
      const res = await mcp(token, 'tools/list')
      expect(res.status).toBe(200)
      const { result } = (await res.json()) as {
        result: { tools: { name: string; annotations?: { readOnlyHint: boolean } }[] }
      }
      const create = result.tools.find((t) => t.name === 'create_funnel')
      expect(create).toBeDefined()
      expect(create?.annotations?.readOnlyHint).toBe(false)
      // A read tool is still read-only.
      expect(result.tools.find((t) => t.name === 'list_sites')?.annotations?.readOnlyHint).toBe(
        true,
      )
    })

    it('creates a funnel through tools/call, and refuses a viewer as tool content', async () => {
      const ownerToken = await grant(ownerId, 'analytics:read funnels:write')
      const created = await mcp(ownerToken, 'tools/call', {
        name: 'create_funnel',
        arguments: {
          site_id: siteA,
          body: { name: 'Via MCP', steps: ['/a', '/b'], window_ms: 86_400_000 },
        },
      })
      expect(created.status).toBe(200)
      const createdBody = (await created.json()) as { result: { isError: boolean } }
      // The dispatch went through the real route and succeeded — not a JSON-RPC
      // error, and not `isError`.
      expect(createdBody.result.isError).toBe(false)

      // A viewer's write comes back as readable tool content with isError, not a
      // transport error: the model has to read "you are not permitted".
      const viewerToken = await grant(viewerId, ALL_WRITE_SCOPES)
      const refused = await mcp(viewerToken, 'tools/call', {
        name: 'create_funnel',
        arguments: {
          site_id: siteA,
          body: { name: 'Nope', steps: ['/a', '/b'], window_ms: 86_400_000 },
        },
      })
      expect(refused.status).toBe(200)
      const refusedBody = (await refused.json()) as {
        result: { isError: boolean; content: { text: string }[] }
      }
      expect(refusedBody.result.isError).toBe(true)
      // The refusal the model reads is the *capability's*, carried verbatim
      // through the tool — the same message the route gives a browser. `isError`
      // alone would also be true if the allowlist or the scope had refused,
      // which is a different claim about who is in charge.
      const text = refusedBody.result.content[0]?.text ?? ''
      expect(text).toContain('Insufficient capability for this operation')
      expect(text).not.toContain('does not include the')
    })

    it('spends events:write through the tools that ADR-0048 D3 named', async () => {
      // The five tools were missing until the roster was pinned, so this is the
      // first proof that the scope reaches a tool at all rather than only a
      // route: a consent screen naming `events:write` now buys something.
      const token = await grant(ownerId, 'analytics:read events:write')
      const created = await mcp(token, 'tools/call', {
        name: 'create_event_definition',
        arguments: {
          site_id: siteA,
          body: { event_name: `m${newId().replace(/-/gu, '')}`, display_name: 'Via MCP' },
        },
      })
      expect(created.status).toBe(200)
      const createdBody = (await created.json()) as {
        result: { isError: boolean; content: { text: string }[] }
      }
      expect(createdBody.result.isError).toBe(false)
      const definitionId = (
        JSON.parse(createdBody.result.content[0]?.text ?? '{}') as { id: string }
      ).id

      const publishedRes = await mcp(token, 'tools/call', {
        name: 'publish_event_definition',
        arguments: {
          site_id: siteA,
          definition_id: definitionId,
          body: { version: 1, expected_published_version: null },
        },
      })
      const publishedBody = (await publishedRes.json()) as {
        result: { isError: boolean; content: { text: string }[] }
      }
      expect(publishedBody.result.isError, publishedBody.result.content[0]?.text).toBe(false)
      expect(publishedBody.result.content[0]?.text).toContain('"published_version":1')

      // And a grant without the scope is refused as tool content, not silently.
      const noScope = await grant(ownerId, 'analytics:read funnels:write')
      const refused = await mcp(noScope, 'tools/call', {
        name: 'rollback_event_definition',
        arguments: {
          site_id: siteA,
          definition_id: definitionId,
          body: { version: 1, expected_published_version: 1 },
        },
      })
      const refusedBody = (await refused.json()) as {
        result: { isError: boolean; content: { text: string }[] }
      }
      expect(refusedBody.result.isError).toBe(true)
      expect(refusedBody.result.content[0]?.text).toContain('events:write')
    })
  })

  describe('an unresolvable or missing bearer', () => {
    it('a made-up token is 401, not 403', async () => {
      const res = await request(`/v1/sites/${siteA}/members`, {
        headers: { authorization: 'Bearer not-a-real-token-aaaaaaaaaaaaaaaaaaaa' },
      })
      expect(res.status).toBe(401)
    })

    it('a share write with share:write rotates the link', async () => {
      const token = await grant(ownerId, 'share:write')
      const res = await putJson(
        `/v1/sites/${siteA}/public-dashboard`,
        { enabled: true, share_overview: true, rotate_slug: true },
        bearer(token),
      )
      expect(res.status, await res.clone().text()).toBe(200)
    })
  })

  /**
   * ADR-0048 D5, delivered by ADR-0051 D10: a token-authored write names its
   * client — in the request log *and* in the audit ledger.
   *
   * The write under test is `POST /v1/sites`, chosen because it produces an
   * audit row without anything in this test asking it to: `createSite` mints the
   * site's first tracking key in the same transaction, and `insertApiKey` writes
   * `api_key.created`. So the row is one an ordinary handler wrote through the
   * ordinary repository, which is the claim — `writeAudit` names the client
   * everywhere, not at instrumented call sites.
   *
   * Every assertion here is paired with the same write driven through a session
   * cookie. Without that pair the test would pass against a hard-coded field: it
   * is the *absence* on the session request that proves the value came from the
   * grant.
   */
  describe('the grant journal (ADR-0048 D5, ADR-0051 D10)', () => {
    interface AuditRow {
      readonly action: string
      readonly metadata: Record<string, unknown>
    }

    const auditRowsForSite = async (siteId: string): Promise<AuditRow[]> => {
      const { rows } = await pool.query<AuditRow>(
        `SELECT action, metadata FROM audit_logs WHERE site_id = $1 ORDER BY occurred_at`,
        [siteId],
      )
      return rows
    }

    const createdSiteRequest = (line: Record<string, unknown>): boolean =>
      line['msg'] === 'http_request' && line['route'] === '/v1/sites' && line['method'] === 'POST'

    /**
     * A user per creation, because an unfunded account may hold exactly one site
     * (`unfunded_site_limit` → `402`, ADR-0040). Reusing the outer owner would
     * make the second write in this block fail for a reason that has nothing to
     * do with what is under test.
     */
    let seq = 0
    const freshUser = async (): Promise<{ userId: string; cookie: string }> =>
      signUpVerifyLogin(`garm-journal-${Date.now()}-${(seq += 1)}@example.com`)

    it('names the client and the grant in the audit row and the request log', async () => {
      const user = await freshUser()
      const token = await grant(user.userId, 'sites:write')
      const resolved = await resolveOAuthAccessToken(db, token)
      expect(resolved).not.toBeNull()

      captured.clear()
      const res = await postJson(
        '/v1/sites',
        { slug: `j-${newId()}`, name: 'Journalled' },
        bearer(token),
      )
      expect(res.status, await res.clone().text()).toBe(201)
      const { site_id: siteId } = (await res.json()) as { site_id: string }

      const rows = await auditRowsForSite(siteId)
      const created = rows.find((row) => row.action === 'api_key.created')
      expect(created, `audit rows: ${JSON.stringify(rows)}`).toBeDefined()
      expect(created?.metadata['client_id']).toBe(resolved?.clientId)
      expect(created?.metadata['grant_id']).toBe(resolved?.id)
      // The metadata the call site already wrote survives the merge.
      expect(created?.metadata['type']).toBe('tracking_write')

      const logLine = captured.lines.find(createdSiteRequest)
      expect(logLine, 'no http_request line for POST /v1/sites').toBeDefined()
      expect(logLine?.['client_id']).toBe(resolved?.clientId)
      expect(logLine?.['grant_id']).toBe(resolved?.id)
    })

    it('leaves both absent when the same write comes from a session', async () => {
      const user = await freshUser()

      captured.clear()
      const res = await postJson(
        '/v1/sites',
        { slug: `j-${newId()}`, name: 'Session made this' },
        { cookie: user.cookie },
      )
      expect(res.status, await res.clone().text()).toBe(201)
      const { site_id: siteId } = (await res.json()) as { site_id: string }

      const created = (await auditRowsForSite(siteId)).find(
        (row) => row.action === 'api_key.created',
      )
      expect(created).toBeDefined()
      expect(created?.metadata).not.toHaveProperty('client_id')
      expect(created?.metadata).not.toHaveProperty('grant_id')

      const logLine = captured.lines.find(createdSiteRequest)
      expect(logLine).toBeDefined()
      expect(logLine).not.toHaveProperty('client_id')
      expect(logLine).not.toHaveProperty('grant_id')
    })

    it('does not leak one request’s client into the next', async () => {
      const first = await freshUser()
      const token = await grant(first.userId, 'sites:write')
      const withGrant = await postJson(
        '/v1/sites',
        { slug: `j-${newId()}`, name: 'First' },
        bearer(token),
      )
      expect(withGrant.status).toBe(201)

      // A second request on the same app, with no bearer at all. The context is
      // mutated in place for the rest of a request (`setRequestContextFields`),
      // so "the rest of a request" has to mean this one and no other.
      const second = await freshUser()
      captured.clear()
      const res = await postJson(
        '/v1/sites',
        { slug: `j-${newId()}`, name: 'Second' },
        { cookie: second.cookie },
      )
      expect(res.status, await res.clone().text()).toBe(201)
      expect(captured.lines.find(createdSiteRequest)).not.toHaveProperty('client_id')
    })
  })
})
