import { ApiError } from '@openanalytics/contracts'
import {
  exportManifestKey,
  exportRunStatusFor,
  type ExportManifest,
  type ExportRunStatus,
} from '@openanalytics/domain'
import { ObjectStorageError, type ObjectStorage, type SignedUrl } from '@openanalytics/integrations'
import {
  claimExportDownload,
  createExportRun,
  exportRunJobKey,
  listExportRuns,
  readExportRun,
  readJobStatusByIdempotencyKey,
  type Database,
  type Executor,
  type ExportRunRow,
} from '@openanalytics/postgres'
import { Hono } from 'hono'
import { idempotent } from './idempotency.ts'
import { requireCapability, siteMembership, type ApiVariables } from './middleware.ts'

/**
 * The export surface (ADR-0032, D8).
 *
 * Three ideas shape it, and each is a boundary rather than a preference.
 *
 * **The bytes never pass through this service, and neither does ClickHouse.**
 * The api creates a row and enqueues a job; the worker reads the analytics store
 * and moves the bytes; the customer downloads straight from the bucket through a
 * signed URL. An api that streamed the export would be an api holding a
 * customer's whole history in the request path of the service that also holds
 * every session — and it would be the api connecting to ClickHouse, which
 * D-208 forbids outright.
 *
 * **Status and download are separate surfaces.** `GET …/exports/{id}` answers
 * state and mints nothing, so a frontend may poll it as fast as it likes;
 * `POST …/exports/{id}/download` mints every URL in one response and writes
 * **one** audit row. Folding the URLs into the status read would make a polling
 * dashboard generate an audit entry per second and hand out a bearer credential
 * to a request nobody made.
 *
 * **The pin is taken here, in one transaction.** The cutoff (the database
 * clock) and the site's published import pointer are read under the same row
 * lock, so a publish or a rollback landing mid-export cannot make the early
 * chunks disagree with the late ones. That is `createExportRun`'s job; this file
 * is what makes sure nothing else decides either value.
 *
 * ## Authorization: `export:raw`, owner only
 *
 * Both write operations require `export:raw`, which the capability matrix grants
 * to the owner role and to nothing else.
 *
 * ADR-0032 D8 says "owner/admin", and **that sentence was the mistake.** Docs
 * snapshot 02 §25 is explicit that admin/viewer permission is separated from
 * revenue-credential and *raw-export* authority, and the capability matrix was
 * drawn to that rule years of decisions ago: `export:raw` sits in the owner-only
 * set beside `revenue:read` and `site:delete`, the set defined by irreversibility
 * and by personal data. An export is the second of those in its purest form — the
 * site's entire `events_raw` history, every anonymous id, session id, hashed user
 * id, page URL, referrer and city it ever recorded, in one downloadable file. It
 * is not "reshape what the dashboard shows", which is what `site:settings`
 * covers and why the *import* door legitimately uses it; it is "hand me all of
 * it". Choosing the capability that already exists for exactly this, rather than
 * widening it to admin to match one clause of the ADR, is why the ADR carries a
 * dated amendment (D8, 2026-07-29) instead of this file carrying a workaround.
 *
 * The read surfaces are membership-only on purpose: every member may see *that*
 * an export happened and what state it is in, which is the transparency half of
 * the same rule. Only an owner may cause one or take delivery of one.
 */

type Env = { Variables: ApiVariables }

/**
 * How long a download URL lives (D8: fifteen minutes).
 *
 * Not a policy knob, for the reason `UPLOAD_URL_TTL_SECONDS` gives on the import
 * side: it is a property of the interaction rather than something a deployment
 * tunes. Long enough for a browser to start every chunk of a multi-gigabyte
 * export, short enough that a URL copied out of devtools is worthless by the
 * time anyone finds it. A download that outlives it repeats the `POST` for a
 * fresh set — each one audited, which is the point.
 */
const DOWNLOAD_URL_TTL_SECONDS = 900

/**
 * Run a storage call, and turn a storage failure into an answer.
 *
 * Identical in shape and reasoning to the import surface's: `ObjectStorageError`
 * would otherwise reach the error middleware as an unrecognised exception — a
 * `500` that tells a client nothing and reads to an operator as a bug in this
 * service rather than an outage in the bucket.
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

/**
 * The live job's own status, when one owns the run.
 *
 * Found by the **run-scoped idempotency key** rather than by `(type, subject)`,
 * the same reason the import surface gives: a site with two historical exports
 * has two jobs of the same type, and a subject lookup would answer with
 * whichever is live rather than with the one belonging to the run being read.
 *
 * Only consulted for the two non-terminal phases, so a list of fifty exports
 * performs at most one job query — a site may hold one live export at a time.
 */
async function liveJobStatus(
  db: Executor,
  run: ExportRunRow,
): Promise<ExportRunStatus | undefined> {
  if (run.state !== 'queued' && run.state !== 'running') return undefined
  const status = await readJobStatusByIdempotencyKey(db, exportRunJobKey(run.id))
  return status ?? undefined
}

/** Milliseconds in a day, for the server-computed `expires_at`. */
const DAY_MS = 86_400_000

/**
 * When this export's files stop being downloadable, or null before it finishes.
 *
 * **Computed on the server and answered**, rather than left for a client to
 * derive from `finished_at` plus a number it would have to hardcode. The TTL is
 * a deployment value (`EXPORT_OBJECT_TTL_DAYS`, capped at the bucket rule's seven
 * days) and a frontend that added its own "+7 days" would be inventing a
 * deadline — wrong the moment the two disagree, and wrong in the direction that
 * shows a customer a download button for bytes the lifecycle rule already
 * deleted.
 *
 * It is a *prediction* rather than a stored column: the row is flipped to
 * `expired` lazily, at the first download attempt after this instant, so an
 * export past this time may still read `phase: succeeded` until somebody asks.
 * The instant is what a client should render; the `410` is what settles it.
 */
function expiresAtOf(run: ExportRunRow, objectTtlDays: number): string | null {
  if (run.finishedAt === null) return null
  return new Date(run.finishedAt.getTime() + objectTtlDays * DAY_MS).toISOString()
}

/**
 * The wire shape of an export — **status only, never a URL**.
 *
 * `manifest` is summarized rather than echoed: a customer wants to know how big
 * the download is before starting it, and the full chunk list with its per-chunk
 * digests is what the manifest object itself is for. Echoing it here would put a
 * multi-thousand-entry array in every poll response.
 */
function exportJson(
  run: ExportRunRow,
  objectTtlDays: number,
  options: { jobStatus?: ExportRunStatus } = {},
) {
  return {
    id: run.id,
    status: exportRunStatusFor(run.state, options.jobStatus),
    phase: run.state,
    cutoff: run.cutoff.toISOString(),
    pinned_import_run_id: run.pinnedImportRunId,
    error_code: run.errorCode,
    created_at: run.createdAt.toISOString(),
    started_at: run.startedAt?.toISOString() ?? null,
    finished_at: run.finishedAt?.toISOString() ?? null,
    expires_at: expiresAtOf(run, objectTtlDays),
    // Required-and-nullable, the ADR-0027 convention: null is a statement
    // ("this export has produced nothing yet"), not an omission.
    manifest: run.manifest === null ? null : manifestSummaryJson(run.manifest),
  }
}

function manifestSummaryJson(manifest: ExportManifest) {
  return {
    schema_version: manifest.schema_version,
    chunks: manifest.totals.chunks,
    rows: manifest.totals.rows,
    bytes: manifest.totals.bytes,
  }
}

async function exportJsonWithStatus(
  db: Executor,
  run: ExportRunRow,
  objectTtlDays: number,
): Promise<ReturnType<typeof exportJson>> {
  const jobStatus = await liveJobStatus(db, run)
  return exportJson(run, objectTtlDays, { ...(jobStatus === undefined ? {} : { jobStatus }) })
}

export interface ExportRoutesDeps {
  readonly db: Database
  /** The bucket. Its presence is what mounts this surface at all (`routes.ts`):
   * every route here either creates work that writes to it or mints a URL that
   * reads from it. */
  readonly objectStorage: ObjectStorage
  /** `EXPORT_OBJECT_TTL_DAYS`. The lazy-expiry deadline, applied in SQL against
   * the database-stamped `finished_at`. */
  readonly objectTtlDays: number
}

export function createExportRoutes(deps: ExportRoutesDeps): Hono<Env> {
  const { db, objectStorage } = deps
  const app = new Hono<Env>()

  const base = '/sites/:site_id/exports'

  app.use(`${base}/*`, siteMembership(db))
  app.use(base, siteMembership(db))

  /** The site's exports, newest first. Readable by every member: knowing that
   * an export happened is not the same as being able to download it, and the
   * audit trail exists precisely so a team can see who took their data. */
  app.get(base, async (c) => {
    const { siteId } = c.get('membership')
    const runs = await listExportRuns(db, { siteId })
    // Serial rather than `Promise.all`: at most one run of the page is in a
    // job-owned phase, so this is one query, not fifty in parallel.
    const items = []
    for (const row of runs) items.push(await exportJsonWithStatus(db, row, deps.objectTtlDays))
    return c.json({ items })
  })

  app.get(`${base}/:export_id`, async (c) => {
    const { siteId } = c.get('membership')
    const run = await readExportRun(db, {
      siteId,
      exportRunId: c.req.param('export_id') as string,
    })
    if (!run) throw new ApiError('NOT_FOUND', 'No such export on this site')
    return c.json(await exportJsonWithStatus(db, run, deps.objectTtlDays))
  })

  /**
   * Start an export.
   *
   * The whole endpoint is one repository call, and that is deliberate: the
   * cutoff, the import pin, the row, the job and the audit entry all commit
   * together or not at all. Split, a crash between any two of them produces a
   * state with no owner — a row nothing works, a job with no row, an export
   * pinned to a pointer that had already moved, or a customer's data leaving the
   * system with no audit trail.
   *
   * The conflict is the runner's `(type, subject_id)` liveness index (D8), which
   * here genuinely serializes: an export is one job type, unlike the import
   * pair. `409 EXPORT_IN_PROGRESS` names the run in the way so the client has
   * something to act on.
   */
  app.post(
    base,
    requireCapability('export:raw'),
    idempotent({ db, scope: 'exports.create' }),
    async (c) => {
      const { siteId } = c.get('membership')
      const user = c.get('user')

      const created = await createExportRun(db, {
        siteId,
        requestedByUserId: user.id,
        requestId: c.get('requestId'),
      })
      if (!created.ok) {
        // A site being deleted reads as a site that is not there, which is what
        // `requireAnalyticsAccess` already answers for one — and the repository
        // decided it under the same row lock `startSiteDeletion` takes, so the
        // two cannot interleave and leave an object prefix outside the deletion
        // snapshot.
        if (created.conflict === 'site_unavailable') {
          throw new ApiError('SITE_NOT_FOUND', 'No such site')
        }
        throw new ApiError('EXPORT_IN_PROGRESS', 'This site already has an export running', {
          details: { export_id: created.exportRunId },
        })
      }

      return c.json({ export: exportJson(created.run, deps.objectTtlDays) }, 202)
    },
  )

  /**
   * Mint the download.
   *
   * One response carries **every** URL — the manifest and each chunk — because a
   * per-chunk endpoint would write a per-chunk audit row, and D8 asks for one
   * row per download *request*. A multi-chunk download that outlives the
   * fifteen-minute window repeats this call for a fresh set, which is itself an
   * audited download, which is the honest record.
   *
   * The state check, the lazy expiry and the audit row are one transaction under
   * the run's row lock (`claimExportDownload`), so "this export was still
   * downloadable when we said so" and "somebody was told" cannot come apart. The
   * URLs are minted afterwards, outside it: the storage port is not a database
   * and has no business inside a transaction that holds a row lock.
   *
   * A storage failure after the audit row is written leaves an audited download
   * that produced no URLs. That is the right direction to fail: the audit trail
   * over-reports rather than under-reports, and the customer simply calls again.
   */
  app.post(`${base}/:export_id/download`, requireCapability('export:raw'), async (c) => {
    const { siteId } = c.get('membership')
    const exportRunId = c.req.param('export_id') as string

    const claim = await claimExportDownload(db, {
      siteId,
      exportRunId,
      ttlDays: deps.objectTtlDays,
      actorUserId: c.get('user').id,
      requestId: c.get('requestId'),
    })

    if (!claim.ok) {
      if (claim.reason === 'not_found') {
        throw new ApiError('NOT_FOUND', 'No such export on this site')
      }
      if (claim.reason === 'expired') {
        throw new ApiError(
          'EXPORT_EXPIRED',
          'This export has expired and its files are no longer available',
          { details: { export_id: exportRunId, ttl_days: deps.objectTtlDays } },
        )
      }
      throw new ApiError('EXPORT_IN_PROGRESS', 'This export is not ready to download', {
        details: { export_id: exportRunId, phase: claim.state },
      })
    }

    // The manifest first, and it is not merely first in the array: a client that
    // fetches it before the chunks has the row counts and digests to verify
    // every file it then downloads.
    const targets = [
      // From the domain helper, never rebuilt here: `exportObjectKeysOf` derives
      // the same key for the deletion enumeration, and two places spelling the
      // manifest's name independently is how a rename makes a purge quietly stop
      // covering it.
      { key: exportManifestKey(claim.objectPrefix), kind: 'manifest' as const, chunk: null },
      ...claim.manifest.chunks.map((chunk) => ({ key: chunk.key, kind: 'chunk' as const, chunk })),
    ]

    const files = []
    let signedExpiresAt = new Date().toISOString()
    for (const target of targets) {
      const signed = await storageCall(
        async () =>
          await objectStorage.signedDownloadUrl({
            key: target.key,
            expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
            // The bucket serves export artefacts as attachments, never inline:
            // an NDJSON or JSON object rendered in a browser tab from a bucket
            // origin is a document nobody asked to open.
            downloadFilename: filenameOf(target.key),
          }),
      )
      signedExpiresAt = signed.expiresAt.toISOString()
      files.push(downloadJson(target, signed))
    }

    // Every URL was minted in one loop with one TTL, so they share an expiry;
    // `signedExpiresAt` is set by the first (the manifest, always present) and is
    // the honest answer rather than a `??` fallback that could only ever be
    // reached by a manifest with no files, which cannot exist.
    return c.json({ export_id: exportRunId, expires_at: signedExpiresAt, files })
  })

  return app
}

function filenameOf(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1)
}

function downloadJson(
  target: {
    key: string
    kind: 'manifest' | 'chunk'
    chunk: { rows: number; bytes: number; sha256: string } | null
  },
  signed: SignedUrl,
) {
  return {
    kind: target.kind,
    filename: filenameOf(target.key),
    url: signed.url,
    expires_at: signed.expiresAt.toISOString(),
    // Null for the manifest: its digest cannot be inside itself. Every chunk
    // carries one so a downloader can verify what arrived without re-reading the
    // manifest it just fetched.
    rows: target.chunk?.rows ?? null,
    bytes: target.chunk?.bytes ?? null,
    sha256: target.chunk?.sha256 ?? null,
  }
}
