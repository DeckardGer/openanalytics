import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Milestone 1 gate, ClickHouse half (docs snapshot 04, Milestone 1 item 8).
 *
 * The gate bullet is "a retry of the same stable ClickHouse batch does not
 * duplicate the raw/MV result" — D-209 step 4. The worker derives a
 * deterministic `batch_id`
 * from the stream message ids and retries the insert with that same id as the
 * deduplication token, so a retry after an ambiguous failure cannot double the
 * data.
 *
 * The dependent materialized view is included deliberately. Insert dedup and MV
 * behaviour are separate mechanisms, and a token that protects the raw table
 * while the MV still double-counts is the failure that would silently inflate
 * every dashboard rollup built on it.
 *
 * Reached over the Fly private network (a `flyctl proxy` to 6PN), because
 * ClickHouse has no public port — that is the topology under test, not an
 * inconvenience to work around.
 */

const CH_URL = process.env['M1_CLICKHOUSE_URL']
const CH_USER = process.env['M1_CLICKHOUSE_USER']
const CH_PASSWORD = process.env['M1_CLICKHOUSE_PASSWORD']
const CH_ADMIN_USER = process.env['M1_CLICKHOUSE_MIGRATION_USER']
const CH_ADMIN_PASSWORD = process.env['M1_CLICKHOUSE_MIGRATION_PASSWORD']

const describeIfLive = CH_URL && CH_USER && CH_ADMIN_USER ? describe : describe.skip

describeIfLive('M1 gate — stable batch token against live ClickHouse', () => {
  const suffix = randomUUID().replace(/-/g, '')
  const raw = `analytics.m1_events_${suffix}`
  const rollup = `analytics.m1_rollup_${suffix}`
  const view = `analytics.m1_mv_${suffix}`

  const query = async (
    sql: string,
    { user = CH_USER, password = CH_PASSWORD, settings = {} } = {},
  ): Promise<string> => {
    const url = new URL(CH_URL as string)
    for (const [k, v] of Object.entries(settings)) url.searchParams.set(k, String(v))
    const response = await fetch(url, {
      method: 'POST',
      body: sql,
      headers: {
        'X-ClickHouse-User': user as string,
        'X-ClickHouse-Key': password as string,
      },
    })
    const text = (await response.text()).trim()
    if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 300)}`)
    return text
  }

  const admin = (sql: string, settings = {}) =>
    query(sql, { user: CH_ADMIN_USER, password: CH_ADMIN_PASSWORD, settings })

  beforeAll(async () => {
    // `non_replicated_deduplication_window` is the setting that makes this work
    // at all: on a non-replicated MergeTree, insert deduplication is OFF by
    // default, so the token would be accepted and silently ignored. G-002 lists
    // pinning this window as a gate item, and this is the measurement behind it.
    await admin(`
      CREATE TABLE ${raw} (
        site_id     String,
        event_id    String,
        occurred_at DateTime64(3, 'UTC'),
        batch_id    String
      )
      ENGINE = MergeTree
      ORDER BY (site_id, occurred_at)
      SETTINGS non_replicated_deduplication_window = 1000
    `)
    // The window is repeated on the MV TARGET table, and that is the whole
    // finding of this test. Setting it only on the raw table dedupes the raw
    // insert while the materialized view fires once per retry — three identical
    // inserts leave 50 raw rows and a rollup of 150. The token protects the data
    // nobody reads and inflates the numbers every dashboard is built from.
    //
    // Measured on 26.3.17.56: the target-table window is both necessary and
    // sufficient. `deduplicate_blocks_in_dependent_materialized_views` changed
    // nothing in either direction, so it is deliberately not set here.
    await admin(`
      CREATE TABLE ${rollup} (
        site_id String,
        day     Date,
        events  UInt64
      )
      ENGINE = SummingMergeTree
      ORDER BY (site_id, day)
      SETTINGS non_replicated_deduplication_window = 1000
    `)
    await admin(`
      CREATE MATERIALIZED VIEW ${view} TO ${rollup} AS
      SELECT site_id, toDate(occurred_at) AS day, count() AS events
      FROM ${raw}
      GROUP BY site_id, day
    `)
  })

  afterAll(async () => {
    await admin(`DROP VIEW IF EXISTS ${view}`)
    await admin(`DROP TABLE IF EXISTS ${rollup}`)
    await admin(`DROP TABLE IF EXISTS ${raw}`)
  })

  const rowsIn = async (table: string, siteId: string): Promise<number> =>
    Number(await admin(`SELECT count() FROM ${table} WHERE site_id = '${siteId}'`))

  const rollupTotal = async (siteId: string): Promise<number> =>
    Number(await admin(`SELECT sum(events) FROM ${rollup} FINAL WHERE site_id = '${siteId}'`))

  it('does not duplicate raw rows or MV output when the same batch is retried', async () => {
    const siteId = `site-${randomUUID()}`
    const batchId = `batch-${randomUUID()}`
    const values = Array.from(
      { length: 50 },
      () => `('${siteId}', '${randomUUID()}', now64(3), '${batchId}')`,
    ).join(',')
    const insert = `INSERT INTO ${raw} (site_id, event_id, occurred_at, batch_id) VALUES ${values}`

    // Synchronous insert, exactly as D-209 step 4 requires: an async insert
    // would acknowledge before the data is durable and break at-least-once.
    const settings = {
      insert_deduplication_token: batchId,
      async_insert: 0,
      wait_for_async_insert: 1,
    }

    await admin(insert, settings)
    expect(await rowsIn(raw, siteId)).toBe(50)
    expect(await rollupTotal(siteId)).toBe(50)

    // The retry: identical rows, identical token. This is the worker replaying
    // a batch whose outcome it never learned.
    await admin(insert, settings)
    await admin(insert, settings)

    expect(await rowsIn(raw, siteId)).toBe(50)
    // The MV must not have fired again either.
    expect(await rollupTotal(siteId)).toBe(50)
  })

  it('treats a different batch id as genuinely new data', async () => {
    // The guard against the opposite error: dedup that is too aggressive would
    // silently drop real events.
    const siteId = `site-${randomUUID()}`
    const rowFor = (batchId: string) =>
      `INSERT INTO ${raw} (site_id, event_id, occurred_at, batch_id) VALUES ('${siteId}', '${randomUUID()}', now64(3), '${batchId}')`

    const a = `batch-${randomUUID()}`
    const b = `batch-${randomUUID()}`
    await admin(rowFor(a), { insert_deduplication_token: a, async_insert: 0 })
    await admin(rowFor(b), { insert_deduplication_token: b, async_insert: 0 })

    expect(await rowsIn(raw, siteId)).toBe(2)
    expect(await rollupTotal(siteId)).toBe(2)
  })

  it('refuses DDL from the ingest credential', async () => {
    // The ingest user DOES hold SELECT, and not by choice: ClickHouse checks the
    // inserting user's SELECT privilege on a materialized view's source table
    // while pushing to the view, so an INSERT-only credential cannot drive an MV
    // at all (measured on 26.3.17.56 — see ADR-0005). The boundary that still
    // has to hold is that the worker cannot change the schema it writes into.
    await expect(
      query(`CREATE TABLE ${raw}_nope (x UInt8) ENGINE=MergeTree ORDER BY x`),
    ).rejects.toThrow(/Not enough privileges/)
  })
})
