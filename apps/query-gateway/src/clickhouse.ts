/**
 * The gateway's only view of ClickHouse.
 *
 * Kept as an interface so the request path is testable without infrastructure
 * and so the read credential stays in exactly one implementation. Note what the
 * interface cannot express: there is no way to pass a table name, a fragment or
 * a interpolated value — a caller supplies a registered `sql` constant and a
 * parameter map, which is the D-208 "no arbitrary SQL" rule made structural
 * rather than reviewed.
 */

/** Values ClickHouse can bind through `{name:Type}` placeholders. */
export type QueryParameterValue = string | number | boolean

export interface ClickHouseQuery {
  readonly sql: string
  readonly parameters: Readonly<Record<string, QueryParameterValue>>
  /** Aborted when the per-request timeout fires. */
  readonly signal: AbortSignal
  /** Correlation key, forwarded so a slow query can be traced back to a request. */
  readonly queryId: string
  /**
   * ClickHouse-side cost guards applied per query (`max_execution_time`,
   * `max_result_rows`, …). These are defence in depth behind the gateway's own
   * timeout and each operation's `maxRows`/`LIMIT`: the read-only `oa_read`
   * profile already caps both server-side, and `readonly=2` permits lowering
   * them per request but never raising them (infra/fly/clickhouse). Sent as
   * settings, never spliced into the statement.
   */
  readonly settings?: Readonly<Record<string, string | number>>
}

export interface ClickHouseQueryResult {
  readonly rows: readonly Record<string, unknown>[]
}

export interface ClickHouseReader {
  query(input: ClickHouseQuery): Promise<ClickHouseQueryResult>
}
