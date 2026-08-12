import { createHash } from 'node:crypto'
import { createClient, type ClickHouseClient } from '@clickhouse/client'

/**
 * The canonical revenue fact's ClickHouse surface (ADR-0033, D5; migration
 * 0016). Milestone 12 Checkpoint 3.
 *
 * Two things live here and nothing else: the typed row shape the worker's
 * projection loop builds, and the two statements that write and read it. Every
 * decision about *what* a row contains — conversion, hashing, which head is due
 * — belongs to the worker, because those need Postgres and a secret this package
 * has no business holding.
 *
 * ## Written by the worker, never by the api
 *
 * `analytics.revenue_events` is a ClickHouse table, so by the standing rule
 * (AGENTS.md, D-208) the api cannot reach it: the api holds no ClickHouse
 * credential at all and reads analytics only through the signed query gateway.
 * The projection loop runs in the worker on the `oa_ingest` credential, which is
 * granted `INSERT` and `SELECT` on this table by the ClickHouse entrypoint XML
 * the deployment ships — the grant is a container recreate, not a SQL `GRANT`,
 * and CP7's deploy has to perform it before the loop can write.
 *
 * ## The insert is synchronous and content-deduplicated
 *
 * Both settings are the session-facts pattern and both are load-bearing:
 *
 * - `async_insert = 0` / `wait_for_async_insert = 1`, because the loop advances
 *   `revenue_objects.projected_version` **after** the insert resolves. An async
 *   insert acknowledges before the block is durable, so the marker would move
 *   past rows ClickHouse had not committed — and unlike a watermark, a marker
 *   never comes back.
 * - `insert_deduplication_token` derived from the rows themselves. A crash
 *   between the insert and the marker re-projects the same heads, which rebuilds
 *   byte-identical rows, which hashes to the same token, which ClickHouse drops.
 *   That is what makes the insert-then-mark ordering safe rather than merely
 *   likely to be safe.
 *
 *   **It rests entirely on the row builder having no clock in it.** The row is a
 *   pure function of `(head, reporting currency, rate plan, hint)`, and
 *   `ingested_at` is `revenue_objects.updated_at` — stable per `(head, version)`
 *   — rather than the projecting tick's time. A clock there would make the
 *   replay build a different row, hash to a different token, and be written as a
 *   second fact at the same version, which is exactly the duplicate the token
 *   exists to prevent.
 *
 *   It also only works because migration 0016 sets
 *   `non_replicated_deduplication_window`; without it the token is accepted and
 *   silently ignored (ADR-0005 measured a 3x from exactly that).
 *
 * ## The read rule is argMax, never FINAL
 *
 * `readCurrentRevenueEvents` exists so CP4's matcher and CP5's rollup have one
 * implementation of the current-truth read rather than two. ReplacingMergeTree's
 * merge is a space reclamation, not a correctness mechanism, so the current
 * version is selected explicitly with `argMax(col, version) GROUP BY key` — and
 * every filter on a *value* column is applied after that grouping, never before,
 * or a superseded version is resurrected. Aggregated columns are qualified
 * through the table alias, because CI's ClickHouse resolves a bare name an alias
 * shadows to the alias and throws ILLEGAL_AGGREGATION.
 */

export const REVENUE_EVENTS_TABLE = 'revenue_events'

/**
 * One row of `analytics.revenue_events` — one version of one money object.
 *
 * snake_case because these are the migration's column names, sent as
 * `JSONEachRow`. Numbers rather than bigints: every amount is an `Int64` in
 * minor units and every version a `UInt64`, both far inside `2^53` for any real
 * account, and the projection is where the values are decided anyway.
 */
export interface RevenueEventRow {
  readonly site_id: string
  readonly provider: string
  readonly object_id: string
  readonly object_kind: string
  /** The Postgres-minted monotonic version. The engine's replacing column. */
  readonly version: number
  /** `YYYY-MM-DD HH:MM:SS.mmm`, UTC. */
  readonly occurred_at: string
  readonly status: string
  readonly livemode: number
  /** Lowercase ISO-4217, the original currency, untouched. */
  readonly currency: string
  /** Magnitudes. The sign is a function of `object_kind`, applied at read (D2d). */
  readonly gross_minor: number
  /** In `fee_currency`, which is not always `currency`. */
  readonly fee_minor: number
  /** Lowercase ISO-4217, or `''` when the fee was not readable (0019). */
  readonly fee_currency: string
  readonly net_minor: number
  readonly reporting_currency: string
  /** Zero **and meaningless** when `conversion_source = 'unavailable'`. */
  readonly reporting_gross_minor: number
  readonly reporting_net_minor: number
  /** `ecb | none | unavailable`. */
  readonly conversion_source: string
  /** Diagnostic only. Never recompute an amount from this. */
  readonly conversion_rate: number
  /** `YYYY-MM-DD`. `1970-01-01` when there was no conversion. */
  readonly conversion_rate_date: string
  readonly parent_object_id: string
  readonly order_id: string
  readonly checkout_session_id: string
  readonly client_reference_id: string
  readonly subscription_id: string
  readonly product_id: string
  readonly product_name: string
  /** Site-scoped HMAC under the `revenue_customer` purpose tag. Not joinable
   * against `user_id`, by design. */
  readonly customer_hash: string
  /** The `identify()` derivation, byte for byte. Joins against
   * `events_raw.user_id` — that join is CP4. Empty when nothing identifying was
   * available. */
  readonly external_user_hash: string
  readonly ingested_via: string
  readonly ingested_at: string
}

/** The current (latest-version) fact of one object, as the argMax read returns
 * it. A narrow projection: the columns CP4's matcher and CP5's rollup actually
 * need, rather than every column, so a read that grows is a deliberate edit. */
export interface CurrentRevenueEvent {
  readonly objectId: string
  readonly provider: string
  readonly objectKind: string
  readonly version: number
  readonly occurredAtMs: number
  readonly status: string
  readonly livemode: number
  readonly currency: string
  readonly grossMinor: number
  readonly feeMinor: number
  /** Lowercase ISO-4217, or `''` when the fee was not readable (0019). */
  readonly feeCurrency: string
  readonly netMinor: number
  readonly reportingCurrency: string
  readonly reportingGrossMinor: number
  readonly reportingNetMinor: number
  readonly conversionSource: string
  readonly parentObjectId: string
  readonly orderId: string
  readonly checkoutSessionId: string
  readonly customerHash: string
  readonly externalUserHash: string
}

/**
 * The ordered set of `argMax(col, version)` projections that read a fact's
 * current value.
 *
 * A single constant rather than an inline list per query, for the reason the
 * session facts store gives: a reader that assembled its own set could omit
 * `version` from the grouping or apply a filter before it, and both mistakes
 * return a superseded row while looking entirely reasonable.
 */
const CURRENT_ARGMAX_COLUMNS = `
  max(re.version)                                                 AS version,
  toUnixTimestamp64Milli(argMax(re.occurred_at, re.version))      AS occurred_ms,
  argMax(re.object_kind, re.version)                              AS object_kind,
  argMax(re.status, re.version)                                   AS status,
  argMax(re.livemode, re.version)                                 AS livemode,
  argMax(re.currency, re.version)                                 AS currency,
  argMax(re.gross_minor, re.version)                              AS gross_minor,
  argMax(re.fee_minor, re.version)                                AS fee_minor,
  argMax(re.fee_currency, re.version)                             AS fee_currency,
  argMax(re.net_minor, re.version)                                AS net_minor,
  argMax(re.reporting_currency, re.version)                       AS reporting_currency,
  argMax(re.reporting_gross_minor, re.version)                    AS reporting_gross_minor,
  argMax(re.reporting_net_minor, re.version)                      AS reporting_net_minor,
  argMax(re.conversion_source, re.version)                        AS conversion_source,
  argMax(re.parent_object_id, re.version)                         AS parent_object_id,
  argMax(re.order_id, re.version)                                 AS order_id,
  argMax(re.checkout_session_id, re.version)                      AS checkout_session_id,
  argMax(re.customer_hash, re.version)                            AS customer_hash,
  argMax(re.external_user_hash, re.version)                       AS external_user_hash
`

export interface RevenueEventsStoreOptions {
  readonly url: string
  readonly username: string
  readonly password: string
  readonly database: string
  readonly requestTimeoutMs?: number
  /** Overridable for tests that migrate into a throwaway database. */
  readonly table?: string
}

export const DEFAULT_REVENUE_EVENTS_TIMEOUT_MS = 60_000

export interface RevenueEventsStore {
  /**
   * Insert a batch under a content-derived deduplication token.
   *
   * Returns the token so the caller can log it: when a re-projection writes
   * nothing, the identical token is the evidence that it was deduplicated rather
   * than lost.
   */
  insertRows(rows: readonly RevenueEventRow[]): Promise<{ readonly token: string | null }>
  /**
   * Current facts for a site over a half-open `occurred_at` window.
   *
   * The window filters `occurred_at`, which is part of neither the sort key's
   * tail nor a value that versions change — a money object's occurrence does not
   * move — so filtering it before the grouping is safe and is what keeps the
   * scan inside the right monthly partitions. Any filter on a column a *version*
   * can change (`status`, the amounts, the hashes) must be applied to the
   * grouped result instead.
   */
  readCurrentRows(input: {
    siteId: string
    fromMs: number
    toMs: number
  }): Promise<CurrentRevenueEvent[]>
  ping(): Promise<boolean>
  close(): Promise<void>
}

/**
 * The batch's deduplication token: sha256 over a namespace and the rows.
 *
 * Identical to the session facts derivation, deliberately — same namespace-then-
 * newline-then-JSON shape, same 32-hex slice. Content-derived rather than
 * counter-derived is the whole point: two *different* attempts at the same work
 * produce the same token, so a redelivered batch is dropped, while genuinely new
 * rows produce a different one and are always written.
 */
export function revenueEventsToken(rows: readonly RevenueEventRow[]): string {
  const hash = createHash('sha256')
  hash.update('revenue_events')
  hash.update('\n')
  hash.update(JSON.stringify(rows))
  return hash.digest('hex').slice(0, 32)
}

export function createRevenueEventsStore(options: RevenueEventsStoreOptions): RevenueEventsStore {
  const table = options.table ?? REVENUE_EVENTS_TABLE

  const client: ClickHouseClient = createClient({
    url: options.url,
    username: options.username,
    password: options.password,
    database: options.database,
    request_timeout: options.requestTimeoutMs ?? DEFAULT_REVENUE_EVENTS_TIMEOUT_MS,
    clickhouse_settings: {
      // The projection advances a durable marker after this resolves. An async
      // insert would acknowledge before the block was committed and the marker
      // would move past rows that are not there.
      async_insert: 0,
      wait_for_async_insert: 1,
    },
  })

  return {
    async insertRows(rows) {
      if (rows.length === 0) return { token: null }
      const token = revenueEventsToken(rows)
      await client.insert({
        table,
        values: rows,
        format: 'JSONEachRow',
        clickhouse_settings: { insert_deduplication_token: token },
      })
      return { token }
    },

    async readCurrentRows({ siteId, fromMs, toMs }) {
      const resultSet = await client.query({
        query: `SELECT
                  re.object_id AS object_id,
                  re.provider  AS provider,
                  ${CURRENT_ARGMAX_COLUMNS}
                FROM ${table} AS re
                WHERE re.site_id = {siteId:String}
                  AND re.occurred_at >= fromUnixTimestamp64Milli({fromMs:Int64})
                  AND re.occurred_at <  fromUnixTimestamp64Milli({toMs:Int64})
                GROUP BY re.site_id, re.provider, re.object_id`,
        query_params: { siteId, fromMs, toMs },
        format: 'JSONEachRow',
      })
      const rows = await resultSet.json<Record<string, string>>()
      return rows.map((row) => ({
        objectId: row['object_id'] as string,
        provider: row['provider'] as string,
        objectKind: row['object_kind'] as string,
        version: Number(row['version']),
        occurredAtMs: Number(row['occurred_ms']),
        status: row['status'] as string,
        livemode: Number(row['livemode']),
        currency: row['currency'] as string,
        grossMinor: Number(row['gross_minor']),
        feeMinor: Number(row['fee_minor']),
        feeCurrency: row['fee_currency'] as string,
        netMinor: Number(row['net_minor']),
        reportingCurrency: row['reporting_currency'] as string,
        reportingGrossMinor: Number(row['reporting_gross_minor']),
        reportingNetMinor: Number(row['reporting_net_minor']),
        conversionSource: row['conversion_source'] as string,
        parentObjectId: row['parent_object_id'] as string,
        orderId: row['order_id'] as string,
        checkoutSessionId: row['checkout_session_id'] as string,
        customerHash: row['customer_hash'] as string,
        externalUserHash: row['external_user_hash'] as string,
      }))
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
