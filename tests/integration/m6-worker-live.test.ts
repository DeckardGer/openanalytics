import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createClient } from '@clickhouse/client'
import { EVENT_SCHEMA_VERSION, type PersistedEvent } from '@openanalytics/contracts'
import { createEventsIngest, migrateClickHouse } from '@openanalytics/clickhouse'
import { deriveBatchId, loadPolicy, type Policy } from '@openanalytics/domain'
import { createCapturedLogger } from '@openanalytics/testkit'
import { createRecordingMetrics } from '@openanalytics/observability'
import {
  createDatabase,
  createPool,
  getManifest,
  newId,
  readBatchLedgerTotal,
  type Database,
} from '@openanalytics/postgres'
import { CLOUD_STREAM_PRESENT, applyPostgresStreams } from '../support/postgres-streams.ts'
import { ensureBillingAccount } from '../support/cloud-billing-fixtures.ts'
import {
  createEventStreamConsumer,
  createEventStreamQueue,
  createQueueClient,
  createQueueMaintenance,
  createRealtimeCache,
  dedupKey,
  siteQueueIndexKey,
  utcDayOf,
} from '@openanalytics/redis'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  processMessages,
  recoverManifests,
  runCeilingDayCheck,
  runManifest,
  runRetentionTrim,
  runUsageReconciliation,
  type IngestDeps,
} from '../../apps/worker/src/ingest/index.ts'

/**
 * Milestone 6 acceptance, against real Postgres, real ClickHouse and a real
 * Valkey — the three stores whose interaction is the whole milestone.
 *
 * A double cannot prove any of this. "A retried batch does not double a
 * dependent materialized view" is a statement about ClickHouse's insert
 * deduplication reaching a view target; "usage increments once" is a statement
 * about a Postgres unique constraint under a real transaction; "no loss and no
 * duplicate at every crash point" is a statement about all three plus the
 * consumer group's pending list. Substituting any of them would leave the test
 * proving our TypeScript (ADR-0004, ADR-0009 make the same argument).
 *
 * Crashes are reproduced by putting the manifest into the exact durable state a
 * crash at that point leaves, and then running recovery. That is not a shortcut:
 * the manifest state *is* everything a restarted process inherits, so a
 * recovery driven from it is the real one.
 *
 * Self-skips without all three URLs so a contributor with partial infrastructure
 * still runs everything else.
 */

const POSTGRES_URL = process.env['TEST_POSTGRES_URL']
const CLICKHOUSE_URL = process.env['TEST_CLICKHOUSE_URL']
const VALKEY_URL = process.env['TEST_VALKEY_URL']
const CH_USER = process.env['TEST_CLICKHOUSE_USER'] ?? 'default'
const CH_PASSWORD = process.env['TEST_CLICKHOUSE_PASSWORD'] ?? ''
/**
 * The insert path's own credential, when the deployment has one.
 *
 * ADR-0005 gives ingest a separate, narrower user, and driving a materialized
 * view is exactly where that narrowness bit once before. Falls back to the
 * migration credential where there is only one user (CI's container).
 */
const CH_INGEST_USER = process.env['TEST_CLICKHOUSE_INGEST_USER'] ?? CH_USER
const CH_INGEST_PASSWORD = process.env['TEST_CLICKHOUSE_INGEST_PASSWORD'] ?? CH_PASSWORD
/**
 * Where the analytics schema is built.
 *
 * Defaults to a throwaway database, which is what CI does. A deployment whose
 * migration credential is scoped to one database (ADR-0005 grants `oa_migration`
 * only `analytics.*`) sets this instead, and the suite then cleans up its own
 * rows rather than dropping the database.
 */
const CH_DATABASE = process.env['TEST_CLICKHOUSE_DB'] ?? `m6test_${Date.now()}`
const CH_OWNS_DATABASE = process.env['TEST_CLICKHOUSE_DB'] === undefined

const describeIfLive = POSTGRES_URL && CLICKHOUSE_URL && VALKEY_URL ? describe : describe.skip

const CH_MIGRATIONS = fileURLToPath(
  new URL('../../packages/clickhouse/migrations/', import.meta.url),
)

describeIfLive('M6 batch worker against live stores', () => {
  const schemaName = `m6w_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  const suiteId = randomUUID().replace(/-/g, '').slice(0, 12)
  const streamKey = `m6_stream_${suiteId}`
  const groupName = `m6_group_${suiteId}`
  const dlqKey = `m6_dlq_${suiteId}`
  const cachePrefix = `m6_${suiteId}:`

  let pool: Pool
  let db: Database
  let redis: ReturnType<typeof createQueueClient>
  let ch: ReturnType<typeof createClient>
  let policy: Policy
  let deps: IngestDeps
  let metrics: ReturnType<typeof createRecordingMetrics>
  let queue: ReturnType<typeof createEventStreamQueue>

  /** Seeded once; every test uses a fresh site so rows never collide. */
  let ownerId: string
  let successorId: string
  const createdSiteIds: string[] = []
  /**
   * Exact keys this suite created, so cleanup never scans.
   *
   * `KEYS ingest_dedup:*` on a shared instance is an O(N) blocking command and
   * a licence to delete something that is not ours. The enqueue helper records
   * what it writes instead.
   */
  const ownedKeys = new Set<string>()

  const chQuery = async <T>(query: string): Promise<T[]> => {
    const result = await ch.query({ query, format: 'JSONEachRow' })
    return await result.json<T>()
  }

  const scalar = async (query: string): Promise<number> => {
    const [row] = await chQuery<Record<string, string>>(query)
    return Number(Object.values(row ?? {})[0] ?? 0)
  }

  const insertUser = async (email: string, anchor: Date | null): Promise<string> => {
    const id = newId()
    await pool.query(`INSERT INTO users (id, name, email) VALUES ($1, $2, $3)`, [id, email, email])
    // A quota anchor is a subscription's, and subscriptions are the hosted
    // service's table: a build without that stream has no anchor to write.
    if (anchor && CLOUD_STREAM_PRESENT) {
      await pool.query(
        `INSERT INTO subscriptions
           (id, billing_account_id, entitlement_state, plan_tier, billing_interval, quota_anchor_at)
         VALUES ($1, $2, 'active', 'starter', 'month', $3)`,
        [newId(), await ensureBillingAccount(pool, id), anchor],
      )
    }
    return id
  }

  const createSite = async (
    options: { ownerUserId?: string; status?: string; generation?: number } = {},
  ): Promise<string> => {
    const siteId = newId()
    const owner = options.ownerUserId ?? ownerId
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO sites (id, slug, name, status, owner_user_id, ingest_generation)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          siteId,
          `site-${siteId}`,
          'Site',
          options.status ?? 'active',
          owner,
          options.generation ?? 1,
        ],
      )
      await client.query(
        `INSERT INTO site_members (id, site_id, user_id, role) VALUES ($1, $2, $3, 'owner')`,
        [newId(), siteId, owner],
      )
      // Who funds this site. Cloud migration 0009 made that an account rather
      // than a user (`billing_account_sites`), and the whole table is the hosted
      // service's — a product build funds nothing and bills no one.
      if (CLOUD_STREAM_PRESENT) {
        await client.query(
          `INSERT INTO billing_account_sites
             (id, site_id, billing_account_id, version, effective_from)
           VALUES ($1, $2, $3, 1, now() - interval '365 days')`,
          [newId(), siteId, await ensureBillingAccount(client, owner)],
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    createdSiteIds.push(siteId)
    return siteId
  }

  const envelope = (overrides: Partial<PersistedEvent> & { site_id: string }): PersistedEvent => ({
    schema_version: EVENT_SCHEMA_VERSION,
    event_id: `01890000-0000-7000-8000-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    type: 'page_view',
    name: null,
    occurred_at: '2026-07-23T10:00:00.000Z',
    received_at: '2026-07-23T10:00:01.000Z',
    accepted_at: '2026-07-23T10:00:01.000Z',
    clock_skewed: false,
    ingest_generation: 1,
    billing_user_id: ownerId,
    billing_assignment_version: 1,
    usage_window_start: '2026-07-01T00:00:00.000Z',
    usage_window_id: null,
    billing_grace: false,
    billable: true,
    test_mode: false,
    rule_id: null,
    rule_version: null,
    anonymous_id: 'anon-1',
    session_id: null,
    user_id: null,
    page: { url: 'https://shop.example.com/p', path: '/p', title: 'P' },
    source: {
      referrer_domain: null,
      referrer_path: null,
      utm_source: null,
      utm_medium: null,
      utm_campaign: null,
      utm_content: null,
      utm_term: null,
    },
    properties: {},
    context: {
      sdk: 'web',
      sdk_version: '1.0.0',
      device_type: 'desktop',
      browser: 'chrome',
      os: 'macos',
      country: 'AZ',
      city: 'Baku',
    },
    ...overrides,
  })

  /** Enqueues through the collector's real script, so dedup behaves as in production. */
  const enqueue = async (events: readonly PersistedEvent[]): Promise<void> => {
    for (const event of events) {
      ownedKeys.add(dedupKey(event.site_id, event.event_id))
      ownedKeys.add(siteQueueIndexKey(event.site_id, utcDayOf(event.accepted_at)))
    }
    const result = await queue.enqueueBatch(
      events.map((event) => ({
        siteId: event.site_id,
        eventId: event.event_id,
        payloadHash: `h-${event.event_id}`,
        payload: JSON.stringify(event),
        acceptedAt: event.accepted_at,
      })),
    )
    expect(result.outcome).toBe('accepted')
  }

  const readAll = async (count = 100) => await deps.consumer.read({ count, blockMs: 50 })

  const rawCount = (siteId: string) =>
    scalar(`SELECT count() FROM ${CH_DATABASE}.events_raw WHERE site_id = '${siteId}'`)
  const rollupSum = (siteId: string) =>
    scalar(`SELECT sum(events) FROM ${CH_DATABASE}.metrics_1m WHERE site_id = '${siteId}'`)
  const performanceCount = (siteId: string) =>
    scalar(`SELECT count() FROM ${CH_DATABASE}.performance_events WHERE site_id = '${siteId}'`)

  const usageTotal = async (siteId: string): Promise<number> => {
    // Not a join to ingest_batch_items: one delta row against N item rows would
    // count the delta N times. The item table only picks the batches.
    const { rows } = await pool.query<{ total: string }>(
      `SELECT coalesce(sum(d.delta), 0) AS total
         FROM usage_batch_deltas d
        WHERE d.batch_id IN (
          SELECT DISTINCT batch_id FROM ingest_batch_items WHERE site_id = $1
        )`,
      [siteId],
    )
    return Number(rows[0]?.total ?? 0)
  }

  const pendingCount = async (): Promise<number> => (await deps.consumer.pending()).count

  beforeAll(async () => {
    const admin = new Client({ connectionString: POSTGRES_URL as string })
    await admin.connect()
    try {
      await admin.query(`CREATE SCHEMA ${schemaName}`)
    } finally {
      await admin.end()
    }

    const url = new URL(POSTGRES_URL as string)
    url.searchParams.set('options', `-c search_path=${schemaName}`)
    const scoped = url.toString()
    const { logger } = createCapturedLogger()
    await applyPostgresStreams({ connectionString: scoped, logger })
    await migrateClickHouse({
      url: CLICKHOUSE_URL as string,
      username: CH_USER,
      password: CH_PASSWORD,
      database: CH_DATABASE,
      directory: CH_MIGRATIONS,
      logger,
    })

    pool = createPool(scoped)
    db = createDatabase(pool)
    ch = createClient({
      url: CLICKHOUSE_URL as string,
      username: CH_USER,
      password: CH_PASSWORD,
      database: CH_DATABASE,
    })
    redis = createQueueClient({ mode: 'worker', url: VALKEY_URL as string })

    policy = loadPolicy({})
    metrics = createRecordingMetrics()
    queue = createEventStreamQueue({ client: redis, policy, streamKey })

    deps = {
      db,
      consumer: createEventStreamConsumer({
        client: redis,
        consumerName: `m6-${suiteId}`,
        streamKey,
        groupName,
      }),
      maintenance: createQueueMaintenance({
        client: redis,
        streamKey,
        groupName,
        deadLetterKey: dlqKey,
      }),
      clickhouse: createEventsIngest({
        url: CLICKHOUSE_URL as string,
        username: CH_INGEST_USER,
        password: CH_INGEST_PASSWORD,
        database: CH_DATABASE,
      }),
      cache: createRealtimeCache({
        client: redis,
        eventMaxLatenessHours: policy.EVENT_MAX_LATENESS_HOURS,
        keyPrefix: cachePrefix,
      }),
      logger,
      metrics,
      policy,
      consumerName: `m6-${suiteId}`,
      streamName: streamKey,
      consumerGroup: groupName,
      now: () => new Date(),
    }

    await deps.consumer.ensureGroup()

    ownerId = await insertUser(`owner-${suiteId}@example.com`, new Date('2026-01-15T00:00:00.000Z'))
    successorId = await insertUser(
      `successor-${suiteId}@example.com`,
      new Date('2026-02-20T00:00:00.000Z'),
    )
  }, 120_000)

  afterAll(async () => {
    await deps?.clickhouse.close()

    if (ch) {
      if (CH_OWNS_DATABASE) {
        await ch.command({ query: `DROP DATABASE IF EXISTS ${CH_DATABASE}` })
      } else if (createdSiteIds.length > 0) {
        // Scoped to this suite's sites, so a shared database keeps everything
        // that is not ours.
        const ids = createdSiteIds.map((id) => `'${id}'`).join(',')
        for (const table of ['events_raw', 'performance_events', 'metrics_1m']) {
          await ch.command({
            query: `ALTER TABLE ${CH_DATABASE}.${table} DELETE WHERE site_id IN (${ids})`,
            clickhouse_settings: { mutations_sync: '2' },
          })
        }
      }
      await ch.close()
    }

    if (redis) {
      // Only keys this suite created. The cache prefix is suite-scoped, so
      // scanning it cannot reach anything else.
      const doomed: string[] = [streamKey, dlqKey, ...ownedKeys]
      doomed.push(...(await redis.keys(`${cachePrefix}*`)))
      if (doomed.length > 0) await redis.del(...doomed)
      redis.disconnect()
    }

    await pool?.end()
    const admin = new Client({ connectionString: POSTGRES_URL as string })
    await admin.connect()
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
    } finally {
      await admin.end()
    }
  }, 120_000)

  beforeEach(() => {
    metrics.reset()
  })

  // -------------------------------------------------------------------------
  // Acceptance criterion 1 — every crash point yields no loss and no duplicate
  // -------------------------------------------------------------------------

  describe('crash matrix', () => {
    it('crash before the manifest loses nothing: the messages are still pending', async () => {
      const siteId = await createSite()
      await enqueue([envelope({ site_id: siteId })])

      // Read the messages and then "die" — nothing is written, and no manifest
      // exists. The queue is the only record, which is exactly the state the
      // consumer group is designed to leave.
      const messages = await readAll()
      expect(messages).toHaveLength(1)
      expect(await rawCount(siteId)).toBe(0)
      expect(await pendingCount()).toBeGreaterThan(0)

      // A new worker reclaims and completes them.
      const outcomes = await processMessages(deps, messages)
      expect(outcomes.every((outcome) => outcome.kind === 'completed')).toBe(true)
      expect(await rawCount(siteId)).toBe(1)
      expect(await usageTotal(siteId)).toBe(1)
    })

    it('crash after the manifest completes the saved manifest, not a new one', async () => {
      const siteId = await createSite()
      await enqueue([envelope({ site_id: siteId }), envelope({ site_id: siteId })])
      const messages = await readAll()

      const expectedBatchId = deriveBatchId({
        streamName: streamKey,
        consumerGroup: groupName,
        messageIds: messages.map((message) => message.id),
      })

      // Crash between the manifest write and the insert: a `pending` manifest.
      const failing: IngestDeps = {
        ...deps,
        clickhouse: {
          ...deps.clickhouse,
          insertEvents: () => Promise.reject(new Error('worker died')),
        },
      }
      await processMessages(failing, messages)

      const afterCrash = await getManifest(db, expectedBatchId)
      expect(afterCrash?.state).toBe('inserting')
      expect(afterCrash?.items).toHaveLength(2)
      expect(await rawCount(siteId)).toBe(0)

      // Recovery finishes *that* manifest — same id, same two items.
      await pool.query(`UPDATE ingest_batches SET next_attempt_at = NULL WHERE batch_id = $1`, [
        expectedBatchId,
      ])
      const recovered = await recoverManifests(deps, 10)
      expect(recovered.some((outcome) => outcome.kind === 'completed')).toBe(true)

      const done = await getManifest(db, expectedBatchId)
      expect(done?.state).toBe('completed')
      expect(await rawCount(siteId)).toBe(2)
      expect(await usageTotal(siteId)).toBe(2)
    })

    it('an ambiguous ClickHouse timeout retries the same manifest and the same token', async () => {
      const siteId = await createSite()
      await enqueue([envelope({ site_id: siteId }), envelope({ site_id: siteId })])
      const messages = await readAll()

      const batchId = deriveBatchId({
        streamName: streamKey,
        consumerGroup: groupName,
        messageIds: messages.map((message) => message.id),
      })

      // The rows land, and *then* the response is lost. This is the case the
      // stable token exists for: the worker cannot tell it from a failure.
      const tokens: string[] = []
      const ambiguous: IngestDeps = {
        ...deps,
        clickhouse: {
          ...deps.clickhouse,
          async insertEvents(rows, options) {
            tokens.push(options.token)
            await deps.clickhouse.insertEvents(rows, options)
            const { ClickHouseInsertError } = await import('@openanalytics/clickhouse')
            throw new ClickHouseInsertError('socket hang up', {
              ambiguous: true,
              code: 'ETIMEDOUT',
            })
          },
        },
      }

      await processMessages(ambiguous, messages)
      expect(await getManifest(db, batchId).then((m) => m?.state)).toBe('inserting')
      expect(await rawCount(siteId)).toBe(2)

      await pool.query(`UPDATE ingest_batches SET next_attempt_at = NULL WHERE batch_id = $1`, [
        batchId,
      ])
      await recoverManifests(deps, 10)

      // The retry used the same token, so ClickHouse deduplicated it.
      expect(tokens.every((token) => token === batchId)).toBe(true)
      expect(await rawCount(siteId)).toBe(2)
      expect(await rollupSum(siteId)).toBe(2)
      expect(await usageTotal(siteId)).toBe(2)
    })

    it('crash after ClickHouse and before usage records usage exactly once', async () => {
      const siteId = await createSite()
      await enqueue([envelope({ site_id: siteId }), envelope({ site_id: siteId })])
      const messages = await readAll()
      const batchId = deriveBatchId({
        streamName: streamKey,
        consumerGroup: groupName,
        messageIds: messages.map((message) => message.id),
      })

      await processMessages(deps, messages)
      expect(await usageTotal(siteId)).toBe(2)

      // Reproduce the durable state a crash right after `markInserted` leaves,
      // and re-run. The rows are already in ClickHouse and the ledger already
      // holds this batch's delta.
      await pool.query(
        `UPDATE ingest_batches SET state = 'inserted', completed_at = NULL WHERE batch_id = $1`,
        [batchId],
      )
      const manifest = await getManifest(db, batchId)
      expect(manifest).not.toBeNull()
      const outcome = await runManifest(deps, manifest!)

      expect(outcome.kind).toBe('completed')
      expect(await rawCount(siteId)).toBe(2)
      expect(await rollupSum(siteId)).toBe(2)
      expect(await usageTotal(siteId)).toBe(2)
      expect(await readBatchLedgerTotal(db, batchId)).toBe(2)
    })

    it('crash after usage and before the ACK acknowledges without billing again', async () => {
      const siteId = await createSite()
      await enqueue([envelope({ site_id: siteId })])
      const messages = await readAll()
      const batchId = deriveBatchId({
        streamName: streamKey,
        consumerGroup: groupName,
        messageIds: messages.map((message) => message.id),
      })

      await processMessages(deps, messages)

      await pool.query(
        `UPDATE ingest_batches SET state = 'usage_recorded', completed_at = NULL WHERE batch_id = $1`,
        [batchId],
      )
      const manifest = await getManifest(db, batchId)
      const outcome = await runManifest(deps, manifest!)

      expect(outcome.kind).toBe('completed')
      expect(await getManifest(db, batchId).then((m) => m?.state)).toBe('completed')
      expect(await rawCount(siteId)).toBe(1)
      expect(await usageTotal(siteId)).toBe(1)
    })

    it('crash after the ACK and before completion finishes without redoing anything', async () => {
      const siteId = await createSite()
      await enqueue([envelope({ site_id: siteId })])
      const messages = await readAll()
      const batchId = deriveBatchId({
        streamName: streamKey,
        consumerGroup: groupName,
        messageIds: messages.map((message) => message.id),
      })
      await processMessages(deps, messages)

      // Messages already ACKed (they are gone from the pending list) but the
      // manifest never reached `completed`.
      await pool.query(
        `UPDATE ingest_batches SET state = 'usage_recorded', completed_at = NULL WHERE batch_id = $1`,
        [batchId],
      )
      const manifest = await getManifest(db, batchId)
      await runManifest(deps, manifest!)

      expect(await getManifest(db, batchId).then((m) => m?.state)).toBe('completed')
      expect(await rawCount(siteId)).toBe(1)
      expect(await usageTotal(siteId)).toBe(1)
    })

    it('a completed manifest re-run writes nothing at all', async () => {
      const siteId = await createSite()
      await enqueue([envelope({ site_id: siteId })])
      const messages = await readAll()
      await processMessages(deps, messages)
      const batchId = deriveBatchId({
        streamName: streamKey,
        consumerGroup: groupName,
        messageIds: messages.map((message) => message.id),
      })

      const manifest = await getManifest(db, batchId)
      await runManifest(deps, manifest!)

      expect(await rawCount(siteId)).toBe(1)
      expect(await usageTotal(siteId)).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // Acceptance criterion 2 — one event in two client batches
  // -------------------------------------------------------------------------

  it('gives one raw row and one usage unit for an event sent in two client batches', async () => {
    const siteId = await createSite()
    const event = envelope({ site_id: siteId })

    await enqueue([event])
    // The same event id and the same payload hash, in a second request. The
    // collector's dedup script is what makes this a single stream entry
    // (D-209 step 1); the worker never even sees a second copy.
    await enqueue([event])

    const messages = await readAll()
    expect(messages).toHaveLength(1)

    await processMessages(deps, messages)

    expect(await rawCount(siteId)).toBe(1)
    expect(await rollupSum(siteId)).toBe(1)
    expect(await usageTotal(siteId)).toBe(1)
  })

  // -------------------------------------------------------------------------
  // Acceptance criterion 3 — a manifest retry does not double a dependent MV
  // -------------------------------------------------------------------------

  it('does not double the dependent materialized views on a manifest retry', async () => {
    const siteId = await createSite()
    const events = [
      envelope({ site_id: siteId }),
      envelope({ site_id: siteId }),
      envelope({
        site_id: siteId,
        type: 'web_vital',
        billable: false,
        test_mode: false,
        rule_id: null,
        rule_version: null,
        web_vital: { metric: 'LCP', value: 1200, rating: 'good' },
      }),
    ]
    await enqueue(events)
    const messages = await readAll()
    const batchId = deriveBatchId({
      streamName: streamKey,
      consumerGroup: groupName,
      messageIds: messages.map((message) => message.id),
    })

    await processMessages(deps, messages)
    expect(await rawCount(siteId)).toBe(3)
    expect(await rollupSum(siteId)).toBe(3)
    expect(await performanceCount(siteId)).toBe(1)

    // Three more insert attempts under the same manifest and the same token.
    // This is ADR-0005's finding as an end-to-end test: without the dedup window
    // on every MV target, the raw table would stay at 3 while the rollup climbed
    // to 12 and the performance table to 4.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await pool.query(
        `UPDATE ingest_batches SET state = 'pending', completed_at = NULL WHERE batch_id = $1`,
        [batchId],
      )
      const manifest = await getManifest(db, batchId)
      await runManifest(deps, manifest!)
    }

    expect(await rawCount(siteId)).toBe(3)
    expect(await rollupSum(siteId)).toBe(3)
    expect(await performanceCount(siteId)).toBe(1)
    expect(await usageTotal(siteId)).toBe(2)
  })

  // -------------------------------------------------------------------------
  // The audit's addition — typed payloads must survive the row mapping
  // -------------------------------------------------------------------------

  it('turns a web_vital event into a performance_events row end to end', async () => {
    const siteId = await createSite()
    await enqueue([
      envelope({
        site_id: siteId,
        type: 'web_vital',
        billable: false,
        test_mode: false,
        rule_id: null,
        rule_version: null,
        web_vital: { metric: 'INP', value: 187.5, rating: 'needs-improvement' },
      }),
    ])
    await processMessages(deps, await readAll())

    const [row] = await chQuery<{ metric: string; value: number; rating: string }>(
      `SELECT metric, value, rating FROM ${CH_DATABASE}.performance_events
        WHERE site_id = '${siteId}'`,
    )
    expect(row?.metric).toBe('INP')
    expect(Number(row?.value)).toBeCloseTo(187.5, 3)
    expect(row?.rating).toBe('needs-improvement')
  })

  it('keeps an interaction payload intact all the way into events_raw', async () => {
    const siteId = await createSite()
    await enqueue([
      envelope({
        site_id: siteId,
        type: 'interaction',
        billable: false,
        test_mode: false,
        rule_id: null,
        rule_version: null,
        interaction: {
          x_percent: 42.5,
          y_percent: 10,
          viewport_class: 'desktop',
          viewport_width: 1440,
          selector: 'main > button.buy',
          text: 'Buy now',
        },
      }),
    ])
    await processMessages(deps, await readAll())

    const [row] = await chQuery<{ properties: string }>(
      `SELECT properties FROM ${CH_DATABASE}.events_raw
        WHERE site_id = '${siteId}' AND type = 'interaction'`,
    )
    expect(JSON.parse(row?.properties ?? '{}')).toMatchObject({
      oa_x_percent: 42.5,
      oa_selector: 'main > button.buy',
      oa_viewport_class: 'desktop',
      oa_text: 'Buy now',
    })
  })

  // -------------------------------------------------------------------------
  // Acceptance criterion 4 — the worker's write time never shifts a window
  // -------------------------------------------------------------------------

  // Skipped since the open-core split: a usage *window* is the hosted service's
  // (`apps/worker/src/cloud`, `registerUsageAttributionExtension`), and this
  // harness builds the product worker, which attributes without one. The claim
  // still matters and still has to be pinned — against a worker that mounts that
  // extension, from a `tests/integration/cloud/` harness that does not exist yet.
  it.skip('bills into the window accepted_at falls in, however late the worker runs', async () => {
    const siteId = await createSite()
    // The anchor is 15 Jan, so windows run 15th to 15th. This event was accepted
    // on 20 May and belongs to the 15 May window — regardless of the fact that
    // the worker is processing it now.
    await enqueue([
      envelope({
        site_id: siteId,
        accepted_at: '2026-05-20T08:00:00.000Z',
        occurred_at: '2026-05-20T08:00:00.000Z',
        received_at: '2026-05-20T08:00:00.000Z',
        usage_window_start: '2026-05-15T00:00:00.000Z',
      }),
    ])
    await processMessages(deps, await readAll())

    const { rows } = await pool.query<{ starts_at: Date; delta: number }>(
      `SELECT w.starts_at, d.delta
         FROM usage_batch_deltas d
         JOIN usage_windows w ON w.id = d.usage_window_id
        WHERE d.batch_id IN (
          SELECT DISTINCT batch_id FROM ingest_batch_items WHERE site_id = $1
        )`,
      [siteId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.starts_at.toISOString()).toBe('2026-05-15T00:00:00.000Z')
  })

  // -------------------------------------------------------------------------
  // Acceptance criterion 5 — a billing-owner cutover
  // -------------------------------------------------------------------------

  // Skipped for the same reason as the window case above: funding history and
  // the attribution that reads it are the hosted service's.
  it.skip('bills events either side of a billing-owner cutover to the right user', async () => {
    const siteId = await createSite()
    const cutover = new Date('2026-06-10T12:00:00.000Z')

    // The history is the authority (02 §7.1 item 10). Both events carry the
    // *old* owner in their snapshot, as a stale collector cache would produce.
    await pool.query(
      `UPDATE billing_account_sites SET effective_to = $2 WHERE site_id = $1 AND version = 1`,
      [siteId, cutover],
    )
    await pool.query(
      `INSERT INTO site_members (id, site_id, user_id, role) VALUES ($1, $2, $3, 'owner')`,
      [newId(), siteId, successorId],
    )
    await pool.query(
      `INSERT INTO billing_account_sites
         (id, site_id, billing_account_id, version, effective_from)
       VALUES ($1, $2, $3, 2, $4)`,
      [newId(), siteId, await ensureBillingAccount(pool, successorId), cutover],
    )

    await enqueue([
      envelope({
        site_id: siteId,
        accepted_at: '2026-06-10T11:00:00.000Z',
        occurred_at: '2026-06-10T11:00:00.000Z',
        received_at: '2026-06-10T11:00:00.000Z',
      }),
      envelope({
        site_id: siteId,
        accepted_at: '2026-06-10T13:00:00.000Z',
        occurred_at: '2026-06-10T13:00:00.000Z',
        received_at: '2026-06-10T13:00:00.000Z',
      }),
    ])
    await processMessages(deps, await readAll())

    const { rows } = await pool.query<{ billing_user_id: string; delta: number }>(
      `SELECT d.billing_user_id, sum(d.delta)::int AS delta
         FROM usage_batch_deltas d
        WHERE d.batch_id IN (
          SELECT DISTINCT batch_id FROM ingest_batch_items WHERE site_id = $1
        )
        GROUP BY d.billing_user_id`,
      [siteId],
    )

    const byUser = new Map(rows.map((row) => [row.billing_user_id, Number(row.delta)]))
    expect(byUser.get(ownerId)).toBe(1)
    expect(byUser.get(successorId)).toBe(1)
  })

  // -------------------------------------------------------------------------
  // The D-210 write fence
  // -------------------------------------------------------------------------

  describe('write fence', () => {
    it('drops a deleting site’s rows with an audit trail instead of writing them', async () => {
      const siteId = await createSite()
      await enqueue([envelope({ site_id: siteId })])
      const messages = await readAll()
      await pool.query(`UPDATE sites SET status = 'deleting' WHERE id = $1`, [siteId])

      await processMessages(deps, messages)

      expect(await rawCount(siteId)).toBe(0)
      expect(await usageTotal(siteId)).toBe(0)

      const { rows } = await pool.query<{ state: string; drop_reason: string; row_count: number }>(
        `SELECT state, drop_reason, row_count FROM ingest_batch_sites WHERE site_id = $1`,
        [siteId],
      )
      expect(rows[0]?.state).toBe('dropped')
      expect(rows[0]?.drop_reason).toBe('site_deleting')
      expect(Number(rows[0]?.row_count)).toBe(1)
      expect(metrics.countOf('worker_fence_dropped')).toBeGreaterThan(0)
    })

    it('drops rows whose generation no longer matches the site', async () => {
      const siteId = await createSite()
      await enqueue([envelope({ site_id: siteId, ingest_generation: 1 })])
      const messages = await readAll()
      await pool.query(`UPDATE sites SET ingest_generation = 2 WHERE id = $1`, [siteId])

      await processMessages(deps, messages)

      expect(await rawCount(siteId)).toBe(0)
      const { rows } = await pool.query<{ drop_reason: string; observed_generation: number }>(
        `SELECT drop_reason, observed_generation FROM ingest_batch_sites WHERE site_id = $1`,
        [siteId],
      )
      expect(rows[0]?.drop_reason).toBe('generation_mismatch')
      expect(Number(rows[0]?.observed_generation)).toBe(2)
    })

    it('settles the fence registration so a deletion drain is not blocked by it', async () => {
      const siteId = await createSite()
      await enqueue([envelope({ site_id: siteId })])
      await processMessages(deps, await readAll())

      const { rows } = await pool.query<{ state: string }>(
        `SELECT state FROM ingest_batch_sites WHERE site_id = $1`,
        [siteId],
      )
      expect(rows[0]?.state).toBe('written')
    })
  })

  // -------------------------------------------------------------------------
  // Plan item 13 — an XDEL-ed message in the pending list
  // -------------------------------------------------------------------------

  it('drops a manifest message whose stream entry was deleted, with an audit trail', async () => {
    const siteId = await createSite()
    await enqueue([envelope({ site_id: siteId }), envelope({ site_id: siteId })])
    const messages = await readAll()
    expect(messages).toHaveLength(2)

    // Deletion removes a site's retained entries without waiting for retention
    // (D-210). One of this batch's messages is now unreadable.
    await redis.xdel(streamKey, messages[0]!.id)

    const outcomes = await processMessages(deps, messages)

    expect(outcomes.every((outcome) => outcome.kind === 'completed')).toBe(true)
    // The surviving event is stored; the deleted one is not resurrected.
    expect(await rawCount(siteId)).toBe(1)
    expect(metrics.countOf('worker_message_missing')).toBeGreaterThan(0)
    expect(await pendingCount()).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Retry, dead-letter and manual replay
  // -------------------------------------------------------------------------

  it('dead-letters a batch after its attempts are exhausted, keeping the manifest', async () => {
    const siteId = await createSite()
    await enqueue([envelope({ site_id: siteId })])
    const messages = await readAll()
    const batchId = deriveBatchId({
      streamName: streamKey,
      consumerGroup: groupName,
      messageIds: messages.map((message) => message.id),
    })

    const broken: IngestDeps = {
      ...deps,
      clickhouse: {
        ...deps.clickhouse,
        insertEvents: () => Promise.reject(new Error('clickhouse is gone')),
      },
    }

    await processMessages(broken, messages)
    for (let attempt = 1; attempt < policy.WORKER_BATCH_MAX_ATTEMPTS; attempt += 1) {
      await pool.query(`UPDATE ingest_batches SET next_attempt_at = NULL WHERE batch_id = $1`, [
        batchId,
      ])
      await recoverManifests(broken, 10)
    }

    const manifest = await getManifest(db, batchId)
    expect(manifest?.state).toBe('dead_lettered')
    expect(manifest?.items).toHaveLength(1)
    expect(await redis.xlen(dlqKey)).toBeGreaterThan(0)
    // The queue no longer redelivers it; the DLQ and the manifest hold it.
    expect(await pendingCount()).toBe(0)

    // Manual replay re-enters at the start, and the token protects the retry.
    await pool.query(
      `UPDATE ingest_batches SET state = 'pending', dead_lettered_at = NULL, attempts = 0 WHERE batch_id = $1`,
      [batchId],
    )
    const replayed = await getManifest(db, batchId)
    await runManifest(deps, replayed!)
    expect(await rawCount(siteId)).toBe(1)
    expect(await usageTotal(siteId)).toBe(1)
  })

  // -------------------------------------------------------------------------
  // Retention and the queue-age metric
  // -------------------------------------------------------------------------

  it('never trims past the oldest still-pending entry', async () => {
    const siteId = await createSite()
    await enqueue([envelope({ site_id: siteId })])
    const messages = await readAll()
    expect(messages).toHaveLength(1)

    // A retention horizon far in the future would trim everything, except that
    // this entry has not been acknowledged yet.
    const future: IngestDeps = { ...deps, now: () => new Date(Date.now() + 90 * 86_400_000) }
    await runRetentionTrim(future)

    expect(await redis.xlen(streamKey)).toBeGreaterThan(0)
    // And it is still processable, which is the property that matters.
    await processMessages(deps, messages)
    expect(await rawCount(siteId)).toBe(1)
  })

  it('reports queue age as a gauge that falls back to zero on an empty queue', async () => {
    const age = await deps.maintenance.oldestPendingAgeMs(new Date())
    expect(age === null || age >= 0).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Plan item 11 and the two ADR-0009 carry-forwards
  // -------------------------------------------------------------------------

  describe('operational jobs', () => {
    it('reports zero drift when ClickHouse and the ledger agree', async () => {
      const siteId = await createSite()
      await enqueue([envelope({ site_id: siteId }), envelope({ site_id: siteId })])
      const messages = await readAll()
      const batchId = deriveBatchId({
        streamName: streamKey,
        consumerGroup: groupName,
        messageIds: messages.map((message) => message.id),
      })
      await processMessages(deps, messages)

      const report = await runUsageReconciliation(deps, { sinceMs: 60 * 60 * 1000 })

      expect(report.batchesChecked).toBeGreaterThan(0)
      // Every batch in the window, not just this one: the whole suite's traffic
      // has been through the pipeline by now, so a single drifting batch
      // anywhere is a real disagreement worth failing on. The batch ids are in
      // the message so a failure names what disagreed.
      expect({ drifting: report.drifting }).toEqual({ drifting: [] })
      expect(report.drifting.map((entry) => entry.batchId)).not.toContain(batchId)
      expect(report.totalDrift).toBe(0)
      // Published as zero rather than omitted: a gauge that only appears when
      // something is wrong looks exactly like a job that stopped running.
      expect(metrics.gaugeOf('worker_usage_reconciliation_drift')).toBe(0)
    })

    it('names the batch when the ledger and ClickHouse disagree', async () => {
      const siteId = await createSite()
      await enqueue([envelope({ site_id: siteId }), envelope({ site_id: siteId })])
      const messages = await readAll()
      const batchId = deriveBatchId({
        streamName: streamKey,
        consumerGroup: groupName,
        messageIds: messages.map((message) => message.id),
      })
      await processMessages(deps, messages)

      // Corrupt the ledger, which is what a lost usage delta would look like
      // from the outside. This is the measurement that would catch it.
      await pool.query(`UPDATE usage_batch_deltas SET delta = delta - 1 WHERE batch_id = $1`, [
        batchId,
      ])

      const report = await runUsageReconciliation(deps, { sinceMs: 60 * 60 * 1000 })

      expect(report.drifting.map((entry) => entry.batchId)).toContain(batchId)
      expect(report.totalDrift).toBeGreaterThan(0)
      expect(metrics.gaugeOf('worker_usage_reconciliation_drift')).toBeGreaterThan(0)
    })

    // Skipped for the same reason as the two window cases above: the rapid-burn
    // notice is one of the two after-effects the hosted usage extension adds
    // (`registerUsageAttributionExtension`.afterApply), and it fires off a plan
    // limit this build has no notion of. It needs the same
    // `tests/integration/cloud/` harness.
    it.skip('writes one rapid-burn outbox row per site per UTC day', async () => {
      const siteId = await createSite()
      // Starter's monthly limit is 50,000, so half is 25,000. The counter is
      // seeded directly: producing 25,000 real events would prove the same thing
      // and take minutes.
      const day = new Date().toISOString().slice(0, 10)
      await redis.set(`${cachePrefix}site_day_billable:${siteId}:${day}`, '30000')

      await enqueue([envelope({ site_id: siteId })])
      await processMessages(deps, await readAll())

      // A second batch on the same day must not produce a second notification.
      await enqueue([envelope({ site_id: siteId })])
      await processMessages(deps, await readAll())

      const { rows } = await pool.query<{ idempotency_key: string; payload: unknown }>(
        `SELECT idempotency_key, payload FROM outbox WHERE topic = 'notification.rapid_burn'
           AND idempotency_key = $1`,
        [`rapid_burn:${siteId}:${day}`],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]?.payload).toMatchObject({ site_id: siteId, window_limit: 50_000 })
    })

    it('writes no rapid-burn row for a site well inside its limit', async () => {
      const siteId = await createSite()
      await enqueue([envelope({ site_id: siteId })])
      await processMessages(deps, await readAll())

      const { rows } = await pool.query(`SELECT 1 FROM outbox WHERE idempotency_key LIKE $1`, [
        `rapid_burn:${siteId}:%`,
      ])
      expect(rows).toHaveLength(0)
    })

    it('raises the ceiling alert on the third consecutive day, and not the second', async () => {
      const siteId = await createSite()
      await enqueue([envelope({ site_id: siteId })])
      await processMessages(deps, await readAll())

      const ceiling = policy.SITE_DAILY_EVENT_CEILING
      const dayKey = (offset: number) =>
        `${cachePrefix}site_day_events:${siteId}:${new Date(Date.now() - offset * 86_400_000)
          .toISOString()
          .slice(0, 10)}`

      // Scoped to this site: the check sweeps every recently-ingested site, so
      // another test's site legitimately appears in the same result.
      const alertFor = async () =>
        (await runCeilingDayCheck(deps)).find((alert) => alert.siteId === siteId) ?? null

      // Two days at the ceiling: G-005 says three.
      await redis.set(dayKey(1), String(ceiling))
      await redis.set(dayKey(2), String(ceiling))
      expect(await alertFor()).toBeNull()

      await redis.set(dayKey(3), String(ceiling))
      const alert = await alertFor()

      expect(alert).not.toBeNull()
      expect(alert?.consecutiveDays).toBeGreaterThanOrEqual(3)
      // An alert, never an automatic block (G-005).
      const { rows } = await pool.query<{ status: string }>(
        `SELECT status FROM sites WHERE id = $1`,
        [siteId],
      )
      expect(rows[0]?.status).toBe('active')
    })

    it('does not count a broken streak', async () => {
      const siteId = await createSite()
      await enqueue([envelope({ site_id: siteId })])
      await processMessages(deps, await readAll())

      const ceiling = policy.SITE_DAILY_EVENT_CEILING
      const dayKey = (offset: number) =>
        `${cachePrefix}site_day_events:${siteId}:${new Date(Date.now() - offset * 86_400_000)
          .toISOString()
          .slice(0, 10)}`

      await redis.set(dayKey(1), String(ceiling))
      await redis.set(dayKey(2), '1')
      await redis.set(dayKey(3), String(ceiling))

      const alerts = await runCeilingDayCheck(deps)
      expect(alerts.map((entry) => entry.siteId)).not.toContain(siteId)
    })
  })

  // -------------------------------------------------------------------------
  // Acceptance criterion 6 — healthy freshness
  // -------------------------------------------------------------------------

  it('keeps healthy low-traffic freshness under three seconds', async () => {
    const siteId = await createSite()
    const samples: number[] = []

    for (let round = 0; round < 10; round += 1) {
      const acceptedAt = new Date()
      await enqueue([
        envelope({
          site_id: siteId,
          accepted_at: acceptedAt.toISOString(),
          received_at: acceptedAt.toISOString(),
          occurred_at: acceptedAt.toISOString(),
        }),
      ])
      const messages = await readAll()
      await processMessages(deps, messages)
      samples.push(Date.now() - acceptedAt.getTime())
    }

    samples.sort((a, b) => a - b)
    const p95 = samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)] ?? 0
    // Printed as well as asserted: the number is the deliverable, and a bare
    // pass tells a reader nothing about how much headroom there is.
    // eslint-disable-next-line no-console
    console.log(`[m6] freshness p50=${samples[Math.floor(samples.length / 2)]}ms p95=${p95}ms`)

    // G-003's healthy ingest freshness target, measured accepted_at → durable in
    // ClickHouse, which is the boundary the criterion names. Meaningful only
    // where the three stores are in one region, as they are in CI and in
    // production; over a developer's tunnel this measures the tunnel.
    expect(p95).toBeLessThan(3_000)
    expect(await rawCount(siteId)).toBe(10)
  }, 180_000)
})
