import { createDatabase, listCompletedBatchLedgerTotals, newId } from '@openanalytics/postgres'
import { CLOUD_STREAM_PRESENT, applyPostgresStreams } from '../support/postgres-streams.ts'
import { ensureBillingAccount } from '../support/cloud-billing-fixtures.ts'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Schema invariants for the batch manifest (migration 0015).
 *
 * These are the constraints the M6 correctness argument rests on, so they are
 * asserted against a real database rather than trusted from the DDL:
 *
 *   * (stream_name, message_id) is unique across the whole table — one queue
 *     message belongs to exactly one manifest, which is what makes "never
 *     silently re-split into new batches" enforceable (docs snapshot 05, D-209
 *     step 3);
 *   * (batch_id, position) is unique — row order inside a batch is a set of
 *     distinct positions, because the ClickHouse token only recognises a retry
 *     that re-issues the same rows in the same order (02 §7.5);
 *   * a terminal state and its timestamp cannot disagree, which is what bounded
 *     disaster replay selects on (D-216);
 *   * (batch_id, site_id) is unique in the write fence, and a dropped
 *     registration must name why (D-210);
 *   * items and fence rows cascade with their manifest, and neither carries a
 *     foreign key to `sites` — a manifest is an audit record that has to outlive
 *     the deletion it describes.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

describeIfPostgres('ingest batch manifest schema', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m6manifest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool

  let counter = 0
  const nextBatchId = () => `b1_test_${(counter += 1)}_${Date.now()}`

  const insertBatch = async (
    batchId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> => {
    const row = {
      state: 'pending',
      message_count: 1,
      byte_size: 100,
      payload_hash: 'ph',
      completed_at: null,
      dead_lettered_at: null,
      ...overrides,
    }
    await pool.query(
      `INSERT INTO ingest_batches
         (id, batch_id, stream_name, consumer_group, state, message_count, byte_size,
          payload_hash, completed_at, dead_lettered_at)
       VALUES ($1, $2, 'event_stream', 'ingest_workers', $3, $4, $5, $6, $7, $8)`,
      [
        newId(),
        batchId,
        row.state,
        row.message_count,
        row.byte_size,
        row.payload_hash,
        row.completed_at,
        row.dead_lettered_at,
      ],
    )
    return batchId
  }

  const insertItem = (input: { batchId: string; messageId: string; position: number }) =>
    pool.query(
      `INSERT INTO ingest_batch_items
         (id, batch_id, stream_name, message_id, position, site_id, event_id,
          payload_hash, accepted_at)
       VALUES ($1, $2, 'event_stream', $3, $4, $5, $6, 'ph', now())`,
      [newId(), input.batchId, input.messageId, input.position, newId(), newId()],
    )

  const insertFence = (input: {
    batchId: string
    siteId: string
    state?: string
    dropReason?: string | null
  }) =>
    pool.query(
      `INSERT INTO ingest_batch_sites
         (id, batch_id, site_id, ingest_generation, state, drop_reason)
       VALUES ($1, $2, $3, 1, $4, $5)`,
      [newId(), input.batchId, input.siteId, input.state ?? 'registered', input.dropReason ?? null],
    )

  beforeAll(async () => {
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`CREATE SCHEMA ${schemaName}`)
    } finally {
      await admin.end()
    }
    const url = new URL(connectionString)
    url.searchParams.set('options', `-c search_path=${schemaName}`)
    const scoped = url.toString()
    const { logger } = createCapturedLogger()
    await applyPostgresStreams({ connectionString: scoped, logger })
    pool = new Pool({ connectionString: scoped })
  })

  afterAll(async () => {
    await pool?.end()
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
    } finally {
      await admin.end()
    }
  })

  it('refuses to put one queue message into two manifests', async () => {
    const first = await insertBatch(nextBatchId())
    const second = await insertBatch(nextBatchId())
    const messageId = `1721000000000-${counter}`

    await insertItem({ batchId: first, messageId, position: 0 })

    await expect(insertItem({ batchId: second, messageId, position: 0 })).rejects.toThrow(
      /ingest_batch_items_stream_message_key/,
    )
  })

  it('refuses two rows at the same position in one batch', async () => {
    const batchId = await insertBatch(nextBatchId())
    await insertItem({ batchId, messageId: `a-${counter}`, position: 0 })

    await expect(insertItem({ batchId, messageId: `b-${counter}`, position: 0 })).rejects.toThrow(
      /ingest_batch_items_batch_position_key/,
    )
  })

  it('refuses a completed batch with no completion time', async () => {
    await expect(insertBatch(nextBatchId(), { state: 'completed' })).rejects.toThrow(
      /ingest_batches_completed_check/,
    )
  })

  it('refuses a completion time on a batch that is not completed', async () => {
    await expect(
      insertBatch(nextBatchId(), { state: 'inserted', completed_at: new Date() }),
    ).rejects.toThrow(/ingest_batches_completed_check/)
  })

  it('refuses a dead-lettered batch with no dead-letter time', async () => {
    await expect(insertBatch(nextBatchId(), { state: 'dead_lettered' })).rejects.toThrow(
      /ingest_batches_dead_lettered_check/,
    )
  })

  it('refuses a state outside the manifest state machine', async () => {
    await expect(insertBatch(nextBatchId(), { state: 'nearly_done' })).rejects.toThrow(
      /ingest_batches_state_check/,
    )
  })

  it('registers a site at most once per batch', async () => {
    const batchId = await insertBatch(nextBatchId())
    const siteId = newId()
    await insertFence({ batchId, siteId })

    await expect(insertFence({ batchId, siteId })).rejects.toThrow(
      /ingest_batch_sites_batch_site_key/,
    )
  })

  it('refuses a dropped registration that does not say why', async () => {
    const batchId = await insertBatch(nextBatchId())
    await expect(insertFence({ batchId, siteId: newId(), state: 'dropped' })).rejects.toThrow(
      /ingest_batch_sites_drop_state_check/,
    )
  })

  it('refuses a drop reason outside the D-210 vocabulary', async () => {
    const batchId = await insertBatch(nextBatchId())
    await expect(
      insertFence({ batchId, siteId: newId(), state: 'dropped', dropReason: 'felt_wrong' }),
    ).rejects.toThrow(/ingest_batch_sites_drop_reason_check/)
  })

  it('cascades items and fence rows when a manifest is removed', async () => {
    const batchId = await insertBatch(nextBatchId())
    await insertItem({ batchId, messageId: `c-${counter}`, position: 0 })
    await insertFence({ batchId, siteId: newId() })

    await pool.query(`DELETE FROM ingest_batches WHERE batch_id = $1`, [batchId])

    const items = await pool.query(`SELECT 1 FROM ingest_batch_items WHERE batch_id = $1`, [
      batchId,
    ])
    const fences = await pool.query(`SELECT 1 FROM ingest_batch_sites WHERE batch_id = $1`, [
      batchId,
    ])
    expect(items.rowCount).toBe(0)
    expect(fences.rowCount).toBe(0)
  })

  it('keeps the manifest free of foreign keys to sites', async () => {
    // A cascade from `sites` would erase the record of what was written exactly
    // when the D-210 deletion needs to prove it removed it.
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT tc.table_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name
          AND ccu.constraint_schema = tc.constraint_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = $1
          AND tc.table_name IN ('ingest_batch_items', 'ingest_batch_sites')
          AND ccu.table_name = 'sites'`,
      [schemaName],
    )
    expect(rows).toEqual([])
  })

  it('attributes each batch its own ledger total, not the whole table', async () => {
    // Regression. The first version of this read used a correlated subquery in
    // the projection, which silently did not correlate: every batch came back
    // with the sum of all deltas. The reconciliation metric would then have
    // reported enormous drift permanently — and an alert that always fires is
    // an alert that gets ignored, which is worse than not having it.
    const db = createDatabase(pool)
    const userId = newId()
    const windowId = newId()

    await pool.query(`INSERT INTO users (id, name, email) VALUES ($1, 'u', $2)`, [
      userId,
      `ledger-${counter}@example.com`,
    ])
    // `usage_batch_deltas.usage_window_id` is a plain grouping column in the
    // product schema; the foreign key to `usage_windows` is added by the cloud
    // stream, so the window row only has to exist where that stream ran.
    if (CLOUD_STREAM_PRESENT)
      await pool.query(
        `INSERT INTO usage_windows
           (id, billing_account_id, kind, plan_tier, event_limit, starts_at, ends_at, quota_anchor_at)
         VALUES ($1, $2, 'paid', 'starter', 50000,
                 now() - interval '1 day', now() + interval '20 days', now() - interval '1 day')`,
        [windowId, await ensureBillingAccount(pool, userId)],
      )

    const expected = new Map<string, number>()
    for (const delta of [3, 7, 12]) {
      const batchId = await insertBatch(nextBatchId(), {
        state: 'completed',
        completed_at: new Date(),
      })
      await pool.query(`INSERT INTO usage_batches (id, batch_id) VALUES ($1, $2)`, [
        newId(),
        batchId,
      ])
      await pool.query(
        `INSERT INTO usage_batch_deltas (id, batch_id, billing_user_id, usage_window_id, delta)
         VALUES ($1, $2, $3, $4, $5)`,
        [newId(), batchId, userId, windowId, delta],
      )
      expected.set(batchId, delta)
    }

    const totals = await listCompletedBatchLedgerTotals(db, {
      since: new Date(Date.now() - 3_600_000),
      limit: 100,
    })
    const byBatch = new Map(totals.map((row) => [row.batchId, row.ledger]))

    for (const [batchId, delta] of expected) {
      expect(byBatch.get(batchId)).toBe(delta)
    }
  })
})
