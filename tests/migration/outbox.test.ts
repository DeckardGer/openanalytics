import {
  claimDueOutbox,
  createDatabase,
  createPool,
  enqueueOutbox,
  markOutboxDelivered,
  markOutboxFailed,
  newId,
  readOutboxBacklog,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createRecordingMetrics } from '@openanalytics/observability'
import {
  EMAIL_OUTBOX_TOPIC,
  buildVerificationEmailPayload,
  processEmailOutbox,
  selectEmailTransport,
  type EmailOutboxStore,
} from '@openanalytics/integrations'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_OUTBOX_TOPICS, drainOutboxTopic } from '../../apps/worker/src/outbox-dispatcher.ts'

/**
 * The outbox path against a real Postgres: idempotent enqueue, locked claim, and
 * a full enqueue → drain → deliver run through the log transport. This is the
 * database half of "email must go through the outbox"; the request-side wiring
 * and its HTTP test come with the API mount.
 */

/** The policy the handlers read; the defaults `policySchema` declares. */
const POLICY = {
  blockIngestGraceHours: 24,
  blockedDataRetentionDays: 90,
  productName: 'Open Analytics',
} as const

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

describeIfPostgres('outbox repository', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m2outbox_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database

  const emailStore = (database: Database): EmailOutboxStore => ({
    claimDue: (limit) => claimDueOutbox(database, { topic: EMAIL_OUTBOX_TOPIC, limit }),
    markDelivered: (id) => markOutboxDelivered(database, id),
    markFailed: (id, reason) => markOutboxFailed(database, id, reason),
  })

  const enqueueVerification = (to: string, token: string) =>
    enqueueOutbox(db, {
      topic: EMAIL_OUTBOX_TOPIC,
      payload: buildVerificationEmailPayload({
        to,
        url: `https://api.test/verify?token=${token}`,
        productName: 'Acme Metrics',
      }) as unknown as Record<string, unknown>,
      idempotencyKey: `email.verification:${token}`,
    })

  const statusOf = async (idempotencyKey: string) => {
    const result = await pool.query<{
      status: string
      attempts: number
      last_error: string | null
    }>(`SELECT status, attempts, last_error FROM outbox WHERE idempotency_key = $1`, [
      idempotencyKey,
    ])
    return result.rows[0]
  }

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

  it('enqueues idempotently on the idempotency key', async () => {
    const first = await enqueueVerification('a@example.com', 'idem-1')
    const second = await enqueueVerification('a@example.com', 'idem-1')

    expect(first.enqueued).toBe(true)
    expect(second.enqueued).toBe(false)

    const count = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM outbox WHERE idempotency_key = 'email.verification:idem-1'`,
    )
    expect(count.rows[0]?.n).toBe('1')
  })

  it('delivers a due email through the transport and marks it delivered', async () => {
    await enqueueVerification('b@example.com', 'deliver-1')

    const transport = selectEmailTransport({ defaultFrom: 'noreply@test' })
    const result = await processEmailOutbox({ store: emailStore(db), transport })

    expect(result.delivered).toBeGreaterThanOrEqual(1)
    expect(await statusOf('email.verification:deliver-1')).toMatchObject({ status: 'delivered' })
  })

  it('requeues a transient failure and buries an exhausted one', async () => {
    await enqueueVerification('c@example.com', 'retry-1')
    const claimed = await claimDueOutbox(db, { topic: EMAIL_OUTBOX_TOPIC, limit: 10 })
    const target = claimed.find((row) => {
      const payload = row.payload as { to?: string }
      return payload.to === 'c@example.com'
    })
    expect(target).toBeDefined()

    if (target) {
      await markOutboxFailed(db, target.id, 'smtp down')
      expect(await statusOf('email.verification:retry-1')).toMatchObject({
        status: 'pending',
        attempts: 1,
        last_error: 'smtp down',
      })

      // With a single-attempt ceiling the same failed row is buried, not retried.
      await markOutboxFailed(db, target.id, 'smtp down', { maxAttempts: 1 })
      expect(await statusOf('email.verification:retry-1')).toMatchObject({ status: 'dead' })
    }
  })

  it('drains every topic the generic dispatcher owns', async () => {
    // Before this, `site.ownership_changed` and its siblings had a producer and no
    // consumer: their rows sat `pending` for good, and an outbox nobody drains is a
    // side effect that never happens plus a table that only grows.
    // Identifiers of rows that do not exist, which is the point: every handler
    // has to settle a payload whose subject is gone rather than retry it forever.
    // An ownership change that did not block needs no epoch bump; a deletion notice
    // for a scrubbed subject has nothing left to read.
    //
    // `billing.subscription` and `notification.rapid_burn` were in this list until
    // the open-core split. They are registered by the surface that writes them, so
    // a build without it drains the three below and this is that set.
    const absentUser = newId()
    const absentSite = newId()
    const keys = [
      [
        'site.ownership_changed',
        'site.ownership:site_drain_1:1',
        { siteId: absentSite, status: 'active' },
      ],
      // Observe-only until the email milestone; drained all the same (CP3).
      [
        'site.deletion_completed',
        `site.deletion_completed:${absentSite}`,
        { site_id: absentSite, deletion_request_id: newId() },
      ],
      // Likewise (CP4). The subject is a scrubbed users row by the time this is
      // delivered, which is exactly the "settle a payload whose subject is gone"
      // property the whole test is about.
      [
        'account.deletion_completed',
        `account.deletion_completed:${absentUser}`,
        { user_id: absentUser, deletion_request_id: newId() },
      ],
    ] as const

    for (const [topic, idempotencyKey, payload] of keys) {
      await enqueueOutbox(db, { topic, idempotencyKey, payload })
    }

    const { logger } = createCapturedLogger()
    const metrics = createRecordingMetrics()
    for (const registration of DEFAULT_OUTBOX_TOPICS) {
      const result = await drainOutboxTopic({ db, logger, metrics, policy: POLICY }, registration)
      expect(result.failed).toBe(0)
      expect(result.delivered).toBeGreaterThanOrEqual(1)
    }

    for (const [, idempotencyKey] of keys) {
      expect(await statusOf(idempotencyKey)).toMatchObject({ status: 'delivered' })
    }
  })

  it('reports the undelivered backlog by topic and status', async () => {
    await enqueueOutbox(db, {
      topic: 'notification.rapid_burn',
      idempotencyKey: 'rapid_burn:site_backlog:2026-07-27',
      payload: { site_id: 'backlog' },
      // Old enough that the age is unambiguously non-zero.
      availableAt: new Date(Date.now() - 60_000),
    })

    const rows = await readOutboxBacklog(db)
    const pending = rows.find(
      (row) => row.topic === 'notification.rapid_burn' && row.status === 'pending',
    )
    expect(pending?.count).toBeGreaterThanOrEqual(1)
    // Age is measured from `created_at`, not `available_at`: a row retried for an
    // hour has an `available_at` in the future and would report a backlog of ~0
    // while the side effect is still owed.
    expect(pending?.oldestAgeMs).toBeGreaterThanOrEqual(0)

    const dead = rows.find((row) => row.topic === EMAIL_OUTBOX_TOPIC && row.status === 'dead')
    expect(dead?.count).toBeGreaterThanOrEqual(1)
    expect(dead?.oldestAgeMs).toBeGreaterThanOrEqual(0)
  })
})
