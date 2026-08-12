/**
 * The export run's vocabulary, its object keys and its manifest shape
 * (ADR-0032, D8/D9).
 *
 * Four consumers have to agree on these strings — the migration's CHECK, the
 * repository's transition guards, the worker that writes the chunks and the api
 * that answers a status — so they live in one pure module rather than being
 * restated at each end. The object keys matter most: the storage port
 * deliberately has no `list`, so a key nobody recorded is a key nobody can ever
 * find again, and the deletion registry enumerates them from Postgres (D9).
 *
 * The **phase** is the run's own state and the **status** is the generic job
 * vocabulary every long-running operation in this API reports (docs snapshot 03
 * §13), exactly as the import surface splits them: one is a statement about this
 * export, the other is a statement about work in general, and collapsing them
 * would make a generic progress component impossible.
 */

export const EXPORT_RUN_STATES = ['queued', 'running', 'succeeded', 'failed', 'expired'] as const
export type ExportRunState = (typeof EXPORT_RUN_STATES)[number]

/**
 * The states an export can still move out of by itself.
 *
 * Unlike the import surface, this is **not** backed by a partial unique on the
 * run table. ADR-0032 D8 makes the runner's own `(type, subject_id)` liveness
 * index the serializer, and here — unlike imports — it genuinely applies: an
 * export is one job type, so one live `export_run` job per site *is* one live
 * export per site. The list exists so the api can name the blocking run in a
 * `409` rather than answering a conflict with nothing to act on.
 */
export const EXPORT_RUN_LIVE_STATES = ['queued', 'running'] as const
export type ExportRunLiveState = (typeof EXPORT_RUN_LIVE_STATES)[number]

export function isExportRunState(value: unknown): value is ExportRunState {
  return typeof value === 'string' && (EXPORT_RUN_STATES as readonly string[]).includes(value)
}

export function isLiveExportRunState(state: ExportRunState): boolean {
  return (EXPORT_RUN_LIVE_STATES as readonly string[]).includes(state)
}

/** The generic job vocabulary an operation's `status` is reported in — the same
 * six strings `ImportRunStatus` uses, because it is the same vocabulary (docs
 * snapshot 03 §13) and not a parallel one that happens to agree. */
export type ExportRunStatus =
  'queued' | 'running' | 'succeeded' | 'failed_retryable' | 'failed_terminal' | 'cancelled'

/**
 * The generic status derived from the run's phase (D7's table, extended to D8).
 *
 * `expired` maps to `succeeded`, and that is a deliberate reading rather than an
 * oversight: the *operation* succeeded — the export ran, the chunks were
 * written, the manifest landed — and what expired is the artefact's 7-day
 * lifetime, which is a property of the bytes and not an outcome of the work. A
 * client that only understands the generic vocabulary should render a finished
 * export; the `phase` is what tells it the download is gone, and
 * `POST …/download` answers `410 EXPORT_EXPIRED` with no ambiguity at all.
 *
 * `queued` and `running` optionally defer to the live job's own status, so an
 * export between retries reports `failed_retryable` rather than a flat
 * `running` — the difference between "this is working" and "this keeps failing
 * and will be tried again".
 */
export function exportRunStatusFor(
  state: ExportRunState,
  jobStatus?: ExportRunStatus,
): ExportRunStatus {
  switch (state) {
    case 'queued':
      return jobStatus ?? 'queued'
    case 'running':
      return jobStatus ?? 'running'
    case 'succeeded':
    case 'expired':
      return 'succeeded'
    case 'failed':
      return 'failed_terminal'
  }
}

// --- Object keys (D1's id-addressed layout) ----------------------------------

/** The `exports/` prefix the bucket lifecycle rule expires after 7 days (D1). */
export const EXPORT_OBJECT_PREFIX = 'exports/'

/**
 * Where one export's objects live.
 *
 * Id-addressed and nothing customer-supplied steers it, exactly like
 * `importArchiveObjectKey`. Recorded on the run row as `object_prefix` rather
 * than recomputed at read time, so a deletion enumerating keys works from what
 * the export actually wrote and not from what this build would write today.
 */
export function exportObjectPrefix(siteId: string, exportRunId: string): string {
  return `${EXPORT_OBJECT_PREFIX}${siteId}/${exportRunId}/`
}

/** The manifest's filename. Its presence in the bucket is what says the export
 * is complete — it is uploaded last, after every chunk (D8). */
export const EXPORT_MANIFEST_FILENAME = 'manifest.json'

export function exportManifestKey(objectPrefix: string): string {
  return `${objectPrefix}${EXPORT_MANIFEST_FILENAME}`
}

/**
 * The part suffix, shared by all three chunk kinds.
 *
 * `part` is 1-based and part 1 carries no suffix, so the ordinary case — a unit
 * that fits under `EXPORT_MAX_CHUNK_BYTES` — is the plain name, and a split one
 * reads as `…-p2`, `…-p3` beside it. A scheme that suffixed every part would
 * rename every file the day one month grew.
 */
function partSuffix(part: number): string {
  return part <= 1 ? '' : `-p${String(part)}`
}

/** One month of events, or one part of one. */
export function exportEventsChunkKey(objectPrefix: string, month: string, part = 1): string {
  return `${objectPrefix}events-${month}${partSuffix(part)}.ndjson.gz`
}

/** One imported report of the pinned run, or one part of one. */
export function exportImportedChunkKey(objectPrefix: string, report: string, part = 1): string {
  return `${objectPrefix}imported-${report}${partSuffix(part)}.ndjson.gz`
}

/** The site's funnel definitions. Split like the others, though a site would
 * need tens of thousands of funnels to reach the cap — the uniform shape is
 * worth more than a special case that would only ever be exercised by a bug. */
export function exportFunnelsChunkKey(objectPrefix: string, part = 1): string {
  return `${objectPrefix}funnels${partSuffix(part)}.ndjson.gz`
}

// --- The manifest (D8) --------------------------------------------------------

/** The manifest format version. Bumped when the *shape* of a chunk's rows
 * changes, which is a different question from the API's own contract version. */
export const EXPORT_SCHEMA_VERSION = 1

export type ExportChunkKind = 'events' | 'imported' | 'funnels'

/**
 * One uploaded object, as recorded the moment it landed.
 *
 * `sha256` and `bytes` describe the **stored (gzipped) object**, not the NDJSON
 * inside it: they are what a downloader can check against the bytes it received
 * without inflating anything, and what a resume compares when deciding whether
 * an already-uploaded chunk is still there.
 */
export interface ExportChunkRecord {
  readonly key: string
  readonly kind: ExportChunkKind
  /** `YYYY-MM` for an events chunk; absent otherwise. */
  readonly month?: string
  /** The imported report name for an imported chunk; absent otherwise. */
  readonly report?: string
  /** 1-based part number within a month. Always present for events chunks. */
  readonly part?: number
  readonly rows: number
  readonly bytes: number
  readonly sha256: string
}

/** What the run row carries while the export is still being written — the
 * enumeration a deletion needs for an export that never finished. */
export interface ExportProgress {
  readonly chunks: readonly ExportChunkRecord[]
  /**
   * Keys of objects a *later* attempt orphaned, kept so nothing can address
   * them again but the purge.
   *
   * A regeneration that produces fewer parts than the attempt before it leaves
   * the surplus objects in the bucket, and their records have to be **retracted**
   * from `chunks` — otherwise the next resume would walk `p1, p2, p3, p4`, find
   * a record for the stale `p4`, `head()` it successfully (it is still there)
   * and adopt a longer generation than the one that was actually written,
   * splicing a chunk from a previous stream into the manifest.
   *
   * Retracting the record without recording the key somewhere would be worse
   * than the bug it fixes: the port has no `list`, so the object would become
   * unreachable for a site deletion and survive until the bucket lifecycle rule
   * happened to reap it. This is the tombstone that keeps it enumerable — it is
   * read only by `exportObjectKeysOf` and never by the resume path, which is
   * exactly the split the problem needs.
   */
  readonly orphaned_keys?: readonly string[]
}

export interface ExportManifest {
  readonly schema_version: number
  readonly export_id: string
  readonly site_id: string
  /** Every events query bound `accepted_at <= cutoff`; the pinned run bound
   * every imported query. Both are recorded so the export is reproducible. */
  readonly cutoff: string
  readonly pinned_import_run_id: string | null
  readonly generated_at: string
  readonly number_encoding: typeof EXPORT_NUMBER_ENCODING
  readonly notes: readonly string[]
  readonly chunks: readonly ExportChunkRecord[]
  readonly totals: {
    readonly chunks: number
    readonly rows: number
    readonly bytes: number
  }
}

/**
 * How integers are written into the NDJSON, declared in the manifest so a
 * consumer never has to guess.
 *
 * **JSON numbers, everywhere.** The alternative — quoting 64-bit integers as
 * strings, which is what ClickHouse's `JSONEachRow` does by default — would make
 * `visitors` a string in the imported chunks and a number in the event chunks,
 * because `events_raw` has no 64-bit integer column at all (its widest is
 * `UInt32`). One encoding across the whole export is worth more to a consumer
 * than exactness at a magnitude no column here can reach: the imported counts
 * are per-site-per-day aggregates, and `2^53` visitors in one day is not a
 * number this system can produce.
 *
 * The caveat is stated rather than hidden — see `EXPORT_MANIFEST_NOTES`, which
 * ships inside every manifest.
 */
export const EXPORT_NUMBER_ENCODING = 'json_number'

/**
 * What a consumer has to know to read the files correctly. Written into every
 * manifest rather than only into documentation, because the manifest is the only
 * part of an export that outlives its 7-day download window in the customer's
 * own hands.
 */
export const EXPORT_MANIFEST_NOTES: readonly string[] = [
  'Every file is gzipped NDJSON: one JSON object per line, UTF-8, no trailing comma.',
  'Integers are JSON numbers. Values above 2^53 would lose precision in an IEEE-754 ' +
    'parser; no column in this schema version can reach that magnitude.',
  'Instants are ISO-8601 in UTC (…Z). Dates on imported rows are calendar days (YYYY-MM-DD).',
  'Booleans stored as UInt8 (clock_skewed) are 0 or 1, as stored.',
  'events_raw rows carry the contract shape the collector accepted. Pipeline internals ' +
    '(batch_id, ingest_generation, billing_user_id, billing_assignment_version, ' +
    'usage_window_start, billing_grace, billable) are deliberately absent.',
  'event properties are the stored JSON text, exported verbatim as a string rather than ' +
    're-parsed, so the bytes are byte-identical to what was stored.',
  'An absent optional value is the empty string, as stored — the analytics tables use no ' +
    'Nullable columns.',
  'Imported chunks are the pinned import run in full, including the hostname, region, ' +
    'utm_content, utm_term, link_url and path dimensions that the dashboard read path ' +
    'does not surface. The export is lossless where the read path is not.',
  'A chunk with zero rows is still written: "this report was empty" and "this report was ' +
    'not exported" are different statements.',
  'sha256 and bytes in the chunk list describe the gzipped object as stored.',
  'Imported rows keep import_run_id: it is the generation the site had published when this ' +
    'export was pinned, so a customer holding two exports can tell which provider import ' +
    'each one carries rather than having to infer it from the dates.',
  'Funnel rows omit the creating user: a funnel definition is the site’s, and the ' +
    'identity of the member who saved it is account data that belongs to a DSAR about that ' +
    'person rather than to a site data export.',
]

/**
 * Every object key an export row is responsible for.
 *
 * Pure, and shared by the deletion snapshot and its tests, because getting it
 * wrong is unrecoverable in one direction: the port has no `list`, so a key this
 * function misses is a key nothing can ever address again — it survives the
 * customer's deletion until the bucket lifecycle rule happens to reap it, which
 * is a backstop and not a mechanism of record (D9).
 *
 * Three sources, unioned:
 *
 * - **the manifest key**, derived from the prefix and included *unconditionally*
 *   — an export that failed before writing one has no object there, and a
 *   `delete` of an absent key is a no-op that the phase's `head() === null`
 *   verification passes trivially. Deriving it beats recording it, because the
 *   one moment it would be missing from a record is the moment a crash happened.
 * - **progress chunks**, recorded as each object landed. This is what covers an
 *   export that died half-way: its bytes are in the bucket and its manifest is
 *   not.
 * - **manifest chunks**, for a finished export. Belt and braces — a successful
 *   run's progress already lists the same keys — and cheap enough to be worth
 *   the redundancy for the one class of bug (a progress write that failed after
 *   its upload) that would otherwise leak bytes.
 * - **orphaned keys**, the tombstones a retraction leaves. Records are removed
 *   from `chunks` so a resume cannot adopt a stale generation, and the keys land
 *   here so removing the record does not also remove the bytes from the purge's
 *   reach.
 */
export function exportObjectKeysOf(row: {
  readonly objectPrefix: string
  readonly progress: ExportProgress | null
  readonly manifest: ExportManifest | null
}): string[] {
  const keys = new Set<string>([exportManifestKey(row.objectPrefix)])
  for (const chunk of row.progress?.chunks ?? []) keys.add(chunk.key)
  for (const key of row.progress?.orphaned_keys ?? []) keys.add(key)
  for (const chunk of row.manifest?.chunks ?? []) keys.add(chunk.key)
  return [...keys]
}

/**
 * The UTC calendar month an instant falls in, as `YYYY-MM`.
 *
 * UTC rather than any request timezone: the chunk boundary is a *file naming*
 * decision over `occurred_at`, which is stored in UTC and partitioned by
 * `toYYYYMM(occurred_at)` in ClickHouse. Naming the months in a viewer's zone
 * would put a month's rows in two files for no benefit, and the export carries
 * every row's own timestamp anyway.
 */
export function exportMonthOf(occurredAt: Date): string {
  const year = occurredAt.getUTCFullYear()
  const month = occurredAt.getUTCMonth() + 1
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`
}
