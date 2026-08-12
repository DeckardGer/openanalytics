import {
  createDatabase,
  createPool,
  createSiteWithOwner,
  createWidget,
  deleteWidget,
  newId,
  resolvePublicWidget,
  updateSiteSettings,
  updateWidget,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * `resolvePublicWidget` against a real database (ADR-0045, CP2).
 *
 * The anonymous read's one query, and the only piece of this checkpoint that a
 * mocked repository cannot prove: it joins three tables — `widgets` inner-joined
 * to `sites` for the lifecycle gate and the cache epoch, left-joined to
 * `import_runs` for a cutover date most sites do not have — and a `LEFT JOIN`
 * written as an inner one is the classic way to make a route answer `404` for
 * every site that never imported anything.
 *
 * Everything it asserts is a fact the route depends on and cannot check for
 * itself:
 *
 * - the widget resolves by **id alone**, because that is the door (every other
 *   read in that repository is site-scoped, deliberately);
 * - it carries the site's `status`, `config_version`, `reporting_timezone` and
 *   `first_event_at` — the four columns the gate and the range resolver need —
 *   in one round trip;
 * - it returns `enabled: false` and a blocked status as **facts**, leaving the
 *   404 to the route, so the gate lives in one place rather than half here;
 * - a deleted widget resolves to nothing, which is what makes `DELETE` a
 *   revocation of a public credential rather than a state change.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

describeIfPostgres('the anonymous widget resolution (migration 0048)', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `wpr_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database

  const makeUser = async () => {
    const id = newId()
    await pool.query(
      `INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'U', $2, true)`,
      [id, `${id}@example.com`],
    )
    return id
  }

  const makeSite = async () => {
    const ownerUserId = await makeUser()
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId,
    })
    return { siteId, ownerUserId }
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

  it('resolves a widget and its site’s read facts in one query', async () => {
    const { siteId, ownerUserId } = await makeSite()
    // The site's own clock, which is what the range is cut in.
    await updateSiteSettings(db, {
      siteId,
      reportingTimezone: 'Asia/Baku',
      actorUserId: ownerUserId,
    })
    const created = await createWidget(db, {
      siteId,
      surface: 'pages',
      title: 'Most read this week',
      range: '7d',
      limit: 5,
      allowedOrigins: ['https://shop.example.com'],
      createdByUserId: ownerUserId,
    })

    const resolved = await resolvePublicWidget(db, created.id)
    expect(resolved).not.toBeNull()
    expect(resolved).toMatchObject({
      id: created.id,
      siteId,
      surface: 'pages',
      title: 'Most read this week',
      range: '7d',
      limit: 5,
      allowedOrigins: ['https://shop.example.com'],
      enabled: true,
      siteStatus: 'active',
      reportingTimezone: 'Asia/Baku',
    })
    // The gateway's cache key (ADR-0030 D6), taken from the row this query
    // already read rather than from a second one.
    expect(typeof resolved?.configVersion).toBe('number')
  })

  it('resolves a site that never imported anything — the LEFT JOIN is not an inner one', async () => {
    // The failure this pins: an inner join to `import_runs` would make every
    // widget on every site that never migrated from another provider resolve to
    // nothing, and the route would answer 404 to all of them.
    const { siteId, ownerUserId } = await makeSite()
    const created = await createWidget(db, {
      siteId,
      surface: 'overview',
      range: 'today',
      limit: null,
      allowedOrigins: [],
      createdByUserId: ownerUserId,
    })
    const resolved = await resolvePublicWidget(db, created.id)
    expect(resolved?.publishedImportRunId).toBeNull()
    expect(resolved?.importCutoverDate).toBeNull()
  })

  it('reports a fresh site’s first_event_at as null — `all` has no anchor to invent', async () => {
    const { siteId, ownerUserId } = await makeSite()
    const created = await createWidget(db, {
      siteId,
      surface: 'overview',
      range: 'all',
      limit: null,
      allowedOrigins: [],
      createdByUserId: ownerUserId,
    })
    expect((await resolvePublicWidget(db, created.id))?.firstEventAt).toBeNull()
  })

  it('reports `enabled: false` as a fact and leaves the 404 to the route', async () => {
    const { siteId, ownerUserId } = await makeSite()
    const created = await createWidget(db, {
      siteId,
      surface: 'devices',
      range: '30d',
      limit: 10,
      allowedOrigins: [],
      createdByUserId: ownerUserId,
    })
    await updateWidget(db, { id: created.id, siteId, enabled: false, actorUserId: ownerUserId })

    const resolved = await resolvePublicWidget(db, created.id)
    // Not null: a repository that swallowed the disabled row would put half the
    // gate here and half in the route, which is how the two drift apart.
    expect(resolved?.enabled).toBe(false)
  })

  it('answers nothing for an invented id and for a deleted widget', async () => {
    const { siteId, ownerUserId } = await makeSite()
    const created = await createWidget(db, {
      siteId,
      surface: 'sources',
      range: '90d',
      limit: 10,
      allowedOrigins: [],
      createdByUserId: ownerUserId,
    })
    expect(await resolvePublicWidget(db, 'wzzzzzzzzzzzzzzz')).toBeNull()

    await deleteWidget(db, { id: created.id, siteId, actorUserId: ownerUserId })
    // A widget delete is the revocation of a public credential (ADR-0045 D13):
    // the row is gone, so the door resolves nothing.
    expect(await resolvePublicWidget(db, created.id)).toBeNull()
  })

  it('is addressed by the id alone, across sites', async () => {
    // Every other read in this repository puts `site_id` in the WHERE, because a
    // widget id found on the web must not let a member of another site act on
    // it. This one *is* the anonymous door: the site is what it resolves.
    const a = await makeSite()
    const b = await makeSite()
    const widgetA = await createWidget(db, {
      siteId: a.siteId,
      surface: 'pages',
      range: '7d',
      limit: 3,
      allowedOrigins: [],
      createdByUserId: a.ownerUserId,
    })
    const widgetB = await createWidget(db, {
      siteId: b.siteId,
      surface: 'pages',
      range: '7d',
      limit: 3,
      allowedOrigins: [],
      createdByUserId: b.ownerUserId,
    })
    expect((await resolvePublicWidget(db, widgetA.id))?.siteId).toBe(a.siteId)
    expect((await resolvePublicWidget(db, widgetB.id))?.siteId).toBe(b.siteId)
  })

  it('carries the site’s lifecycle status, so §20’s billing gate has something to read', async () => {
    const { siteId, ownerUserId } = await makeSite()
    const created = await createWidget(db, {
      siteId,
      surface: 'geography',
      range: '12mo',
      limit: 10,
      allowedOrigins: [],
      createdByUserId: ownerUserId,
    })
    await pool.query(`UPDATE sites SET status = 'suspended' WHERE id = $1`, [siteId])
    const resolved = await resolvePublicWidget(db, created.id)
    // Again a fact rather than a decision: the route collapses it into the one
    // indistinguishable 404 (D7), so a customer's billing state is never
    // published to their own readers.
    expect(resolved?.siteStatus).toBe('suspended')
  })
})
