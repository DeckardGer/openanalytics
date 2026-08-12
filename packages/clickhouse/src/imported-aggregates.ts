import { createClient, type ClickHouseClient } from '@clickhouse/client'
import {
  IMPORTED_REPORTS,
  IMPORTED_REPORT_TABLES,
  type ImportedReport,
  type ImportedRow,
} from '@openanalytics/domain'

/**
 * The staging write and cleanup path for imported aggregates (ADR-0032, D2/D7;
 * migration 0015).
 *
 * Two surfaces, deliberately separate, because they need two different
 * ClickHouse credentials and conflating them would mean one user that can both
 * write analytics and erase it:
 *
 * - **`ImportedAggregatesWriter`** inserts staged rows on the *ingest*
 *   credential. It is the same shape the batch worker's `EventsIngest` uses —
 *   `async_insert = 0`, a caller-supplied `insert_deduplication_token`, and an
 *   ambiguity-preserving error — for exactly the reason ADR-0005 gives: the
 *   token is what makes a retried chunk a no-op, and it only works per
 *   destination table under `non_replicated_deduplication_window`.
 * - **`ImportedAggregatesMaintenance`** deletes a run's rows on the
 *   `oa_maintenance` credential (`ALTER DELETE` + `SELECT` on `analytics.*`,
 *   nothing else), the same user and the same statement shape the site-deletion
 *   purge uses.
 *
 * **Operator note for the M11 deploy:** `oa_ingest`'s grant was narrowed to an
 * exact table list (ADR-0014's closure of the ADR-0005 item), so the eight
 * `imported_*` tables have to be added to it before staging can write. The
 * maintenance user is granted on `analytics.*` and therefore already covers
 * them. A missing grant surfaces as a definite (non-ambiguous) insert failure —
 * ACCESS_DENIED, code 497 — which the executor reports as an infrastructure
 * retry rather than as a failed run, so the import waits for the grant instead
 * of telling a customer their archive is broken.
 */

/** The ClickHouse table each report stages into. Re-exported from the domain
 * vocabulary rather than restated: the deletion registry names the same eight
 * tables, and a second literal list here is a cleanup that quietly stops
 * covering one of them. */
export const IMPORTED_AGGREGATE_TABLES = IMPORTED_REPORT_TABLES

/** Every imported table, in report order — what a per-run cleanup walks. */
export const IMPORTED_AGGREGATE_TABLE_LIST: readonly string[] = IMPORTED_REPORTS.map(
  (report) => IMPORTED_REPORT_TABLES[report],
)

// --- Stored row shapes -------------------------------------------------------

/**
 * The two columns every staged row carries, stamped by the pipeline.
 *
 * They are added here rather than accepted from the adapter on purpose: an
 * adapter that could name a `site_id` would be an adapter that could stage a
 * customer's export into somebody else's site, and `import_run_id` is the
 * generation the publish pointer names — a row with the wrong one is a row that
 * becomes visible without anybody publishing it.
 */
interface ImportedRowKey {
  readonly site_id: string
  readonly import_run_id: string
}

export interface StoredImportedMetricsRow extends ImportedRowKey {
  readonly date: string
  readonly visitors: number
  readonly visits: number
  readonly pageviews: number
  readonly bounces: number
  readonly visit_duration: number
}

export interface StoredImportedPagesRow extends ImportedRowKey {
  readonly date: string
  readonly hostname: string
  readonly page: string
  readonly visitors: number
  readonly visits: number
  readonly pageviews: number
}

export interface StoredImportedSourcesRow extends ImportedRowKey {
  readonly date: string
  readonly source: string
  readonly referrer: string
  readonly utm_source: string
  readonly utm_medium: string
  readonly utm_campaign: string
  readonly utm_content: string
  readonly utm_term: string
  readonly visitors: number
  readonly visits: number
  readonly pageviews: number
  readonly bounces: number
  readonly visit_duration: number
}

export interface StoredImportedGeographyRow extends ImportedRowKey {
  readonly date: string
  readonly country: string
  readonly region: string
  readonly visitors: number
  readonly visits: number
  readonly pageviews: number
  readonly bounces: number
  readonly visit_duration: number
}

export interface StoredImportedDevicesRow extends ImportedRowKey {
  readonly date: string
  readonly device: string
  readonly visitors: number
  readonly visits: number
  readonly pageviews: number
  readonly bounces: number
  readonly visit_duration: number
}

export interface StoredImportedBrowsersRow extends ImportedRowKey {
  readonly date: string
  readonly browser: string
  readonly browser_version: string
  readonly visitors: number
  readonly visits: number
  readonly pageviews: number
  readonly bounces: number
  readonly visit_duration: number
}

export interface StoredImportedOsRow extends ImportedRowKey {
  readonly date: string
  readonly operating_system: string
  readonly os_version: string
  readonly visitors: number
  readonly visits: number
  readonly pageviews: number
  readonly bounces: number
  readonly visit_duration: number
}

export interface StoredImportedCustomEventsRow extends ImportedRowKey {
  readonly date: string
  readonly name: string
  readonly link_url: string
  readonly path: string
  readonly visitors: number
  readonly events: number
}

export interface StoredImportedRowByReport {
  readonly metrics: StoredImportedMetricsRow
  readonly pages: StoredImportedPagesRow
  readonly sources: StoredImportedSourcesRow
  readonly geography: StoredImportedGeographyRow
  readonly devices: StoredImportedDevicesRow
  readonly browsers: StoredImportedBrowsersRow
  readonly os: StoredImportedOsRow
  readonly custom_events: StoredImportedCustomEventsRow
}
export type StoredImportedRow<R extends ImportedReport = ImportedReport> =
  StoredImportedRowByReport[R]

/**
 * Normalized adapter row → stored row.
 *
 * A explicit per-report mapping rather than a generic key rename, because the
 * column names are the migration's and a rename helper would let a typo in a
 * dimension name become a silently absent column that ClickHouse fills with the
 * type default. Every field below is checked by the compiler against the
 * `Stored*` interface, which is checked by the CH-gated suite against the real
 * table.
 */
export function toStoredImportedRow<R extends ImportedReport>(
  report: R,
  key: ImportedRowKey,
  row: ImportedRow<R>,
): StoredImportedRow<R> {
  // The per-report narrowing is done through an unknown-typed local rather than
  // with a cast per branch: the `report` discriminant and the `row` parameter are
  // correlated generics, which TypeScript cannot narrow together.
  const source = row as ImportedRow
  switch (report) {
    case 'metrics': {
      const r = source as ImportedRow<'metrics'>
      return {
        ...key,
        date: r.date,
        visitors: r.visitors,
        visits: r.visits,
        pageviews: r.pageviews,
        bounces: r.bounces,
        visit_duration: r.visitDuration,
      } as StoredImportedRow<R>
    }
    case 'pages': {
      const r = source as ImportedRow<'pages'>
      return {
        ...key,
        date: r.date,
        hostname: r.hostname,
        page: r.page,
        visitors: r.visitors,
        visits: r.visits,
        pageviews: r.pageviews,
      } as StoredImportedRow<R>
    }
    case 'sources': {
      const r = source as ImportedRow<'sources'>
      return {
        ...key,
        date: r.date,
        source: r.source,
        referrer: r.referrer,
        utm_source: r.utmSource,
        utm_medium: r.utmMedium,
        utm_campaign: r.utmCampaign,
        utm_content: r.utmContent,
        utm_term: r.utmTerm,
        visitors: r.visitors,
        visits: r.visits,
        pageviews: r.pageviews,
        bounces: r.bounces,
        visit_duration: r.visitDuration,
      } as StoredImportedRow<R>
    }
    case 'geography': {
      const r = source as ImportedRow<'geography'>
      return {
        ...key,
        date: r.date,
        country: r.country,
        region: r.region,
        visitors: r.visitors,
        visits: r.visits,
        pageviews: r.pageviews,
        bounces: r.bounces,
        visit_duration: r.visitDuration,
      } as StoredImportedRow<R>
    }
    case 'devices': {
      const r = source as ImportedRow<'devices'>
      return {
        ...key,
        date: r.date,
        device: r.device,
        visitors: r.visitors,
        visits: r.visits,
        pageviews: r.pageviews,
        bounces: r.bounces,
        visit_duration: r.visitDuration,
      } as StoredImportedRow<R>
    }
    case 'browsers': {
      const r = source as ImportedRow<'browsers'>
      return {
        ...key,
        date: r.date,
        browser: r.browser,
        browser_version: r.browserVersion,
        visitors: r.visitors,
        visits: r.visits,
        pageviews: r.pageviews,
        bounces: r.bounces,
        visit_duration: r.visitDuration,
      } as StoredImportedRow<R>
    }
    case 'os': {
      const r = source as ImportedRow<'os'>
      return {
        ...key,
        date: r.date,
        operating_system: r.operatingSystem,
        os_version: r.osVersion,
        visitors: r.visitors,
        visits: r.visits,
        pageviews: r.pageviews,
        bounces: r.bounces,
        visit_duration: r.visitDuration,
      } as StoredImportedRow<R>
    }
    default: {
      const r = source as ImportedRow<'custom_events'>
      return {
        ...key,
        date: r.date,
        name: r.name,
        link_url: r.linkUrl,
        path: r.path,
        visitors: r.visitors,
        events: r.events,
      } as StoredImportedRow<R>
    }
  }
}

// --- The writer --------------------------------------------------------------

export interface InsertImportedRowsResult {
  readonly rows: number
  readonly durationMs: number
}

export interface InsertImportedRowsInput<R extends ImportedReport = ImportedReport> {
  readonly report: R
  readonly rows: readonly StoredImportedRow<R>[]
  /**
   * `{run_id}:{report}:{chunk_no}` (D7), and it is the whole retry guarantee.
   *
   * Passed explicitly rather than derived here for the reason the chunk size is
   * recorded on the run row: the token has to name the same *rows* on every
   * attempt, and a value this module computed from its own defaults would change
   * meaning the day a policy default was retuned mid-run.
   */
  readonly insertDeduplicationToken: string
}

/** The narrow insert surface, so a test can drive the whole staging path with a
 * fake and so nothing here can reach for a `query` or a `command` it has no
 * credential for. `ClickHouseClient` satisfies it structurally. */
export interface ImportedAggregatesInsertClient {
  insert(input: {
    table: string
    values: readonly unknown[]
    format: 'JSONEachRow'
    clickhouse_settings?: {
      insert_deduplication_token: string
      max_partitions_per_insert_block: string
    }
  }): Promise<unknown>
}

/**
 * Lift the per-insert partition cap for staged imports.
 *
 * ClickHouse refuses an INSERT block that touches more than
 * `max_partitions_per_insert_block` partitions — **100 by default** — with
 * `TOO_MANY_PARTS`. These tables are partitioned monthly, so the limit is
 * "a single insert may not span more than 100 months", and a chunk of a
 * multi-year provider export routinely does: eight years of daily rows is 96
 * partitions and a ten-year history is 120. That is not an edge case, it is the
 * ordinary shape of a history import, and it would fail the run outright.
 *
 * `0` means unlimited, and it is set **per insert** rather than on the
 * connection so that the guarantee travels with this function — any client
 * handed to it, including a future one built elsewhere, inserts under the same
 * rule.
 *
 * Raising it does not make the insert unbounded: the chunk is already bounded by
 * `staging_chunk_bytes`, and what the cap protects against — thousands of tiny
 * parts from one statement — is bounded here by the number of *months* a bounded
 * number of bytes can cover. It does change the deduplication arithmetic, and
 * the sizing note in ClickHouse migration 0015 states how.
 */
const UNLIMITED_PARTITIONS_PER_BLOCK = '0'

/**
 * Insert one chunk of one report under a stable deduplication token.
 *
 * The error handling mirrors `insertEvents` exactly, and the reason is the same:
 * a timeout is not a failure, it is an *unknown*, and treating one as a clean
 * failure would eventually re-insert the chunk under a token the server has
 * already seen — which is fine — or, worse, let a caller decide the chunk never
 * landed and skip recording its progress, which would re-do it forever.
 */
export async function insertImportedRows<R extends ImportedReport>(
  client: ImportedAggregatesInsertClient,
  input: InsertImportedRowsInput<R>,
): Promise<InsertImportedRowsResult> {
  if (input.rows.length === 0) {
    // An empty insert still consumes a deduplication token, which would make the
    // token stop recognising the real chunk that follows it.
    throw new ImportedInsertError('Refusing to insert an empty chunk', {
      ambiguous: false,
      code: 'EMPTY_CHUNK',
    })
  }

  const startedAt = Date.now()
  try {
    await client.insert({
      table: IMPORTED_REPORT_TABLES[input.report],
      values: input.rows,
      format: 'JSONEachRow',
      clickhouse_settings: {
        insert_deduplication_token: input.insertDeduplicationToken,
        max_partitions_per_insert_block: UNLIMITED_PARTITIONS_PER_BLOCK,
      },
    })
  } catch (error) {
    const ambiguous = isAmbiguousImportedInsertFailure(error)
    throw new ImportedInsertError(
      ambiguous
        ? 'ClickHouse insert outcome is unknown, the chunk may have been written'
        : 'ClickHouse insert failed before execution',
      { ambiguous, code: importedErrorCode(error), cause: error },
    )
  }

  return { rows: input.rows.length, durationMs: Date.now() - startedAt }
}

export class ImportedInsertError extends Error {
  readonly ambiguous: boolean
  readonly code: string

  constructor(message: string, options: { ambiguous: boolean; code: string; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ImportedInsertError'
    this.ambiguous = options.ambiguous
    this.code = options.code
  }
}

/** Errors that prove the request never reached execution — an allowlist, for the
 * reason `isAmbiguousInsertFailure` gives: a wrong "definitely failed" costs
 * duplicated data and a wrong "unknown" costs one retry that deduplicates. */
const DEFINITE_FAILURE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
])

const DEFINITE_SERVER_ERROR_CODES = new Set([
  '47', // UNKNOWN_IDENTIFIER
  '60', // UNKNOWN_TABLE
  '62', // SYNTAX_ERROR
  '81', // UNKNOWN_DATABASE
  '497', // ACCESS_DENIED
  // TOO_MANY_PARTS. Two conditions raise it and both reject the statement before
  // anything is written, which is what makes it *definite* rather than ambiguous:
  // a block spanning more partitions than `max_partitions_per_insert_block`
  // allows (which the insert above lifts, so this should be unreachable — unless
  // a deployment pins the setting server-side), and a destination table whose
  // active parts have outrun its merges. The second is transient, and classifying
  // it definite is what makes the retry safe: the rows are known not to be there,
  // so re-inserting under the same token is correct either way.
  '252',
])

function importedErrorCode(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') return code
    if (typeof code === 'number') return String(code)
  }
  return 'unknown'
}

export function isAmbiguousImportedInsertFailure(error: unknown): boolean {
  const code = importedErrorCode(error)
  if (DEFINITE_FAILURE_CODES.has(code)) return false
  if (DEFINITE_SERVER_ERROR_CODES.has(code)) return false
  return true
}

export interface ImportedAggregatesWriter {
  insertRows<R extends ImportedReport>(
    input: InsertImportedRowsInput<R>,
  ): Promise<InsertImportedRowsResult>
  ping(): Promise<boolean>
  close(): Promise<void>
}

export interface ImportedAggregatesWriterOptions {
  readonly url: string
  readonly username: string
  readonly password: string
  readonly database: string
  readonly requestTimeoutMs?: number
}

export const DEFAULT_IMPORT_INSERT_TIMEOUT_MS = 60_000

export function createImportedAggregatesWriter(
  options: ImportedAggregatesWriterOptions,
): ImportedAggregatesWriter {
  const client: ClickHouseClient = createClient({
    url: options.url,
    username: options.username,
    password: options.password,
    database: options.database,
    request_timeout: options.requestTimeoutMs ?? DEFAULT_IMPORT_INSERT_TIMEOUT_MS,
    clickhouse_settings: {
      // Synchronous, for the reason D-209 step 4 gives on the live path: an async
      // insert acknowledges before the block is durable, and the run's chunk
      // progress would then record a chunk ClickHouse had not committed.
      async_insert: 0,
      wait_for_async_insert: 1,
    },
  })

  return {
    async insertRows(input) {
      return await insertImportedRows(client, input)
    },
    async ping() {
      const result = await client.ping()
      return result.success
    },
    async close() {
      await client.close()
    },
  }
}

// --- Per-run cleanup ---------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class InvalidImportKeyError extends Error {
  constructor(field: string, value: string) {
    super(`Invalid ${field} for a ClickHouse import statement: ${JSON.stringify(value)}`)
    this.name = 'InvalidImportKeyError'
  }
}

/**
 * The interpolation guard, and it is doing real work here.
 *
 * `ALTER TABLE ... DELETE` takes no query parameters in a version-portable way —
 * the site-deletion purge documents the same constraint — so both ids are
 * literals in the statement text. Both are UUIDs on every path that reaches
 * here, so refusing anything else costs nothing and closes the only injection
 * surface this module has.
 */
function assertUuid(field: string, value: string): string {
  if (!UUID.test(value)) throw new InvalidImportKeyError(field, value)
  return value
}

export interface ImportRunRowsKey {
  readonly siteId: string
  readonly importRunId: string
}

export interface DeleteImportRunRowsResult {
  /** Tables a delete was submitted against. Always all eight — a table with no
   * rows for the run is a free mutation, and skipping one would need a count per
   * table first, which is more work than the delete it would save. */
  readonly tables: number
}

/** The maintenance surface: `ALTER DELETE` and a verification count, nothing
 * else. Narrow for the reason `RedisPurgeClient` is narrow — what a component
 * cannot name, it cannot accidentally do. */
export interface ImportedAggregatesMaintenance {
  /**
   * Delete every staged row of one run, across all eight tables.
   *
   * Used on three paths, and it has to be idempotent on all of them: the prepare
   * job's failure cleanup, the publish job's grandparent cleanup, and the
   * sweeper's backstop. Re-running it submits mutations over part sets a
   * previous run already emptied — wasted work, never a wrong result.
   */
  deleteImportRunRows(key: ImportRunRowsKey): Promise<DeleteImportRunRowsResult>
  /** Rows still present for the run, summed across the eight tables. The
   * verification statement, and what the CH-gated suite asserts against. */
  countImportRunRows(key: ImportRunRowsKey): Promise<number>
  ping(): Promise<boolean>
  close(): Promise<void>
}

export interface ImportedAggregatesMaintenanceOptions {
  readonly url: string
  readonly username: string
  readonly password: string
  readonly database: string
  readonly requestTimeoutMs?: number
}

export const DEFAULT_IMPORT_CLEANUP_TIMEOUT_MS = 60_000

export function createImportedAggregatesMaintenance(
  options: ImportedAggregatesMaintenanceOptions,
): ImportedAggregatesMaintenance {
  const client: ClickHouseClient = createClient({
    url: options.url,
    username: options.username,
    password: options.password,
    database: options.database,
    request_timeout: options.requestTimeoutMs ?? DEFAULT_IMPORT_CLEANUP_TIMEOUT_MS,
    clickhouse_settings: {
      // **Synchronous, unlike the site-deletion purge**, and the difference is
      // the size of the work. A site purge rewrites the parts of a customer's
      // whole history, which is why it registers the mutation and polls
      // `system.mutations` rather than holding a job lease for it. A run cleanup
      // touches one run's staged rows in one recently written part set, so
      // waiting is bounded — and waiting is what makes the cleanup *observable*:
      // the caller learns whether the rows are gone instead of learning that a
      // mutation was accepted. Every caller treats it as best-effort with the
      // sweeper as backstop, so a timeout here costs a retry, never correctness.
      mutations_sync: '1',
    },
  })

  return {
    async deleteImportRunRows(key) {
      const siteId = assertUuid('site_id', key.siteId)
      const importRunId = assertUuid('import_run_id', key.importRunId)
      for (const table of IMPORTED_AGGREGATE_TABLE_LIST) {
        await client.command({
          query: `ALTER TABLE ${table} DELETE WHERE site_id = '${siteId}' AND import_run_id = '${importRunId}'`,
          clickhouse_settings: { mutations_sync: '1' },
        })
      }
      return { tables: IMPORTED_AGGREGATE_TABLE_LIST.length }
    },

    async countImportRunRows(key) {
      const siteId = assertUuid('site_id', key.siteId)
      const importRunId = assertUuid('import_run_id', key.importRunId)
      // One statement over all eight tables rather than eight round trips. The
      // ids are bound as parameters here because a SELECT can bind them, unlike
      // the ALTER above.
      const union = IMPORTED_AGGREGATE_TABLE_LIST.map(
        (table) =>
          `SELECT count() AS rows FROM ${table} WHERE site_id = {siteId:UUID} AND import_run_id = {runId:UUID}`,
      ).join(' UNION ALL ')
      const resultSet = await client.query({
        query: `SELECT sum(rows) AS rows FROM (${union})`,
        query_params: { siteId, runId: importRunId },
        format: 'JSONEachRow',
      })
      const rows = await resultSet.json<{ rows: string | number }>()
      return Number(rows[0]?.rows ?? 0)
    },

    async ping() {
      const result = await client.ping()
      return result.success
    },

    async close() {
      await client.close()
    },
  }
}
