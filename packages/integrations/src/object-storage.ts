/**
 * S3-compatible object storage contract.
 *
 * Milestone 1 item 10 and [G-001]. The production provider is **not** chosen
 * here — G-001 stays open until private bucket, encryption, lifecycle,
 * multipart, signed URL, region, egress cost and a restore test have been
 * compared. What this file fixes is the shape the rest of the system codes
 * against, so that choice stays a deployment decision rather than a rewrite.
 *
 * Three consumers, from docs snapshot 02:
 *
 * - Import (§16): the browser uploads **directly** to a private bucket with a
 *   signed URL; the API never proxies the bytes.
 * - Export (§16): a finished artefact is handed out as a short-lived signed
 *   download URL.
 * - Backup (§25): ClickHouse snapshots, which is where multipart matters.
 *
 * And one non-consumer: nothing here is ever public. Every object is private
 * and reached only through a signed URL with an explicit expiry, which is why
 * the contract has no notion of an ACL or a public bucket to get wrong.
 */

/**
 * Explicit failure, never an empty success.
 *
 * The same rule as `ProviderResult` in this package, for the same reason: a
 * storage outage that reads as "no files" is how legacy turned an error into a
 * confident wrong answer (docs snapshot 01 §12.3). Callers must be able to tell
 * "the object is not there" from "storage did not answer".
 */
export type StorageFailureReason =
  | 'not_found'
  | 'unavailable'
  | 'unauthorized'
  | 'precondition_failed'
  /** Object exceeds a configured limit; the caller must not retry unchanged. */
  | 'too_large'

export class ObjectStorageError extends Error {
  readonly reason: StorageFailureReason
  readonly retryable: boolean

  constructor(reason: StorageFailureReason, message: string) {
    super(message)
    this.name = 'ObjectStorageError'
    this.reason = reason
    // Only an outage is worth retrying. A missing object or a rejected
    // credential will fail identically forever, and retrying them turns a clear
    // error into a slow one.
    this.retryable = reason === 'unavailable'
  }
}

/** Where an object lives. Bucket is per-deployment config, never per-request. */
export interface ObjectRef {
  readonly key: string
}

export interface PutObjectInput extends ObjectRef {
  readonly body: Uint8Array | string
  readonly contentType: string
  /**
   * Server-side encryption is requested per object rather than assumed from a
   * bucket default, so a misconfigured bucket cannot silently store customer
   * exports unencrypted. G-001 will confirm the provider honours it.
   */
  readonly serverSideEncryption?: boolean
  readonly metadata?: Readonly<Record<string, string>>
}

export interface PutObjectResult {
  readonly key: string
  readonly etag: string
  readonly size: number
}

export interface GetObjectResult {
  readonly key: string
  readonly body: Uint8Array
  readonly contentType: string
  readonly size: number
}

/**
 * A streamed read (ADR-0032, D6.3).
 *
 * `get()` buffers the whole object into a `Uint8Array`, which is right for a
 * manifest and wrong for an import archive: `IMPORT_MAX_ARCHIVE_BYTES` is
 * 256 MiB, and holding one of those in the worker's heap — beside batch ingest,
 * the outbox dispatcher and every other duty that process runs — is an OOM
 * waiting for the first customer with a large history. The pipeline needs the
 * bytes on disk anyway (the ZIP central directory is at the *end* of the file,
 * so entry enumeration needs random access), so what it actually wants is a
 * stream it can write straight to a temp file.
 *
 * `etag` is on the response because the verification the whole upload security
 * model rests on happens here: the run pinned the ETag `complete` observed, and
 * the bytes about to be parsed have to be the bytes that were checked. Doing it
 * with a separate `head()` would leave a window between the two calls — small,
 * but the thing being defended against is precisely a client re-PUTting through
 * a still-valid signed URL.
 */
export interface GetObjectStreamResult {
  readonly key: string
  readonly size: number
  readonly contentType: string
  readonly etag: string
  /**
   * The body, in provider-sized chunks.
   *
   * `AsyncIterable<Uint8Array>` rather than a Node `Readable`, for the reason
   * every other type in this file is provider-neutral: a Node stream is an
   * implementation of this, not a requirement of it. Consumers must read it to
   * completion or abandon it — the underlying socket is released either way when
   * the iterator is closed.
   */
  readonly body: AsyncIterable<Uint8Array>
}

export interface HeadObjectResult {
  readonly key: string
  readonly size: number
  readonly contentType: string
  readonly lastModified: Date
  /**
   * The provider's content fingerprint, quotes included, or `''` when it did not
   * supply one.
   *
   * Present because a `head()` is how the import flow confirms an upload
   * arrived, and confirming the *size* alone is not enough: the signed PUT URL
   * stays valid until it expires, so a client can re-upload different bytes of
   * the same length after the check passed. The observed ETag is pinned on the
   * run and re-verified at download time, which turns that into a failed import
   * instead of an unchecked one (docs snapshot 02 §16, ADR-0032 D6).
   */
  readonly etag: string
}

export interface SignedUploadInput extends ObjectRef {
  readonly expiresInSeconds: number
  /**
   * Both are bound into the signature, not advisory.
   *
   * A signed upload URL is handed to a browser, so whatever it does not
   * constrain, the client chooses. Without a content-length bound the holder
   * can upload arbitrarily large files into a private bucket the account pays
   * for; without a content type they can store something the import parser was
   * never meant to read (docs snapshot 02 §16 step 2).
   */
  readonly maxSizeBytes: number
  readonly contentType: string
}

export interface SignedDownloadInput extends ObjectRef {
  readonly expiresInSeconds: number
  /** Filename offered to the browser; export artefacts are not served inline. */
  readonly downloadFilename?: string
}

export interface SignedUrl {
  readonly url: string
  readonly expiresAt: Date
  /** Headers the caller MUST replay for the signature to verify. */
  readonly requiredHeaders: Readonly<Record<string, string>>
}

/**
 * Multipart boundary.
 *
 * The threshold is a property of the protocol, not a tuning knob: S3-compatible
 * stores cap a single PUT at 5 GiB, and every part except the last must be at
 * least 5 MiB. Those two numbers decide where the boundary sits, so they live
 * here rather than at each call site.
 *
 * Sitting below the threshold is not merely an optimisation — a single PUT is
 * atomic, while a multipart upload is a session that can be abandoned half
 * finished and leaves billable parts behind until it is aborted or a lifecycle
 * rule reaps it. That cleanup obligation is exactly why `abort` is part of this
 * contract and not an implementation detail.
 */
export const MULTIPART_MINIMUM_PART_BYTES = 5 * 1024 * 1024
export const MULTIPART_THRESHOLD_BYTES = 64 * 1024 * 1024
export const SINGLE_PUT_MAXIMUM_BYTES = 5 * 1024 * 1024 * 1024

export function requiresMultipart(sizeBytes: number): boolean {
  return sizeBytes >= MULTIPART_THRESHOLD_BYTES
}

/**
 * Rejects a part plan the provider would reject anyway, before any bytes move.
 *
 * Discovering an undersized part on part 900 of 1000 wastes the whole upload,
 * and the failure arrives as an opaque provider error far from its cause.
 */
export function assertValidPartPlan(sizeBytes: number, partSizeBytes: number): void {
  if (partSizeBytes < MULTIPART_MINIMUM_PART_BYTES) {
    throw new RangeError(
      `part size ${partSizeBytes} is below the ${MULTIPART_MINIMUM_PART_BYTES}-byte minimum every part but the last must meet`,
    )
  }
  if (!requiresMultipart(sizeBytes) && sizeBytes > SINGLE_PUT_MAXIMUM_BYTES) {
    throw new RangeError(`object of ${sizeBytes} bytes exceeds the single-PUT maximum`)
  }
}

export interface MultipartUpload {
  readonly key: string
  /** Provider-issued session id; required to upload parts, complete or abort. */
  readonly uploadId: string
}

export interface UploadedPart {
  /** 1-based, and contiguous. Providers reject gaps at completion. */
  readonly partNumber: number
  readonly etag: string
}

/**
 * One bucket expiry rule (ADR-0032, D1).
 *
 * Deliberately not the provider's own rule shape. S3 lifecycle configuration
 * carries transitions, storage classes, version rules and tag filters, none of
 * which this system has any use for — and every one of them is a way for a
 * misapplied configuration to move or delete something nobody asked to move.
 * What M11 needs is exactly two statements per prefix: objects under it expire
 * after N days, and abandoned multipart sessions under it are aborted after N
 * days. Anything else is a provider feature, not a contract.
 */
export interface BucketLifecycleRule {
  /** Stable id. The rule set is replace-all, so this is what makes a rule
   * recognisable across two writes rather than an anonymous positional entry. */
  readonly id: string
  /** Key prefix the rule applies to. The empty string means the whole bucket. */
  readonly prefix: string
  readonly expirationDays?: number
  readonly abortIncompleteMultipartDays?: number
}

/**
 * Refuses a rule that expresses no expiry.
 *
 * A rule with neither field is accepted by some providers and silently ignored
 * by others, so the orphan sweep it was supposed to install simply never runs —
 * and the only symptom is a bucket that grows. Failing here makes the
 * misconfiguration visible where it is written.
 */
export function assertValidLifecycleRule(rule: BucketLifecycleRule): void {
  if (rule.expirationDays === undefined && rule.abortIncompleteMultipartDays === undefined) {
    throw new RangeError(
      `lifecycle rule "${rule.id}" sets neither expirationDays nor abortIncompleteMultipartDays`,
    )
  }
}

/**
 * One entry from a prefix listing. Metadata only — a listing never reads a
 * body, which is what keeps it usable against objects this process has no key
 * for (ADR-0052, D10).
 */
export interface ListedObject {
  readonly key: string
  readonly size: number
  readonly lastModified: Date
}

/**
 * The whole storage surface.
 *
 * Deliberately narrow: no copy, no bucket management. Each of those would be a
 * new way for a caller to reach data it was not scoped to, and nothing in the
 * import/export/backup flows needs them. It grows when a milestone proves a
 * need, not in advance — which is exactly how `newestUnder` arrived (ADR-0052,
 * D10): the backup alert has to answer "does a recent backup object exist",
 * and there was no way to ask.
 */
export interface ObjectStorage {
  put(input: PutObjectInput): Promise<PutObjectResult>
  get(ref: ObjectRef): Promise<GetObjectResult>
  /**
   * The same read, streamed and with the fingerprint attached.
   *
   * Added rather than replacing `get()` because both shapes are genuinely
   * needed: a manifest is read whole and an import archive must never be. See
   * `GetObjectStreamResult`.
   */
  getStream(ref: ObjectRef): Promise<GetObjectStreamResult>
  /** Resolves `null` for a missing object; throws only when storage misbehaves. */
  head(ref: ObjectRef): Promise<HeadObjectResult | null>
  /** Idempotent: deleting an absent key succeeds (D-210 re-runs deletion). */
  delete(refs: readonly ObjectRef[]): Promise<void>

  /**
   * The most recently modified object under `prefix`, or `null` if there are
   * none (ADR-0052, D10).
   *
   * Deliberately not a general `list()`. What the backup alert needs is one
   * fact — the age of the newest object under a prefix — and a paginated
   * listing surface handed to every caller is a way to enumerate a bucket that
   * no other flow here asks for. Narrowing it to the reduction also means the
   * pagination lives in the adapter rather than in each caller's loop, which is
   * where a forgotten continuation token would silently truncate the answer and
   * make a stale backup look fresh.
   *
   * Metadata only: a customer-key-encrypted object lists fine and cannot be
   * read, so the caller of this never needs the encryption key.
   */
  newestUnder(prefix: string): Promise<ListedObject | null>

  signedUploadUrl(input: SignedUploadInput): Promise<SignedUrl>
  signedDownloadUrl(input: SignedDownloadInput): Promise<SignedUrl>

  createMultipartUpload(input: {
    key: string
    contentType: string
    serverSideEncryption?: boolean
  }): Promise<MultipartUpload>
  uploadPart(input: {
    upload: MultipartUpload
    partNumber: number
    body: Uint8Array
  }): Promise<UploadedPart>
  completeMultipartUpload(input: {
    upload: MultipartUpload
    parts: readonly UploadedPart[]
  }): Promise<PutObjectResult>
  /** Must be called on any abandoned upload; unaborted parts are billable. */
  abortMultipartUpload(upload: MultipartUpload): Promise<void>

  /**
   * Replace the bucket's lifecycle rule set (ADR-0032, D1).
   *
   * Replace-all rather than merge, because that is what the provider API is: a
   * partial write would read as an addition and silently drop every rule it did
   * not name. The caller therefore always states the whole intended set.
   */
  putBucketLifecycle(rules: readonly BucketLifecycleRule[]): Promise<void>
  /** The current rule set; an empty array when the bucket has none configured. */
  getBucketLifecycle(): Promise<readonly BucketLifecycleRule[]>
}

export interface ObjectStorageConfig {
  /**
   * Set for MinIO and most S3-compatible providers; omitted for AWS itself.
   * Its presence is also what keeps this adapter provider-agnostic while G-001
   * is open.
   */
  readonly endpoint?: string
  readonly region: string
  readonly bucket: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  /**
   * MinIO and several providers serve buckets as a path segment rather than a
   * subdomain. Wrong here means every request 404s against a bucket that exists.
   */
  readonly forcePathStyle?: boolean
}
