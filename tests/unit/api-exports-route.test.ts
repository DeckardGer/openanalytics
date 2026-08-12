import { loadServiceEnv } from '@openanalytics/domain'
import type { Auth, SiteRole } from '@openanalytics/auth'
import { ObjectStorageError, type ObjectStorage } from '@openanalytics/integrations'
import type { Database, ExportRunRow } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The export door's guards (ADR-0032, D8).
 *
 * The repository has its own live-Postgres suite; what lives only at the route
 * is:
 *
 * - **status and download are different surfaces.** The two `GET`s mint nothing
 *   and never carry a URL — a frontend polls them, and a poll that handed out a
 *   signed URL would be a bearer credential issued to a request nobody made;
 * - **the capability gate is owner-only** (`export:raw`): an export is the
 *   site's whole raw event history in one file, which 02 §25 separates from
 *   admin authority — so an admin may read an export's status and may not start
 *   one or download it, and a non-member does not learn the site exists;
 * - the one-live-export conflict surfacing as `409 EXPORT_IN_PROGRESS` with the
 *   blocking export named, rather than as a generic failure with nothing to act
 *   on;
 * - **expiry answers `410`, not `404`.** The export existed and the customer's
 *   memory of it is correct; what is gone is the seven-day artefact, and the
 *   recovery is to request a new one;
 * - **exactly one audit row per download request** (D8), and none at all on a
 *   status read — which is what keeps a polling dashboard from filling the audit
 *   trail;
 * - a storage failure reading as `503 PROVIDER_UNAVAILABLE` rather than a `500`;
 * - the whole surface being absent on a deployment with no bucket.
 */

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const OWNER = 'u-owner'
const ADMIN = 'u-admin'
const VIEWER = 'u-viewer'
const STRANGER = 'u-stranger'
const EXPORT = '7c4e0b12-0000-4000-8000-0000000000ee'
const PREFIX = `exports/${SITE}/${EXPORT}/`

const memberships = new Map<string, { role: SiteRole; isBillingOwner: boolean }>([
  [OWNER, { role: 'owner', isBillingOwner: true }],
  [ADMIN, { role: 'admin', isBillingOwner: false }],
  [VIEWER, { role: 'viewer', isBillingOwner: false }],
])

function exportRun(overrides: Partial<ExportRunRow> = {}): ExportRunRow {
  return {
    id: EXPORT,
    siteId: SITE,
    requestedBy: OWNER,
    state: 'queued',
    cutoff: new Date('2026-07-29T10:00:00.000Z'),
    pinnedImportRunId: null,
    manifest: null,
    progress: null,
    objectPrefix: PREFIX,
    errorCode: null,
    createdAt: new Date('2026-07-29T10:00:00.000Z'),
    startedAt: null,
    finishedAt: null,
    sweptAt: null,
    ...overrides,
  }
}

const manifest = {
  schema_version: 1,
  export_id: EXPORT,
  site_id: SITE,
  cutoff: '2026-07-29T10:00:00.000Z',
  pinned_import_run_id: null,
  generated_at: '2026-07-29T10:05:00.000Z',
  number_encoding: 'json_number' as const,
  notes: [],
  chunks: [
    {
      key: `${PREFIX}events-2026-07.ndjson.gz`,
      kind: 'events' as const,
      month: '2026-07',
      part: 1,
      rows: 3,
      bytes: 120,
      sha256: 'aa',
    },
    {
      key: `${PREFIX}funnels.ndjson.gz`,
      kind: 'funnels' as const,
      part: 1,
      rows: 0,
      bytes: 20,
      sha256: 'bb',
    },
  ],
  totals: { chunks: 2, rows: 3, bytes: 140 },
}

/** What the repository and the bucket answer, per test. */
const world = {
  createConflict: null as null | 'live_export' | 'site_unavailable',
  storedRun: exportRun() as ExportRunRow | null,
  download: { ok: true } as Record<string, unknown>,
  storageFails: false,
  jobStatus: null as null | 'running' | 'failed_retryable',
}

const calls = {
  created: [] as Record<string, unknown>[],
  claims: [] as Record<string, unknown>[],
  signed: [] as { key: string; expiresInSeconds: number; downloadFilename?: string }[],
}

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    getMembership: async (_db: unknown, params: { siteId: string; userId: string }) =>
      memberships.get(params.userId) ?? null,
    readJobStatusByIdempotencyKey: async () => world.jobStatus,
    createExportRun: async (_db: unknown, input: Record<string, unknown>) => {
      calls.created.push(input)
      if (world.createConflict === 'live_export') {
        return { ok: false, conflict: 'live_export', exportRunId: EXPORT }
      }
      if (world.createConflict === 'site_unavailable') {
        return { ok: false, conflict: 'site_unavailable' }
      }
      return { ok: true, run: world.storedRun, jobId: 'job-1' }
    },
    readExportRun: async () => world.storedRun,
    listExportRuns: async () => (world.storedRun ? [world.storedRun] : []),
    claimExportDownload: async (_db: unknown, input: Record<string, unknown>) => {
      calls.claims.push(input)
      return world.download
    },
  }
})

const { createApp } = await import('../../apps/api/src/app.ts')

const objectStorage = {
  async signedDownloadUrl(input: {
    key: string
    expiresInSeconds: number
    downloadFilename?: string
  }) {
    await Promise.resolve()
    if (world.storageFails) throw new ObjectStorageError('unavailable', 'storage did not answer')
    calls.signed.push(input)
    return {
      url: `https://storage.test/${input.key}?sig=x`,
      expiresAt: new Date('2026-07-29T10:15:00.000Z'),
      requiredHeaders: {},
    }
  },
} as unknown as ObjectStorage

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

const db = {
  transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => await fn(db),
} as unknown as Database

const { logger } = createCapturedLogger()
const app = createApp({
  service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
  logger,
  env: loadServiceEnv('api', testEnv()),
  auth,
  db,
  objectStorage,
})

/** A second app with no bucket: the optional-until-used mount. */
const bucketlessApp = createApp({
  service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
  logger,
  env: loadServiceEnv('api', testEnv()),
  auth,
  db,
})

const call = (
  method: string,
  path: string,
  user: string | null,
  body?: unknown,
  target = app,
): Promise<Response> =>
  Promise.resolve(
    target.fetch(
      new Request(`http://api.test${path}`, {
        method,
        headers: {
          ...(user === null ? {} : { 'x-test-user': user }),
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    ),
  )

/** The envelope, read once: a `Response` body cannot be consumed twice, and
 * every refusal below asserts both the code and the detail that makes it
 * actionable. */
const errorOf = async (
  res: Response,
): Promise<{ code: string; details: Record<string, unknown> }> => {
  const body = (await res.json()) as {
    error: { code: string; details: Record<string, unknown> }
  }
  return body.error
}

beforeEach(() => {
  world.createConflict = null
  world.storedRun = exportRun()
  world.download = {
    ok: true,
    manifest,
    objectPrefix: PREFIX,
    finishedAt: new Date('2026-07-29T10:05:00.000Z'),
  }
  world.storageFails = false
  world.jobStatus = null
  calls.created = []
  calls.claims = []
  calls.signed = []
})

describe('POST /v1/sites/{site_id}/exports', () => {
  it('requires export:raw — owner only, not admin and not viewer', async () => {
    // The capability the matrix already reserves for exactly this (02 §25
    // separates raw-export authority from admin), not the `site:settings` the
    // import door uses. ADR-0032 D8's "owner/admin" was corrected by a dated
    // amendment rather than by widening the capability to match it.
    expect((await call('POST', `/v1/sites/${SITE}/exports`, OWNER)).status).toBe(202)
    expect((await call('POST', `/v1/sites/${SITE}/exports`, ADMIN)).status).toBe(403)
    expect((await call('POST', `/v1/sites/${SITE}/exports`, VIEWER)).status).toBe(403)
  })

  it('does not reveal the site to a non-member, or to nobody at all', async () => {
    expect((await call('POST', `/v1/sites/${SITE}/exports`, null)).status).toBe(401)
    const res = await call('POST', `/v1/sites/${SITE}/exports`, STRANGER)
    expect(res.status).toBe(404)
    expect((await errorOf(res)).code).toBe('SITE_NOT_FOUND')
  })

  it('records who asked, and answers the pinned cutoff', async () => {
    const res = await call('POST', `/v1/sites/${SITE}/exports`, OWNER)
    expect(res.status).toBe(202)

    // The requester is carried into the repository so the audit row names a
    // person rather than "the system".
    expect(calls.created[0]).toMatchObject({ siteId: SITE, requestedByUserId: OWNER })

    const body = (await res.json()) as { export: Record<string, unknown> }
    // Both halves of the D8 pin are answered, so the result is reproducible and
    // a client can show what the export covers before it finishes.
    expect(body.export['cutoff']).toBe('2026-07-29T10:00:00.000Z')
    expect(body.export).toHaveProperty('pinned_import_run_id', null)
    expect(body.export['phase']).toBe('queued')
    expect(body.export['status']).toBe('queued')
  })

  it('answers 409 EXPORT_IN_PROGRESS naming the export in the way', async () => {
    world.createConflict = 'live_export'
    const res = await call('POST', `/v1/sites/${SITE}/exports`, OWNER)
    expect(res.status).toBe(409)
    const error = await errorOf(res)
    expect(error.code).toBe('EXPORT_IN_PROGRESS')
    // Without the id the client has a conflict and nothing to act on.
    expect(error.details).toMatchObject({ export_id: EXPORT })
  })

  it('reads a site being torn down as a site that is not there', async () => {
    world.createConflict = 'site_unavailable'
    const res = await call('POST', `/v1/sites/${SITE}/exports`, OWNER)
    expect(res.status).toBe(404)
    expect((await errorOf(res)).code).toBe('SITE_NOT_FOUND')
  })

  it('is not mounted at all without a bucket', async () => {
    // Optional-until-used: the whole surface either mints URLs into storage or
    // creates work that writes to it, so a mount without a bucket could offer
    // nothing but failures.
    const res = await call('POST', `/v1/sites/${SITE}/exports`, OWNER, undefined, bucketlessApp)
    expect(res.status).toBe(404)
  })
})

describe('GET /v1/sites/{site_id}/exports', () => {
  it('is readable by every member and never carries a URL', async () => {
    world.storedRun = exportRun({
      state: 'succeeded',
      manifest,
      finishedAt: new Date('2026-07-29T10:05:00.000Z'),
    })

    const list = await call('GET', `/v1/sites/${SITE}/exports`, VIEWER)
    expect(list.status).toBe(200)
    const listBody = (await list.json()) as { items: Record<string, unknown>[] }
    expect(JSON.stringify(listBody)).not.toContain('storage.test')

    const one = await call('GET', `/v1/sites/${SITE}/exports/${EXPORT}`, VIEWER)
    const body = (await one.json()) as Record<string, unknown>
    expect(JSON.stringify(body)).not.toContain('storage.test')
    // The manifest is summarized, never echoed: a poll must not carry a chunk
    // list that can run to thousands of entries.
    expect(body['manifest']).toEqual({ schema_version: 1, chunks: 2, rows: 3, bytes: 140 })
    // A status read mints nothing.
    expect(calls.signed).toHaveLength(0)
    // ...and audits nothing, which is what makes polling free.
    expect(calls.claims).toHaveLength(0)
  })

  it('reports the live job status while one owns the export', async () => {
    // The difference between "this is working" and "this keeps failing and will
    // be tried again" is exactly what a support conversation turns on.
    world.storedRun = exportRun({ state: 'running' })
    world.jobStatus = 'failed_retryable'
    const res = await call('GET', `/v1/sites/${SITE}/exports/${EXPORT}`, VIEWER)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['phase']).toBe('running')
    expect(body['status']).toBe('failed_retryable')
  })

  it('answers a server-computed expires_at, null until the export finishes', async () => {
    // Derived here rather than by the client: the retention is a deployment
    // value, and a frontend that hardcoded "+7 days" would keep offering a
    // download after the bucket rule had already deleted the objects.
    const queued = await call('GET', `/v1/sites/${SITE}/exports/${EXPORT}`, VIEWER)
    expect((await queued.json()) as Record<string, unknown>).toMatchObject({ expires_at: null })

    world.storedRun = exportRun({
      state: 'succeeded',
      manifest,
      finishedAt: new Date('2026-07-29T10:05:00.000Z'),
    })
    const done = await call('GET', `/v1/sites/${SITE}/exports/${EXPORT}`, VIEWER)
    const body = (await done.json()) as Record<string, unknown>
    // finished_at + EXPORT_OBJECT_TTL_DAYS (7).
    expect(body['expires_at']).toBe('2026-08-05T10:05:00.000Z')
  })

  it('reports an expired export as a succeeded operation with an expired phase', async () => {
    // The export succeeded; what ran out is the life of its files. A client that
    // only knows the generic vocabulary renders a finished export, and `phase`
    // is what tells it the download is gone.
    world.storedRun = exportRun({ state: 'expired', manifest })
    const res = await call('GET', `/v1/sites/${SITE}/exports/${EXPORT}`, VIEWER)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['status']).toBe('succeeded')
    expect(body['phase']).toBe('expired')
  })

  it('answers NOT_FOUND for an export of another site', async () => {
    world.storedRun = null
    const res = await call('GET', `/v1/sites/${SITE}/exports/${EXPORT}`, VIEWER)
    expect(res.status).toBe(404)
    expect((await errorOf(res)).code).toBe('NOT_FOUND')
  })
})

describe('POST /v1/sites/{site_id}/exports/{export_id}/download', () => {
  it('mints the manifest and every chunk in one response, once', async () => {
    const res = await call('POST', `/v1/sites/${SITE}/exports/${EXPORT}/download`, OWNER)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { files: Record<string, unknown>[] }
    // Manifest first and not merely first in the array: a client that fetches it
    // before the chunks has the digests to verify everything that follows.
    expect(body.files[0]).toMatchObject({ kind: 'manifest', filename: 'manifest.json' })
    expect(body.files.map((file) => file['filename'])).toEqual([
      'manifest.json',
      'events-2026-07.ndjson.gz',
      'funnels.ndjson.gz',
    ])
    // Per-chunk digests travel with the URL so a download is verifiable without
    // re-reading the manifest it just fetched. The manifest's own digest cannot
    // be inside itself.
    expect(body.files[1]).toMatchObject({ rows: 3, bytes: 120, sha256: 'aa' })
    expect(body.files[0]).toMatchObject({ rows: null, bytes: null, sha256: null })

    // Fifteen minutes, and every file is served as an attachment.
    expect(calls.signed).toHaveLength(3)
    for (const signed of calls.signed) expect(signed.expiresInSeconds).toBe(900)
    expect(calls.signed[0]?.downloadFilename).toBe('manifest.json')

    // **One** audit claim per download request (D8) — the repository writes the
    // row inside it, so one claim is one audit row.
    expect(calls.claims).toHaveLength(1)
    expect(calls.claims[0]).toMatchObject({ siteId: SITE, exportRunId: EXPORT, actorUserId: OWNER })
  })

  it('passes the TTL to the repository so the deadline is decided in SQL', async () => {
    // The expiry comparison is `finished_at < now() - interval` inside the
    // claim, never a `Date` this service computed: an api clock running fast
    // would otherwise retire a download that is still live, and there is no way
    // back from telling a customer their export is gone.
    await call('POST', `/v1/sites/${SITE}/exports/${EXPORT}/download`, OWNER)
    expect(calls.claims[0]).toMatchObject({ ttlDays: 7 })
  })

  it('needs export:raw, like the create — an admin may look but not download', async () => {
    expect((await call('POST', `/v1/sites/${SITE}/exports/${EXPORT}/download`, OWNER)).status).toBe(
      200,
    )
    expect((await call('POST', `/v1/sites/${SITE}/exports/${EXPORT}/download`, ADMIN)).status).toBe(
      403,
    )
    expect(
      (await call('POST', `/v1/sites/${SITE}/exports/${EXPORT}/download`, VIEWER)).status,
    ).toBe(403)

    // ...and the read surfaces stay open to every member, which is the
    // transparency half of the same rule: a team can see that somebody took
    // their data even if only an owner could.
    expect((await call('GET', `/v1/sites/${SITE}/exports/${EXPORT}`, ADMIN)).status).toBe(200)
    expect((await call('GET', `/v1/sites/${SITE}/exports`, VIEWER)).status).toBe(200)
  })

  it('answers 410 EXPORT_EXPIRED once the seven-day window has passed', async () => {
    world.download = { ok: false, reason: 'expired' }
    const res = await call('POST', `/v1/sites/${SITE}/exports/${EXPORT}/download`, OWNER)
    // Not a 404: the export existed and the customer's memory of it is correct.
    // Not a 409 either: nothing is in progress and waiting will never help.
    expect(res.status).toBe(410)
    const error = await errorOf(res)
    expect(error.code).toBe('EXPORT_EXPIRED')
    expect(error.details).toMatchObject({ export_id: EXPORT, ttl_days: 7 })
    expect(calls.signed).toHaveLength(0)
  })

  it('answers 409 EXPORT_IN_PROGRESS with the phase for an unfinished export', async () => {
    world.download = { ok: false, reason: 'not_downloadable', state: 'running' }
    const res = await call('POST', `/v1/sites/${SITE}/exports/${EXPORT}/download`, OWNER)
    expect(res.status).toBe(409)
    const error = await errorOf(res)
    expect(error.code).toBe('EXPORT_IN_PROGRESS')
    expect(error.details).toMatchObject({ phase: 'running' })
  })

  it('answers NOT_FOUND for an export of another site', async () => {
    world.download = { ok: false, reason: 'not_found' }
    const res = await call('POST', `/v1/sites/${SITE}/exports/${EXPORT}/download`, OWNER)
    expect(res.status).toBe(404)
    expect((await errorOf(res)).code).toBe('NOT_FOUND')
  })

  it('turns a storage outage into 503 PROVIDER_UNAVAILABLE, not a 500', async () => {
    world.storageFails = true
    const res = await call('POST', `/v1/sites/${SITE}/exports/${EXPORT}/download`, OWNER)
    expect(res.status).toBe(503)
    expect((await errorOf(res)).code).toBe('PROVIDER_UNAVAILABLE')
  })
})
