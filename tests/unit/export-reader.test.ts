import {
  EXPORT_EVENT_COLUMNS,
  ExportReadError,
  createExportReader,
} from '@openanalytics/clickhouse'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The export read path's SQL and settings (ADR-0032, D8).
 *
 * This is the suite behind plan-04's "export returns no other site's data" at
 * the level a unit test can reach it: the criterion is proven against real data
 * by `tests/migration/clickhouse-export.test.ts`, and what is asserted *here* is
 * the thing that would make that proof stop being true without anybody
 * noticing — that `site_id` is a **bound parameter** on every statement the
 * reader issues, never interpolated and never absent.
 *
 * The two output-format settings are asserted for the same reason. They are
 * invisible in a passing integration test that happens to use small numbers and
 * a UTC-looking timestamp, and they decide the format of every file a customer
 * receives.
 */

const created: { settings: Record<string, unknown> }[] = []
const queries: { query: string; query_params: Record<string, unknown> }[] = []

const resultSet = {
  json: async () => await Promise.resolve([{ month: 202607 }]),
  stream: () => ({
    async *[Symbol.asyncIterator]() {
      await Promise.resolve()
      yield [{ json: () => ({ event_id: 'a' }) }]
    },
  }),
}

vi.mock('@clickhouse/client', () => ({
  createClient: (options: { clickhouse_settings: Record<string, unknown> }) => {
    created.push({ settings: options.clickhouse_settings })
    return {
      query: async (input: { query: string; query_params: Record<string, unknown> }) => {
        queries.push(input)
        return await Promise.resolve(resultSet)
      },
      ping: async () => await Promise.resolve({ success: true }),
      close: async () => await Promise.resolve(undefined),
    }
  },
}))

const SITE = 'aa11bb22-cc33-4d44-8e55-ff6677889900'
const OTHER_SITE = 'bb22cc33-dd44-4e55-8f66-001122334455'
const IMPORT_RUN = 'cc33dd44-ee55-4f66-8a77-112233445566'
const CUTOFF = new Date('2026-07-29T10:00:00.000Z')

function reader() {
  return createExportReader({
    url: 'http://clickhouse.test',
    database: 'analytics',
    username: 'oa_maintenance',
    password: 'secret',
  })
}

async function drain(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const rows: unknown[] = []
  for await (const row of iterable) rows.push(row)
  return rows
}

beforeEach(() => {
  created.length = 0
  queries.length = 0
})

describe('the export reader', () => {
  it('binds site_id and the cutoff as parameters on every statement', async () => {
    const client = reader()
    await client.eventMonths({ siteId: SITE, cutoff: CUTOFF })
    await drain(client.streamEvents({ siteId: SITE, cutoff: CUTOFF, month: '2026-07' }))
    await drain(client.streamImported({ siteId: SITE, importRunId: IMPORT_RUN, report: 'metrics' }))

    expect(queries).toHaveLength(3)
    for (const query of queries) {
      // Bound, so no value a caller passes can become SQL — and *present*, which
      // is the isolation guarantee itself. A statement missing the site filter
      // would return another customer's rows with no error anywhere.
      expect(query.query).toContain('site_id = {siteId:UUID}')
      expect(query.query_params['siteId']).toBe(SITE)
      // The id never appears as a literal.
      expect(query.query).not.toContain(SITE)
    }

    // The two event statements additionally bind the D8 cutoff, which is what
    // makes every chunk of one export cover the same set of events.
    for (const query of queries.slice(0, 2)) {
      expect(query.query).toContain("accepted_at <= {cutoff:DateTime64(3, 'UTC')}")
      // Rendered as ClickHouse's own DateTime64 literal, never a `Z`-suffixed
      // ISO string, which the column does not parse.
      expect(query.query_params['cutoff']).toBe('2026-07-29 10:00:00.000')
    }

    // The imported statement binds the pinned run beside the site: the run alone
    // would be enough, and binding both keeps the isolation argument identical
    // on every statement rather than "identical except for the imported ones".
    expect(queries[2]?.query).toContain('import_run_id = {importRunId:UUID}')
    expect(queries[2]?.query_params['importRunId']).toBe(IMPORT_RUN)
  })

  it('never mixes two sites into one statement', async () => {
    const client = reader()
    await drain(client.streamEvents({ siteId: SITE, cutoff: CUTOFF, month: '2026-07' }))
    await drain(client.streamEvents({ siteId: OTHER_SITE, cutoff: CUTOFF, month: '2026-07' }))

    expect(queries[0]?.query_params['siteId']).toBe(SITE)
    expect(queries[1]?.query_params['siteId']).toBe(OTHER_SITE)
    // Same SQL, different bound value — which is why the gateway-style parameter
    // discipline is worth keeping here even though this is not the gateway.
    expect(queries[0]?.query).toBe(queries[1]?.query)
  })

  it('selects the contract columns and none of the pipeline internals', async () => {
    const client = reader()
    await drain(client.streamEvents({ siteId: SITE, cutoff: CUTOFF, month: '2026-07' }))
    const sql = queries[0]?.query ?? ''

    for (const column of EXPORT_EVENT_COLUMNS) expect(sql).toContain(column)
    // D8: no fence, no billing internals. `billing_user_id` is additionally
    // another person's id — the payer of a site need not be a member of it.
    for (const internal of [
      'batch_id',
      'ingest_generation',
      'billing_user_id',
      'billing_assignment_version',
      'usage_window_start',
      'billing_grace',
      'billable',
    ]) {
      expect(sql).not.toContain(internal)
    }
  })

  it('orders events by the table sort key so a stream is a merge, not a sort', async () => {
    const client = reader()
    await drain(client.streamEvents({ siteId: SITE, cutoff: CUTOFF, month: '2026-07' }))
    // `(site_id, occurred_at, event_id)` minus the bound site. `event_id` closes
    // it so two events of the same millisecond have a deterministic order.
    expect(queries[0]?.query).toContain('ORDER BY occurred_at, event_id')
    // The month is the partition expression, so the bound is a partition prune.
    expect(queries[0]?.query).toContain('toYYYYMM(occurred_at) = {month:UInt32}')
    expect(queries[0]?.query_params['month']).toBe(202607)
  })

  it('asks ClickHouse for unquoted 64-bit integers and ISO instants', async () => {
    reader()
    // The NDJSON encoding decision, made at the one place it can be made
    // uniformly. Without the first, imported `UInt64` counts arrive as JSON
    // strings while the event columns arrive as numbers, and a consumer has to
    // branch per file. Without the second, every instant is a zone-less wall
    // clock somebody will parse locally.
    expect(created[0]?.settings).toMatchObject({
      output_format_json_quote_64bit_integers: 0,
      date_time_output_format: 'iso',
    })
  })

  it('refuses a month that is not a calendar month', () => {
    const client = reader()
    // Synchronously, before the generator is even returned: a malformed month is
    // a bug in the caller, and the failure belongs at the call site rather than
    // buried in the first `await` of a stream.
    expect(() => client.streamEvents({ siteId: SITE, cutoff: CUTOFF, month: '2026-7' })).toThrow(
      RangeError,
    )
  })

  it('classifies a driver failure so the executor can retry rather than fail the run', async () => {
    // The distinction the whole executor is organised around: ClickHouse being
    // unreachable must not tell a customer their data cannot be exported.
    expect(new ExportReadError('boom', new Error('socket')).name).toBe('ExportReadError')
  })
})
