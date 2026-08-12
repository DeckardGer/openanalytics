import {
  INGEST_PIPELINE_ID,
  createDatabase,
  createPool,
  getWorkerHeartbeat,
  upsertWorkerHeartbeat,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The pipeline liveness heartbeat (migration 0022; ADR-0025).
 *
 * The properties that matter are all properties of a real database: that the
 * upsert creates the row on the first tick and *replaces* it on every later one
 * (so the table stays one row per pipeline no matter how long the worker runs),
 * that a second instance writing the same pipeline overwrites rather than
 * conflicts, and that the CHECK refuses a negative age.
 *
 * Skipped without TEST_POSTGRES_URL so a contributor with no database can still
 * run the rest of the suite; CI always provides one.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

describeIfPostgres('worker heartbeat', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `hb_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database

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
    pool = createPool(scoped)
    db = createDatabase(pool)
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

  it('reads back nothing before the pipeline has ever ticked', async () => {
    // The pre-migration/pre-deploy state the read API falls back on.
    expect(await getWorkerHeartbeat(db, INGEST_PIPELINE_ID)).toBeNull()
  })

  it('creates the row on the first tick and updates it in place on the next', async () => {
    const first = new Date('2026-07-27T09:00:00.000Z')
    await upsertWorkerHeartbeat(db, {
      id: INGEST_PIPELINE_ID,
      consumer: 'worker-a',
      lastTickAt: first,
      queueOldestAgeMs: 0,
    })
    expect(await getWorkerHeartbeat(db, INGEST_PIPELINE_ID)).toEqual({
      consumer: 'worker-a',
      lastTickAt: first,
      queueOldestAgeMs: 0,
    })

    // A later tick from a *different* instance: last writer wins, and the table
    // still holds exactly one row for the pipeline.
    const second = new Date('2026-07-27T09:00:05.000Z')
    await upsertWorkerHeartbeat(db, {
      id: INGEST_PIPELINE_ID,
      consumer: 'worker-b',
      lastTickAt: second,
      queueOldestAgeMs: 1_500,
    })
    expect(await getWorkerHeartbeat(db, INGEST_PIPELINE_ID)).toEqual({
      consumer: 'worker-b',
      lastTickAt: second,
      queueOldestAgeMs: 1_500,
    })

    const count = await pool.query<{ n: string }>('SELECT count(*) AS n FROM worker_heartbeats')
    expect(Number(count.rows[0]?.n)).toBe(1)
  })

  it('keeps pipelines apart by id', async () => {
    const at = new Date('2026-07-27T09:01:00.000Z')
    await upsertWorkerHeartbeat(db, {
      id: 'some-other-pipeline',
      consumer: 'worker-c',
      lastTickAt: at,
      queueOldestAgeMs: 42,
    })
    const other = await getWorkerHeartbeat(db, 'some-other-pipeline')
    expect(other?.consumer).toBe('worker-c')
    // The ingest row is untouched by it.
    expect((await getWorkerHeartbeat(db, INGEST_PIPELINE_ID))?.consumer).toBe('worker-b')
  })

  it('refuses a negative queue age', async () => {
    // Drizzle wraps the driver error ("Failed query: …"), so the violated
    // constraint's name lives on the cause, not the message.
    const attempt = upsertWorkerHeartbeat(db, {
      id: INGEST_PIPELINE_ID,
      consumer: 'worker-a',
      lastTickAt: new Date('2026-07-27T09:02:00.000Z'),
      queueOldestAgeMs: -1,
    })
    await expect(attempt).rejects.toSatisfy((error: unknown) => {
      const cause = (error as { cause?: unknown }).cause
      return `${String(error)} ${String(cause)}`.includes('worker_heartbeats_queue_age_check')
    })
  })
})
