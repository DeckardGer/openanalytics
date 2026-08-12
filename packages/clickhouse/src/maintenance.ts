import { createClient, type ClickHouseClient } from '@clickhouse/client'
import { DELETION_CLICKHOUSE_TARGETS, type DeletionClickhouseTarget } from '@openanalytics/domain'

/**
 * The per-site ClickHouse purge (ADR-0030, decision 4, `clickhouse_purge`).
 *
 * The only module that deletes analytics data, and it runs on its own
 * credential: `oa_maintenance` holds `ALTER DELETE` + `SELECT` on `analytics.*`
 * and `SELECT` on `system.mutations`, and nothing else. `oa_ingest` stays
 * insert-only and `oa_read` stays readonly — a deletion path reachable from
 * either would mean the ingest or the dashboard credential could erase a
 * customer's history. Giving the worker the *migration* credential was the
 * alternative and was rejected: that user can also DROP tables, from inside a
 * process that runs forever.
 *
 * Three facts about ClickHouse shape everything here.
 *
 * 1. **A delete is a mutation, and a mutation is asynchronous.** `ALTER TABLE …
 *    DELETE` submitted with `mutations_sync = 0` returns as soon as the mutation
 *    is *registered*, not when it has rewritten the parts. So "delete" is three
 *    operations, not one: submit, poll `system.mutations` until `is_done`, then
 *    verify. Anything that treats the submit's return as completion reports a
 *    purge that has not happened.
 *
 * 2. **The mutation id is the only handle back.** The submit gives nothing; the
 *    id has to be read out of `system.mutations` afterwards, matched on the
 *    command text. That is why the site id is interpolated into the `ALTER`
 *    rather than bound as a query parameter — the recorded `command` must
 *    contain the literal id for the match to be possible at all, and parameter
 *    support in `ALTER` has been version-dependent in a way `SELECT` never was.
 *    The injection that interpolation would otherwise open is closed by
 *    construction: `assertSiteId` refuses anything that is not a canonical UUID,
 *    which is what a `site_id` is on every path that reaches here. Every other
 *    statement in this file is parameter-bound, because it can be.
 *
 * 3. **Verification is a count, not a promise.** After `is_done`, a
 *    `SELECT count()` for the site must return zero. It is the only statement in
 *    the whole deletion that observes the end state rather than an intermediate
 *    one, and it is what `deletion_targets.verified` records.
 */

/**
 * Every table that stores a `site_id` (ADR-0030, decision 7).
 *
 * Re-exported from the domain vocabulary rather than restated: Postgres writes
 * the same names into `deletion_targets` at the start transaction,
 * and a second literal list here would be a purge that quietly stops covering a
 * table the day one of the two is edited.
 */
export const DELETION_CLICKHOUSE_TABLES = DELETION_CLICKHOUSE_TARGETS

export type DeletionClickhouseTable = DeletionClickhouseTarget

/** 30 s. Every statement here is either a registration or a small aggregate; a
 * long timeout would only hide a ClickHouse that has stopped answering. */
export const DEFAULT_MAINTENANCE_REQUEST_TIMEOUT_MS = 30_000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class InvalidSiteIdError extends Error {
  constructor(value: string) {
    super(`Invalid site id for a ClickHouse maintenance statement: ${JSON.stringify(value)}`)
    this.name = 'InvalidSiteIdError'
  }
}

/**
 * The interpolation guard. A `site_id` is a UUID everywhere in this system, so
 * refusing everything else costs nothing and closes the hole that reason 2 above
 * would otherwise open.
 */
export function assertSiteId(siteId: string): string {
  if (!UUID.test(siteId)) throw new InvalidSiteIdError(siteId)
  return siteId
}

export interface SubmittedMutation {
  /**
   * The id `system.mutations` gave the submitted delete, or null when the
   * mutation is already gone from the table — which happens when it completed
   * and was cleaned up between the submit and the lookup. Null therefore does
   * not mean "failed"; the caller resolves it by verifying the count, which is
   * the only statement that observes truth rather than progress.
   */
  readonly mutationId: string | null
}

export interface MutationProgress {
  /** False when the mutation is still rewriting parts. */
  readonly done: boolean
  /** `latest_fail_reason`, non-empty only when an attempt has failed. */
  readonly failReason: string | null
  /** True when no row for this mutation id exists any more (completed and
   * cleaned up, or never registered). The caller falls back to the count. */
  readonly missing: boolean
}

export interface ClickhouseMaintenance {
  /**
   * Register `ALTER TABLE {table} DELETE WHERE site_id = '{siteId}'` and return
   * its mutation id.
   *
   * Idempotent in the only sense that matters: submitting the same delete twice
   * registers a second mutation over a part set the first one already emptied,
   * which is wasted work but never wrong. The stored `mutation_id` is what keeps
   * a resumed job from paying that cost.
   */
  submitSiteDelete(table: string, siteId: string): Promise<SubmittedMutation>
  /** Progress of a previously submitted mutation. */
  pollMutation(table: string, mutationId: string): Promise<MutationProgress>
  /** Rows still present for the site. The verification statement. */
  countSiteRows(table: string, siteId: string): Promise<number>
  ping(): Promise<boolean>
  close(): Promise<void>
}

export interface ClickhouseMaintenanceOptions {
  readonly url: string
  readonly database: string
  readonly username: string
  readonly password: string
  readonly requestTimeoutMs?: number
}

export function createClickhouseMaintenance(
  options: ClickhouseMaintenanceOptions,
): ClickhouseMaintenance {
  const client: ClickHouseClient = createClient({
    url: options.url,
    username: options.username,
    password: options.password,
    database: options.database,
    request_timeout: options.requestTimeoutMs ?? DEFAULT_MAINTENANCE_REQUEST_TIMEOUT_MS,
    clickhouse_settings: {
      // Register and return. The phase polls `system.mutations` itself, because
      // a synchronous wait would hold the job's lease for the whole rewrite of a
      // large table and lose it — and a lost lease mid-purge is exactly the
      // state the lease guard exists to refuse.
      mutations_sync: '0',
    },
  })

  const query = async <T>(sql: string, params: Record<string, unknown>): Promise<T[]> => {
    const resultSet = await client.query({
      query: sql,
      query_params: params,
      format: 'JSONEachRow',
    })
    return await resultSet.json<T>()
  }

  return {
    async submitSiteDelete(table: string, siteId: string): Promise<SubmittedMutation> {
      const id = assertSiteId(siteId)
      // `command` is the queried table's own DDL text; the site id has to be a
      // literal in it (see the header, reason 2). `table` never comes from
      // input — the caller picks it out of DELETION_CLICKHOUSE_TABLES — but it
      // is still checked here so a future caller cannot pass a string through.
      assertTable(table)
      await client.command({
        query: `ALTER TABLE ${table} DELETE WHERE site_id = '${id}'`,
        clickhouse_settings: { mutations_sync: '0' },
      })

      // Newest first: a re-submitted delete for the same site leaves several
      // matching rows, and the one this call registered is the latest.
      const rows = await query<{ mutation_id: string }>(
        `SELECT mutation_id
           FROM system.mutations
          WHERE database = {database:String}
            AND table = {table:String}
            AND command LIKE {pattern:String}
          ORDER BY create_time DESC
          LIMIT 1`,
        { database: options.database, table, pattern: `%${id}%` },
      )
      return { mutationId: rows[0]?.mutation_id ?? null }
    },

    async pollMutation(table: string, mutationId: string): Promise<MutationProgress> {
      assertTable(table)
      const rows = await query<{ is_done: number; latest_fail_reason: string }>(
        `SELECT is_done, latest_fail_reason
           FROM system.mutations
          WHERE database = {database:String}
            AND table = {table:String}
            AND mutation_id = {mutationId:String}`,
        { database: options.database, table, mutationId },
      )
      const row = rows[0]
      if (!row) return { done: false, failReason: null, missing: true }
      return {
        done: Number(row.is_done) === 1,
        failReason: row.latest_fail_reason === '' ? null : row.latest_fail_reason,
        missing: false,
      }
    },

    async countSiteRows(table: string, siteId: string): Promise<number> {
      assertTable(table)
      const rows = await query<{ rows: string }>(
        `SELECT count() AS rows FROM ${table} WHERE site_id = {siteId:String}`,
        { siteId: assertSiteId(siteId) },
      )
      return Number(rows[0]?.rows ?? 0)
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

const TABLE_NAME = /^[a-z_][a-z0-9_]{0,63}$/

export class InvalidTableNameError extends Error {
  constructor(value: string) {
    super(`Invalid ClickHouse table name: ${JSON.stringify(value)}`)
    this.name = 'InvalidTableNameError'
  }
}

/**
 * Table names are interpolated (a table cannot be a query parameter), so the
 * same closed-charset guard `assertSiteId` applies to the other interpolated
 * value applies here — narrowed to what a table name in this schema actually is:
 * a lowercase unquoted identifier of at most 64 characters. Every real caller
 * passes a member of `DELETION_CLICKHOUSE_TABLES`; this is what keeps a future
 * one from passing something else.
 */
function assertTable(table: string): string {
  if (!TABLE_NAME.test(table)) throw new InvalidTableNameError(table)
  return table
}
