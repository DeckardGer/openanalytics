import { createClient, type ClickHouseClient } from '@clickhouse/client'
import { IMPORTED_REPORT_TABLES, type ImportedReport } from '@openanalytics/domain'
import { EVENTS_RAW_TABLE, toClickHouseDateTime64 } from './events-raw.ts'

/**
 * The export read path (ADR-0032, D8).
 *
 * It runs in the **worker**, never in the api: the api reaches analytics only
 * through the signed query gateway (D-208), and an export is not a dashboard
 * read — it is a bulk scan of a customer's whole history that would blow past
 * every row cap the gateway's operation registry exists to enforce.
 *
 * ## Streaming, not paging
 *
 * Every other ClickHouse surface in this repository buffers: `maintenance`,
 * `session-facts` and `imported-aggregates` all call `resultSet.json()`, which
 * is right for an aggregate of a few thousand rows and catastrophic for a site's
 * entire `events_raw`. This module is the one place that uses
 * `resultSet.stream()`, and that choice removes a whole class of problem rather
 * than merely bounding it: a keyset or `OFFSET` pager would need a total order
 * on every table it reads, and the imported aggregates have no unique key — two
 * rows with the same dimensions and the same day are legitimately
 * indistinguishable, so an `OFFSET` page boundary landing between them could
 * skip or repeat one. A single ordered stream never asks the question.
 *
 * Memory is bounded by the consumer instead: the executor accumulates NDJSON up
 * to `EXPORT_MAX_CHUNK_BYTES`, flushes an object, and the stream's own
 * backpressure holds the rest.
 *
 * ## Two settings, both load-bearing
 *
 * - `date_time_output_format: 'iso'` — without it ClickHouse serializes
 *   `DateTime64` as `2026-07-29 10:00:00.000`, a local-looking wall clock with
 *   no zone. Every instant in this schema is UTC, and an export whose
 *   timestamps had to be *documented* as UTC rather than *stated* as UTC is an
 *   export somebody will parse in their own zone.
 * - `output_format_json_quote_64bit_integers: 0` — the imported aggregates are
 *   `UInt64` and would otherwise arrive as JSON strings while `events_raw`
 *   (whose widest integer is `UInt32`) arrived as numbers. One encoding across
 *   the export is worth more than exactness at a magnitude no column here can
 *   reach; the manifest states the `2^53` caveat rather than hiding it.
 */

/** 5 minutes. A month of a large site's events is a long scan, and the timeout
 * that matters is the one that distinguishes "still streaming" from "ClickHouse
 * has stopped answering" — not one tuned for an aggregate. */
export const DEFAULT_EXPORT_REQUEST_TIMEOUT_MS = 300_000

/**
 * The event columns an export carries — the **contract** shape (D8).
 *
 * This list is the decision, so it is written out rather than derived from
 * `EventsRawRow`: a column added to the pipeline must not join a customer's
 * export because a type widened. What is here is what the collector accepted and
 * the server stamped about the *event*; what is deliberately absent is what the
 * pipeline stamped about its own bookkeeping:
 *
 * - `batch_id` — which manifest wrote the row. An internal handle for usage
 *   reconciliation; it names nothing a customer has.
 * - `ingest_generation` — the deletion fence's generation (D-210). Internal.
 * - `billing_user_id`, `billing_assignment_version`, `usage_window_start`,
 *   `billing_grace`, `billable` — the billing snapshot the collector attached.
 *   D8 says no billing internals, and `billing_user_id` is additionally another
 *   *person's* id: the payer of a site is not necessarily a member of it, and an
 *   export any admin can request must not hand out that link.
 *
 * `site_id` stays, because it is the customer's own id and an export of several
 * sites concatenated by the customer would otherwise be unattributable.
 * `properties` stays as the stored JSON **text**: re-parsing it here would add a
 * way for the export to fail on a row the pipeline already accepted, and the
 * bytes as stored are the most faithful thing we can hand over.
 */
export const EXPORT_EVENT_COLUMNS = [
  'schema_version',
  'site_id',
  'event_id',
  'type',
  'name',
  'origin',
  'occurred_at',
  'received_at',
  'accepted_at',
  'clock_skewed',
  'anonymous_id',
  'session_id',
  'user_id',
  'page_url',
  'page_path',
  'page_title',
  'referrer_domain',
  'referrer_path',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'properties',
  'sdk',
  'sdk_version',
  'device_type',
  'browser',
  'os',
  'country',
  'city',
] as const

export type ExportEventColumn = (typeof EXPORT_EVENT_COLUMNS)[number]
export type ExportRow = Record<string, unknown>

/**
 * A failure of the export read path.
 *
 * Its own class so the executor can tell "ClickHouse is unreachable" — an
 * infrastructure retry that must not fail the customer's export — from a bug in
 * the export code, which should reach the runner's attempt guard as a throw.
 */
export class ExportReadError extends Error {
  override readonly cause: unknown

  constructor(message: string, cause: unknown) {
    super(message)
    this.name = 'ExportReadError'
    this.cause = cause
  }
}

export interface ExportReader {
  /**
   * The UTC calendar months (`YYYY-MM`) the site has events in, up to the
   * cutoff, oldest first.
   *
   * The chunk plan, and it is **stable across attempts** — which is the property
   * the whole resume design rests on. It can be: an event accepted after the
   * export started carries `accepted_at > cutoff` and is therefore outside every
   * query this reader issues, so no attempt can discover a month a previous one
   * did not.
   */
  eventMonths(input: { siteId: string; cutoff: Date }): Promise<string[]>
  /** One month of events, contract-shaped, in sort-key order. */
  streamEvents(input: { siteId: string; cutoff: Date; month: string }): AsyncIterable<ExportRow>
  /**
   * One imported report of the pinned run, in full.
   *
   * Every column, including the dimensions the dashboard read path drops
   * (`hostname`, `region`, `utm_content`, `utm_term`, `link_url`, `path`): the
   * export is lossless where the read path is not, and a customer migrating away
   * should get back everything their previous provider gave us.
   */
  streamImported(input: {
    siteId: string
    importRunId: string
    report: ImportedReport
  }): AsyncIterable<ExportRow>
  ping(): Promise<boolean>
  close(): Promise<void>
}

export interface ExportReaderOptions {
  readonly url: string
  readonly database: string
  readonly username: string
  readonly password: string
  readonly requestTimeoutMs?: number
}

/**
 * `YYYY-MM` ⇄ the `toYYYYMM` integer ClickHouse partitions by.
 *
 * The partition expression is what makes a month bound a partition prune rather
 * than a full scan, so the filter is written against it directly instead of
 * against a date range that the optimiser would have to recognise.
 */
function monthToPartition(month: string): number {
  const match = /^(\d{4})-(\d{2})$/.exec(month)
  if (!match) throw new RangeError(`Invalid export month: ${JSON.stringify(month)}`)
  return Number(match[1]) * 100 + Number(match[2])
}

function partitionToMonth(value: number): string {
  const year = Math.floor(value / 100)
  const month = value % 100
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`
}

export function createExportReader(options: ExportReaderOptions): ExportReader {
  const client: ClickHouseClient = createClient({
    url: options.url,
    username: options.username,
    password: options.password,
    database: options.database,
    request_timeout: options.requestTimeoutMs ?? DEFAULT_EXPORT_REQUEST_TIMEOUT_MS,
    clickhouse_settings: {
      // See the header: one integer encoding and one instant format across the
      // whole export, declared in the manifest rather than discovered by the
      // customer.
      date_time_output_format: 'iso',
      output_format_json_quote_64bit_integers: 0,
    },
  })

  /** Rows of one query, streamed. Wrapped so every caller reports the same
   * classified failure — the executor's retry decision is made on the class, and
   * a raw driver error reaching it would be counted as a bug instead. */
  async function* stream(sql: string, params: Record<string, unknown>): AsyncIterable<ExportRow> {
    let resultSet
    try {
      resultSet = await client.query({ query: sql, query_params: params, format: 'JSONEachRow' })
    } catch (error) {
      throw new ExportReadError('export read failed to start', error)
    }
    try {
      for await (const rows of resultSet.stream<ExportRow>()) {
        for (const row of rows) yield row.json()
      }
    } catch (error) {
      throw new ExportReadError('export read failed mid-stream', error)
    }
  }

  return {
    async eventMonths(input): Promise<string[]> {
      try {
        const resultSet = await client.query({
          query: `SELECT DISTINCT toYYYYMM(occurred_at) AS month
                    FROM ${EVENTS_RAW_TABLE}
                   WHERE site_id = {siteId:UUID}
                     AND accepted_at <= {cutoff:DateTime64(3, 'UTC')}
                   ORDER BY month`,
          query_params: {
            siteId: input.siteId,
            cutoff: toClickHouseDateTime64(input.cutoff.toISOString()),
          },
          format: 'JSONEachRow',
        })
        const rows = await resultSet.json<{ month: number | string }>()
        return rows.map((row) => partitionToMonth(Number(row.month)))
      } catch (error) {
        throw new ExportReadError('export month enumeration failed', error)
      }
    },

    streamEvents(input): AsyncIterable<ExportRow> {
      // `site_id` and `accepted_at` are bound on this query and on nothing else
      // is the export's whole isolation argument (plan-04: "export returns no
      // other site's data"). Both are parameters, never interpolation.
      //
      // ORDER BY is the table's own sort key minus the site — `(site_id,
      // occurred_at, event_id)` — so the stream is a merge over already-sorted
      // parts rather than a sort, and the order is total: `event_id` closes it
      // for two events of the same millisecond.
      return stream(
        `SELECT ${EXPORT_EVENT_COLUMNS.join(', ')}
           FROM ${EVENTS_RAW_TABLE}
          WHERE site_id = {siteId:UUID}
            AND accepted_at <= {cutoff:DateTime64(3, 'UTC')}
            AND toYYYYMM(occurred_at) = {month:UInt32}
          ORDER BY occurred_at, event_id`,
        {
          siteId: input.siteId,
          cutoff: toClickHouseDateTime64(input.cutoff.toISOString()),
          month: monthToPartition(input.month),
        },
      )
    },

    streamImported(input): AsyncIterable<ExportRow> {
      // The table name comes from the domain's report → table map and never from
      // input, so there is nothing customer-supplied in the interpolated half.
      const table = IMPORTED_REPORT_TABLES[input.report]
      // Bound by BOTH the site and the pinned run. The run alone would be
      // enough — staged rows carry one site — but binding the site as well means
      // the isolation argument is identical on every query this module issues,
      // rather than being "identical except for the imported ones".
      //
      // `date` is the leading dimension of every imported sort key after the
      // run, so ordering by it is free and gives the file a readable shape. It
      // is deliberately not claimed to be a *total* order: an imported report
      // has no unique key, and nothing here needs one because the stream is read
      // once, start to finish.
      return stream(
        `SELECT *
           FROM ${table}
          WHERE site_id = {siteId:UUID}
            AND import_run_id = {importRunId:UUID}
          ORDER BY date`,
        { siteId: input.siteId, importRunId: input.importRunId },
      )
    },

    async ping(): Promise<boolean> {
      const result = await client.ping()
      return result.success
    },

    async close(): Promise<void> {
      await client.close()
    },
  }
}
