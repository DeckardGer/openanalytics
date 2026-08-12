import { loadServiceEnv } from '@openanalytics/domain'
import type { Auth } from '@openanalytics/auth'
import type {
  Database,
  PublicDashboardSettings,
  UpdatePublicDashboardInput,
} from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The owner-facing public-dashboard settings surface after ADR-0039 and
 * ADR-0044.
 *
 * Two things are worth pinning here and neither needs a database: the response
 * carries **all nine** per-surface flags (a screen that cannot see a flag
 * cannot offer a toggle for it), and the `PUT` is a **full replace** whose
 * omitted surfaces come out `false` — the direction a missing field has to fail
 * in, because the alternative is a client publishing a surface it never sent.
 */

const membership = { value: null as { role: string; isBillingOwner: boolean } | null }
const getSettingsMock = vi.fn()
const updateSettingsMock = vi.fn()

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    getMembership: async () => membership.value,
    getPublicDashboardSettings: (...args: unknown[]) => getSettingsMock(...(args as [])),
    updatePublicDashboardSettings: (...args: unknown[]) => updateSettingsMock(...(args as [])),
  }
})

const { createApp } = await import('../../apps/api/src/app.ts')

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const ACTOR = 'actor-1'
const URL_SETTINGS = `http://api.test/v1/sites/${SITE}/public-dashboard`

/** The nine wire names, in the order the ADRs list them. */
const WIRE_FLAGS = [
  'share_overview',
  'share_geography',
  'share_realtime',
  'share_timeseries',
  'share_sessions',
  'share_pages',
  'share_sources',
  'share_devices',
  // ADR-0044: the ninth. It publishes the site's name and favicon domain.
  'share_identity',
] as const

const SETTINGS: PublicDashboardSettings = {
  enabled: true,
  shareSlug: 'sunny-otter-4821',
  shareOverview: true,
  shareGeography: false,
  shareRealtime: false,
  shareTimeseries: true,
  shareSessions: true,
  sharePages: false,
  shareSources: false,
  shareDevices: true,
  shareIdentity: false,
}

function sessionAuthStub(): Auth {
  return {
    api: {
      getSession: async () => ({
        user: {
          id: ACTOR,
          email: 'a@b.test',
          emailVerified: true,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        session: { createdAt: new Date() },
      }),
    },
    handler: async () => new Response(null),
  } as unknown as Auth
}

function buildApp() {
  const { logger } = createCapturedLogger()
  return createApp({
    service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
    logger,
    env: loadServiceEnv('api', testEnv()),
    auth: sessionAuthStub(),
    db: {} as Database,
  })
}

beforeEach(() => {
  membership.value = { role: 'owner', isBillingOwner: false }
  getSettingsMock.mockReset()
  getSettingsMock.mockResolvedValue(SETTINGS)
  updateSettingsMock.mockReset()
  updateSettingsMock.mockResolvedValue(SETTINGS)
})

async function put(body: Record<string, unknown>) {
  return buildApp().fetch(
    new Request(URL_SETTINGS, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

describe('GET /v1/sites/:id/public-dashboard', () => {
  it('returns every per-surface flag, including the five ADR-0039 added', async () => {
    const res = await buildApp().fetch(new Request(URL_SETTINGS))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>

    for (const flag of WIRE_FLAGS) expect(body).toHaveProperty(flag)
    expect(body['share_timeseries']).toBe(true)
    expect(body['share_pages']).toBe(false)
    // Not merely present: the nine flags plus the master switch and the slug,
    // and nothing else — the response is an allowlist, not a row dump.
    expect(Object.keys(body).sort()).toEqual(['enabled', 'share_slug', ...WIRE_FLAGS].sort())
  })
})

describe('PUT /v1/sites/:id/public-dashboard', () => {
  it('passes each new surface through to the repository', async () => {
    const res = await put({
      enabled: true,
      share_timeseries: true,
      share_sessions: true,
      share_pages: true,
      share_sources: true,
      share_devices: true,
    })
    expect(res.status).toBe(200)

    const input = updateSettingsMock.mock.calls[0]?.[1] as UpdatePublicDashboardInput
    expect(input).toMatchObject({
      siteId: SITE,
      enabled: true,
      shareTimeseries: true,
      shareSessions: true,
      sharePages: true,
      shareSources: true,
      shareDevices: true,
    })
  })

  it('is a full replace: an omitted surface is stored as false, never left alone', async () => {
    const res = await put({ enabled: true, share_overview: true })
    expect(res.status).toBe(200)

    const input = updateSettingsMock.mock.calls[0]?.[1] as UpdatePublicDashboardInput
    expect(input.shareOverview).toBe(true)
    // A client that predates ADR-0039 sends none of the five. It must close
    // them, not open them — a `?? existing` default here would let an old
    // client's write silently republish a surface, and a truthiness test would
    // let `"false"` open one.
    expect(input.shareTimeseries).toBe(false)
    expect(input.shareSessions).toBe(false)
    expect(input.sharePages).toBe(false)
    expect(input.shareSources).toBe(false)
    expect(input.shareDevices).toBe(false)
    // And the ninth, which is the one whose omission would publish the owner's
    // own site name — the failure direction that matters most on this flag.
    expect(input.shareIdentity).toBe(false)
  })

  it('only the literal true opens a surface', async () => {
    await put({ enabled: true, share_pages: 'true', share_sources: 1, share_devices: null })
    const input = updateSettingsMock.mock.calls[0]?.[1] as UpdatePublicDashboardInput
    expect(input.sharePages).toBe(false)
    expect(input.shareSources).toBe(false)
    expect(input.shareDevices).toBe(false)
  })

  it('a viewer cannot change the exposure', async () => {
    membership.value = { role: 'viewer', isBillingOwner: false }
    const res = await put({ enabled: true, share_pages: true })
    expect(res.status).toBe(403)
    expect(updateSettingsMock).not.toHaveBeenCalled()
  })
})
