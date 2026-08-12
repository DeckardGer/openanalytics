import { loadServiceEnv } from '@openanalytics/domain'
import type { Auth, SiteRole } from '@openanalytics/auth'
import { ObjectStorageError, type ObjectStorage } from '@openanalytics/integrations'
import type { Database, ImportRunRow, ImportUploadRow } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The import door's guards (ADR-0032, D6).
 *
 * Every refusal here happens before a byte is admitted, which is the entire
 * reason the size is declared up front — and it is what this suite exists to
 * hold. The repository has its own Postgres suite; what lives only at the route
 * is:
 *
 * - the three door checks (known-and-available provider, exact content type,
 *   size within `IMPORT_MAX_ARCHIVE_BYTES`), each refusing before the run row is
 *   written and therefore before a signed URL exists at all;
 * - the one-live-run conflict surfacing as `409 IMPORT_IN_PROGRESS` with the
 *   blocking run named, rather than as a generic failure with nothing to act on;
 * - `complete` treating a missing object and a wrong-sized object as *different*
 *   answers — one says upload again, the other says the file is wrong;
 * - the ETag being pinned in the same transaction as the transition, which is
 *   what makes a later re-PUT through the still-valid signed URL a failed run
 *   rather than an unchecked import — and what stops a run reaching `uploaded`
 *   with no job to prepare it;
 * - `complete` on an already-`uploaded` run being a success rather than a
 *   conflict, which is the recovery for a lost response;
 * - a storage failure reading as `503 PROVIDER_UNAVAILABLE` rather than as a
 *   `500`, while `head()`'s "the object is not there" stays its own answer;
 * - the provider catalog being reachable with no bucket configured, which is
 *   what lets the frontend retire its hardcoded list without a redeploy;
 * - discard being allowed exactly where it is unambiguous.
 */

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const OWNER = 'u-owner'
const ADMIN = 'u-admin'
const VIEWER = 'u-viewer'
const STRANGER = 'u-stranger'
const RUN = '9a1d0b3c-0000-4000-8000-00000000abcd'

/** 256 MiB — `IMPORT_MAX_ARCHIVE_BYTES`'s default. */
const MAX_ARCHIVE_BYTES = 268_435_456

const memberships = new Map<string, { role: SiteRole; isBillingOwner: boolean }>([
  [OWNER, { role: 'owner', isBillingOwner: true }],
  [ADMIN, { role: 'admin', isBillingOwner: false }],
  [VIEWER, { role: 'viewer', isBillingOwner: false }],
])

function run(overrides: Partial<ImportRunRow> = {}): ImportRunRow {
  return {
    id: RUN,
    siteId: SITE,
    provider: 'plausible',
    state: 'uploading',
    summary: null,
    cutoverDate: null,
    stagingChunkBytes: null,
    stagingProgress: null,
    supersededRunId: null,
    sweptAt: null,
    errorCode: null,
    createdAt: new Date('2026-07-29T00:00:00.000Z'),
    updatedAt: new Date('2026-07-29T00:00:00.000Z'),
    finishedAt: null,
    ...overrides,
  }
}

function upload(overrides: Partial<ImportUploadRow> = {}): ImportUploadRow {
  return {
    id: 'up-1',
    importRunId: RUN,
    objectKey: `imports/${SITE}/${RUN}/archive.zip`,
    declaredBytes: 1_024,
    contentType: 'application/zip',
    etag: null,
    createdAt: new Date('2026-07-29T00:00:00.000Z'),
    completedAt: null,
    ...overrides,
  }
}

/** What the repository and the bucket answer, per test. */
const world = {
  createConflict: null as null | 'live_run' | 'site_unavailable',
  storedRun: run(),
  storedUpload: upload() as ImportUploadRow | null,
  headSize: 1_024 as number | null,
  headEtag: '"deadbeef"',
  transitionMoves: true,
  /** Which storage call throws the port's classified failure, if any. */
  storageFails: null as null | 'sign' | 'head',
  /** What the run's live job reports, when the phase is one a job owns. */
  jobStatus: null as null | 'running' | 'failed_retryable',
}

const calls = {
  created: [] as Record<string, unknown>[],
  pinned: [] as { importRunId: string; etag: string }[],
  transitions: [] as { to: string; from: readonly string[] }[],
  jobs: [] as { type: string; idempotencyKey: string; payload?: Record<string, unknown> }[],
  deleted: [] as string[],
  signed: [] as { key: string; maxSizeBytes: number; contentType: string }[],
}

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    getMembership: async (_db: unknown, params: { siteId: string; userId: string }) =>
      memberships.get(params.userId) ?? null,
    // The derived status consults the live job for the three job-owned phases
    // (ADR-0032, D7). No job exists in these fakes, so the state alone decides.
    readJobStatusByIdempotencyKey: async () => world.jobStatus,
    createImportRun: async (_db: unknown, input: Record<string, unknown>) => {
      calls.created.push(input)
      if (world.createConflict === 'live_run') {
        return { ok: false, conflict: 'live_run', runId: RUN }
      }
      if (world.createConflict === 'site_unavailable') {
        return { ok: false, conflict: 'site_unavailable' }
      }
      return { ok: true, run: world.storedRun, upload: upload() }
    },
    readImportRun: async () => world.storedRun,
    readImportUpload: async () => world.storedUpload,
    listImportRuns: async () => [world.storedRun],
    pinUploadEtag: async (_db: unknown, input: { importRunId: string; etag: string }) => {
      calls.pinned.push(input)
      return true
    },
    transitionImportRun: async (_db: unknown, input: { to: string; from: readonly string[] }) => {
      calls.transitions.push({ to: input.to, from: input.from })
      return world.transitionMoves
    },
    enqueueJob: async (
      _db: unknown,
      input: { type: string; idempotencyKey: string; payload?: Record<string, unknown> },
    ) => {
      calls.jobs.push(input)
      return { enqueued: true, id: 'job-1' }
    },
  }
})

const { createApp } = await import('../../apps/api/src/app.ts')

const objectStorage = {
  async signedUploadUrl(input: { key: string; maxSizeBytes: number; contentType: string }) {
    await Promise.resolve()
    if (world.storageFails === 'sign') {
      throw new ObjectStorageError('unavailable', 'storage did not answer')
    }
    calls.signed.push(input)
    return {
      url: 'https://storage.test/signed',
      expiresAt: new Date('2026-07-29T01:00:00.000Z'),
      requiredHeaders: {
        'content-type': input.contentType,
        'content-length': String(input.maxSizeBytes),
      },
    }
  },
  async head(ref: { key: string }) {
    await Promise.resolve()
    if (world.storageFails === 'head') {
      throw new ObjectStorageError('unavailable', 'storage did not answer')
    }
    if (world.headSize === null) return null
    return {
      key: ref.key,
      size: world.headSize,
      contentType: 'application/zip',
      lastModified: new Date(0),
      etag: world.headEtag,
    }
  },
  async delete(refs: readonly { key: string }[]) {
    for (const ref of refs) calls.deleted.push(ref.key)
    await Promise.resolve()
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

/**
 * A database that only knows how to open a transaction.
 *
 * `complete` moves the run, pins the ETag and enqueues the prepare job in one —
 * so the seam the route depends on is `db.transaction`, and the executor it
 * hands the mocked repository functions is this same handle. Every repository
 * call itself is replaced above.
 */
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

const errorCode = async (res: Response): Promise<string> =>
  ((await res.json()) as { error: { code: string } }).error.code

const errorDetails = async (res: Response): Promise<Record<string, unknown>> =>
  ((await res.json()) as { error: { details: Record<string, unknown> } }).error.details

const validArchive = { provider: 'plausible', size_bytes: 1_024, content_type: 'application/zip' }

beforeEach(() => {
  world.createConflict = null
  world.storedRun = run()
  world.storedUpload = upload()
  world.headSize = 1_024
  world.headEtag = '"deadbeef"'
  world.transitionMoves = true
  world.storageFails = null
  world.jobStatus = null
  calls.created = []
  calls.pinned = []
  calls.transitions = []
  calls.jobs = []
  calls.deleted = []
  calls.signed = []
})

describe('GET /v1/imports/providers', () => {
  it('requires a session but not a site', async () => {
    expect((await call('GET', '/v1/imports/providers', null)).status).toBe(401)

    const res = await call('GET', '/v1/imports/providers', VIEWER)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { id: string; available: boolean }[] }
    expect(body.items.find((item) => item.id === 'plausible')?.available).toBe(true)
    // Unavailable providers are listed, not hidden: the picker has to be able to
    // say "later" rather than only "no".
    expect(body.items.find((item) => item.id === 'matomo')?.available).toBe(false)
  })

  it('is reachable with no bucket configured — the catalog needs none', async () => {
    // D11's whole purpose is that the frontend can retire its hardcoded provider
    // list without a redeploy. Behind the `OBJECT_STORAGE_*` check this would
    // 404 on a deployment mid-configuration, and the frontend cannot tell that
    // from "this build is too old" — so it would keep rendering the mock.
    const res = await call('GET', '/v1/imports/providers', OWNER, undefined, bucketlessApp)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { id: string }[] }
    expect(body.items.map((item) => item.id)).toContain('plausible')
  })

  it('still gates the SITE-scoped surface on the bucket', async () => {
    // The other half of the same rule: every route under `/sites/{id}/imports`
    // either mints a signed URL or reads the object one produced, so a mount
    // without a bucket could offer nothing but failures.
    const list = await call('GET', `/v1/sites/${SITE}/imports`, OWNER, undefined, bucketlessApp)
    expect(list.status).toBe(404)
    const create = await call(
      'POST',
      `/v1/sites/${SITE}/imports`,
      OWNER,
      validArchive,
      bucketlessApp,
    )
    expect(create.status).toBe(404)
    expect(calls.created).toEqual([])
  })
})

describe('POST /v1/sites/{site_id}/imports — the door', () => {
  it('refuses an unauthenticated caller and a non-member', async () => {
    expect((await call('POST', `/v1/sites/${SITE}/imports`, null, validArchive)).status).toBe(401)
    // 404, never 403: the API does not reveal that a site it cannot see exists.
    expect((await call('POST', `/v1/sites/${SITE}/imports`, STRANGER, validArchive)).status).toBe(
      404,
    )
    expect(calls.created).toEqual([])
  })

  it('refuses a viewer: starting an import needs site:settings', async () => {
    const res = await call('POST', `/v1/sites/${SITE}/imports`, VIEWER, validArchive)
    expect(res.status).toBe(403)
    expect(await errorCode(res)).toBe('FORBIDDEN')
    expect(calls.created).toEqual([])
  })

  it('admits an admin, which is what site:settings means', async () => {
    expect((await call('POST', `/v1/sites/${SITE}/imports`, ADMIN, validArchive)).status).toBe(201)
  })

  it('refuses an unknown provider before writing anything', async () => {
    const res = await call('POST', `/v1/sites/${SITE}/imports`, OWNER, {
      ...validArchive,
      provider: 'nope',
    })
    expect(res.status).toBe(400)
    expect(await errorCode(res)).toBe('VALIDATION_FAILED')
    expect(calls.created).toEqual([])
  })

  it('refuses a listed but unavailable provider, and says which', async () => {
    // The catalog lists Matomo so the picker can promise it later; the door must
    // still refuse it, or the archive uploads and no parser ever reads it.
    const res = await call('POST', `/v1/sites/${SITE}/imports`, OWNER, {
      ...validArchive,
      provider: 'matomo',
    })
    expect(res.status).toBe(400)
    expect(await errorDetails(res)).toEqual({
      issues: [{ field: 'provider', code: 'unavailable' }],
    })
    expect(calls.created).toEqual([])
    expect(calls.signed).toEqual([])
  })

  it('refuses any content type but application/zip', async () => {
    const res = await call('POST', `/v1/sites/${SITE}/imports`, OWNER, {
      ...validArchive,
      content_type: 'application/x-tar',
    })
    expect(res.status).toBe(400)
    expect(await errorDetails(res)).toEqual({
      issues: [{ field: 'content_type', code: 'invalid' }],
    })
    expect(calls.created).toEqual([])
  })

  it('refuses a size above IMPORT_MAX_ARCHIVE_BYTES, before minting a URL for it', async () => {
    // The signature binds the exact size, so admitting one above the policy
    // limit would mint a URL for bytes the parser is guaranteed to reject.
    const res = await call('POST', `/v1/sites/${SITE}/imports`, OWNER, {
      ...validArchive,
      size_bytes: MAX_ARCHIVE_BYTES + 1,
    })
    expect(res.status).toBe(400)
    expect(await errorDetails(res)).toEqual({
      issues: [{ field: 'size_bytes', code: 'too_large', limit: MAX_ARCHIVE_BYTES }],
    })
    expect(calls.signed).toEqual([])
  })

  it('refuses a non-integer or non-positive size', async () => {
    for (const size of [0, -1, 1.5, '1024', null]) {
      const res = await call('POST', `/v1/sites/${SITE}/imports`, OWNER, {
        ...validArchive,
        size_bytes: size,
      })
      expect(res.status, `size_bytes=${String(size)}`).toBe(400)
    }
    expect(calls.created).toEqual([])
  })

  it('answers 201 with a single-PUT URL bound to the declared size and type', async () => {
    const res = await call('POST', `/v1/sites/${SITE}/imports`, OWNER, validArchive)
    expect(res.status).toBe(201)

    const body = (await res.json()) as {
      run: { id: string; phase: string; status: string }
      upload: { method: string; url: string; required_headers: Record<string, string> }
    }
    expect(body.run).toMatchObject({ id: RUN, phase: 'uploading', status: 'queued' })
    // No multipart plan in CP1: one signature that binds the exact length is a
    // stronger guarantee than a part list, which cannot bind a total at all.
    expect(body.upload.method).toBe('PUT')
    expect(body.upload.required_headers).toEqual({
      'content-type': 'application/zip',
      'content-length': '1024',
    })
    expect(calls.signed).toEqual([
      {
        key: `imports/${SITE}/${RUN}/archive.zip`,
        maxSizeBytes: 1_024,
        contentType: 'application/zip',
        expiresInSeconds: 3_600,
      },
    ])
  })

  it('answers 409 IMPORT_IN_PROGRESS naming the run that is in the way', async () => {
    // A site holds one non-terminal run (D3). The blocking run has to be named:
    // the recovery is to publish or discard *that one*, and an error with
    // nothing to act on would leave the customer stuck.
    world.createConflict = 'live_run'
    const res = await call('POST', `/v1/sites/${SITE}/imports`, OWNER, validArchive)
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } }
    expect(body.error.code).toBe('IMPORT_IN_PROGRESS')
    expect(body.error.details).toEqual({ import_run_id: RUN })
    expect(calls.signed).toEqual([])
  })

  it('answers 404 SITE_NOT_FOUND for a site whose deletion has started', async () => {
    // The repository decides this under the same site row lock
    // `startSiteDeletion` takes, so the two cannot interleave and leave an
    // object key outside the deletion snapshot. The answer is the one
    // `requireAnalyticsAccess` already gives for a `deleting` site: a torn-down
    // site must not be distinguishable from one that never existed.
    world.createConflict = 'site_unavailable'
    const res = await call('POST', `/v1/sites/${SITE}/imports`, OWNER, validArchive)
    expect(res.status).toBe(404)
    expect(await errorCode(res)).toBe('SITE_NOT_FOUND')
    expect(calls.signed).toEqual([])
  })

  it('answers 503 PROVIDER_UNAVAILABLE when the bucket will not sign', async () => {
    // Without the mapping this reaches the error middleware as an unrecognised
    // exception — a 500 that reads as a bug in this service rather than an
    // outage in the bucket, and that a client has no retry branch for.
    world.storageFails = 'sign'
    const res = await call('POST', `/v1/sites/${SITE}/imports`, OWNER, validArchive)
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } }
    expect(body.error.code).toBe('PROVIDER_UNAVAILABLE')
    expect(body.error.details).toMatchObject({ reason: 'unavailable', retryable: true })
  })
})

describe('POST /v1/sites/{site_id}/imports/{run_id}/complete', () => {
  const complete = (user: string) => call('POST', `/v1/sites/${SITE}/imports/${RUN}/complete`, user)

  it('refuses a viewer', async () => {
    expect((await complete(VIEWER)).status).toBe(403)
    expect(calls.jobs).toEqual([])
  })

  it('answers 409 IMPORT_UPLOAD_MISSING when the object is not in storage', async () => {
    // Distinct from IMPORT_FAILED on purpose: the archive never landed, so the
    // fix is another PUT through the same URL, not a different file.
    world.headSize = null
    const res = await complete(OWNER)
    expect(res.status).toBe(409)
    expect(await errorCode(res)).toBe('IMPORT_UPLOAD_MISSING')
    expect(calls.transitions).toEqual([])
    expect(calls.jobs).toEqual([])
  })

  it('answers 422 IMPORT_FAILED with both sizes when the object is not what was declared', async () => {
    world.headSize = 999
    const res = await complete(OWNER)
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } }
    expect(body.error.code).toBe('IMPORT_FAILED')
    expect(body.error.details).toMatchObject({ declared_bytes: 1_024, observed_bytes: 999 })
    expect(calls.transitions).toEqual([])
    expect(calls.jobs).toEqual([])
  })

  it('pins the ETag, moves the run and queues preparation', async () => {
    const res = await complete(OWNER)
    expect(res.status).toBe(202)

    // The fingerprint is recorded in the SAME transaction as the transition. A
    // client holding the still-valid signed URL can re-PUT different bytes after
    // this check, and the worker refusing a mismatch at download time is what
    // turns that into a failed run rather than an unchecked import (D6 step 2).
    expect(calls.pinned).toEqual([{ importRunId: RUN, etag: '"deadbeef"' }])
    expect(calls.transitions).toEqual([{ from: ['uploading'], to: 'uploaded' }])
    expect(calls.jobs).toEqual([
      {
        type: 'import_prepare',
        subjectId: SITE,
        // Keyed on the run, so a retried `complete` finds its own job instead of
        // minting a twin.
        idempotencyKey: `import_prepare:${RUN}`,
        payload: { import_run_id: RUN },
      },
    ])
  })

  it('pins an empty ETag as-is rather than inventing one', async () => {
    // A provider that omits the header leaves `''`, and it is pinned unchanged:
    // CP2's worker treats an unverifiable fingerprint as a reason to fail the
    // run `validating`, so the archive is never silently accepted — and that
    // decision belongs where the bytes are, not here.
    world.headEtag = ''
    await complete(OWNER)
    expect(calls.pinned).toEqual([{ importRunId: RUN, etag: '' }])
  })

  it('is a success, not a conflict, when the run already reached `uploaded`', async () => {
    // The recovery for a `complete` whose response was lost — and for any path
    // that once left a run in `uploaded` with no job. `uploaded` is inside the
    // live-run unique's predicate, so such a run holds the site's only import
    // slot forever while nothing works it.
    world.storedRun = run({ state: 'uploaded' })
    const res = await complete(OWNER)

    expect(res.status).toBe(202)
    expect((await res.json()) as unknown).toMatchObject({ id: RUN, phase: 'uploaded' })
    // The job is re-enqueued (keyed on the run, so no twin) and nothing else is
    // re-done: `head()` is deliberately not repeated, because re-reading could
    // only replace the pinned fingerprint with a later one — which is exactly
    // the substitution the pin exists to catch.
    expect(calls.jobs).toEqual([
      {
        type: 'import_prepare',
        subjectId: SITE,
        idempotencyKey: `import_prepare:${RUN}`,
        payload: { import_run_id: RUN },
      },
    ])
    expect(calls.pinned).toEqual([])
    expect(calls.transitions).toEqual([])
  })

  it('answers 503 PROVIDER_UNAVAILABLE when the head() call itself fails', async () => {
    // Distinct from `head()` resolving null, which is an answer about the object
    // rather than about storage — see the next assertion.
    world.storageFails = 'head'
    const res = await complete(OWNER)
    expect(res.status).toBe(503)
    expect(await errorCode(res)).toBe('PROVIDER_UNAVAILABLE')
    expect(calls.transitions).toEqual([])
    expect(calls.jobs).toEqual([])
  })

  it('refuses a run that has already left `uploading`', async () => {
    world.storedRun = run({ state: 'processing' })
    const res = await complete(OWNER)
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } }
    expect(body.error.code).toBe('IMPORT_IN_PROGRESS')
    expect(body.error.details).toMatchObject({ phase: 'processing' })
    expect(calls.jobs).toEqual([])
  })

  it('refuses when the guarded transition loses a race', async () => {
    // The state guard is in the WHERE, so a run moved between the read and the
    // write does not match — a conflict, never an overwrite.
    world.transitionMoves = false
    const res = await complete(OWNER)
    expect(res.status).toBe(409)
    expect(await errorCode(res)).toBe('IMPORT_IN_PROGRESS')
    expect(calls.jobs).toEqual([])
  })
})

describe('DELETE /v1/sites/{site_id}/imports/{run_id}', () => {
  const discard = (user: string) => call('DELETE', `/v1/sites/${SITE}/imports/${RUN}`, user)

  it('refuses a viewer', async () => {
    expect((await discard(VIEWER)).status).toBe(403)
    expect(calls.transitions).toEqual([])
  })

  it('discards from the three unambiguous phases and deletes the object', async () => {
    const res = await discard(OWNER)
    expect(res.status).toBe(204)
    expect(calls.transitions).toEqual([
      { from: ['uploading', 'uploaded', 'ready_for_review'], to: 'discarded' },
    ])
    expect(calls.deleted).toEqual([`imports/${SITE}/${RUN}/archive.zip`])
  })

  it('refuses a run past those phases, because undoing it is a rollback', async () => {
    world.storedRun = run({ state: 'published' })
    world.transitionMoves = false
    const res = await discard(OWNER)
    expect(res.status).toBe(409)
    expect(await errorCode(res)).toBe('IMPORT_IN_PROGRESS')
    // Nothing removed: a published run's archive is not this endpoint's to take.
    expect(calls.deleted).toEqual([])
  })

  it('still records the discard when storage refuses the delete', async () => {
    // The customer's intent is durable whether or not the bucket answers this
    // second; the `imports/` lifecycle rule reaps whatever is left behind.
    const failing = {
      ...objectStorage,
      delete: async () => {
        await Promise.resolve()
        throw new Error('storage down')
      },
    } as unknown as ObjectStorage
    const localApp = createApp({
      service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
      logger,
      env: loadServiceEnv('api', testEnv()),
      auth,
      db: {} as Database,
      objectStorage: failing,
    })

    const res = await call('DELETE', `/v1/sites/${SITE}/imports/${RUN}`, OWNER, undefined, localApp)
    expect(res.status).toBe(204)
    expect(calls.transitions).toHaveLength(1)
  })
})

describe('GET the import list and detail', () => {
  const detail = (user: string) => call('GET', `/v1/sites/${SITE}/imports/${RUN}`, user)

  it('is readable by a viewer, and carries both phase and derived status', async () => {
    world.storedRun = run({ state: 'ready_for_review' })

    const list = await call('GET', `/v1/sites/${SITE}/imports`, VIEWER)
    expect(list.status).toBe(200)
    expect((await list.json()) as unknown).toMatchObject({
      items: [{ id: RUN, phase: 'ready_for_review', status: 'running' }],
    })

    const res = await detail(VIEWER)
    expect(res.status).toBe(200)
    // Awaiting a human decision is `running`: the preparation finished, the
    // operation the customer started has not.
    expect((await res.json()) as unknown).toMatchObject({ status: 'running' })
  })

  it('mints a FRESH upload target while the run is still `uploading`', async () => {
    // The create call's URL lives an hour, and a 256 MiB upload over a bad
    // connection — or a customer who comes back after lunch — can outlive it.
    // Without this the only recovery from an expired signature is to discard the
    // run and start over, which throws away the bytes already transferred.
    const res = await detail(OWNER)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      phase: string
      upload: { method: string; url: string; required_headers: Record<string, string> } | null
    }
    expect(body.phase).toBe('uploading')
    expect(body.upload?.method).toBe('PUT')
    // Bound to the SAME declared size and content type, read from the upload row
    // rather than from the request: a re-issued signature can never widen what
    // the first one admitted.
    expect(calls.signed).toEqual([
      {
        key: `imports/${SITE}/${RUN}/archive.zip`,
        maxSizeBytes: 1_024,
        contentType: 'application/zip',
        expiresInSeconds: 3_600,
      },
    ])
    expect(body.upload?.required_headers).toEqual({
      'content-type': 'application/zip',
      'content-length': '1024',
    })
  })

  it('answers a null upload in every other phase, and mints nothing', async () => {
    // Past `uploading` there is nothing to upload to, and minting a credential
    // for a run whose ETag is already pinned would hand out a way to replace the
    // very bytes the pin fixed.
    for (const state of ['uploaded', 'processing', 'published', 'discarded'] as const) {
      calls.signed = []
      world.storedRun = run({ state })
      const res = await detail(VIEWER)
      expect(((await res.json()) as { upload: unknown }).upload, state).toBeNull()
      expect(calls.signed, state).toEqual([])
    }
  })

  it('answers 503 rather than 500 when the re-mint cannot reach storage', async () => {
    world.storageFails = 'sign'
    const res = await detail(OWNER)
    expect(res.status).toBe(503)
    expect(await errorCode(res)).toBe('PROVIDER_UNAVAILABLE')
  })

  it('does not carry an upload target on the list read', async () => {
    // A list that minted a signed URL per row would hand out credentials to a
    // poll; the field is present and null so the shape stays one contract.
    const list = await call('GET', `/v1/sites/${SITE}/imports`, VIEWER)
    const body = (await list.json()) as { items: { upload: unknown }[] }
    expect(body.items[0]?.upload).toBeNull()
    expect(calls.signed).toEqual([])
  })
})
