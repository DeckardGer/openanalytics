import {
  archiveFunnel,
  createDatabase,
  createFunnel,
  createPool,
  createSiteWithOwner,
  getFunnel,
  listFunnels,
  newId,
  updateFunnel,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { MAX_FUNNEL_WINDOW_MS } from '@openanalytics/domain'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Stored funnel definitions against real Postgres (migration 0024).
 *
 * Two things are proven here that no mocked test can prove: that the JSONB step
 * array survives a round trip as an ordered array of strings, and that the
 * database itself refuses a definition the compute endpoint could not run — the
 * CHECK constraints, not the zod schema in front of them.
 *
 * The site scoping is proven the way it matters: a second site is created, and
 * every read and write is attempted across the boundary with a real id.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

const STEPS = ['/pricing', '/signup', '/checkout', 'purchase']

describeIfPostgres('stored funnel definitions', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `funnels_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database
  let siteId: string
  let otherSiteId: string
  let userId: string

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
    userId = newId()
    await pool.query(
      `INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'U', $2, true)`,
      [userId, `${userId}@example.com`],
    )
    siteId = (
      await createSiteWithOwner(db, { slug: `s-${newId()}`, name: 'S', ownerUserId: userId })
    ).siteId
    otherSiteId = (
      await createSiteWithOwner(db, { slug: `o-${newId()}`, name: 'O', ownerUserId: userId })
    ).siteId
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

  const create = (overrides: Partial<Parameters<typeof createFunnel>[1]> = {}) =>
    createFunnel(db, {
      siteId,
      name: 'Checkout',
      steps: STEPS,
      scope: 'visitor',
      windowMs: 604_800_000,
      createdByUserId: userId,
      ...overrides,
    })

  it('round-trips a definition, steps included and in order', async () => {
    const created = await create()
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(created.archivedAt).toBeNull()

    const read = await getFunnel(db, { id: created.id, siteId })
    expect(read).not.toBeNull()
    // Order is the whole meaning of a funnel; a set would be a different feature.
    expect(read?.steps).toEqual(STEPS)
    expect(read?.scope).toBe('visitor')
    expect(read?.createdByUserId).toBe(userId)
    // bigint in `number` mode, not a string — a window that read back as text
    // would be silently wrong the moment it was compared.
    expect(read?.windowMs).toBe(604_800_000)
    expect(typeof read?.windowMs).toBe('number')
  })

  it('stores the top of the window range, which does not fit in an int4', async () => {
    // 2_592_000_000 > 2_147_483_647. An `integer` column would refuse the
    // longest window the compute endpoint accepts.
    const created = await create({ name: 'Long', windowMs: MAX_FUNNEL_WINDOW_MS })
    const read = await getFunnel(db, { id: created.id, siteId })
    expect(read?.windowMs).toBe(MAX_FUNNEL_WINDOW_MS)
  })

  it('applies a partial update and leaves the untouched fields alone', async () => {
    const created = await create({ name: 'Before' })
    const updated = await updateFunnel(db, {
      id: created.id,
      siteId,
      name: 'After',
      actorUserId: userId,
    })
    expect(updated?.name).toBe('After')
    expect(updated?.steps).toEqual(STEPS)
    expect(updated?.scope).toBe('visitor')
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime())

    const replaced = await updateFunnel(db, {
      id: created.id,
      siteId,
      steps: ['/a', '/b'],
      scope: 'session',
      windowMs: 1_800_000,
      actorUserId: userId,
    })
    expect(replaced?.steps).toEqual(['/a', '/b'])
    expect(replaced?.scope).toBe('session')
    expect(replaced?.windowMs).toBe(1_800_000)
    expect(replaced?.name).toBe('After')
  })

  it('hides archived definitions from the default list and shows them on request', async () => {
    const live = await create({ name: 'Live' })
    const gone = await create({ name: 'Gone' })
    await archiveFunnel(db, { id: gone.id, siteId, actorUserId: userId })

    const listed = await listFunnels(db, siteId)
    const ids = listed.map((funnel) => funnel.id)
    expect(ids).toContain(live.id)
    expect(ids).not.toContain(gone.id)

    const all = await listFunnels(db, siteId, { includeArchived: true })
    expect(all.map((funnel) => funnel.id)).toContain(gone.id)
    expect(all.find((funnel) => funnel.id === gone.id)?.archivedAt).toBeInstanceOf(Date)
  })

  it('archives idempotently and keeps the first instant', async () => {
    const created = await create({ name: 'Twice' })
    expect(await archiveFunnel(db, { id: created.id, siteId })).toEqual({ archived: true })
    const first = (await getFunnel(db, { id: created.id, siteId }))?.archivedAt

    // A replay succeeds rather than 404-ing, and does not move the timestamp:
    // `archived_at` records when the funnel left the list, not the last click.
    expect(await archiveFunnel(db, { id: created.id, siteId })).toEqual({ archived: true })
    const second = (await getFunnel(db, { id: created.id, siteId }))?.archivedAt
    expect(second?.getTime()).toBe(first?.getTime())
  })

  it('refuses to update an archived definition', async () => {
    const created = await create({ name: 'Archived' })
    await archiveFunnel(db, { id: created.id, siteId })
    const updated = await updateFunnel(db, { id: created.id, siteId, name: 'Resurrected' })
    expect(updated).toBeNull()
  })

  it('reports a missing funnel rather than inventing one', async () => {
    expect(await archiveFunnel(db, { id: newId(), siteId })).toEqual({ archived: false })
    expect(await updateFunnel(db, { id: newId(), siteId, name: 'X' })).toBeNull()
    expect(await getFunnel(db, { id: newId(), siteId })).toBeNull()
  })

  it('scopes every operation to the site, so another site’s id is invisible', async () => {
    const mine = await create({ name: 'Mine' })

    expect(await getFunnel(db, { id: mine.id, siteId: otherSiteId })).toBeNull()
    expect(await updateFunnel(db, { id: mine.id, siteId: otherSiteId, name: 'Stolen' })).toBeNull()
    expect(await archiveFunnel(db, { id: mine.id, siteId: otherSiteId })).toEqual({
      archived: false,
    })

    // The cross-site attempts changed nothing.
    const read = await getFunnel(db, { id: mine.id, siteId })
    expect(read?.name).toBe('Mine')
    expect(read?.archivedAt).toBeNull()

    expect(await listFunnels(db, otherSiteId, { includeArchived: true })).toEqual([])
  })

  it('writes an audit row for every mutation, in the same transaction', async () => {
    const created = await create({ name: 'Audited' })
    await updateFunnel(db, { id: created.id, siteId, name: 'Audited 2', actorUserId: userId })
    await archiveFunnel(db, { id: created.id, siteId, actorUserId: userId })

    const audit = await pool.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE target_id = $1 ORDER BY occurred_at, action`,
      [created.id],
    )
    expect(audit.rows.map((r) => r.action).sort()).toEqual([
      'funnel.archived',
      'funnel.created',
      'funnel.updated',
    ])
  })

  describe('the database refuses what the compute endpoint could not run', () => {
    const insert = (columns: string, values: unknown[]) =>
      pool.query(
        `INSERT INTO funnels (id, site_id, name, steps, scope, window_ms) VALUES ${columns}`,
        values,
      )

    it('refuses fewer than two steps and more than eight', async () => {
      await expect(
        insert(`($1, $2, 'One', $3::jsonb, 'visitor', 1000)`, [
          newId(),
          siteId,
          JSON.stringify(['/only']),
        ]),
      ).rejects.toThrow(/funnels_steps_check/)

      await expect(
        insert(`($1, $2, 'Nine', $3::jsonb, 'visitor', 1000)`, [
          newId(),
          siteId,
          JSON.stringify(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']),
        ]),
      ).rejects.toThrow(/funnels_steps_check/)
    })

    it('refuses steps that are not a JSON array', async () => {
      // `jsonb_array_length` errors rather than returning false on a non-array,
      // which is why the constraint checks `jsonb_typeof` first.
      await expect(
        insert(`($1, $2, 'Object', $3::jsonb, 'visitor', 1000)`, [
          newId(),
          siteId,
          JSON.stringify({ first: '/a' }),
        ]),
      ).rejects.toThrow(/funnels_steps_check/)
    })

    it('refuses step elements that are not JSON strings', async () => {
      // The read path types steps as string[]; a direct SQL write of numbers
      // or nested values must fail the constraint, not surface later as a
      // definition the compute endpoint refuses every time.
      for (const bad of [
        [1, 2],
        ['/a', 5],
        ['/a', null],
        ['/a', ['/b']],
      ]) {
        await expect(
          insert(`($1, $2, 'Typed', $3::jsonb, 'visitor', 1000)`, [
            newId(),
            siteId,
            JSON.stringify(bad),
          ]),
        ).rejects.toThrow(/funnels_steps_check/)
      }
    })

    it('refuses an empty name and a window past the ceiling', async () => {
      await expect(
        insert(`($1, $2, '', $3::jsonb, 'visitor', 1000)`, [
          newId(),
          siteId,
          JSON.stringify(STEPS),
        ]),
      ).rejects.toThrow(/funnels_name_length_check/)

      await expect(
        insert(`($1, $2, 'Too long', $3::jsonb, 'visitor', 2592000001)`, [
          newId(),
          siteId,
          JSON.stringify(STEPS),
        ]),
      ).rejects.toThrow(/funnels_window_ms_check/)
    })

    it('refuses a scope the gateway has no operation for', async () => {
      await expect(
        insert(`($1, $2, 'Bad scope', $3::jsonb, 'canonical_session', 1000)`, [
          newId(),
          siteId,
          JSON.stringify(STEPS),
        ]),
      ).rejects.toThrow(/funnels_scope_check/)
    })

    it('refuses a funnel on a site that does not exist', async () => {
      await expect(
        insert(`($1, $2, 'Orphan', $3::jsonb, 'visitor', 1000)`, [
          newId(),
          newId(),
          JSON.stringify(STEPS),
        ]),
      ).rejects.toThrow(/funnels_site_id_fkey/)
    })
  })
})
