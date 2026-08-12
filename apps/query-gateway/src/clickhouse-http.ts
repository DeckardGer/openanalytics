import type { ClickHouseQuery, ClickHouseQueryResult, ClickHouseReader } from './clickhouse.ts'

/**
 * ClickHouse HTTP reader.
 *
 * The HTTP interface is the one the gateway uses (infra/fly/clickhouse); the
 * native port stays for the worker. Written against `fetch` rather than the
 * official client because the only thing needed here is a parameterised SELECT,
 * and a dependency that can also insert is a dependency that can be misused.
 *
 * Values travel as `param_<name>` query-string arguments — ClickHouse binds them
 * server side to the `{name:Type}` placeholders, so no value is ever part of the
 * statement text (docs snapshot 05, D-208).
 */

export interface HttpClickHouseOptions {
  readonly url: string
  readonly database: string
  readonly username: string
  readonly password: string
}

interface ClickHouseJsonResponse {
  readonly data?: readonly Record<string, unknown>[]
}

export function createHttpClickHouseReader(options: HttpClickHouseOptions): ClickHouseReader {
  return {
    async query(input: ClickHouseQuery): Promise<ClickHouseQueryResult> {
      const url = new URL(options.url)
      url.searchParams.set('database', options.database)
      url.searchParams.set('default_format', 'JSON')
      url.searchParams.set('query_id', input.queryId)
      // Cost guards travel as ordinary settings. readonly=2 lets the gateway
      // lower them per query; the profile's ceilings still bound anything it
      // does not send (infra/fly/clickhouse).
      for (const [name, value] of Object.entries(input.settings ?? {})) {
        url.searchParams.set(name, String(value))
      }
      for (const [name, value] of Object.entries(input.parameters)) {
        url.searchParams.set(`param_${name}`, String(value))
      }

      const response = await fetch(url, {
        method: 'POST',
        body: input.sql,
        signal: input.signal,
        headers: {
          // Credentials as headers, never in the URL: the URL is what ends up in
          // proxy and ClickHouse query logs.
          'x-clickhouse-user': options.username,
          'x-clickhouse-key': options.password,
          'content-type': 'text/plain; charset=utf-8',
        },
      })

      if (!response.ok) {
        // The upstream body can echo the statement back, so it is never thrown
        // wholesale — but its `Code: NNN` prefix is the difference between a
        // diagnosable failure and a bare 500 (the M7 ILLEGAL_AGGREGATION defect
        // cost a round trip to a live server to name). The code alone carries
        // no query text. The route still replaces the message with a generic
        // one before it leaves the gateway.
        const body = await response.text().catch(() => '')
        const code = /Code:\s*(\d+)/.exec(body)?.[1]
        throw new Error(
          `clickhouse responded ${response.status}${code ? ` (error code ${code})` : ''}`,
        )
      }

      const payload = (await response.json()) as ClickHouseJsonResponse
      return { rows: payload.data ?? [] }
    },
  }
}

/**
 * Stand-in used when no ClickHouse credential is configured.
 *
 * Milestone 0 left every credential optional so the skeleton starts on a clean
 * machine. A gateway without one must fail the request explicitly rather than
 * return an empty result set — AGENTS.md: a provider failure is never an empty
 * result.
 */
export function createUnconfiguredReader(): ClickHouseReader {
  return {
    query(): Promise<ClickHouseQueryResult> {
      return Promise.reject(new Error('clickhouse is not configured for this gateway'))
    },
  }
}
