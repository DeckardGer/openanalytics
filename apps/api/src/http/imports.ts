import { ApiError } from '@openanalytics/contracts'
import {
  IMPORT_PROVIDERS,
  IMPORT_RUN_DISCARDABLE_STATES,
  findImportProvider,
  importRunStatusFor,
  resolveCutoverDate,
  type ImportProviderDescriptor,
  type ImportRunStatus,
} from '@openanalytics/domain'
import { ObjectStorageError, type ObjectStorage, type SignedUrl } from '@openanalytics/integrations'
import {
  IMPORT_PREPARE_JOB_TYPE,
  IMPORT_PUBLISH_JOB_TYPE,
  createImportRun,
  enqueueJob,
  listImportRuns,
  pinUploadEtag,
  readImportRun,
  readImportUpload,
  readJobStatusByIdempotencyKey,
  readSiteImportContext,
  rollbackImportRun,
  transitionImportRun,
  type Database,
  type Executor,
  type ImportRunRow,
} from '@openanalytics/postgres'
import { Hono } from 'hono'
import { idempotent } from './idempotency.ts'
import { requireCapability, siteMembership, type ApiVariables } from './middleware.ts'

/**
 * The import surface (ADR-0032, D6/D7/D11).
 *
 * The bytes never pass through this service. A create mints a signed PUT URL
 * with the content type and the exact length bound into the signature, the
 * browser uploads straight to the bucket, and `complete` is the api's first and
 * only look at what arrived — a `head()` against the declared size, and an ETag
 * pinned so the worker can tell later whether the bytes it downloads are the
 * bytes that were checked. Proxying the archive through here would put a
 * customer-controlled 256 MiB stream inside the request path of the service that
 * also holds every session.
 *
 * **CP1 mints single-PUT URLs only.** ADR-0032 D6 allows a multipart plan above
 * the port's 64 MiB threshold, and it is deliberately not built here: a single
 * PUT binds the exact size into the signature, whereas multipart part signatures
 * cannot, which makes `complete`-time `head()` the size gate of record for the
 * multipart path. Until an import large enough to need it exists, the narrower
 * door is the one whose guarantee is strongest — and `IMPORT_MAX_ARCHIVE_BYTES`
 * (256 MiB) sits far under the 5 GiB single-PUT ceiling, so nothing the policy
 * admits is unreachable.
 *
 * Authorization mirrors the rest of the site surface: membership to read, and
 * `site:settings` (owner and admin, never viewer) to start, complete or discard
 * one. An import rewrites what the whole team sees on the dashboard, which is
 * the class that capability was drawn around.
 */

type Env = { Variables: ApiVariables }

/**
 * How long a signed upload URL lives.
 *
 * Not a policy knob: it is a property of the browser interaction rather than a
 * limit anybody tunes per deployment. An hour is long enough for a 256 MiB
 * upload on a slow connection and short enough that a URL copied out of devtools
 * is worthless by the time anyone finds it. The URL is also single-use in
 * practice — the run leaves `uploading` on `complete`, and a second PUT after
 * that fails the ETag check the worker performs.
 */
const UPLOAD_URL_TTL_SECONDS = 3_600

function providerJson(provider: ImportProviderDescriptor) {
  return {
    id: provider.id,
    display_name: provider.displayName,
    capability: provider.capability,
    available: provider.available,
  }
}

/**
 * Run a storage call, and turn a storage failure into an answer.
 *
 * `ObjectStorageError` is the port's classified failure, and without this it
 * reaches the error middleware as an unrecognised exception — a `500` with an
 * `INTERNAL` code, which tells a client nothing and reads to an operator as a
 * bug in this service rather than an outage in the bucket. `PROVIDER_UNAVAILABLE`
 * (503, retryable) is the catalog's existing name for exactly that, and it is
 * the code the mount-less deployment already answers, so a client that handles
 * "no bucket configured" handles "bucket not answering" with the same branch.
 *
 * Every reason maps to the same code, including `unauthorized`. From the
 * customer's side a rejected deployment credential and a dead endpoint are one
 * situation — the door is shut and nothing they can do reopens it — and telling
 * them which of our own credentials failed would be a disclosure with no
 * recovery attached. `details.reason` carries the distinction for the operator
 * reading the response beside the log line.
 *
 * `head()` is unaffected in the case that matters: the port resolves `null` for
 * an absent object rather than throwing, so the `IMPORT_UPLOAD_MISSING` path
 * never passes through here.
 */
async function storageCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (!(error instanceof ObjectStorageError)) throw error
    throw new ApiError('PROVIDER_UNAVAILABLE', 'Object storage did not answer', {
      details: { reason: error.reason, retryable: error.retryable },
    })
  }
}

/** The wire shape of a signed single-PUT target. */
function uploadJson(signed: SignedUrl) {
  return {
    method: 'PUT',
    url: signed.url,
    expires_at: signed.expiresAt.toISOString(),
    // Must be replayed verbatim: both are in `SignedHeaders`, so the request
    // only verifies with these exact values.
    required_headers: signed.requiredHeaders,
  }
}

/**
 * The three phases a job owns, and which job owns each.
 *
 * `importRunStatusFor` only consults a job status in these, so the lookup is
 * skipped everywhere else — which matters for the list read: a site may hold
 * exactly one non-terminal run (D3), so a list of fifty runs performs at most
 * one job query rather than fifty.
 */
function jobTypeForPhase(state: ImportRunRow['state']): string | null {
  if (state === 'validating' || state === 'processing') return IMPORT_PREPARE_JOB_TYPE
  if (state === 'publishing') return IMPORT_PUBLISH_JOB_TYPE
  return null
}

/**
 * The live job's own status, when one owns the run (D7).
 *
 * It is what lets a run being retried between attempts report `failed_retryable`
 * rather than a flat `running` — the difference between "this is working" and
 * "this keeps failing and will be tried again", which is exactly what a support
 * conversation turns on.
 *
 * Found by the **run-scoped idempotency key** rather than by `(type, subject)`:
 * the subject is the site, and a site with two historical runs has two jobs of
 * the same type, so a subject lookup would answer with whichever is live rather
 * than with the one belonging to the run being read.
 *
 * The two vocabularies are the same six strings by construction — `JobStatus`
 * and `ImportRunStatus` are both the generic long-operation vocabulary of docs
 * snapshot 03 §13 — so there is nothing to map, and a widening of one that
 * forgot the other is a compile error here.
 */
async function liveJobStatus(
  db: Executor,
  run: ImportRunRow,
): Promise<ImportRunStatus | undefined> {
  const type = jobTypeForPhase(run.state)
  if (type === null) return undefined
  const status = await readJobStatusByIdempotencyKey(db, `${type}:${run.id}`)
  return status ?? undefined
}

/**
 * The wire shape of a run.
 *
 * `phase` is the run's own state and `status` is the generic job vocabulary
 * derived from it (docs snapshot 03 §13, ADR-0032 D7). Both are present because
 * they answer different questions — one is "what is this import doing", the
 * other is "is this operation finished" — and a client that only understands the
 * second can still render a progress row.
 *
 * `upload` is required-and-nullable, the ADR-0027 convention: null is a
 * statement ("there is nothing to upload to right now"), not an omission. It is
 * non-null only on the single-run read of a run still `uploading` — the list
 * read never carries one, because minting a credential per row of a list nobody
 * asked to upload to would be a signed URL handed out by a poll.
 */
function runJson(
  run: ImportRunRow,
  options: { upload?: SignedUrl; jobStatus?: ImportRunStatus } = {},
) {
  return {
    id: run.id,
    provider: run.provider,
    status: importRunStatusFor(run.state, options.jobStatus),
    phase: run.state,
    summary: run.summary,
    cutover_date: run.cutoverDate,
    error_code: run.errorCode,
    created_at: run.createdAt.toISOString(),
    finished_at: run.finishedAt?.toISOString() ?? null,
    upload: options.upload === undefined ? null : uploadJson(options.upload),
  }
}

/** The run payload with its live job status resolved. */
async function runJsonWithStatus(
  db: Executor,
  run: ImportRunRow,
  upload?: SignedUrl,
): Promise<ReturnType<typeof runJson>> {
  const jobStatus = await liveJobStatus(db, run)
  return runJson(run, {
    ...(upload === undefined ? {} : { upload }),
    ...(jobStatus === undefined ? {} : { jobStatus }),
  })
}

function validationFailed(message: string, issues: readonly Record<string, unknown>[]): never {
  throw new ApiError('VALIDATION_FAILED', message, { details: { issues } })
}

/**
 * A body that may legitimately be absent.
 *
 * Publish and rollback both have every field optional, so `POST` with no body at
 * all is the ordinary call — "publish this with the cutover you proposed". An
 * empty object is the honest reading of that, and refusing it would make the
 * common case require a client to send `{}`.
 */
async function readOptionalJson(c: {
  req: { json: () => Promise<unknown> }
}): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json()
    if (typeof body !== 'object' || body === null) return {}
    return body as Record<string, unknown>
  } catch {
    return {}
  }
}

async function readJson(c: {
  req: { json: () => Promise<unknown> }
}): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json()
    if (typeof body !== 'object' || body === null) throw new Error('not an object')
    return body as Record<string, unknown>
  } catch {
    throw new ApiError('VALIDATION_FAILED', 'A JSON request body is required')
  }
}

export interface ImportRoutesDeps {
  readonly db: Database
  /** The bucket. Its presence is what mounts the **site-scoped** surface at all
   * (`routes.ts`); the provider catalog is mounted regardless, being a static
   * list that touches neither the bucket nor the database. */
  readonly objectStorage: ObjectStorage
  /** `IMPORT_MAX_ARCHIVE_BYTES`. The door admits nothing the parser is bound to
   * reject, and the signed URL binds exactly the size that was admitted. */
  readonly maxArchiveBytes: number
}

/** The only content type an import archive may declare. Bound into the upload
 * signature, so this is not advisory: a PUT with any other type is refused by
 * storage, not by us. */
const ARCHIVE_CONTENT_TYPE = 'application/zip'

/**
 * The provider catalog (D11), on its own mount and with no dependencies.
 *
 * Session-authenticated but not site-scoped: it is a property of this build, not
 * of a site, and the picker is rendered before a site has been chosen.
 * `available: false` entries are listed on purpose — "coming later" and "not a
 * thing we do" are different answers, and a list that only carried working
 * adapters could give only the second.
 *
 * **Mounted unconditionally**, unlike the site-scoped surface below. It is a
 * static list that touches neither the database nor the bucket, and D11's whole
 * purpose is convergence: the frontend's hardcoded provider list is replaced by
 * this endpoint *without a redeploy*. Hiding it behind `OBJECT_STORAGE_*` would
 * mean a deployment that has not finished its bucket configuration answers 404
 * here, and the frontend — unable to tell that from "this build is too old" —
 * falls back to the mock list this endpoint exists to retire.
 */
export function createImportCatalogRoutes(): Hono<Env> {
  const app = new Hono<Env>()
  app.get('/imports/providers', (c) => c.json({ items: IMPORT_PROVIDERS.map(providerJson) }))
  return app
}

export function createImportRoutes(deps: ImportRoutesDeps): Hono<Env> {
  const { db, objectStorage } = deps
  const app = new Hono<Env>()

  const base = '/sites/:site_id/imports'

  app.use(`${base}/*`, siteMembership(db))
  app.use(base, siteMembership(db))

  app.get(base, async (c) => {
    const { siteId } = c.get('membership')
    const runs = await listImportRuns(db, { siteId })
    // Never `runs.map(runJson)`: `Array.map` passes the index as the second
    // argument, and this function's second argument is an options object.
    // Serial rather than `Promise.all`: at most one run of the page is in a
    // job-owned phase (D3), so this is one query, not fifty in parallel.
    const items = []
    for (const row of runs) items.push(await runJsonWithStatus(db, row))
    return c.json({ items })
  })

  /**
   * One run — and, while it is still `uploading`, a **freshly minted** upload
   * target beside it.
   *
   * The create call's URL lives an hour (`UPLOAD_URL_TTL_SECONDS`) and a 256 MiB
   * upload over a bad connection can outlive it, as can a customer who starts
   * the import, closes the tab and comes back after lunch. Without this the only
   * recovery from an expired signature is to discard the run and start again —
   * which is a working recovery, and a needlessly destructive one for a URL that
   * costs nothing to re-issue. The re-mint binds the *same* declared size and
   * content type, read from the upload row rather than taken from the request,
   * so a re-issued signature can never widen what the first one admitted.
   *
   * Every other phase answers `upload: null`: past `uploading` there is nothing
   * to upload to, and minting a credential for a run that has already been
   * checked would hand out a way to replace bytes the ETag pin has fixed.
   */
  app.get(`${base}/:run_id`, async (c) => {
    const { siteId } = c.get('membership')
    const run = await readImportRun(db, {
      siteId,
      importRunId: c.req.param('run_id') as string,
    })
    if (!run) throw new ApiError('NOT_FOUND', 'No such import on this site')
    if (run.state !== 'uploading') return c.json(await runJsonWithStatus(db, run))

    const upload = await readImportUpload(db, run.id)
    if (!upload) return c.json(await runJsonWithStatus(db, run))

    const signed = await storageCall(
      async () =>
        await objectStorage.signedUploadUrl({
          key: upload.objectKey,
          expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
          contentType: upload.contentType,
          maxSizeBytes: upload.declaredBytes,
        }),
    )
    return c.json(await runJsonWithStatus(db, run, signed))
  })

  /**
   * Start an import: create the run and hand back a signed upload URL.
   *
   * Every refusal here happens before a single byte is admitted, which is the
   * point of declaring the size up front. The three checks are not
   * interchangeable:
   *
   * - an unavailable provider means this build has no parser, so the archive
   *   could be uploaded and never read;
   * - the content type is bound into the signature, so a value we did not sign
   *   for could not be PUT at all — refusing here gives a readable error instead
   *   of an opaque storage rejection;
   * - the size is what the signature binds, so admitting one above
   *   `IMPORT_MAX_ARCHIVE_BYTES` would mint a URL for bytes the parser is
   *   guaranteed to reject.
   *
   * A size violation is a `VALIDATION_FAILED` rather than `PAYLOAD_TOO_LARGE`:
   * `size_bytes` is a *field of this request*, not the request's own body, and
   * 413 in this catalog means the payload that arrived was too big
   * (`packages/contracts/src/errors.ts`). Nothing has arrived yet.
   */
  app.post(
    base,
    requireCapability('site:settings'),
    idempotent({ db, scope: 'imports.create' }),
    async (c) => {
      const { siteId } = c.get('membership')
      const body = await readJson(c)

      const provider = findImportProvider(body['provider'])
      if (!provider) {
        validationFailed('No such import provider', [{ field: 'provider', code: 'unknown' }])
      }
      if (!provider.available) {
        validationFailed(`Importing from ${provider.displayName} is not available yet`, [
          { field: 'provider', code: 'unavailable' },
        ])
      }

      if (body['content_type'] !== ARCHIVE_CONTENT_TYPE) {
        validationFailed(`content_type must be ${ARCHIVE_CONTENT_TYPE}`, [
          { field: 'content_type', code: 'invalid' },
        ])
      }

      const sizeBytes = body['size_bytes']
      if (typeof sizeBytes !== 'number' || !Number.isInteger(sizeBytes) || sizeBytes < 1) {
        validationFailed('size_bytes must be a positive integer', [
          { field: 'size_bytes', code: 'invalid' },
        ])
      }
      if (sizeBytes > deps.maxArchiveBytes) {
        validationFailed(`The archive may be at most ${String(deps.maxArchiveBytes)} bytes`, [
          { field: 'size_bytes', code: 'too_large', limit: deps.maxArchiveBytes },
        ])
      }

      const created = await createImportRun(db, {
        siteId,
        provider: provider.id,
        declaredBytes: sizeBytes,
        contentType: ARCHIVE_CONTENT_TYPE,
      })
      if (!created.ok) {
        // A site being deleted reads as a site that is not there, which is what
        // `requireAnalyticsAccess` already answers for one — and the repository
        // decided it under the same row lock `startSiteDeletion` takes, so the
        // two cannot interleave and leave an object key outside the deletion
        // snapshot.
        if (created.conflict === 'site_unavailable') {
          throw new ApiError('SITE_NOT_FOUND', 'No such site')
        }
        throw new ApiError(
          'IMPORT_IN_PROGRESS',
          'This site already has an import awaiting completion or review',
          { details: { import_run_id: created.runId } },
        )
      }

      // Minted after the row exists, so a signed URL never names an object no
      // run is tracking — the deletion registry enumerates keys from these rows
      // (D9), and an untracked key is one nothing would ever purge.
      const signed = await storageCall(
        async () =>
          await objectStorage.signedUploadUrl({
            key: created.upload.objectKey,
            expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
            contentType: ARCHIVE_CONTENT_TYPE,
            maxSizeBytes: sizeBytes,
          }),
      )

      return c.json({ run: runJson(created.run), upload: uploadJson(signed) }, 201)
    },
  )

  /**
   * Confirm the upload landed, then queue the prepare job.
   *
   * `head()` is the api's only look at the archive, and it does two things at
   * once. It answers "did the browser actually finish", which nothing else can —
   * a signed PUT succeeds against storage with no callback to us — and it
   * compares the observed size against what was declared and signed. A mismatch
   * is `IMPORT_FAILED` (422) rather than a validation error: the request is
   * fine, the *content* is not what it was supposed to be, and that is what 422
   * means in this catalog.
   *
   * The transition, the ETag pin and the enqueue are **one transaction**. Split,
   * a crash between any two of them leaves a run in `uploaded` with no job to
   * prepare it — and because `uploaded` is inside the live-run unique's
   * predicate (D3), that run holds the site's only import slot forever while
   * nothing is working it. The pin sits inside the successful branch for the
   * same reason: an ETag recorded for a transition that then did not happen
   * would describe an object the run never accepted.
   *
   * **A repeated call on an `uploaded` run is a success, not a conflict.** It is
   * the recovery for a `complete` whose response was lost, and for the window
   * this endpoint used to leave open. It re-enqueues (the job key is the run's,
   * so an existing row is found rather than twinned) and answers the same
   * payload — `head()` is deliberately not repeated, because the fingerprint
   * that matters was already pinned and re-reading could only replace it with a
   * later one, which is precisely the substitution the pin exists to catch.
   */
  app.post(`${base}/:run_id/complete`, requireCapability('site:settings'), async (c) => {
    const { siteId } = c.get('membership')
    const runId = c.req.param('run_id') as string

    /** The prepare job of this run. Keyed on the run, so a retried `complete`
     * finds its own job rather than minting a twin. The executor arrives in CP2:
     * until it registers the type, `claimDueJobs` filters on the registered type
     * list, so the row is never claimed and sits `queued` — visible to an
     * operator, harmless to the runner, picked up by the deploy that adds it. */
    const enqueuePrepare = async (executor: Parameters<typeof enqueueJob>[0]): Promise<void> => {
      await enqueueJob(executor, {
        type: IMPORT_PREPARE_JOB_TYPE,
        subjectId: siteId,
        idempotencyKey: `${IMPORT_PREPARE_JOB_TYPE}:${runId}`,
        payload: { import_run_id: runId },
      })
    }

    const run = await readImportRun(db, { siteId, importRunId: runId })
    if (!run) throw new ApiError('NOT_FOUND', 'No such import on this site')

    if (run.state === 'uploaded') {
      await enqueuePrepare(db)
      return c.json(await runJsonWithStatus(db, run), 202)
    }

    if (run.state !== 'uploading') {
      // A conflict with the run's state, in the same sense as starting a second
      // import: the request is permitted, the run is simply past the point where
      // completing an upload means anything.
      throw new ApiError('IMPORT_IN_PROGRESS', 'This import is no longer awaiting its upload', {
        details: { import_run_id: run.id, phase: run.state },
      })
    }

    const upload = await readImportUpload(db, runId)
    if (!upload) throw new ApiError('NOT_FOUND', 'No such import on this site')

    const head = await storageCall(async () => await objectStorage.head({ key: upload.objectKey }))
    if (head === null) {
      throw new ApiError('IMPORT_UPLOAD_MISSING', 'The uploaded archive is not in storage', {
        details: { import_run_id: run.id },
      })
    }
    if (head.size !== upload.declaredBytes) {
      throw new ApiError(
        'IMPORT_FAILED',
        'The uploaded archive is not the size that was declared',
        {
          details: {
            import_run_id: run.id,
            declared_bytes: upload.declaredBytes,
            observed_bytes: head.size,
          },
        },
      )
    }

    const moved = await db.transaction(async (tx) => {
      const advanced = await transitionImportRun(tx, {
        importRunId: runId,
        from: ['uploading'],
        to: 'uploaded',
      })
      if (!advanced) return false
      // An empty etag ('' — the provider omitted the header) is pinned as-is
      // rather than rejected here: CP2's worker treats an unverifiable
      // fingerprint as a reason to fail the run `validating`, so the archive is
      // never silently accepted, and the decision stays in the one place that
      // has the bytes to compare against.
      await pinUploadEtag(tx, { importRunId: runId, etag: head.etag })
      await enqueuePrepare(tx)
      return true
    })
    if (!moved) {
      // Somebody else moved it between the read and this write. The guard is in
      // the WHERE precisely so that is a conflict rather than an overwrite.
      throw new ApiError('IMPORT_IN_PROGRESS', 'This import is no longer awaiting its upload', {
        details: { import_run_id: run.id },
      })
    }

    const updated = await readImportRun(db, { siteId, importRunId: runId })
    return c.json(await runJsonWithStatus(db, updated ?? run), 202)
  })

  /**
   * Discard a run.
   *
   * Only from the three states where discarding is unambiguous: before the
   * prepare job owns it, and at the review point where the customer is being
   * asked to decide. Past those the run either holds a job lease or is the
   * published pointer, and undoing it is *rollback* — a different operation with
   * a different transaction, below.
   *
   * The object delete is best-effort and deliberately after the state change:
   * the customer's intent is recorded whether or not storage answers this
   * second, and the bucket's `imports/` expiry rule reaps whatever is left. The
   * staged ClickHouse rows of a discarded `ready_for_review` run are left to the
   * sweeper's backstop (D7) rather than deleted here: this route holds no job
   * lease, and issuing eight ClickHouse mutations inside a customer's `DELETE`
   * would make a 204 wait on a store this service is not otherwise allowed to
   * touch.
   */
  app.delete(`${base}/:run_id`, requireCapability('site:settings'), async (c) => {
    const { siteId } = c.get('membership')
    const runId = c.req.param('run_id') as string

    const run = await readImportRun(db, { siteId, importRunId: runId })
    if (!run) throw new ApiError('NOT_FOUND', 'No such import on this site')

    const moved = await transitionImportRun(db, {
      importRunId: runId,
      from: [...IMPORT_RUN_DISCARDABLE_STATES],
      to: 'discarded',
      finished: true,
    })
    if (!moved) {
      throw new ApiError('IMPORT_IN_PROGRESS', 'This import can no longer be discarded', {
        details: { import_run_id: run.id, phase: run.state },
      })
    }

    const upload = await readImportUpload(db, runId)
    if (upload) {
      // Deliberately *not* through `storageCall`: this is the one storage call
      // on the surface whose failure must not become the response. The discard
      // has already committed, the `imports/` lifecycle rule reaps the orphan,
      // and answering 503 here would tell the customer their discard failed when
      // it did not.
      try {
        await objectStorage.delete([{ key: upload.objectKey }])
      } catch (err) {
        c.get('logger')?.warn('import_discard_object_delete_failed', {
          site_id: siteId,
          import_run_id: runId,
          err,
          retryable: true,
        })
      }
    }

    return c.body(null, 204)
  })

  /**
   * Publish a reviewed import (ADR-0032, D3/D4).
   *
   * The endpoint does three things and enqueues the fourth. It **chooses the
   * cutover**, moves the run to `publishing`, and queues `import_publish`; the
   * pointer swap itself is the job's, because it is a transaction over three
   * rows followed by ClickHouse cleanup, and neither belongs inside a request
   * that a browser is waiting on.
   *
   * The cutover is the one decision made here, and it is made here because this
   * is where the customer's choice arrives. D4's default is
   * `min(first live day, max imported date + 1)` — computed at staging time and
   * carried on the summary as `proposed_cutover_date` — and a supplied value is
   * clamped to at most `first live day + 1`. That clamp is not a preference: a
   * later cutover would hide live data the site already has behind imported
   * numbers, which is a wrong dashboard rather than a choice. A site with no
   * live events has no clamp at all, which is the primary migration case: import
   * first, install the tracker second.
   *
   * **Idempotent twice over.** A repeat while the run is already `publishing` or
   * `published` answers 202 with the run rather than a conflict — the recovery
   * for a lost response — and the job's own key is the run's, so the enqueue
   * finds the existing row instead of twinning it.
   */
  app.post(
    `${base}/:run_id/publish`,
    requireCapability('site:settings'),
    idempotent({ db, scope: 'imports.publish' }),
    async (c) => {
      const { siteId } = c.get('membership')
      const runId = c.req.param('run_id') as string

      const run = await readImportRun(db, { siteId, importRunId: runId })
      if (!run) throw new ApiError('NOT_FOUND', 'No such import on this site')

      if (run.state === 'publishing' || run.state === 'published') {
        return c.json(await runJsonWithStatus(db, run), 202)
      }
      if (run.state !== 'ready_for_review') {
        throw new ApiError('IMPORT_IN_PROGRESS', 'This import is not awaiting review', {
          details: { import_run_id: run.id, phase: run.state },
        })
      }

      const site = await readSiteImportContext(db, siteId)
      // A site on its way out reads as a site that is not there, which is what
      // `requireAnalyticsAccess` already answers for one. Checked here rather
      // than left to the job: without it the run would move to `publishing` —
      // inside the live-run unique's predicate — and the job would then find the
      // site unavailable and no-op, leaving a run nothing can advance.
      if (!site || site.status === 'deleting' || site.status === 'deleted') {
        throw new ApiError('SITE_NOT_FOUND', 'No such site')
      }

      const body = await readOptionalJson(c)
      const proposed = run.summary?.['proposed_cutover_date']
      const cutover = resolveCutoverDate({
        requested: body['cutover_date'],
        proposed: typeof proposed === 'string' ? proposed : null,
        firstEventAt: site.firstEventAt,
      })
      if (!cutover.ok) {
        if (cutover.code === 'unavailable') {
          // Nothing was staged, so publishing would point the site at a run with
          // no rows and the dashboard would read empty for a customer who has
          // just imported. Refused rather than silently made a no-op.
          throw new ApiError('IMPORT_FAILED', 'This import staged no rows to publish', {
            details: { import_run_id: run.id },
          })
        }
        validationFailed(
          cutover.code === 'too_late'
            ? 'cutover_date must not be later than the day after this site started collecting data'
            : 'cutover_date must be a calendar date (YYYY-MM-DD)',
          [{ field: 'cutover_date', code: cutover.code }],
        )
      }

      // One transaction: the cutover, the transition and the enqueue. Split, a
      // crash between any two leaves a run in `publishing` — inside the live-run
      // unique's predicate — with no job to publish it, and the site can start
      // no other import ever again.
      const moved = await db.transaction(async (tx) => {
        const advanced = await transitionImportRun(tx, {
          importRunId: runId,
          from: ['ready_for_review'],
          to: 'publishing',
          cutoverDate: cutover.cutoverDate,
        })
        if (!advanced) return false
        await enqueueJob(tx, {
          type: IMPORT_PUBLISH_JOB_TYPE,
          subjectId: siteId,
          idempotencyKey: `${IMPORT_PUBLISH_JOB_TYPE}:${runId}`,
          payload: { import_run_id: runId },
        })
        return true
      })
      if (!moved) {
        throw new ApiError('IMPORT_IN_PROGRESS', 'This import is no longer awaiting review', {
          details: { import_run_id: run.id },
        })
      }

      const updated = await readImportRun(db, { siteId, importRunId: runId })
      return c.json(await runJsonWithStatus(db, updated ?? run), 202)
    },
  )

  /**
   * Undo the last publish (ADR-0032, D3).
   *
   * Inline rather than a job, and that is the payoff of the whole staging
   * design: the predecessor's ClickHouse rows were never deleted — cleanup keeps
   * exactly one rollback generation — so restoring them is moving a pointer.
   * `rollbackImportRun` is one Postgres transaction over the site row and two
   * run rows, and it touches no analytics store at all.
   *
   * The run must be the one the pointer currently names. Rolling back an older
   * published run is not a coherent request: its successor is what the site is
   * showing, and "undo the thing before the thing you are looking at" would
   * leave the dashboard unchanged while telling the customer something happened.
   *
   * A run with **no** predecessor is a valid rollback, not an error: the pointer
   * goes to null and the site returns to having no imported history, which is
   * exactly where it was before the import.
   */
  app.post(
    `${base}/:run_id/rollback`,
    requireCapability('site:settings'),
    idempotent({ db, scope: 'imports.rollback' }),
    async (c) => {
      const { siteId } = c.get('membership')
      const runId = c.req.param('run_id') as string

      const run = await readImportRun(db, { siteId, importRunId: runId })
      if (!run) throw new ApiError('NOT_FOUND', 'No such import on this site')

      // The recovery for a lost response: a run this call already rolled back
      // answers 200 with the run rather than "that is not the published one".
      if (run.state === 'rolled_back') return c.json(await runJsonWithStatus(db, run))

      const result = await rollbackImportRun(db, { siteId, importRunId: runId })
      if (!result.ok) {
        if (result.conflict === 'site_unavailable') {
          throw new ApiError('SITE_NOT_FOUND', 'No such site')
        }
        if (result.conflict === 'generation_erased') {
          // The run is published and the request is permitted; what is gone is
          // the *predecessor*. A client told `IMPORT_IN_PROGRESS` would look at
          // the phase, find it perfectly normal, and have nothing to act on.
          throw new ApiError(
            'IMPORT_ROLLBACK_UNAVAILABLE',
            'The import this one replaced has already been cleaned up and cannot be restored',
            { details: { import_run_id: run.id } },
          )
        }
        throw new ApiError('IMPORT_IN_PROGRESS', 'This import is not the published one', {
          details: { import_run_id: run.id, phase: run.state },
        })
      }

      c.get('logger')?.info('import_rolled_back', {
        site_id: siteId,
        import_run_id: runId,
        restored_import_run_id: result.restoredRunId,
      })

      const updated = await readImportRun(db, { siteId, importRunId: runId })
      return c.json(await runJsonWithStatus(db, updated ?? run))
    },
  )

  return app
}
