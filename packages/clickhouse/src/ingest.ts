import { createClient, type ClickHouseClient } from '@clickhouse/client'
import { EVENTS_RAW_TABLE, type EventsRawRow } from './events-raw.ts'

/**
 * The worker's insert path (docs snapshot 02 §7.5; 05 D-209 step 4).
 *
 * The only component that writes analytics, using the INSERT-scoped credential
 * ADR-0005 declares. Three properties this module exists to hold:
 *
 * 1. **Synchronous.** `async_insert=0`, `wait_for_async_insert=1`. An async
 *    insert acknowledges before the data is durable, which breaks at-least-once
 *    at the exact boundary the manifest is protecting: the worker would ACK the
 *    queue for rows ClickHouse had not yet committed.
 * 2. **A stable token.** The manifest's deterministic `batch_id` is the
 *    `insert_deduplication_token`, so a retry after an ambiguous failure is a
 *    no-op per destination table — and completes whichever dependent view did
 *    not finish (ADR-0005).
 * 3. **Ambiguity is reported, not guessed.** A timeout is not a failure; it is
 *    an unknown. The distinction decides whether the manifest may go back to
 *    `pending` (nothing landed) or must stay in `inserting` (something may
 *    have), and getting it wrong is how a batch gets inserted twice under two
 *    different tokens.
 */

/** The insert either committed, or its outcome is unknown, or it definitely failed. */
export class ClickHouseInsertError extends Error {
  /**
   * True when the request may have been executed by the server.
   *
   * A socket timeout, an aborted request or a dropped connection all leave the
   * server free to have committed the block after the client stopped listening.
   * Treating one of those as a clean failure and retrying under a *new* token
   * would insert the rows a second time.
   */
  readonly ambiguous: boolean
  readonly code: string

  constructor(message: string, options: { ambiguous: boolean; code: string; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ClickHouseInsertError'
    this.ambiguous = options.ambiguous
    this.code = options.code
  }
}

/**
 * Errors that prove the request never reached execution.
 *
 * Deliberately a short allowlist rather than a denylist of ambiguous cases: an
 * unrecognised error is treated as ambiguous, because the cost of a wrong
 * "definitely failed" is duplicated data and the cost of a wrong "unknown" is
 * one retry that deduplicates.
 */
const DEFINITE_FAILURE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
])

/** ClickHouse server error codes that mean the statement was rejected outright. */
const DEFINITE_SERVER_ERROR_CODES = new Set([
  '47', // UNKNOWN_IDENTIFIER
  '60', // UNKNOWN_TABLE
  '62', // SYNTAX_ERROR
  '81', // UNKNOWN_DATABASE
  '497', // ACCESS_DENIED
])

function errorCodeOf(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') return code
    if (typeof code === 'number') return String(code)
  }
  return 'unknown'
}

export function isAmbiguousInsertFailure(error: unknown): boolean {
  const code = errorCodeOf(error)
  if (DEFINITE_FAILURE_CODES.has(code)) return false
  if (DEFINITE_SERVER_ERROR_CODES.has(code)) return false
  return true
}

export interface InsertEventsResult {
  readonly rows: number
  readonly durationMs: number
}

export interface EventsIngest {
  /**
   * Inserts a batch under a stable deduplication token.
   *
   * Resolves only after ClickHouse has confirmed the write. Rejects with a
   * `ClickHouseInsertError` whose `ambiguous` flag tells the caller whether the
   * rows may nevertheless be there.
   */
  insertEvents(
    rows: readonly EventsRawRow[],
    options: { readonly token: string },
  ): Promise<InsertEventsResult>
  /**
   * Billable row counts per batch, for the reconciliation job (plan Milestone 6
   * item 11).
   *
   * A read on the ingest credential, which ADR-0005 already had to widen to
   * `SELECT ON analytics.*` because ClickHouse checks the inserting user's
   * SELECT privilege on a materialized view's source table. Given that grant
   * exists, the alternative was a second credential and a second connection for
   * one aggregate over a table this process just wrote — so this reuses it, and
   * the scope of the query is what keeps it honest: counts by batch id, no row
   * contents, no site scan.
   */
  countBillableByBatch(batchIds: readonly string[]): Promise<Map<string, number>>
  ping(): Promise<boolean>
  close(): Promise<void>
}

export interface EventsIngestOptions {
  readonly url: string
  readonly username: string
  readonly password: string
  readonly database: string
  /**
   * Request timeout. Below any sensible server-side limit so the worker gives up
   * first and the failure is a timeout it can classify, rather than a connection
   * the server closes at a moment the client cannot interpret.
   */
  readonly requestTimeoutMs?: number
  readonly table?: string
}

export const DEFAULT_INSERT_TIMEOUT_MS = 30_000

export function createEventsIngest(options: EventsIngestOptions): EventsIngest {
  const table = options.table ?? EVENTS_RAW_TABLE
  const client: ClickHouseClient = createClient({
    url: options.url,
    username: options.username,
    password: options.password,
    database: options.database,
    request_timeout: options.requestTimeoutMs ?? DEFAULT_INSERT_TIMEOUT_MS,
    clickhouse_settings: {
      // D-209 step 4 requires a synchronous insert. Set on the connection rather
      // than per call so no future insert path can quietly omit it.
      async_insert: 0,
      wait_for_async_insert: 1,
    },
  })

  /** One insert, against one destination table, under one token. */
  const insertInto = async (
    destination: string,
    rows: readonly object[],
    token: string,
  ): Promise<InsertEventsResult> => {
    if (rows.length === 0) {
      // An empty insert would still consume a deduplication token, which would
      // make the token stop recognising the real batch that follows it.
      throw new ClickHouseInsertError('Refusing to insert an empty batch', {
        ambiguous: false,
        code: 'EMPTY_BATCH',
      })
    }

    const startedAt = Date.now()
    try {
      await client.insert({
        table: destination,
        values: rows,
        format: 'JSONEachRow',
        clickhouse_settings: { insert_deduplication_token: token },
      })
    } catch (error) {
      const ambiguous = isAmbiguousInsertFailure(error)
      throw new ClickHouseInsertError(
        ambiguous
          ? 'ClickHouse insert outcome is unknown; the rows may have been written'
          : 'ClickHouse insert failed before execution',
        { ambiguous, code: errorCodeOf(error), cause: error },
      )
    }

    return { rows: rows.length, durationMs: Date.now() - startedAt }
  }

  return {
    async insertEvents(rows, { token }): Promise<InsertEventsResult> {
      return insertInto(table, rows, token)
    },

    async countBillableByBatch(batchIds: readonly string[]): Promise<Map<string, number>> {
      const counts = new Map<string, number>()
      if (batchIds.length === 0) return counts

      const resultSet = await client.query({
        query: `
          SELECT batch_id, countIf(billable = 1) AS billable, count() AS rows
          FROM ${table}
          WHERE batch_id IN {batchIds:Array(String)}
          GROUP BY batch_id
        `,
        query_params: { batchIds: [...batchIds] },
        format: 'JSONEachRow',
      })

      for (const row of await resultSet.json<{ batch_id: string; billable: string }>()) {
        counts.set(row.batch_id, Number(row.billable))
      }
      return counts
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
