import {
  createDatabase,
  createPool,
  createSiteWithOwner,
  getPublicDashboardSettings,
  isSharePublishing,
  isSurfaceShared,
  newId,
  PUBLIC_SURFACES,
  readPublicSiteIdentity,
  resolvePublicShare,
  updatePublicDashboardSettings,
  updateSiteSettings,
  type Database,
  type PublicSurfaceFlags,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Migrations 0040 and 0047, and the nine-surface opt-in (ADR-0039, ADR-0044).
 *
 * The point of one column per surface is that an opt-in means exactly what it
 * meant when it was granted — so these tests are about *independence*: each of
 * the new surfaces opens and closes on its own flag, and closing one leaves the
 * others exactly as they were.
 *
 * `identity` (migration 0047) is the ninth entry and the one that is **not a
 * board card**: it gates two fields of the site-identity read rather than a
 * route, so it also has to be excluded from "does this slug publish anything?"
 * — `isSharePublishing`, pinned at the end of this file.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

const ALL_OFF: PublicSurfaceFlags = {
  shareOverview: false,
  shareGeography: false,
  shareRealtime: false,
  shareTimeseries: false,
  shareSessions: false,
  sharePages: false,
  shareSources: false,
  shareDevices: false,
  shareIdentity: false,
}

/** The surfaces added after the original three, with the flag each one reads. */
const NEW_SURFACES = [
  ['timeseries', 'shareTimeseries'],
  ['sessions', 'shareSessions'],
  ['pages', 'sharePages'],
  ['sources', 'shareSources'],
  ['devices', 'shareDevices'],
  // ADR-0044, migration 0047.
  ['identity', 'shareIdentity'],
] as const

describeIfPostgres('public dashboard surfaces (migrations 0040 and 0047)', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `pds_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
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

  const siteConfigVersion = async (siteId: string): Promise<number> => {
    const { rows } = await pool.query<{ config_version: number }>(
      `SELECT config_version FROM sites WHERE id = $1`,
      [siteId],
    )
    return rows[0]?.config_version as number
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

  it('defaults every new surface to false for a site that never opted in', async () => {
    const { siteId } = await makeSite()
    const settings = await getPublicDashboardSettings(db, siteId)
    for (const [, flag] of NEW_SURFACES) expect(settings[flag]).toBe(false)
  })

  it.each(NEW_SURFACES)(
    '%s round-trips through the repo and gates only its own surface',
    async (surface, flag) => {
      const { siteId, ownerUserId } = await makeSite()

      const updated = await updatePublicDashboardSettings(db, {
        siteId,
        actorUserId: ownerUserId,
        enabled: true,
        ...ALL_OFF,
        [flag]: true,
        rotateSlug: false,
      })
      expect(updated[flag]).toBe(true)
      expect(updated.shareSlug).toBeTruthy()
      expect(await getPublicDashboardSettings(db, siteId)).toMatchObject({ [flag]: true })

      const share = await resolvePublicShare(db, updated.shareSlug as string)
      expect(share).not.toBeNull()
      // Exactly one surface is open. Every other one — including the four that
      // shipped before ADR-0039 — stays shut, which is the whole point of a
      // column per surface rather than one flag over a group.
      for (const other of PUBLIC_SURFACES) {
        expect(isSurfaceShared(share!, other)).toBe(other === surface)
      }
    },
  )

  it('closes one surface without touching another', async () => {
    const { siteId, ownerUserId } = await makeSite()
    const on = await updatePublicDashboardSettings(db, {
      siteId,
      actorUserId: ownerUserId,
      enabled: true,
      ...ALL_OFF,
      sharePages: true,
      shareSources: true,
      rotateSlug: false,
    })

    await updatePublicDashboardSettings(db, {
      siteId,
      actorUserId: ownerUserId,
      enabled: true,
      ...ALL_OFF,
      shareSources: true,
      rotateSlug: false,
    })

    const share = await resolvePublicShare(db, on.shareSlug as string)
    expect(isSurfaceShared(share!, 'pages')).toBe(false)
    expect(isSurfaceShared(share!, 'sources')).toBe(true)
  })

  it('the master switch closes all nine at once, and the slug survives it', async () => {
    const { siteId, ownerUserId } = await makeSite()
    const on = await updatePublicDashboardSettings(db, {
      siteId,
      actorUserId: ownerUserId,
      enabled: true,
      shareOverview: true,
      shareGeography: true,
      shareRealtime: true,
      shareTimeseries: true,
      shareSessions: true,
      sharePages: true,
      shareSources: true,
      shareDevices: true,
      shareIdentity: true,
      rotateSlug: false,
    })
    const open = await resolvePublicShare(db, on.shareSlug as string)
    for (const surface of PUBLIC_SURFACES) expect(isSurfaceShared(open!, surface)).toBe(true)

    const off = await updatePublicDashboardSettings(db, {
      siteId,
      actorUserId: ownerUserId,
      enabled: false,
      shareOverview: true,
      shareGeography: true,
      shareRealtime: true,
      shareTimeseries: true,
      shareSessions: true,
      sharePages: true,
      shareSources: true,
      shareDevices: true,
      shareIdentity: true,
      rotateSlug: false,
    })
    // The per-surface flags are still stored as the owner left them; the master
    // switch is what closes the share, so re-enabling restores the same board.
    expect(off.shareTimeseries).toBe(true)
    expect(off.shareSlug).toBe(on.shareSlug)

    const closed = await resolvePublicShare(db, on.shareSlug as string)
    for (const surface of PUBLIC_SURFACES) expect(isSurfaceShared(closed!, surface)).toBe(false)
  })

  it('records every surface by name in the audit metadata', async () => {
    const { siteId, ownerUserId } = await makeSite()
    await updatePublicDashboardSettings(db, {
      siteId,
      actorUserId: ownerUserId,
      enabled: true,
      ...ALL_OFF,
      shareDevices: true,
      rotateSlug: false,
    })
    const { rows } = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_logs
        WHERE action = 'site.public_dashboard.updated' AND site_id = $1`,
      [siteId],
    )
    expect(rows).toHaveLength(1)
    const metadata = rows[0]?.metadata ?? {}
    for (const surface of PUBLIC_SURFACES) {
      expect(metadata).toHaveProperty(`share_${surface}`, surface === 'devices')
    }
  })

  /**
   * ADR-0044 D2: what makes a slug answerable to the site-identity read.
   *
   * The constraint is narrow and it is the whole reason this predicate exists —
   * a slug that publishes nothing must not be confirmable. The eight board
   * surfaces each gate themselves, so without `isSharePublishing` this one route
   * would become the cheapest existence probe on the public surface.
   */
  describe('isSharePublishing (ADR-0044, D2)', () => {
    it('is false for an enabled share with every surface off', async () => {
      const { siteId, ownerUserId } = await makeSite()
      const on = await updatePublicDashboardSettings(db, {
        siteId,
        actorUserId: ownerUserId,
        enabled: true,
        ...ALL_OFF,
        rotateSlug: false,
      })
      const share = await resolvePublicShare(db, on.shareSlug as string)
      expect(isSharePublishing(share!)).toBe(false)
    })

    it('is false when `share_identity` is the only flag on', async () => {
      // The circularity the exclusion exists to prevent. Identity describes a
      // board rather than being one; where there is no board, the answer is the
      // same 404 a wrong slug gets.
      const { siteId, ownerUserId } = await makeSite()
      const on = await updatePublicDashboardSettings(db, {
        siteId,
        actorUserId: ownerUserId,
        enabled: true,
        ...ALL_OFF,
        shareIdentity: true,
        rotateSlug: false,
      })
      const share = await resolvePublicShare(db, on.shareSlug as string)
      expect(isSurfaceShared(share!, 'identity')).toBe(true)
      expect(isSharePublishing(share!)).toBe(false)
    })

    it.each(PUBLIC_SURFACES.filter((surface) => surface !== 'identity'))(
      'is true when %s alone is on',
      async (surface) => {
        const { siteId, ownerUserId } = await makeSite()
        const on = await updatePublicDashboardSettings(db, {
          siteId,
          actorUserId: ownerUserId,
          enabled: true,
          ...ALL_OFF,
          [`share${surface[0]?.toUpperCase()}${surface.slice(1)}`]: true,
          rotateSlug: false,
        })
        const share = await resolvePublicShare(db, on.shareSlug as string)
        expect(isSharePublishing(share!)).toBe(true)
      },
    )

    it('inherits the master switch rather than restating it', async () => {
      const { siteId, ownerUserId } = await makeSite()
      const on = await updatePublicDashboardSettings(db, {
        siteId,
        actorUserId: ownerUserId,
        enabled: true,
        ...ALL_OFF,
        sharePages: true,
        rotateSlug: false,
      })
      await updatePublicDashboardSettings(db, {
        siteId,
        actorUserId: ownerUserId,
        enabled: false,
        ...ALL_OFF,
        sharePages: true,
        rotateSlug: false,
      })
      const share = await resolvePublicShare(db, on.shareSlug as string)
      expect(isSharePublishing(share!)).toBe(false)
    })

    it('inherits the suspended close rather than restating it', async () => {
      const { siteId, ownerUserId } = await makeSite()
      const on = await updatePublicDashboardSettings(db, {
        siteId,
        actorUserId: ownerUserId,
        enabled: true,
        ...ALL_OFF,
        shareOverview: true,
        rotateSlug: false,
      })
      await pool.query(`UPDATE sites SET status = 'suspended' WHERE id = $1`, [siteId])
      const share = await resolvePublicShare(db, on.shareSlug as string)
      expect(isSharePublishing(share!)).toBe(false)
    })
  })

  /** ADR-0044 D4/D5/D6/D7: the four values the site-identity read serves. */
  describe('readPublicSiteIdentity and sites.reporting_timezone (ADR-0044)', () => {
    it('serves the name, a null timezone and a null favicon domain by default', async () => {
      const { siteId } = await makeSite()
      const identity = await readPublicSiteIdentity(db, siteId)
      expect(identity).toEqual({
        displayName: 'S',
        // No allowlist configured, so there is no domain to derive one from.
        // Null rather than a guess: a wrong favicon is worse than none.
        faviconDomain: null,
        // Migration 0047 adds the column with no default. NULL is "the owner has
        // never chosen", which the public read serves as `null` — never 'UTC',
        // which would be indistinguishable from an owner who chose UTC.
        reportingTimezone: null,
        firstEventAt: null,
      })
    })

    it('derives the favicon domain from the first allowlist entry', async () => {
      const { siteId, ownerUserId } = await makeSite()
      await updateSiteSettings(db, {
        siteId,
        // Sent out of order on purpose: the allowlist is a set with no stored
        // order, so "first" has to be a rule rather than an insertion accident.
        domains: ['zeta.example.com', 'acme.example.com'],
        actorUserId: ownerUserId,
      })
      const identity = await readPublicSiteIdentity(db, siteId)
      expect(identity?.faviconDomain).toBe('acme.example.com')
    })

    it('stores a reporting timezone without bumping config_version', async () => {
      // The pin for D4's last clause. `config_version` is the tracker/ingest
      // config generation — it invalidates the tracker-config ETag, the CDN copy
      // and the collector's ingest cache together — and a reporting timezone is
      // a read-side presentation choice the collector has never heard of.
      // Bumping would re-fetch every browser's config for a value none of them
      // holds.
      const { siteId, ownerUserId } = await makeSite()
      const before = await siteConfigVersion(siteId)

      const updated = await updateSiteSettings(db, {
        siteId,
        reportingTimezone: 'Europe/Istanbul',
        actorUserId: ownerUserId,
      })

      expect(updated.reportingTimezone).toBe('Europe/Istanbul')
      expect(updated.configVersionBumped).toBe(false)
      expect(updated.configVersion).toBe(before)
      expect(await siteConfigVersion(siteId)).toBe(before)
      expect((await readPublicSiteIdentity(db, siteId))?.reportingTimezone).toBe('Europe/Istanbul')
    })

    it('clears the setting on an explicit null, and null is not "unset the field"', async () => {
      const { siteId, ownerUserId } = await makeSite()
      await updateSiteSettings(db, {
        siteId,
        reportingTimezone: 'Europe/Istanbul',
        actorUserId: ownerUserId,
      })
      const cleared = await updateSiteSettings(db, {
        siteId,
        reportingTimezone: null,
        actorUserId: ownerUserId,
      })
      expect(cleared.reportingTimezone).toBeNull()
    })

    it('the column CHECK refuses an offset zone a caller could smuggle past the API', async () => {
      // `Intl` accepts `+05:00` as a time zone and this product does not
      // (ADR-0026). `isValidTimezone`'s shape guard refuses it at the route; this
      // constraint is the floor under that check, so a direct SQL write cannot
      // plant a value the public read would have to defend against.
      const { siteId } = await makeSite()
      await expect(
        pool.query(`UPDATE sites SET reporting_timezone = '+05:00' WHERE id = $1`, [siteId]),
      ).rejects.toMatchObject({ constraint: 'sites_reporting_timezone_format' })
    })
  })
})
