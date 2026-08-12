import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import {
  ObjectStorageError,
  assertValidLifecycleRule,
  type BucketLifecycleRule,
  type GetObjectResult,
  type GetObjectStreamResult,
  type HeadObjectResult,
  type ListedObject,
  type MultipartUpload,
  type ObjectRef,
  type ObjectStorage,
  type ObjectStorageConfig,
  type PutObjectInput,
  type PutObjectResult,
  type SignedDownloadInput,
  type SignedUploadInput,
  type SignedUrl,
  type UploadedPart,
} from './object-storage.ts'

/**
 * The S3-compatible implementation of `ObjectStorage`.
 *
 * One implementation for every candidate provider, MinIO included: the whole
 * point of keeping G-001 open is that the provider is a configuration change,
 * not a code change. MinIO is what the integration test runs against, so the
 * test exercises the same code path production will.
 */

/**
 * Maps provider errors onto the contract's reasons.
 *
 * Without this every failure reaches callers as an opaque SDK error and the
 * retryable/not-retryable distinction — the one thing the worker actually needs
 * — is lost. A 404 and a dead endpoint must not look alike.
 */
function toStorageError(error: unknown, context: string): ObjectStorageError {
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode
  const name = (error as { name?: string })?.name ?? 'Unknown'
  const code = (error as { Code?: string })?.Code ?? ''

  // A missing BUCKET is an outage, not an absent object, and it must be decided
  // before the generic 404 below. Verified live against Hetzner Object Storage
  // on 2026-07-29: a freshly created bucket is intermittently invisible on some
  // gateway nodes, which answer `404 NoSuchBucket`. Under the generic mapping
  // that reads as `not_found`, and `head()` turns `not_found` into `null` — so
  // a deletion's "the object is gone" verification would pass during exactly
  // the window in which storage cannot see the bucket at all. Retryable,
  // because the condition resolves on its own.
  if (name === 'NoSuchBucket' || code === 'NoSuchBucket') {
    return new ObjectStorageError('unavailable', `${context}: bucket is not visible to storage`)
  }
  if (status === 404 || name === 'NoSuchKey' || name === 'NotFound') {
    return new ObjectStorageError('not_found', `${context}: object does not exist`)
  }
  if (status === 401 || status === 403) {
    return new ObjectStorageError('unauthorized', `${context}: rejected by storage credentials`)
  }
  if (status === 412 || name === 'PreconditionFailed') {
    return new ObjectStorageError('precondition_failed', `${context}: precondition failed`)
  }
  // `InvalidArgument` is the provider refusing the request's shape — retrying
  // the same call can only fail the same way. Measured against MinIO
  // RELEASE.2025-09: a lifecycle rule set containing an
  // AbortIncompleteMultipartUpload-only rule is refused wholesale with this
  // code (Hetzner accepts the same set). Deliberately narrow — a bare 400 is
  // NOT mapped here, because S3 reuses 400 for retryable conditions such as
  // `RequestTimeout`.
  if (name === 'InvalidArgument' || code === 'InvalidArgument') {
    return new ObjectStorageError('precondition_failed', `${context}: request refused as invalid`)
  }
  if (status === 413) {
    return new ObjectStorageError('too_large', `${context}: object exceeds the accepted size`)
  }
  // Everything else — connection refused, 5xx, timeouts — is an outage, and
  // that is the only class worth retrying.
  return new ObjectStorageError('unavailable', `${context}: storage did not answer (${name})`)
}

export function createS3ObjectStorage(config: ObjectStorageConfig): ObjectStorage {
  const client = new S3Client({
    region: config.region,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    // MinIO and several S3-compatible providers address buckets as a path
    // segment rather than a subdomain.
    forcePathStyle: config.forcePathStyle ?? config.endpoint !== undefined,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  })

  const bucket = config.bucket
  const encryption = (enabled: boolean | undefined) =>
    enabled === true ? { ServerSideEncryption: 'AES256' as const } : {}

  return {
    async put(input: PutObjectInput): Promise<PutObjectResult> {
      const body = typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : input.body
      try {
        const response = await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: input.key,
            Body: body,
            ContentType: input.contentType,
            ...(input.metadata === undefined ? {} : { Metadata: { ...input.metadata } }),
            ...encryption(input.serverSideEncryption),
          }),
        )
        return { key: input.key, etag: response.ETag ?? '', size: body.byteLength }
      } catch (error) {
        throw toStorageError(error, `put ${input.key}`)
      }
    },

    async get(ref: ObjectRef): Promise<GetObjectResult> {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: ref.key }))
        const body = await response.Body?.transformToByteArray()
        if (body === undefined) {
          throw new ObjectStorageError('unavailable', `get ${ref.key}: storage returned no body`)
        }
        return {
          key: ref.key,
          body,
          contentType: response.ContentType ?? 'application/octet-stream',
          size: body.byteLength,
        }
      } catch (error) {
        if (error instanceof ObjectStorageError) throw error
        throw toStorageError(error, `get ${ref.key}`)
      }
    },

    async getStream(ref: ObjectRef): Promise<GetObjectStreamResult> {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: ref.key }))
        const body: unknown = response.Body
        // `transformToByteArray` is deliberately NOT called: that is what `get`
        // does, and calling it here would reintroduce the buffering this method
        // exists to avoid. The SDK's Node body is a `Readable`, which is an
        // `AsyncIterable<Buffer>`; the check is what turns a browser/blob body
        // (a build misconfiguration) into a classified failure rather than a
        // `for await` over undefined.
        if (
          body === null ||
          typeof body !== 'object' ||
          !(Symbol.asyncIterator in (body as Record<symbol, unknown>))
        ) {
          throw new ObjectStorageError(
            'unavailable',
            `get stream ${ref.key}: storage returned no streamable body`,
          )
        }
        return {
          key: ref.key,
          size: response.ContentLength ?? 0,
          contentType: response.ContentType ?? 'application/octet-stream',
          etag: response.ETag ?? '',
          body: body as AsyncIterable<Uint8Array>,
        }
      } catch (error) {
        if (error instanceof ObjectStorageError) throw error
        throw toStorageError(error, `get stream ${ref.key}`)
      }
    },

    async head(ref: ObjectRef): Promise<HeadObjectResult | null> {
      try {
        const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: ref.key }))
        return {
          key: ref.key,
          size: response.ContentLength ?? 0,
          contentType: response.ContentType ?? 'application/octet-stream',
          lastModified: response.LastModified ?? new Date(0),
          etag: response.ETag ?? '',
        }
      } catch (error) {
        const mapped = toStorageError(error, `head ${ref.key}`)
        // Absence is an answer, not a failure — callers use head() to ask
        // whether an upload arrived.
        if (mapped.reason === 'not_found') return null
        throw mapped
      }
    },

    async newestUnder(prefix: string): Promise<ListedObject | null> {
      let token: string | undefined
      let newest: ListedObject | null = null

      // The whole prefix is walked, not the first page. A backup prefix holds
      // 30 daily objects today and S3 returns keys in lexicographic order, not
      // by time — so "the first page's last entry" is not the newest object,
      // and would become quietly wrong as soon as a key naming scheme changed.
      // Stopping early here would make a stale backup look fresh, which is the
      // one failure this call exists to detect.
      do {
        let response
        try {
          response = await client.send(
            new ListObjectsV2Command({
              Bucket: bucket,
              Prefix: prefix,
              ...(token === undefined ? {} : { ContinuationToken: token }),
            }),
          )
        } catch (error) {
          throw toStorageError(error, `list ${prefix}`)
        }

        for (const entry of response.Contents ?? []) {
          if (entry.Key === undefined || entry.LastModified === undefined) continue
          if (newest === null || entry.LastModified > newest.lastModified) {
            newest = {
              key: entry.Key,
              size: entry.Size ?? 0,
              lastModified: entry.LastModified,
            }
          }
        }

        token = response.IsTruncated === true ? response.NextContinuationToken : undefined
      } while (token !== undefined)

      return newest
    },

    async delete(refs: readonly ObjectRef[]): Promise<void> {
      if (refs.length === 0) return
      let response
      try {
        response = await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: refs.map((ref) => ({ Key: ref.key })), Quiet: true },
          }),
        )
      } catch (error) {
        const mapped = toStorageError(error, `delete ${String(refs.length)} object(s)`)
        // The contract says delete is idempotent, and deletion re-runs (D-210).
        // A provider that answers 404 for a key that is already gone must not
        // turn the desired end state into a failure — the same reasoning
        // `abortMultipartUpload` below applies to an already-gone session.
        if (mapped.reason === 'not_found') return
        throw mapped
      }

      // **A 200 is not a success.** `DeleteObjects` is a batch operation and
      // reports per-key outcomes in the body: the HTTP status says the request
      // was understood, and `Errors` says which keys were not removed. Trusting
      // the status alone is how the site-deletion object phase would report
      // "erased" over bytes that are still there — the `head() = null`
      // verification is the backstop, but a phase that never learns it failed
      // would loop against it instead of surfacing the reason.
      //
      // Already-absent keys are filtered out, for the same idempotency reason
      // the catch above swallows a 404: deletion re-runs, and the desired end
      // state is the observed one.
      const failures = (response.Errors ?? []).filter(
        (entry) => entry.Code !== 'NoSuchKey' && entry.Code !== 'NotFound',
      )
      if (failures.length > 0) {
        const keys = failures.map((entry) => entry.Key ?? '(unnamed)').join(', ')
        throw new ObjectStorageError(
          'unavailable',
          `delete ${String(refs.length)} object(s): storage refused ${String(failures.length)} (${keys})`,
        )
      }
    },

    async signedUploadUrl(input: SignedUploadInput): Promise<SignedUrl> {
      // Content type and length are signed, so the browser holding this URL
      // cannot substitute either. `ContentLength` binds the exact size, which
      // is what stops a signed URL from becoming an open write channel.
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: input.key,
        ContentType: input.contentType,
        ContentLength: input.maxSizeBytes,
      })
      try {
        const url = await getSignedUrl(client, command, {
          expiresIn: input.expiresInSeconds,
          // Without `signableHeaders` these two are advisory and the holder of
          // the URL can substitute either — verified against MinIO, where a PUT
          // declaring `application/x-evil` was accepted by a URL signed for
          // `text/csv`. Naming them forces both into SignedHeaders, so the
          // request only verifies if the client replays the exact values.
          signableHeaders: new Set(['content-type', 'content-length']),
        })
        return {
          url,
          expiresAt: new Date(Date.now() + input.expiresInSeconds * 1_000),
          requiredHeaders: {
            'content-type': input.contentType,
            'content-length': String(input.maxSizeBytes),
          },
        }
      } catch (error) {
        throw toStorageError(error, `sign upload ${input.key}`)
      }
    },

    async signedDownloadUrl(input: SignedDownloadInput): Promise<SignedUrl> {
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: input.key,
        // Export artefacts download rather than render; an HTML export rendered
        // inline from the bucket origin would be a stored-XSS surface.
        ...(input.downloadFilename === undefined
          ? {}
          : { ResponseContentDisposition: `attachment; filename="${input.downloadFilename}"` }),
      })
      try {
        const url = await getSignedUrl(client, command, { expiresIn: input.expiresInSeconds })
        return {
          url,
          expiresAt: new Date(Date.now() + input.expiresInSeconds * 1_000),
          requiredHeaders: {},
        }
      } catch (error) {
        throw toStorageError(error, `sign download ${input.key}`)
      }
    },

    async createMultipartUpload(input: {
      key: string
      contentType: string
      serverSideEncryption?: boolean
    }): Promise<MultipartUpload> {
      try {
        const response = await client.send(
          new CreateMultipartUploadCommand({
            Bucket: bucket,
            Key: input.key,
            ContentType: input.contentType,
            ...encryption(input.serverSideEncryption),
          }),
        )
        if (response.UploadId === undefined) {
          throw new ObjectStorageError('unavailable', 'storage returned no upload id')
        }
        return { key: input.key, uploadId: response.UploadId }
      } catch (error) {
        if (error instanceof ObjectStorageError) throw error
        throw toStorageError(error, `create multipart ${input.key}`)
      }
    },

    async uploadPart(input: {
      upload: MultipartUpload
      partNumber: number
      body: Uint8Array
    }): Promise<UploadedPart> {
      try {
        const response = await client.send(
          new UploadPartCommand({
            Bucket: bucket,
            Key: input.upload.key,
            UploadId: input.upload.uploadId,
            PartNumber: input.partNumber,
            Body: input.body,
          }),
        )
        return { partNumber: input.partNumber, etag: response.ETag ?? '' }
      } catch (error) {
        throw toStorageError(error, `upload part ${input.partNumber}`)
      }
    },

    async completeMultipartUpload(input: {
      upload: MultipartUpload
      parts: readonly UploadedPart[]
    }): Promise<PutObjectResult> {
      try {
        const response = await client.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key: input.upload.key,
            UploadId: input.upload.uploadId,
            MultipartUpload: {
              // Sorted defensively: providers reject out-of-order part lists,
              // and the caller may well have finished them concurrently.
              Parts: [...input.parts]
                .sort((a, b) => a.partNumber - b.partNumber)
                .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
            },
          }),
        )
        return {
          key: input.upload.key,
          etag: response.ETag ?? '',
          size: 0,
        }
      } catch (error) {
        throw toStorageError(error, `complete multipart ${input.upload.key}`)
      }
    },

    async abortMultipartUpload(upload: MultipartUpload): Promise<void> {
      try {
        await client.send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: upload.key,
            UploadId: upload.uploadId,
          }),
        )
      } catch (error) {
        const mapped = toStorageError(error, `abort multipart ${upload.key}`)
        // An already-gone session is the desired end state; abort is called on
        // cleanup paths that must not fail because they ran twice.
        if (mapped.reason === 'not_found') return
        throw mapped
      }
    },

    async putBucketLifecycle(rules: readonly BucketLifecycleRule[]): Promise<void> {
      for (const rule of rules) assertValidLifecycleRule(rule)
      try {
        await client.send(
          new PutBucketLifecycleConfigurationCommand({
            Bucket: bucket,
            LifecycleConfiguration: {
              Rules: rules.map((rule) => ({
                ID: rule.id,
                Status: 'Enabled' as const,
                Filter: { Prefix: rule.prefix },
                ...(rule.expirationDays === undefined
                  ? {}
                  : { Expiration: { Days: rule.expirationDays } }),
                ...(rule.abortIncompleteMultipartDays === undefined
                  ? {}
                  : {
                      AbortIncompleteMultipartUpload: {
                        DaysAfterInitiation: rule.abortIncompleteMultipartDays,
                      },
                    }),
              })),
            },
          }),
        )
      } catch (error) {
        throw toStorageError(error, 'put bucket lifecycle')
      }
    },

    async getBucketLifecycle(): Promise<readonly BucketLifecycleRule[]> {
      let rules
      try {
        const response = await client.send(
          new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
        )
        rules = response.Rules ?? []
      } catch (error) {
        const mapped = toStorageError(error, 'get bucket lifecycle')
        // `NoSuchLifecycleConfiguration` is a 404: the bucket exists and has no
        // rules. That is an answer, not a failure — and it is distinguishable
        // from a missing bucket, which `toStorageError` now classifies as an
        // outage before it can reach this branch.
        if (mapped.reason === 'not_found') return []
        throw mapped
      }

      return rules.map((rule) => {
        const expirationDays = rule.Expiration?.Days
        const abortDays = rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation
        return {
          id: rule.ID ?? '',
          // Providers report the prefix under `Filter.Prefix` or, for rule sets
          // written before the filter form, the deprecated top-level `Prefix`.
          prefix: rule.Filter?.Prefix ?? rule.Prefix ?? '',
          ...(expirationDays === undefined ? {} : { expirationDays }),
          ...(abortDays === undefined ? {} : { abortIncompleteMultipartDays: abortDays }),
        }
      })
    },
  }
}
