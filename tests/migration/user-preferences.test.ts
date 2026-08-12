import {
  createDatabase,
  createPool,
  getUserPreferences,
  newId,
  setUserTimezone,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The user timezone preference against a real Postgres (ADR-0026, migration
 * 0023).
 *
 * What only a database can prove: that the column exists and is nullable, that a
 * pre-existing account reads back as "never chosen" with no backfill, that the
 * repository roundtrips a value and a clear, and that the CHECK constraint is a
 * genuine floor under the API's validation rather than decoration.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

describeIfPostgres('user timezone preference', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `tzpref_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database
  let userId: string

  const makeUser = async (): Promise<string> => {
    const id = newId()
    await pool.query(
      `INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'U', $2, true)`,
      [id, `tz-${id}@example.com`],
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

  it('adds a nullable timezone column to users', async () => {
    const columns = await pool.query<{ is_nullable: string; data_type: string }>(
      `SELECT is_nullable, data_type FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'users' AND column_name = 'timezone'`,
      [schemaName],
    )
    expect(columns.rows).toHaveLength(1)
    expect(columns.rows[0]?.is_nullable).toBe('YES')
    expect(columns.rows[0]?.data_type).toBe('text')
  })

  it('carries no column default, so the server never guesses a zone', async () => {
    // ADR-0026 decision 3. A default of UTC would be indistinguishable from a
    // user who deliberately chose UTC, and no later migration could separate the
    // two.
    const defaults = await pool.query<{ column_default: string | null }>(
      `SELECT column_default FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'users' AND column_name = 'timezone'`,
      [schemaName],
    )
    expect(defaults.rows[0]?.column_default).toBeNull()
  })

  it('reads an untouched account as "never chosen"', async () => {
    // The state every row is in the instant the migration lands: no backfill ran.
    const fresh = await makeUser()
    await expect(getUserPreferences(db, fresh)).resolves.toEqual({ timezone: null })
  })

  it('returns null for a user that does not exist', async () => {
    await expect(getUserPreferences(db, newId())).resolves.toBeNull()
  })

  it('roundtrips a stored zone', async () => {
    const written = await setUserTimezone(db, { userId, timezone: 'Asia/Baku' })
    expect(written).toEqual({ timezone: 'Asia/Baku' })
    await expect(getUserPreferences(db, userId)).resolves.toEqual({ timezone: 'Asia/Baku' })
  })

  it('overwrites rather than accumulating', async () => {
    await setUserTimezone(db, { userId, timezone: 'Asia/Baku' })
    await setUserTimezone(db, { userId, timezone: 'America/New_York' })
    await expect(getUserPreferences(db, userId)).resolves.toEqual({ timezone: 'America/New_York' })
  })

  it('clears the preference back to null', async () => {
    await setUserTimezone(db, { userId, timezone: 'Asia/Baku' })
    const cleared = await setUserTimezone(db, { userId, timezone: null })
    expect(cleared).toEqual({ timezone: null })
    await expect(getUserPreferences(db, userId)).resolves.toEqual({ timezone: null })
  })

  it('bumps updated_at on a write, because Better Auth will not', async () => {
    const before = await pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM users WHERE id = $1`,
      [userId],
    )
    await pool.query(`UPDATE users SET updated_at = now() - interval '1 hour' WHERE id = $1`, [
      userId,
    ])
    await setUserTimezone(db, { userId, timezone: 'Europe/Berlin' })
    const after = await pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM users WHERE id = $1`,
      [userId],
    )
    expect(after.rows[0]?.updated_at.getTime()).toBeGreaterThan(
      new Date(before.rows[0]!.updated_at).getTime() - 3_600_000,
    )
  })

  it('returns null when the user vanished between session and write', async () => {
    await expect(setUserTimezone(db, { userId: newId(), timezone: 'UTC' })).resolves.toBeNull()
  })

  it.each([
    'not a zone; DROP',
    // UTC offsets. `Intl` accepts all three, so before the wire validator
    // carried the same identifier shape these were the one class of input that
    // passed the API and died here, as an unhandled error rather than a 400
    // (ADR-0026 decision 6). They must stay rejected at both ends.
    '+05:00',
    '-08:00',
    '+0500',
  ])('refuses %s, which is not identifier-shaped, at the database', async (value) => {
    // The API rejects these long before here; the constraint is the floor under
    // that check, so a direct SQL write cannot plant a value the read path would
    // have to defend against.
    await expect(
      pool.query(`UPDATE users SET timezone = $2 WHERE id = $1`, [userId, value]),
    ).rejects.toThrow(/users_timezone_format/)
  })

  it('refuses a value longer than the wire schema allows', async () => {
    await expect(
      pool.query(`UPDATE users SET timezone = $2 WHERE id = $1`, [
        userId,
        `Asia/${'x'.repeat(70)}`,
      ]),
    ).rejects.toThrow(/users_timezone_format/)
  })

  it('accepts the identifier shapes the IANA database actually uses', async () => {
    // Multi-segment, a bare name with no region, and an Etc zone whose name
    // contains a `+` — all real, and all things a careless regex refuses.
    for (const zone of [
      'America/Argentina/Buenos_Aires',
      'UTC',
      'Etc/GMT+5',
      'America/Port-au-Prince',
    ]) {
      await setUserTimezone(db, { userId, timezone: zone })
      await expect(getUserPreferences(db, userId)).resolves.toEqual({ timezone: zone })
    }
  })
})
