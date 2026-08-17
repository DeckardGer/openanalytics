import { randomUUID } from 'node:crypto'
import { EVENT_SCHEMA_VERSION, type PersistedEvent } from '@openanalytics/contracts'
import type { EventsIngest } from '@openanalytics/clickhouse'
import { deriveBatchId, loadPolicy, type Policy } from '@openanalytics/domain'
import { createRecordingMetrics } from '@openanalytics/observability'
import {
  createDatabase,
  createOrContinueManifest,
  createSiteWithOwner,
  getManifest,
  newId,
  registerBatchSites,
  replayDeadLettered,
  type Database,
  type Manifest,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import type { EventStreamConsumer, QueueMaintenance, StreamMessage } from '@openanalytics/redis'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { IngestDeps } from '../../apps/worker/src/ingest/deps.ts'
import { runManifest } from '../../apps/worker/src/ingest/pipeline.ts'

/**
 * The D-210 write fence must never leave a registration open forever.
 *
 * `ingest_batch_sites.state = 'registered'` is the M10 deletion drain's
 * definition of "a writer is still in flight for this site". A row that stays in
 * that state after its batch has stopped does not merely look untidy — it blocks
 * the deletion of that site permanently, because nothing revisits a finished
 * batch. Two paths produced exactly that and are what this suite pins:
 *
 *   * a **dead-lettered** batch. The manifest reached its terminal state and the
 *     fence rows were never touched;
 *   * a **crash between the insert and the settle**. Recovery reads the manifest,
 *     `recoveryActionFor('inserted')` says `record_usage`, and the resumed run
 *     skipped the settle step entirely — the batch then completed with its fence
 *     rows still open.
 *
 * Postgres is the whole subject here, so ClickHouse and the queue are stubs: what
 * is being proven is which rows the pipeline leaves behind in *this* database
 * after each interruption, not that a row reached ClickHouse (the live M6 suite
 * proves that). Driving the real `runManifest` matters, though — the second bug
 * was in its step ordering, and a repository-level test would have passed
 * throughout.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

const STREAM = 'event_stream'
const GROUP = 'ingest_workers'

describeIfPostgres('write fence settlement', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `fence_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database
  let policy: Policy
  let ownerId: string

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
    db = createDatabase(pool)
    policy = loadPolicy({})

    ownerId = newId()
    await pool.query(
      `INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'U', $2, true)`,
      [ownerId, `${ownerId}@example.com`],
    )
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

  const createSite = async (): Promise<string> => {
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId: ownerId,
    })
    return siteId
  }

  // A lowercase UUIDv7, which is what the envelope schema accepts. A v4 here
  // parses as an invalid payload, the pipeline drops it, and every assertion
  // below would then be made about an empty batch.
  const eventId = () => `01890000-0000-7000-8000-${randomUUID().replace(/-/g, '').slice(0, 12)}`

  const envelope = (siteId: string): PersistedEvent => ({
    schema_version: EVENT_SCHEMA_VERSION,
    event_id: eventId(),
    site_id: siteId,
    type: 'page_view',
    name: null,
    occurred_at: '2026-07-27T10:00:00.000Z',
    received_at: '2026-07-27T10:00:01.000Z',
    accepted_at: '2026-07-27T10:00:01.000Z',
    clock_skewed: false,
    ingest_generation: 1,
    billing_user_id: ownerId,
    billing_assignment_version: 1,
    usage_window_start: '2026-07-01T00:00:00.000Z',
    usage_window_id: null,
    billing_grace: false,
    billable: true,
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
  })

  let messageCounter = 0

  const messageFor = (event: PersistedEvent): StreamMessage => ({
    id: `1721000000000-${(messageCounter += 1)}`,
    siteId: event.site_id,
    eventId: event.event_id,
    payloadHash: 'ph',
    acceptedAt: event.accepted_at,
    payload: JSON.stringify(event),
  })

  /** A consumer that answers from an in-memory batch; ACKs are counted, not sent. */
  const stubConsumer = (messages: readonly StreamMessage[]): EventStreamConsumer => {
    const byId = new Map(messages.map((message) => [message.id, message]))
    return {
      ensureGroup: () => Promise.resolve(false),
      read: () => Promise.resolve([]),
      ack: (ids) => Promise.resolve(ids.length),
      reclaim: () => Promise.resolve({ nextCursor: '0-0', messages: [], deletedIds: [] }),
      pending: () => Promise.resolve({ count: 0, minId: null, maxId: null, consumers: [] }),
      fetchByIds: (ids) => {
        const found = ids.map((id) => byId.get(id)).filter((m): m is StreamMessage => Boolean(m))
        const missing = ids.filter((id) => !byId.has(id))
        return Promise.resolve({ messages: found, missingIds: missing })
      },
    }
  }

  const stubMaintenance: QueueMaintenance = {
    publishDeadLetter: (input: { messages: readonly StreamMessage[] }) =>
      Promise.resolve(input.messages.length),
    trim: () => Promise.resolve(0),
    queueAgeMs: () => Promise.resolve(0),
  } as unknown as QueueMaintenance

  const okClickHouse: EventsIngest = {
    insertEvents: (rows: readonly unknown[]) =>
      Promise.resolve({ rows: rows.length, durationMs: 1 }),
  } as unknown as EventsIngest

  const brokenClickHouse: EventsIngest = {
    insertEvents: () => Promise.reject(new Error('clickhouse is gone')),
  } as unknown as EventsIngest

  const depsFor = (input: {
    messages: readonly StreamMessage[]
    clickhouse: EventsIngest
  }): IngestDeps => {
    const { logger } = createCapturedLogger()
    return {
      db,
      consumer: stubConsumer(input.messages),
      maintenance: stubMaintenance,
      clickhouse: input.clickhouse,
      cache: null,
      logger,
      metrics: createRecordingMetrics(),
      policy,
      consumerName: 'test-worker',
      streamName: STREAM,
      consumerGroup: GROUP,
      now: () => new Date(),
    }
  }

  /** Plan a manifest exactly as the worker would, and return it. */
  const planManifest = async (messages: readonly StreamMessage[]): Promise<Manifest> => {
    const messageIds = messages.map((message) => message.id)
    const batchId = deriveBatchId({ streamName: STREAM, consumerGroup: GROUP, messageIds })
    const plan = await createOrContinueManifest(db, {
      batchId,
      streamName: STREAM,
      consumerGroup: GROUP,
      payloadHash: 'ph',
      byteSize: 100,
      messages: messages.map((message) => ({
        messageId: message.id,
        siteId: message.siteId,
        eventId: message.eventId,
        payloadHash: message.payloadHash,
        acceptedAt: new Date(message.acceptedAt),
      })),
      claimedBy: 'test-worker',
      leaseTtlMs: 60_000,
    })
    return plan.manifest
  }

  const fenceRows = async (siteId: string) => {
    const { rows } = await pool.query<{ state: string; settled_at: Date | null }>(
      `SELECT state, settled_at FROM ingest_batch_sites WHERE site_id = $1`,
      [siteId],
    )
    return rows
  }

  const firstEventAt = async (siteId: string): Promise<Date | null> => {
    const { rows } = await pool.query<{ first_event_at: Date | null }>(
      `SELECT first_event_at FROM sites WHERE id = $1`,
      [siteId],
    )
    return rows[0]?.first_event_at ?? null
  }

  // -------------------------------------------------------------------------
  // (a) the dead-letter path
  // -------------------------------------------------------------------------

  it('settles the fence when a batch is dead-lettered', async () => {
    const siteId = await createSite()
    const message = messageFor(envelope(siteId))
    const manifest = await planManifest([message])

    // One attempt short of the limit, so the next failure is the dead-letter.
    await pool.query(`UPDATE ingest_batches SET attempts = $2 WHERE batch_id = $1`, [
      manifest.batchId,
      policy.WORKER_BATCH_MAX_ATTEMPTS - 1,
    ])
    const reloaded = await getManifest(db, manifest.batchId)

    const outcome = await runManifest(
      depsFor({ messages: [message], clickhouse: brokenClickHouse }),
      reloaded!,
    )

    expect(outcome.kind).toBe('dead_lettered')
    expect((await getManifest(db, manifest.batchId))?.state).toBe('dead_lettered')

    const rows = await fenceRows(siteId)
    expect(rows).toHaveLength(1)
    // Not `written`: a batch that died in `inserting` may or may not have landed
    // rows, and the settle state must not claim an answer nobody has.
    expect(rows[0]?.state).toBe('abandoned')
    expect(rows[0]?.settled_at).not.toBeNull()

    // The drain's question: is anything still in flight for this site?
    const { rows: open } = await pool.query(
      `SELECT 1 FROM ingest_batch_sites WHERE site_id = $1 AND state = 'registered'`,
      [siteId],
    )
    expect(open).toHaveLength(0)
  })

  it('leaves an already-dropped registration exactly as the fence recorded it', async () => {
    const siteId = await createSite()
    const message = messageFor(envelope(siteId))
    const manifest = await planManifest([message])

    // The fence refuses this write: the site is on its way out.
    await pool.query(`UPDATE sites SET status = 'deleting' WHERE id = $1`, [siteId])
    const decisions = await registerBatchSites(db, {
      batchId: manifest.batchId,
      registrations: [{ siteId, ingestGeneration: 1, rowCount: 1 }],
    })
    expect(decisions[0]?.admitted).toBe(false)

    await pool.query(`UPDATE ingest_batches SET attempts = $2 WHERE batch_id = $1`, [
      manifest.batchId,
      policy.WORKER_BATCH_MAX_ATTEMPTS - 1,
    ])
    const reloaded = await getManifest(db, manifest.batchId)
    await runManifest(depsFor({ messages: [message], clickhouse: brokenClickHouse }), reloaded!)

    const rows = await fenceRows(siteId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.state).toBe('dropped')
  })

  // -------------------------------------------------------------------------
  // (b) the crash between `markInserted` and the settle
  // -------------------------------------------------------------------------

  it('settles the fence when recovery resumes at record_usage', async () => {
    const siteId = await createSite()
    const message = messageFor(envelope(siteId))
    const manifest = await planManifest([message])

    // Exactly the crash: the fence is registered, ClickHouse holds the rows, the
    // manifest says `inserted` — and the process died before it could settle.
    await registerBatchSites(db, {
      batchId: manifest.batchId,
      registrations: [{ siteId, ingestGeneration: 1, rowCount: 1 }],
    })
    await pool.query(
      `UPDATE ingest_batches SET state = 'inserted', inserted_at = now() WHERE batch_id = $1`,
      [manifest.batchId],
    )

    const before = await fenceRows(siteId)
    expect(before[0]?.state).toBe('registered')

    const recovered = await getManifest(db, manifest.batchId)
    expect(recovered?.state).toBe('inserted')

    const outcome = await runManifest(
      depsFor({ messages: [message], clickhouse: okClickHouse }),
      recovered!,
    )

    expect(outcome.kind).toBe('completed')
    expect((await getManifest(db, manifest.batchId))?.state).toBe('completed')

    const rows = await fenceRows(siteId)
    expect(rows[0]?.state).toBe('written')
    expect(rows[0]?.settled_at).not.toBeNull()
  })

  it('settles a registration left open behind the ACK-only recovery path', async () => {
    // The backstop in `markCompleted`. `recoveryActionFor('usage_recorded')` is
    // `ack`, which touches neither the insert block nor the usage block, so a row
    // still open at that point has no other path to a terminal state.
    const siteId = await createSite()
    const message = messageFor(envelope(siteId))
    const manifest = await planManifest([message])

    await registerBatchSites(db, {
      batchId: manifest.batchId,
      registrations: [{ siteId, ingestGeneration: 1, rowCount: 1 }],
    })
    await pool.query(
      `UPDATE ingest_batches SET state = 'usage_recorded', inserted_at = now() WHERE batch_id = $1`,
      [manifest.batchId],
    )

    const recovered = await getManifest(db, manifest.batchId)
    await runManifest(depsFor({ messages: [message], clickhouse: okClickHouse }), recovered!)

    const rows = await fenceRows(siteId)
    expect(rows[0]?.state).toBe('written')
  })

  // -------------------------------------------------------------------------
  // Replay re-asks the fence question
  // -------------------------------------------------------------------------

  it('discards the stale fence decisions when a dead-lettered batch is replayed', async () => {
    const siteId = await createSite()
    const message = messageFor(envelope(siteId))
    const manifest = await planManifest([message])

    await pool.query(`UPDATE ingest_batches SET attempts = $2 WHERE batch_id = $1`, [
      manifest.batchId,
      policy.WORKER_BATCH_MAX_ATTEMPTS - 1,
    ])
    await runManifest(
      depsFor({ messages: [message], clickhouse: brokenClickHouse }),
      (await getManifest(db, manifest.batchId))!,
    )
    expect((await fenceRows(siteId))[0]?.state).toBe('abandoned')

    await replayDeadLettered(db, manifest.batchId)
    expect(await fenceRows(siteId)).toHaveLength(0)

    // The site was deleted while the batch sat in the dead-letter stream. The
    // replay must re-decide against that, not reuse the decision it took before —
    // `registerBatchSites` writes ON CONFLICT DO NOTHING, so a surviving row would
    // have let the replay write for a site on its way out.
    await pool.query(`UPDATE sites SET status = 'deleting' WHERE id = $1`, [siteId])
    await runManifest(
      depsFor({ messages: [message], clickhouse: okClickHouse }),
      (await getManifest(db, manifest.batchId))!,
    )

    const rows = await fenceRows(siteId)
    expect(rows[0]?.state).toBe('dropped')
  })

  // -------------------------------------------------------------------------
  // The install-verified signal takes the same interruptions (ADR-0027)
  // -------------------------------------------------------------------------

  /**
   * `sites.first_event_at` is filled from `runManifest`'s `state === 'inserted'`
   * block, which is the same block the fence settles in — so it inherits every
   * interruption this suite already drives, and it is pinned here rather than in
   * a unit test for the reason the header gives: the claim is about which rows
   * this database holds after each interruption, and a repository-level test
   * cannot see the step ordering that decides them.
   *
   * The claim the field makes to onboarding is narrow and easy to break in
   * either direction: a value must mean an event really is durable in
   * ClickHouse, and NULL must keep meaning "nothing has ever landed" for a site
   * whose events the fence refused. Both halves are step-ordering facts.
   *
   * Every case takes a **fresh** site. `pipeline.ts` holds its already-filled
   * `Set` at module scope with no reset hook, so a site id reused across cases
   * would contribute no candidate the second time and the assertion would pass
   * for the wrong reason.
   */

  it('leaves first_event_at NULL when the batch is dead-lettered', async () => {
    const siteId = await createSite()
    const message = messageFor(envelope(siteId))
    const manifest = await planManifest([message])

    await pool.query(`UPDATE ingest_batches SET attempts = $2 WHERE batch_id = $1`, [
      manifest.batchId,
      policy.WORKER_BATCH_MAX_ATTEMPTS - 1,
    ])

    const outcome = await runManifest(
      depsFor({ messages: [message], clickhouse: brokenClickHouse }),
      (await getManifest(db, manifest.batchId))!,
    )

    expect(outcome.kind).toBe('dead_lettered')
    // The ordering is the whole point: the fill sits after the insert, so a
    // batch whose rows never reached ClickHouse cannot leave the site claiming
    // to have received data it does not have. Onboarding would show a green
    // "installed" over an empty dashboard, and nothing would ever correct it —
    // the `IS NULL` guard means the value, once wrong, is wrong forever.
    expect(await firstEventAt(siteId)).toBeNull()
  })

  it('fills first_event_at with the batch minimum when recovery resumes at record_usage', async () => {
    const siteId = await createSite()
    // Deliberately out of time order, so "the first event in manifest order" and
    // "the earliest event in the batch" are different answers.
    const later = messageFor({ ...envelope(siteId), occurred_at: '2026-07-27T10:05:00.000Z' })
    const earliest = messageFor({ ...envelope(siteId), occurred_at: '2026-07-27T09:40:00.000Z' })
    const messages = [later, earliest]
    const manifest = await planManifest(messages)

    // The same crash as the fence case above: ClickHouse holds the rows, the
    // manifest says `inserted`, and the process died before anything after it.
    await registerBatchSites(db, {
      batchId: manifest.batchId,
      registrations: [{ siteId, ingestGeneration: 1, rowCount: messages.length }],
    })
    await pool.query(
      `UPDATE ingest_batches SET state = 'inserted', inserted_at = now() WHERE batch_id = $1`,
      [manifest.batchId],
    )
    expect(await firstEventAt(siteId)).toBeNull()

    const outcome = await runManifest(
      depsFor({ messages, clickhouse: okClickHouse }),
      (await getManifest(db, manifest.batchId))!,
    )

    expect(outcome.kind).toBe('completed')
    // `recoveryActionFor('inserted')` is `record_usage`, so the resumed run
    // re-enters the block and fills what the crashed process did not — and the
    // value is the minimum across the batch, not the first row it walked.
    expect((await firstEventAt(siteId))?.toISOString()).toBe('2026-07-27T09:40:00.000Z')
  })

  it('skips a fenced-out site while filling the healthy one in the same batch', async () => {
    const healthyId = await createSite()
    const fencedId = await createSite()
    const messages = [messageFor(envelope(healthyId)), messageFor(envelope(fencedId))]
    const manifest = await planManifest(messages)

    // A revoked or rotated key bumps the site's generation. The batch's events
    // still carry the generation they were accepted under, so the fence drops
    // them with `generation_mismatch` while the rest of the batch proceeds.
    await pool.query(`UPDATE sites SET ingest_generation = 2 WHERE id = $1`, [fencedId])

    const outcome = await runManifest(
      depsFor({ messages, clickhouse: okClickHouse }),
      (await getManifest(db, manifest.batchId))!,
    )

    expect(outcome.kind).toBe('completed')
    expect((await fenceRows(fencedId))[0]?.state).toBe('dropped')

    // The fill reads `writable`, post-fence — never `batch.events`. A site whose
    // rows were refused has had nothing land, so its signal must stay NULL even
    // though the batch that carried its events succeeded.
    expect(await firstEventAt(healthyId)).not.toBeNull()
    expect(await firstEventAt(fencedId)).toBeNull()
  })
})
