import {
  SITE_DELETION_JOB_TYPE,
  claimDueJobs,
  completeJob,
  createDatabase,
  createPool,
  enqueueJob,
  extendJobLease,
  failJobRetryable,
  newId,
  readJobsBacklog,
  updateJobPhase,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * The `jobs` table and its repository against a real Postgres
 * (ADR-0030, decision 3; migration 0027).
 *
 * Everything here needs a database to be true at all. `SKIP LOCKED`, a partial
 * unique index, a CHECK constraint and a lease guard are all promises the
 * database keeps, and a fake would only prove that the repository calls the
 * functions the test expects it to call.
 *
 * The claim is the centre of it: two workers must take disjoint work, a job
 * whose worker died must become claimable again without any reaper loop, and a
 * worker whose lease was stolen must be unable to write over the new holder.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

const LEASE_MS = 60_000

describeIfPostgres('lifecycle jobs', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m10jobs_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database
  // A second pool, so a concurrency test genuinely runs on two connections
  // rather than serializing on one.
  let poolB: Pool
  let dbB: Database

  const jobRow = async (id: string) => {
    const r = await pool.query<{
      id: string
      type: string
      subject_id: string | null
      status: string
      phase: string | null
      attempts: number
      claimed_by: string | null
      lease_expires_at: Date | null
      last_error: string | null
      started_at: Date | null
      finished_at: Date | null
      available_at: Date
    }>(`SELECT * FROM jobs WHERE id = $1`, [id])
    return r.rows[0]
  }

  const enqueue = async (subjectId: string, overrides: { key?: string; availableAt?: Date } = {}) =>
    await enqueueJob(db, {
      type: SITE_DELETION_JOB_TYPE,
      subjectId,
      idempotencyKey: overrides.key ?? `${SITE_DELETION_JOB_TYPE}:${subjectId}`,
      payload: { reason: 'retention_expired' },
      ...(overrides.availableAt === undefined ? {} : { availableAt: overrides.availableAt }),
    })

  const claim = async (
    database: Database,
    input: { limit?: number; now?: Date; claimedBy?: string } = {},
  ) =>
    await claimDueJobs(database, {
      types: [SITE_DELETION_JOB_TYPE],
      claimedBy: input.claimedBy ?? 'worker-1',
      leaseTtlMs: LEASE_MS,
      limit: input.limit ?? 10,
      ...(input.now === undefined ? {} : { now: input.now }),
    })

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
    poolB = createPool(scoped)
    dbB = createDatabase(poolB)
  })

  afterAll(async () => {
    await pool?.end()
    await poolB?.end()
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
    } finally {
      await admin.end()
    }
  })

  beforeEach(async () => {
    await pool.query('DELETE FROM jobs')
  })

  describe('migration 0027 shape', () => {
    it('carries every column the runner needs, with the right nullability', async () => {
      const r = await pool.query<{
        column_name: string
        data_type: string
        is_nullable: string
        column_default: string | null
      }>(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'jobs'`,
        [schemaName],
      )
      const columns = new Map(r.rows.map((row) => [row.column_name, row]))

      for (const name of [
        'id',
        'type',
        'subject_id',
        'status',
        'phase',
        'payload',
        'idempotency_key',
        'attempts',
        'available_at',
        'claimed_by',
        'lease_expires_at',
        'last_error',
        'created_at',
        'updated_at',
        'started_at',
        'finished_at',
      ]) {
        expect(columns.has(name), `jobs.${name}`).toBe(true)
      }

      // The lease columns and the subject are nullable — an unclaimed job names
      // no holder, and a job with no single subject names none.
      expect(columns.get('claimed_by')?.is_nullable).toBe('YES')
      expect(columns.get('lease_expires_at')?.is_nullable).toBe('YES')
      expect(columns.get('subject_id')?.is_nullable).toBe('YES')
      expect(columns.get('subject_id')?.data_type).toBe('uuid')
      // The producer's handle is mandatory: a job with no key could be enqueued
      // twice by the same retried caller.
      expect(columns.get('idempotency_key')?.is_nullable).toBe('NO')
      expect(columns.get('status')?.column_default).toContain('queued')
      expect(columns.get('attempts')?.is_nullable).toBe('NO')
    })

    it('refuses a status outside the vocabulary', async () => {
      await expect(
        pool.query(
          `INSERT INTO jobs (id, type, status, idempotency_key) VALUES ($1, 'x', 'weird', $2)`,
          [newId(), newId()],
        ),
      ).rejects.toThrow(/jobs_status_check|check constraint/iu)
    })

    it('refuses a half-held lease in either direction', async () => {
      // The state a crash between two UPDATEs would leave. It reads as "claimed
      // by nobody, forever" or "expires never", and both strand the job.
      await expect(
        pool.query(
          `INSERT INTO jobs (id, type, idempotency_key, claimed_by) VALUES ($1, 'x', $2, 'w-1')`,
          [newId(), newId()],
        ),
      ).rejects.toThrow(/jobs_lease_check/iu)

      await expect(
        pool.query(
          `INSERT INTO jobs (id, type, idempotency_key, lease_expires_at)
           VALUES ($1, 'x', $2, now())`,
          [newId(), newId()],
        ),
      ).rejects.toThrow(/jobs_lease_check/iu)
    })

    it('allows a second job for a subject whose first job is terminal', async () => {
      // The partial unique excludes the terminal statuses on purpose: history
      // must not block the future.
      const subject = newId()
      const first = await enqueue(subject)
      await pool.query(
        `UPDATE jobs SET status = 'succeeded', claimed_by = NULL, lease_expires_at = NULL
          WHERE id = $1`,
        [first.id],
      )

      const second = await enqueue(subject, { key: `retry:${subject}` })
      expect(second.enqueued).toBe(true)
      expect(second.id).not.toBe(first.id)
    })
  })

  describe('enqueue idempotency', () => {
    it('returns the existing job for a repeated idempotency key', async () => {
      const subject = newId()
      const first = await enqueue(subject)
      const second = await enqueue(subject)

      expect(first.enqueued).toBe(true)
      expect(second).toEqual({ enqueued: false, id: first.id })
      const count = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM jobs`)
      expect(count.rows[0]?.n).toBe('1')
    })

    it('finds the live job when a DIFFERENT key targets the same subject', async () => {
      // The partial unique's whole reason for existing: two producers with two
      // legitimately different keys (an operator deletion and the sweeper's)
      // must not put two live jobs on one site.
      const subject = newId()
      const first = await enqueue(subject)
      const second = await enqueue(subject, { key: `operator:${subject}` })

      expect(second).toEqual({ enqueued: false, id: first.id })
      const count = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM jobs`)
      expect(count.rows[0]?.n).toBe('1')
    })

    it('treats a failed_retryable job as live — a backoff is not a finish', async () => {
      const subject = newId()
      const first = await enqueue(subject)
      const [job] = await claim(db)
      await failJobRetryable(db, {
        jobId: job!.id,
        claimedBy: 'worker-1',
        error: 'nope',
        retryDelayMs: 60_000,
      })

      const second = await enqueue(subject, { key: `again:${subject}` })
      expect(second).toEqual({ enqueued: false, id: first.id })
    })

    it('lets two concurrent enqueues for one subject produce exactly one job', async () => {
      const subject = newId()
      const results = await Promise.all([
        enqueueJob(db, {
          type: SITE_DELETION_JOB_TYPE,
          subjectId: subject,
          idempotencyKey: `a:${subject}`,
          payload: {},
        }),
        enqueueJob(dbB, {
          type: SITE_DELETION_JOB_TYPE,
          subjectId: subject,
          idempotencyKey: `b:${subject}`,
          payload: {},
        }),
      ])

      const count = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM jobs`)
      expect(count.rows[0]?.n).toBe('1')
      expect(results.filter((result) => result.enqueued)).toHaveLength(1)
      // Both callers come away with an id, and it is the same one.
      expect(new Set(results.map((result) => result.id)).size).toBe(1)
    })
  })

  describe('claiming', () => {
    it('takes the oldest-available job first, and stamps a lease on it', async () => {
      // Asserted one claim at a time on purpose. `RETURNING` reports rows in the
      // UPDATE's scan order, not in the inner `ORDER BY` — so a two-row claim
      // says nothing about priority, while `LIMIT 1` twice says everything.
      const older = await enqueue(newId(), { availableAt: new Date(Date.now() - 60_000) })
      const newer = await enqueue(newId(), { availableAt: new Date(Date.now() - 1_000) })

      const first = await claim(db, { limit: 1 })
      expect(first.map((row) => row.id)).toEqual([older.id!])
      expect(first[0]?.attempts).toBe(1)
      expect(first[0]?.claimedBy).toBe('worker-1')

      const second = await claim(db, { limit: 1 })
      expect(second.map((row) => row.id)).toEqual([newer.id!])

      const stored = await jobRow(older.id!)
      expect(stored?.status).toBe('running')
      expect(stored?.lease_expires_at).not.toBeNull()
      expect(stored?.started_at).not.toBeNull()
    })

    it('does not take a job whose available_at is still in the future', async () => {
      await enqueue(newId(), { availableAt: new Date(Date.now() + 3_600_000) })
      expect(await claim(db)).toEqual([])
    })

    it('re-claims a running job whose lease has expired, counting the retry', async () => {
      // The crash case, and the reason there is no separate reaper loop.
      const job = await enqueue(newId())
      await claim(db)
      await pool.query(`UPDATE jobs SET lease_expires_at = now() - interval '1 minute'`)

      const stolen = await claim(db, { claimedBy: 'worker-2' })

      expect(stolen.map((row) => row.id)).toEqual([job.id!])
      expect(stolen[0]?.attempts).toBe(2)
      expect(stolen[0]?.claimedBy).toBe('worker-2')
      // `started_at` keeps meaning "when this job first began".
      const stored = await jobRow(job.id!)
      expect(stored?.claimed_by).toBe('worker-2')
    })

    it('leaves a running job alone while its lease is live', async () => {
      await enqueue(newId())
      await claim(db)
      expect(await claim(db, { claimedBy: 'worker-2' })).toEqual([])
    })

    it('gives two concurrent workers disjoint jobs', async () => {
      // `SKIP LOCKED` is the whole mechanism: without it the second claim would
      // block on the first's row locks and then find nothing, which looks the
      // same until the day both are busy.
      const ids = new Set<string>()
      for (let i = 0; i < 6; i += 1) {
        const result = await enqueue(newId())
        ids.add(result.id!)
      }

      const [a, b] = await Promise.all([
        claim(db, { limit: 3, claimedBy: 'worker-a' }),
        claim(dbB, { limit: 3, claimedBy: 'worker-b' }),
      ])

      const takenA = a.map((row) => row.id)
      const takenB = b.map((row) => row.id)
      expect(takenA.filter((id) => takenB.includes(id))).toEqual([])
      expect(new Set([...takenA, ...takenB]).size).toBe(takenA.length + takenB.length)
      for (const id of [...takenA, ...takenB]) expect(ids.has(id)).toBe(true)
    })

    it('claims nothing for a type nobody registered', async () => {
      await enqueue(newId())
      expect(
        await claimDueJobs(db, {
          types: ['account_deletion'],
          claimedBy: 'worker-1',
          leaseTtlMs: LEASE_MS,
          limit: 10,
        }),
      ).toEqual([])
    })
  })

  describe('lease-guarded writes', () => {
    const stealFrom = async (jobId: string) => {
      await pool.query(`UPDATE jobs SET claimed_by = 'thief' WHERE id = $1`, [jobId])
    }

    it('extends, phases, completes and fails for the holder', async () => {
      const job = await enqueue(newId())
      await claim(db)
      const id = job.id!

      expect(
        await extendJobLease(db, { jobId: id, claimedBy: 'worker-1', leaseTtlMs: 5_000 }),
      ).toBe(true)
      expect(
        await updateJobPhase(db, { jobId: id, claimedBy: 'worker-1', phase: 'fence_drain' }),
      ).toBe(true)
      expect((await jobRow(id))?.phase).toBe('fence_drain')

      expect(await completeJob(db, { jobId: id, claimedBy: 'worker-1', status: 'succeeded' })).toBe(
        true,
      )
      const stored = await jobRow(id)
      expect(stored?.status).toBe('succeeded')
      // The lease is released in the same statement — the CHECK forbids the
      // half-state either order would otherwise pass through.
      expect(stored?.claimed_by).toBeNull()
      expect(stored?.lease_expires_at).toBeNull()
      expect(stored?.finished_at).not.toBeNull()
    })

    it('refuses every write from a worker whose lease was stolen', async () => {
      const job = await enqueue(newId())
      await claim(db)
      const id = job.id!
      await stealFrom(id)

      expect(
        await extendJobLease(db, { jobId: id, claimedBy: 'worker-1', leaseTtlMs: 5_000 }),
      ).toBe(false)
      expect(await updateJobPhase(db, { jobId: id, claimedBy: 'worker-1', phase: 'purge' })).toBe(
        false,
      )
      expect(await completeJob(db, { jobId: id, claimedBy: 'worker-1', status: 'succeeded' })).toBe(
        false,
      )
      expect(
        await failJobRetryable(db, {
          jobId: id,
          claimedBy: 'worker-1',
          error: 'x',
          retryDelayMs: 1_000,
        }),
      ).toBe(false)

      // Nothing the dispossessed worker tried actually landed.
      const stored = await jobRow(id)
      expect(stored?.status).toBe('running')
      expect(stored?.claimed_by).toBe('thief')
      expect(stored?.phase).toBeNull()
    })

    it('pushes a retry into the future and releases the lease', async () => {
      const job = await enqueue(newId())
      await claim(db)
      const before = new Date()

      expect(
        await failJobRetryable(db, {
          jobId: job.id!,
          claimedBy: 'worker-1',
          error: 'clickhouse unavailable',
          retryDelayMs: 60_000,
        }),
      ).toBe(true)

      const stored = await jobRow(job.id!)
      expect(stored?.status).toBe('failed_retryable')
      expect(stored?.claimed_by).toBeNull()
      expect(stored?.lease_expires_at).toBeNull()
      expect(stored?.last_error).toBe('clickhouse unavailable')
      expect(stored!.available_at.getTime()).toBeGreaterThan(before.getTime())
      // …and it is not claimable until then.
      expect(await claim(db)).toEqual([])
    })
  })

  describe('backlog', () => {
    it('counts only unfinished jobs, per type and status', async () => {
      const done = await enqueue(newId())
      await claim(db)
      await completeJob(db, { jobId: done.id!, claimedBy: 'worker-1', status: 'succeeded' })
      await enqueue(newId())

      const rows = await readJobsBacklog(db)

      expect(rows).toEqual([
        expect.objectContaining({ type: SITE_DELETION_JOB_TYPE, status: 'queued', count: 1 }),
      ])
      expect(rows[0]!.oldestAgeMs).toBeGreaterThanOrEqual(0)
    })
  })
})
