import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  createDatabase,
  createPool,
  newId,
  releaseIdempotencyKey,
  sweepIdempotencyKeys,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The inbound idempotency ledger (migration 0019; docs snapshot 02 §18).
 *
 * One named test per outcome, plus the race the ledger exists for: two requests
 * carrying the same key arriving together must produce exactly one claim, which
 * is a property of the unique constraint and cannot be proven without a real
 * database.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

const SCOPE = 'sites.create'

describeIfPostgres('inbound idempotency ledger', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m10idem_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database
  let userId: string

  const makeUser = async (): Promise<string> => {
    const id = newId()
    await pool.query(
      `INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'U', $2, true)`,
      [id, `${id}@example.com`],
    )
    return id
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
    userId = await makeUser()
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

  it('claims a fresh key and then replays the stored response verbatim', async () => {
    const key = `k-${newId()}`
    const first = await claimIdempotencyKey(db, {
      userId,
      scope: SCOPE,
      key,
      requestHash: 'hash-a',
    })
    expect(first).toEqual({ status: 'claimed' })

    await completeIdempotencyKey(db, {
      userId,
      scope: SCOPE,
      key,
      responseStatus: 201,
      responseBody: { site_id: 'abc', slug: 'acme' },
    })

    const replay = await claimIdempotencyKey(db, {
      userId,
      scope: SCOPE,
      key,
      requestHash: 'hash-a',
    })
    expect(replay).toEqual({
      status: 'replay',
      responseStatus: 201,
      responseBody: { site_id: 'abc', slug: 'acme' },
    })
  })

  it('conflicts when the same key arrives with a different payload', async () => {
    const key = `k-${newId()}`
    await claimIdempotencyKey(db, { userId, scope: SCOPE, key, requestHash: 'hash-a' })
    await completeIdempotencyKey(db, { userId, scope: SCOPE, key, responseStatus: 201 })

    const conflict = await claimIdempotencyKey(db, {
      userId,
      scope: SCOPE,
      key,
      requestHash: 'hash-b',
    })
    expect(conflict).toEqual({ status: 'conflict' })
  })

  it('reports an in-flight claim as in_progress, not as a replay', async () => {
    const key = `k-${newId()}`
    await claimIdempotencyKey(db, { userId, scope: SCOPE, key, requestHash: 'hash-a' })
    // No completion yet: the first request is still running.
    const second = await claimIdempotencyKey(db, {
      userId,
      scope: SCOPE,
      key,
      requestHash: 'hash-a',
    })
    expect(second).toEqual({ status: 'in_progress' })
  })

  it('lets a released key be claimed again, so a failed request can be retried', async () => {
    const key = `k-${newId()}`
    expect(await claimIdempotencyKey(db, { userId, scope: SCOPE, key, requestHash: 'h' })).toEqual({
      status: 'claimed',
    })
    await releaseIdempotencyKey(db, { userId, scope: SCOPE, key })

    // A corrected payload, with the same key, is a fresh claim.
    expect(await claimIdempotencyKey(db, { userId, scope: SCOPE, key, requestHash: 'h2' })).toEqual(
      { status: 'claimed' },
    )
  })

  it('scopes a key to its caller and its operation', async () => {
    const key = `k-${newId()}`
    const other = await makeUser()
    await claimIdempotencyKey(db, { userId, scope: SCOPE, key, requestHash: 'h' })

    // Another caller's identical key is not blocked and cannot read the claim.
    expect(
      await claimIdempotencyKey(db, { userId: other, scope: SCOPE, key, requestHash: 'h' }),
    ).toEqual({ status: 'claimed' })
    // The same caller reusing the key on a different operation is a fresh claim.
    expect(
      await claimIdempotencyKey(db, { userId, scope: 'sites.update', key, requestHash: 'h' }),
    ).toEqual({ status: 'claimed' })
  })

  it('produces exactly one winner when two claims race', async () => {
    const key = `k-${newId()}`
    const results = await Promise.all([
      claimIdempotencyKey(db, { userId, scope: SCOPE, key, requestHash: 'h' }),
      claimIdempotencyKey(db, { userId, scope: SCOPE, key, requestHash: 'h' }),
    ])

    expect(results.filter((r) => r.status === 'claimed')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'in_progress')).toHaveLength(1)

    const rows = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM idempotency_keys WHERE user_id = $1 AND scope = $2 AND key = $3`,
      [userId, SCOPE, key],
    )
    expect(Number(rows.rows[0]?.n)).toBe(1)
  })

  it('does not overwrite a stored response with a second completion', async () => {
    const key = `k-${newId()}`
    await claimIdempotencyKey(db, { userId, scope: SCOPE, key, requestHash: 'h' })
    await completeIdempotencyKey(db, {
      userId,
      scope: SCOPE,
      key,
      responseStatus: 201,
      responseBody: { first: true },
    })
    await completeIdempotencyKey(db, {
      userId,
      scope: SCOPE,
      key,
      responseStatus: 500,
      responseBody: { second: true },
    })

    expect(await claimIdempotencyKey(db, { userId, scope: SCOPE, key, requestHash: 'h' })).toEqual({
      status: 'replay',
      responseStatus: 201,
      responseBody: { first: true },
    })
  })

  /**
   * The sweeper (ADR-0019 known gap 4, closed by the amendment dated
   * 2026-08-06).
   *
   * `created_at` carries a `now()` default, so every case here backdates the row
   * it has just written: age is the whole subject, and a test that could only
   * observe rows created this millisecond could not tell a working sweep from
   * one that deletes nothing.
   *
   * The two horizons get separate tests on purpose. A sweep written with one
   * horizon passes every completed-row assertion and still leaves an orphaned
   * claim in place forever, which is the failure this half exists to prevent.
   */
  describe('sweeping', () => {
    const ageRow = async (key: string, hours: number): Promise<void> => {
      await pool.query(
        `UPDATE idempotency_keys SET created_at = now() - ($1 || ' hours')::interval
         WHERE user_id = $2 AND scope = $3 AND key = $4`,
        [String(hours), userId, SCOPE, key],
      )
    }
    const exists = async (key: string): Promise<boolean> => {
      const rows = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM idempotency_keys
         WHERE user_id = $1 AND scope = $2 AND key = $3`,
        [userId, SCOPE, key],
      )
      return Number(rows.rows[0]?.n) === 1
    }
    /** 24 h replay horizon and a 1 h orphan horizon, the shipped defaults. */
    const sweep = (limit = 500) =>
      sweepIdempotencyKeys(db, {
        completedBefore: new Date(Date.now() - 24 * 60 * 60 * 1000),
        claimedBefore: new Date(Date.now() - 60 * 60 * 1000),
        limit,
      })

    it('removes a completed row past the replay horizon and keeps one inside it', async () => {
      const old = `k-${newId()}`
      const fresh = `k-${newId()}`
      for (const key of [old, fresh]) {
        await claimIdempotencyKey(db, { userId, scope: SCOPE, key, requestHash: 'h' })
        await completeIdempotencyKey(db, { userId, scope: SCOPE, key, responseStatus: 201 })
      }
      await ageRow(old, 25)
      await ageRow(fresh, 23)

      await sweep()

      expect(await exists(old)).toBe(false)
      expect(await exists(fresh)).toBe(true)
    })

    it('removes an orphaned claim hours before the replay horizon would', async () => {
      const key = `k-${newId()}`
      // Claimed and never completed — the shape a process killed mid-handler
      // leaves behind, which nothing else in the system ever deletes.
      await claimIdempotencyKey(db, { userId, scope: SCOPE, key, requestHash: 'h' })
      await ageRow(key, 2)

      // Two hours old: far inside the 24 h replay horizon, so a sweep written
      // with only that horizon leaves this row exactly where it is.
      await sweep()

      expect(await exists(key)).toBe(false)
    })

    it('frees the key an orphaned claim was holding', async () => {
      const key = `k-${newId()}`
      await claimIdempotencyKey(db, { userId, scope: SCOPE, key, requestHash: 'h' })
      await ageRow(key, 2)

      // Before the sweep the caller is refused, and would be for the life of
      // the table.
      expect(
        await claimIdempotencyKey(db, { userId, scope: SCOPE, key, requestHash: 'h' }),
      ).toEqual({ status: 'in_progress' })

      await sweep()

      expect(
        await claimIdempotencyKey(db, { userId, scope: SCOPE, key, requestHash: 'h' }),
      ).toEqual({ status: 'claimed' })
    })

    it('leaves a claim young enough to still have a live handler', async () => {
      const key = `k-${newId()}`
      await claimIdempotencyKey(db, { userId, scope: SCOPE, key, requestHash: 'h' })
      // Half an hour: inside the orphan horizon, so the handler may still be
      // running and sweeping the claim would let a concurrent retry re-execute.
      await ageRow(key, 0.5)

      await sweep()

      expect(await exists(key)).toBe(true)
    })

    it('removes no more than the limit in one pass, oldest first', async () => {
      const keys = [`k-${newId()}`, `k-${newId()}`, `k-${newId()}`]
      for (const [index, key] of keys.entries()) {
        await claimIdempotencyKey(db, { userId, scope: SCOPE, key, requestHash: 'h' })
        await completeIdempotencyKey(db, { userId, scope: SCOPE, key, responseStatus: 201 })
        // 48 h, 47 h, 46 h: all expired, in a known order.
        await ageRow(key, 48 - index)
      }

      expect(await sweep(2)).toBe(2)
      // The two oldest went; the youngest of the three is what remains.
      expect(await exists(keys[0] as string)).toBe(false)
      expect(await exists(keys[1] as string)).toBe(false)
      expect(await exists(keys[2] as string)).toBe(true)

      expect(await sweep(2)).toBeGreaterThanOrEqual(1)
      expect(await exists(keys[2] as string)).toBe(false)
    })
  })
})
