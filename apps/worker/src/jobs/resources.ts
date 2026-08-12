import type {
  ClickhouseMaintenance,
  ExportReader,
  ImportedAggregatesMaintenance,
  ImportedAggregatesWriter,
} from '@openanalytics/clickhouse'
import type { ImportAdapterRegistry, RevenueAdapterRegistry } from '@openanalytics/domain'
import type { CredentialVault, ObjectStorage } from '@openanalytics/integrations'

/**
 * The non-Postgres stores a job executor may reach (ADR-0030, decision 4).
 *
 * Declared as a narrow structural surface rather than by importing the driver's
 * own client type, for the reason the ingest pipeline's dependency objects give
 * (ADR-0009): what a component cannot name, it cannot accidentally depend on. A
 * purge phase that could see the whole ioredis surface could `SCAN`, `FLUSHDB`
 * or `KEYS` — and the entire design of the Redis purge is that it enumerates
 * from bounded indexes and never scans a shared keyspace. The five commands
 * below are what a bounded walk needs and nothing else.
 */
export interface RedisPurgeClient {
  /** Read a day bucket, or any bounded LIST, whole. */
  lrange(key: string, start: number, stop: number): Promise<string[]>
  /** Read the presence ZSET's members — the per-visitor key enumeration. */
  zrange(key: string, start: number, stop: number): Promise<string[]>
  /** Remove entries from the shared event stream by id. */
  xdel(key: string, ...ids: string[]): Promise<number>
  /** Remove keys. Variadic, so a chunk is one round trip. */
  del(...keys: string[]): Promise<number>
}

/**
 * The policy values the deletion phases read. Never literals at the enforcement
 * point (AGENTS.md): every one of these is a `Policy` field the worker's env
 * already carries, threaded through so a test can drive the same code with
 * different bounds.
 */
export interface DeletionPolicy {
  /** `SITE_QUEUE_INDEX_TTL_DAYS`. The day-bucket walk covers this + 1. */
  readonly siteQueueIndexTtlDays: number
  /** `INGEST_CONFIG_CACHE_TTL_SECONDS`. The first half of the drain's wait. */
  readonly ingestConfigCacheTtlSeconds: number
  /** `DELETION_ACCEPTANCE_MARGIN_MS`. The second half. */
  readonly deletionAcceptanceMarginMs: number
  /** `SITE_CEILING_ALERT_CONSECUTIVE_DAYS`. Bounds the day-counter walk. */
  readonly ceilingAlertConsecutiveDays: number
  /** `WORKER_LEASE_TTL_MS`, for the finalizer lease the purge holds. */
  readonly leaseTtlMs: number
}

/**
 * The non-Postgres resources a job executor may be handed.
 *
 * Every entry is optional and every absence is a phase that waits rather than
 * one that fails: each of these is a separate provisioning step on the host, and
 * a worker that refused to boot without one would take email delivery, ingest and
 * the sweeper down over a credential a single job type uses.
 */
export interface JobResources {
  /**
   * The durable queue instance (`EVENT_STREAM_REDIS_URL`). Holds the site day
   * buckets, the shared event stream and the dedup records.
   */
  readonly queue?: RedisPurgeClient | undefined
  /**
   * The realtime-cache instance (`REALTIME_CACHE_REDIS_URL`). Holds presence,
   * the feed, the epochs and the day counters. A *different* instance from the
   * queue by design (D-205), so both are needed and neither substitutes.
   */
  readonly realtime?: RedisPurgeClient | undefined
  /** The `oa_maintenance` ClickHouse credential's client. */
  readonly clickhouse?: ClickhouseMaintenance | undefined
  // The Stripe client was here until the open-core split, for the one phase that
  // cancels a subscription. It is not threaded through this object any more: the
  // phase that needs it is registered by the surface that owns it, and that
  // surface builds its own provider client from its own schema
  // (`../cloud/stripe.ts`) — so a product resource list no longer names a
  // payment provider it may never talk to.
  /**
   * The object storage bucket (ADR-0032, D1/D9). Present only when all five
   * `OBJECT_STORAGE_*` variables are configured.
   *
   * The whole port rather than a narrowed surface, unlike `RedisPurgeClient`
   * above, and the reason is that the port is *already* the narrow surface: it
   * has no `list`, no copy and no bucket management, so there is nothing here a
   * purge phase could reach that it should not. What the Redis narrowing exists
   * to forbid — a keyspace `SCAN` — has no equivalent to forbid.
   *
   * Absent, `object_purge` returns a retry when the site actually has keys to
   * delete and completes trivially when it does not. It never skips: a phase
   * that reported "nothing to purge" because the credential was missing would be
   * a deletion claiming to have erased bytes it never reached.
   */
  readonly objectStorage?: ObjectStorage | undefined
  readonly deletionPolicy?: DeletionPolicy | undefined
  /**
   * The staging insert path (ADR-0032, D2/D7), on the ClickHouse **ingest**
   * credential.
   *
   * Separate from `clickhouse` above, and the separation is the credential
   * reality rather than tidiness: `oa_ingest` can insert and cannot delete,
   * `oa_maintenance` can delete and cannot insert, and one object holding both
   * would be one object that can rewrite a customer's analytics history.
   */
  readonly importedAggregatesWriter?: ImportedAggregatesWriter | undefined
  /** The per-run cleanup path, on the `oa_maintenance` credential. Used by the
   * prepare job's failure path, the publish job's grandparent cleanup and the
   * sweeper's backstop. */
  readonly importedAggregatesMaintenance?: ImportedAggregatesMaintenance | undefined
  /**
   * Provider id → parser.
   *
   * Composed at startup rather than looked up from a module singleton, so a test
   * drives the pipeline with exactly the adapter it means to exercise and
   * production has one place where a real adapter is switched on. **Empty in
   * CP2**: the Plausible adapter is CP3, and until then every run fails
   * `adapter_unavailable`, which is the honest answer for a build with no parser.
   */
  readonly importAdapters?: ImportAdapterRegistry | undefined
  readonly importPolicy?: ImportPolicy | undefined
  /**
   * The export read path (ADR-0032, D8), on the `oa_maintenance` credential.
   *
   * A **third** ClickHouse object beside `clickhouse` and
   * `importedAggregatesWriter`, and it shares the maintenance user's credential
   * rather than adding a fourth environment variable — `oa_maintenance` already
   * holds `SELECT` on `analytics.*`, which is exactly and only what an export
   * needs. It is a separate object because it is a separate *client*: this one
   * streams (`resultSet.stream()`) with a five-minute request timeout and two
   * output-format settings the maintenance client must not have, and folding
   * them into one client would apply a bulk-scan timeout to the mutation polling
   * the deletion phase depends on.
   *
   * Absent, `export_run` returns a counting retry, so a queued export waits for
   * the restart instead of failing.
   */
  readonly exportReader?: ExportReader | undefined
  readonly exportPolicy?: ExportPolicy | undefined
  /**
   * Revenue sync wiring (ADR-0033, D3/D4). Present only when
   * `OA_CREDENTIAL_KEYRING` parsed into a usable ring.
   *
   * The three travel together because they are useless apart: the vault
   * decrypts the customer's provider key, the registry says which adapter can
   * use it, and the policy bounds how much of the provider's history one run
   * walks. Absent, `revenue_backfill` returns a counting retry — the same
   * treatment every other missing credential gets, and counting for the same
   * reason the export's is: a keyring that was never provisioned does not appear
   * on its own, and an immortal job would hold the credential's only backfill
   * slot forever.
   */
  readonly revenue?: RevenueResources | undefined
}

export interface RevenueResources {
  readonly vault: CredentialVault
  readonly adapters: RevenueAdapterRegistry
  readonly policy: RevenuePolicy
}

/**
 * The D2e/D4 bounds, threaded through rather than read at the enforcement point
 * (AGENTS.md). Every field is a `Policy` value the worker's env already carries,
 * and a test drives the same code with a two-day window and a two-object page —
 * which is the only way to prove that a resumable ninety-day walk resumes
 * without performing one.
 */
export interface RevenuePolicy {
  /** `REVENUE_BACKFILL_DAYS`. How far back the initial walk reaches. */
  readonly backfillDays: number
  /** `REVENUE_SYNC_PAGE_SIZE`. Objects per list request. */
  readonly pageSize: number
  /** `REVENUE_RECONCILE_WINDOW_HOURS`. The sweep's trailing overlap. */
  readonly reconcileWindowHours: number
}

/**
 * The D8 export bounds, threaded through rather than read at the enforcement
 * point (AGENTS.md: no magic numbers in code).
 */
export interface ExportPolicy {
  /** `EXPORT_MAX_CHUNK_BYTES`. Uncompressed NDJSON per object; a unit above it
   * is split into `-p2`, `-p3` parts. */
  readonly maxChunkBytes: number
  /** `EXPORT_OBJECT_TTL_DAYS`. Carried for the future lifecycle backstop and so
   * a single place answers "how long is an export downloadable?". */
  readonly objectTtlDays: number
  /**
   * `WORKER_LEASE_TTL_MS` — the same value the runner's own policy holds.
   *
   * Threaded through rather than read from the environment at the enforcement
   * point, and duplicated here rather than reached for through the runner
   * because the executor is handed `resources`, not `deps`. It is what sizes the
   * export's wall-clock lease heartbeat: a single month can stream for longer
   * than the TTL while touching nothing that renews, and a heartbeat measured
   * against a hardcoded interval would silently stop being safe the day somebody
   * shortened the TTL.
   */
  readonly leaseTtlMs: number
}

/**
 * The D6 budgets, threaded through rather than read from the environment at the
 * enforcement point (AGENTS.md: no magic numbers in code). Every field is a
 * `Policy` value the worker's env already carries, and a test drives the same
 * code with tiny bounds — which is the only way to prove a bomb is refused
 * without building a real one.
 */
export interface ImportPolicy {
  /** `IMPORT_MAX_ARCHIVE_BYTES`. The download's own ceiling. */
  readonly maxArchiveBytes: number
  /** `IMPORT_MAX_ENTRIES`. */
  readonly maxEntries: number
  /** `IMPORT_MAX_ENTRY_BYTES`, uncompressed. */
  readonly maxEntryBytes: number
  /** `IMPORT_MAX_TOTAL_UNCOMPRESSED_BYTES`. */
  readonly maxTotalUncompressedBytes: number
  /** `IMPORT_MAX_ROW_BYTES`. */
  readonly maxRowBytes: number
  /** `IMPORT_STAGING_CHUNK_BYTES`. The *proposed* chunk size — a run that has
   * already recorded one keeps it, whatever this says (D7). */
  readonly stagingChunkBytes: number
  /** `IMPORT_UPLOAD_TTL_DAYS`. The cleanup backstop's age threshold. */
  readonly uploadTtlDays: number
}
