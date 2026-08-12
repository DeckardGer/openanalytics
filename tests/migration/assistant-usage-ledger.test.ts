import {
  assistantQuestionsSpent,
  chargeAssistantQuestion,
  createDatabase,
  createPool,
  newId,
  readAssistantUsage,
  recordAssistantTokens,
  sweepAssistantUsageLedger,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The assistant's question ledger against a real Postgres (ADR-0046 D5).
 *
 * Nothing here is a property of TypeScript. The bucket is `date_trunc('hour',
 * now())` evaluated by the **database**, the window is a rolling sum over at
 * most 24 rows, the counters converge through an upsert two concurrent
 * questions both land in, and the tokens are `bigint`. A fake would prove that
 * the repository calls the functions this test expects and nothing else.
 *
 * The claims, in the order a question makes them:
 *
 * 1. **A charge is one row per (user, hour), and the hour is the database's.**
 *    Two api instances with a few milliseconds of skew must not bucket the same
 *    instant differently — the M10 lesson, applied to a second ledger.
 * 2. **The window is rolling.** A bucket 23 hours old still counts; one 24 hours
 *    old does not. That is what makes the limit reset gradually instead of at
 *    midnight UTC, and what makes `Retry-After` true.
 * 3. **Tokens are a measurement, not a budget.** They are added as usage
 *    arrives, they never move `question_count`, and they are wide enough not to
 *    wrap.
 * 4. **The ledger is per user.** A stranger's questions are not this user's
 *    spend, and F-306 says "per user" rather than per session or per site.
 * 5. **Old buckets are swept.** 48 hours, not 24: a bucket exactly on the
 *    window boundary is still summed, so trimming at 24 would race the read.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

describeIfPostgres('assistant usage ledger', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m17asst_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database

  const makeUser = async (): Promise<string> => {
    const id = newId()
    await pool.query(
      `INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'U', $2, true)`,
      [id, `${id}@example.com`],
    )
    return id
  }

  /** A bucket `hoursAgo` whole hours before the current one, written the way the
   * production statements write it: from the database's clock. */
  const seedBucket = async (
    userId: string,
    hoursAgo: number,
    values: { questions?: number; input?: number; output?: number } = {},
  ): Promise<void> => {
    await pool.query(
      `INSERT INTO assistant_usage_ledger
         (user_id, hour_bucket, question_count, input_tokens, output_tokens)
       VALUES ($1, date_trunc('hour', now()) - make_interval(hours => $2::int), $3, $4, $5)`,
      [userId, hoursAgo, values.questions ?? 0, values.input ?? 0, values.output ?? 0],
    )
  }

  const rowsFor = async (userId: string) =>
    (
      await pool.query<{
        hour_bucket: Date
        question_count: number
        input_tokens: string
        output_tokens: string
      }>(
        `SELECT hour_bucket, question_count, input_tokens::text, output_tokens::text
           FROM assistant_usage_ledger WHERE user_id = $1 ORDER BY hour_bucket`,
        [userId],
      )
    ).rows

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

  describe('charging a question', () => {
    it('writes one row per hour and increments it, on the database’s clock', async () => {
      const userId = await makeUser()

      await chargeAssistantQuestion(db, { userId })
      await chargeAssistantQuestion(db, { userId })
      await chargeAssistantQuestion(db, { userId })

      const rows = await rowsFor(userId)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.question_count).toBe(3)

      // The bucket came from `date_trunc('hour', now())` inside the statement,
      // not from a JavaScript `Date` the caller supplied: two api instances with
      // a few milliseconds of skew would otherwise disagree about which hour a
      // question belongs to and each see a different rolling window.
      const bucket = await pool.query<{ matches: boolean }>(
        `SELECT hour_bucket = date_trunc('hour', now()) AS matches
           FROM assistant_usage_ledger WHERE user_id = $1`,
        [userId],
      )
      expect(bucket.rows[0]?.matches).toBe(true)
    })

    it('counts only this user’s questions', async () => {
      const mine = await makeUser()
      const theirs = await makeUser()
      await chargeAssistantQuestion(db, { userId: mine })
      await chargeAssistantQuestion(db, { userId: theirs })
      await chargeAssistantQuestion(db, { userId: theirs })

      expect(await assistantQuestionsSpent(db, mine)).toBe(1)
      expect(await assistantQuestionsSpent(db, theirs)).toBe(2)
    })

    it('reports zero for a user who has never asked anything', async () => {
      // Zero, not null and not a throw: the gate reads this before every
      // question and a first-time caller is the common case.
      expect(await assistantQuestionsSpent(db, await makeUser())).toBe(0)
    })
  })

  describe('the rolling window', () => {
    it('sums the buckets still inside it and drops the one that has aged out', async () => {
      // The predicate is `hour_bucket > date_trunc('hour', now()) - 23 hours`,
      // the read-cost ledger's own, so the oldest bucket a window can reach is
      // 22 whole hours back and the one at 23 has just left.
      const userId = await makeUser()
      await seedBucket(userId, 0, { questions: 1 })
      await seedBucket(userId, 22, { questions: 2 })
      // Outside: a daily row would still be counting this one until midnight.
      await seedBucket(userId, 23, { questions: 8 })

      expect(await assistantQuestionsSpent(db, userId)).toBe(3)
    })
  })

  describe('recording tokens', () => {
    it('adds tokens to the current bucket without charging a question', async () => {
      // D5: tokens are a measurement, not a budget. Nothing refuses on them, and
      // a usage report arriving after the answer must not cost a slot.
      const userId = await makeUser()
      await chargeAssistantQuestion(db, { userId })
      await recordAssistantTokens(db, { userId, inputTokens: 1200, outputTokens: 340 })
      await recordAssistantTokens(db, { userId, inputTokens: 800, outputTokens: 60 })

      const rows = await rowsFor(userId)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.question_count).toBe(1)
      expect(rows[0]?.input_tokens).toBe('2000')
      expect(rows[0]?.output_tokens).toBe('400')
    })

    it('opens a bucket with no questions in it when usage arrives alone', async () => {
      // The charge is at accept and the tokens arrive as the stream runs, so an
      // answer that crosses an hour boundary reports its usage into a bucket
      // that was never charged. That row is a fact about spend, not a question.
      const userId = await makeUser()
      await recordAssistantTokens(db, { userId, inputTokens: 10, outputTokens: 5 })

      const rows = await rowsFor(userId)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.question_count).toBe(0)
      expect(await assistantQuestionsSpent(db, userId)).toBe(0)
    })

    it('holds a token count no 32-bit counter could', async () => {
      // The migration's reason for `bigint`: a counter that wraps is worse than
      // one that is wide, and this value is past `integer`'s ceiling.
      const userId = await makeUser()
      await recordAssistantTokens(db, { userId, inputTokens: 3_000_000_000, outputTokens: 0 })
      const rows = await rowsFor(userId)
      expect(rows[0]?.input_tokens).toBe('3000000000')
    })

    it('never lets a provider report move a counter backwards', async () => {
      // Usage comes from a third party. A negative or fractional value cannot
      // come from a token count, and one bad write would misreport a user's
      // spend for a full day with nothing to show why.
      const userId = await makeUser()
      await recordAssistantTokens(db, { userId, inputTokens: 100, outputTokens: 100 })
      await recordAssistantTokens(db, { userId, inputTokens: -50, outputTokens: 10.7 })

      // The negative is floored at zero; the fraction is rounded rather than
      // truncated, because truncation would understate every report that
      // carried one.
      const rows = await rowsFor(userId)
      expect(rows[0]?.input_tokens).toBe('100')
      expect(rows[0]?.output_tokens).toBe('111')
    })
  })

  describe('the usage report', () => {
    it('answers the whole window in one read', async () => {
      // What `GET /v1/assistant/usage` is built from, and what the `done` event
      // reports without a second request.
      const userId = await makeUser()
      await seedBucket(userId, 5, { questions: 2, input: 900, output: 120 })
      await seedBucket(userId, 0, { questions: 1, input: 100, output: 30 })
      await seedBucket(userId, 30, { questions: 9, input: 9999, output: 9999 })

      const usage = await readAssistantUsage(db, userId)
      expect(usage.used).toBe(3)
      expect(usage.inputTokens).toBe(1000)
      expect(usage.outputTokens).toBe(150)
      expect(usage.oldestBucketAt).toBeInstanceOf(Date)
    })

    it('reports a Retry-After that names when a question actually frees up', async () => {
      // The oldest *charged* bucket leaves the window 23 hours after it opened,
      // and that is the first moment the count can drop. Reporting the end of
      // the current hour would be a lie whenever a user spent their allowance in
      // one sitting — which is exactly the user who gets refused.
      const userId = await makeUser()
      await seedBucket(userId, 1, { questions: 20 })

      // The bucket opened one whole hour ago, so it leaves the window 22 hours
      // from the top of this hour — between 21 and 22 hours from now, depending
      // on how far into the hour the test is running.
      const usage = await readAssistantUsage(db, userId)
      expect(usage.retryAfterSeconds).toBeGreaterThan(21 * 3600)
      expect(usage.retryAfterSeconds).toBeLessThanOrEqual(22 * 3600)
    })

    it('has no Retry-After when nothing has been charged', async () => {
      const userId = await makeUser()
      await recordAssistantTokens(db, { userId, inputTokens: 5, outputTokens: 5 })

      const usage = await readAssistantUsage(db, userId)
      expect(usage.used).toBe(0)
      expect(usage.retryAfterSeconds).toBeNull()
      expect(usage.oldestBucketAt).toBeNull()
    })

    it('never reports a Retry-After of zero, which a client reads as "immediately"', async () => {
      // The last bucket a window can still reach: it leaves at the top of the
      // next hour, so the honest answer is under an hour and never zero.
      const userId = await makeUser()
      await seedBucket(userId, 22, { questions: 20 })
      const usage = await readAssistantUsage(db, userId)
      expect(usage.retryAfterSeconds).toBeGreaterThan(0)
      expect(usage.retryAfterSeconds).toBeLessThanOrEqual(3600)
    })

    it('reports an empty window for a user who has never asked anything', async () => {
      const usage = await readAssistantUsage(db, await makeUser())
      expect(usage).toMatchObject({
        used: 0,
        inputTokens: 0,
        outputTokens: 0,
        oldestBucketAt: null,
        retryAfterSeconds: null,
      })
    })
  })

  describe('the sweeper', () => {
    it('drops buckets past 48 hours and keeps everything a window can still reach', async () => {
      const userId = await makeUser()
      await seedBucket(userId, 0, { questions: 1 })
      await seedBucket(userId, 47, { questions: 1 })
      await seedBucket(userId, 49, { questions: 1 })
      await seedBucket(userId, 200, { questions: 1 })

      const removed = await sweepAssistantUsageLedger(db)
      expect(removed).toBeGreaterThanOrEqual(2)

      const remaining = (await rowsFor(userId)).length
      expect(remaining).toBe(2)
    })
  })
})
