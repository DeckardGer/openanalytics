import {
  applyDepartureToApiKeys,
  createApiKey,
  createDatabase,
  createPool,
  createSiteWithOwner,
  getLiveTrackingToken,
  listApiKeys,
  newId,
  resolveReadApiKey,
  resolveTrackingKey,
  revokeApiKey,
  touchApiKeyUsage,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * API keys: the public tracking write key and the private read key are kept
 * apart, only the private hash is stored, and no read path accepts a tracking
 * key (docs snapshot 02 §20, plan Milestone 2 items 8 and acceptance).
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

describeIfPostgres('api keys', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m2keys_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database
  let siteId: string
  let userId: string

  const rowJson = async (id: string) => {
    const result = await pool.query<{ row: unknown }>(
      `SELECT to_jsonb(t) AS row FROM api_keys t WHERE id = $1`,
      [id],
    )
    return JSON.stringify(result.rows[0]?.row ?? {})
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
    userId = newId()
    await pool.query(
      `INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'U', $2, true)`,
      [userId, `${userId}@example.com`],
    )
    const created = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId: userId,
    })
    siteId = created.siteId
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

  it('stores only a hash for a private key and never its raw form', async () => {
    const key = await createApiKey(db, {
      siteId,
      type: 'private_read',
      name: 'server',
      createdByUserId: userId,
    })
    expect(key.rawToken.startsWith('oa_sk_')).toBe(true)

    // The raw token appears in no column of the stored row.
    const json = await rowJson(key.id)
    expect(json).not.toContain(key.rawToken)

    // And it is nowhere in the audit trail either.
    const audit = await pool.query<{ row: unknown }>(
      `SELECT to_jsonb(t) AS row FROM audit_logs t WHERE action = 'api_key.created'`,
    )
    const auditJson = JSON.stringify(audit.rows.map((r) => r.row))
    expect(auditJson).not.toContain(key.rawToken)
    expect(auditJson).toContain(key.keyPrefix)
  })

  it('resolves a private key on read but rejects a tracking key there', async () => {
    const priv = await createApiKey(db, { siteId, type: 'private_read', createdByUserId: userId })
    const track = await createApiKey(db, {
      siteId,
      type: 'tracking_write',
      createdByUserId: userId,
    })

    // The private key is accepted on a read path...
    const resolved = await resolveReadApiKey(db, priv.rawToken)
    expect(resolved?.type).toBe('private_read')
    expect(resolved?.siteId).toBe(siteId)

    // ...the public tracking key is not, and is not usable as read auth.
    expect(await resolveReadApiKey(db, track.rawToken)).toBeNull()
    // But it does resolve on the ingest path.
    expect((await resolveTrackingKey(db, track.rawToken))?.type).toBe('tracking_write')
    // And the private key is not a tracking key.
    expect(await resolveTrackingKey(db, priv.rawToken)).toBeNull()
  })

  it('keeps the public tracking token retrievable but not the private one', async () => {
    const track = await createApiKey(db, {
      siteId,
      type: 'tracking_write',
      createdByUserId: userId,
    })
    await createApiKey(db, { siteId, type: 'private_read', createdByUserId: userId })

    const summaries = await listApiKeys(db, siteId)
    const trackSummary = summaries.find((s) => s.id === track.id)
    expect(trackSummary?.publicToken).toBe(track.rawToken)

    for (const summary of summaries.filter((s) => s.type === 'private_read')) {
      expect(summary.publicToken).toBeNull()
    }
  })

  it('stops resolving a revoked key', async () => {
    const key = await createApiKey(db, { siteId, type: 'private_read', createdByUserId: userId })
    expect(await resolveReadApiKey(db, key.rawToken)).not.toBeNull()

    await revokeApiKey(db, { id: key.id, siteId, actorUserId: userId })
    expect(await resolveReadApiKey(db, key.rawToken)).toBeNull()

    const revokeAudit = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs WHERE action = 'api_key.revoked' AND target_id = $1`,
      [key.id],
    )
    expect(revokeAudit.rows[0]?.n).toBe('1')
  })

  /**
   * Scopes (ADR-0042, D3), against a real database rather than a mock, because
   * every one of these claims is about what the *column* holds: the default the
   * insert writes, what migration 0042 did to rows that predate it, and what a
   * NULL that survives the migration resolves to.
   */
  describe('scopes', () => {
    it('mints a private key with the minimum scope when none is asked for', async () => {
      const key = await createApiKey(db, { siteId, type: 'private_read', createdByUserId: userId })

      const stored = await pool.query<{ scopes: string[] | null }>(
        `SELECT scopes FROM api_keys WHERE id = $1`,
        [key.id],
      )
      expect(stored.rows[0]?.scopes).toEqual(['site:read'])

      const resolved = await resolveReadApiKey(db, key.rawToken)
      expect(resolved?.scopes).toEqual(['site:read'])
    })

    it('mints the analytics scope only when it is asked for, and records it in the audit', async () => {
      const key = await createApiKey(db, {
        siteId,
        type: 'private_read',
        createdByUserId: userId,
        scopes: ['site:read', 'analytics:read'],
      })
      const resolved = await resolveReadApiKey(db, key.rawToken)
      expect(resolved?.scopes).toEqual(['site:read', 'analytics:read'])

      // The grant is in the audit trail because it is the part an owner may
      // later dispute — and the raw token still is not.
      const audit = await pool.query<{ metadata: unknown }>(
        `SELECT metadata FROM audit_logs WHERE action = 'api_key.created' AND target_id = $1`,
        [key.id],
      )
      expect(JSON.stringify(audit.rows[0]?.metadata)).toContain('analytics:read')
      expect(JSON.stringify(audit.rows[0]?.metadata)).not.toContain(key.rawToken)
    })

    it('writes no scopes for a tracking key, which has none to grant', async () => {
      const track = await createApiKey(db, {
        siteId,
        type: 'tracking_write',
        createdByUserId: userId,
      })
      const stored = await pool.query<{ scopes: string[] | null }>(
        `SELECT scopes FROM api_keys WHERE id = $1`,
        [track.id],
      )
      expect(stored.rows[0]?.scopes).toBeNull()

      const summary = (await listApiKeys(db, siteId)).find((s) => s.id === track.id)
      expect(summary?.scopes).toBeNull()
    })

    /**
     * The deploy-window row: an older api build inserting `NULL` after migration
     * 0042 has already run. It must resolve to the minimum, not to everything —
     * that reading is the reason the code-side default exists alongside the
     * backfill, and asserting it needs a row the repository would never write.
     */
    it('reads a NULL scopes column as the minimum, never as unscoped', async () => {
      const key = await createApiKey(db, { siteId, type: 'private_read', createdByUserId: userId })
      await pool.query(`UPDATE api_keys SET scopes = NULL WHERE id = $1`, [key.id])

      const resolved = await resolveReadApiKey(db, key.rawToken)
      expect(resolved?.scopes).toEqual(['site:read'])

      const summary = (await listApiKeys(db, siteId)).find((s) => s.id === key.id)
      expect(summary?.scopes).toEqual(['site:read'])
    })

    /**
     * Migration 0042's own statement, replayed over a row it would have found:
     * a pre-M14 private key with a NULL column widens to exactly `site:read`,
     * and a tracking key beside it is left alone.
     */
    it('backfills a pre-M14 private key to site:read and leaves a tracking key NULL', async () => {
      const priv = await createApiKey(db, { siteId, type: 'private_read', createdByUserId: userId })
      const track = await createApiKey(db, {
        siteId,
        type: 'tracking_write',
        createdByUserId: userId,
      })
      await pool.query(`UPDATE api_keys SET scopes = NULL WHERE id = ANY($1)`, [
        [priv.id, track.id],
      ])

      await pool.query(
        `UPDATE api_keys SET scopes = ARRAY['site:read']
         WHERE type = 'private_read' AND scopes IS NULL`,
      )

      const after = await pool.query<{ id: string; scopes: string[] | null }>(
        `SELECT id, scopes FROM api_keys WHERE id = ANY($1)`,
        [[priv.id, track.id]],
      )
      const byId = new Map(after.rows.map((row) => [row.id, row.scopes]))
      expect(byId.get(priv.id)).toEqual(['site:read'])
      expect(byId.get(track.id)).toBeNull()
      // Not `analytics:read`: no key widens because a milestone shipped.
      expect(byId.get(priv.id)).not.toContain('analytics:read')
    })
  })

  /**
   * `last_used_at` (ADR-0042, D7). The column has existed since migration 0004
   * and nothing wrote it until M14.
   */
  describe('last used', () => {
    it('records a first use, then throttles until the stored instant is stale', async () => {
      const key = await createApiKey(db, { siteId, type: 'private_read', createdByUserId: userId })

      const before = await pool.query<{ last_used_at: Date | null }>(
        `SELECT last_used_at FROM api_keys WHERE id = $1`,
        [key.id],
      )
      expect(before.rows[0]?.last_used_at).toBeNull()

      expect((await touchApiKeyUsage(db, { id: key.id, staleAfterSeconds: 60 })).touched).toBe(true)

      const first = await pool.query<{ last_used_at: Date | null }>(
        `SELECT last_used_at FROM api_keys WHERE id = $1`,
        [key.id],
      )
      expect(first.rows[0]?.last_used_at).not.toBeNull()

      // The second use inside the window writes nothing — the throttle lives in
      // the statement's WHERE, so it holds under concurrency too.
      expect((await touchApiKeyUsage(db, { id: key.id, staleAfterSeconds: 60 })).touched).toBe(
        false,
      )
      const second = await pool.query<{ last_used_at: Date | null }>(
        `SELECT last_used_at FROM api_keys WHERE id = $1`,
        [key.id],
      )
      expect(second.rows[0]?.last_used_at?.getTime()).toBe(first.rows[0]?.last_used_at?.getTime())

      // Age the stored instant past the window and it writes again. Aged in the
      // DATABASE's clock, not the test process's: a few milliseconds of skew
      // between the two is exactly what makes this kind of assertion flake.
      await pool.query(
        `UPDATE api_keys SET last_used_at = now() - interval '2 minutes' WHERE id = $1`,
        [key.id],
      )
      expect((await touchApiKeyUsage(db, { id: key.id, staleAfterSeconds: 60 })).touched).toBe(true)
    })
  })

  /**
   * The install block's tracking token (ADR-0042, D8): the newest un-revoked
   * `tracking_write` key, and nothing when there is none.
   */
  describe('the live tracking token', () => {
    it('returns the newest live tracking token and skips revoked ones', async () => {
      const fresh = await createSiteWithOwner(db, {
        slug: `s-${newId()}`,
        name: 'S2',
        ownerUserId: userId,
      })
      // `createSiteWithOwner` is the low-level helper and mints no key —
      // `createSite`, the route's entry point, is what mints the site's first
      // tracking key. So a site starts with nothing to install.
      expect(await getLiveTrackingToken(db, fresh.siteId)).toBeNull()

      const firstKey = await createApiKey(db, {
        siteId: fresh.siteId,
        type: 'tracking_write',
        createdByUserId: userId,
      })
      const first = await getLiveTrackingToken(db, fresh.siteId)
      expect(first).toBe(firstKey.rawToken)
      expect(first?.startsWith('oa_pk_')).toBe(true)

      const second = await createApiKey(db, {
        siteId: fresh.siteId,
        type: 'tracking_write',
        createdByUserId: userId,
      })
      expect(await getLiveTrackingToken(db, fresh.siteId)).toBe(second.rawToken)

      await revokeApiKey(db, { id: second.id, siteId: fresh.siteId, actorUserId: userId })
      expect(await getLiveTrackingToken(db, fresh.siteId)).toBe(first)
    })

    it('is null for a site whose only tracking key is revoked', async () => {
      const fresh = await createSiteWithOwner(db, {
        slug: `s-${newId()}`,
        name: 'S3',
        ownerUserId: userId,
      })
      await createApiKey(db, {
        siteId: fresh.siteId,
        type: 'tracking_write',
        createdByUserId: userId,
      })
      await pool.query(`UPDATE api_keys SET revoked_at = now() WHERE site_id = $1`, [fresh.siteId])
      expect(await getLiveTrackingToken(db, fresh.siteId)).toBeNull()
    })
  })

  describe('who holds the key, and what a departure does to it (ADR-0043 D8)', () => {
    it('mints a private key held by its creator unless the caller says otherwise', async () => {
      const mine = await createApiKey(db, { siteId, type: 'private_read', createdByUserId: userId })
      const installed = await createApiKey(db, {
        siteId,
        type: 'private_read',
        createdByUserId: userId,
        heldBy: 'site',
      })
      const listed = await listApiKeys(db, siteId)
      expect(listed.find((k) => k.id === mine.id)?.heldBy).toBe('user')
      expect(listed.find((k) => k.id === installed.id)?.heldBy).toBe('site')

      // The declaration is in the audit trail, because it is the part an owner
      // may later dispute: it decides whether this key outlives them.
      const audit = await pool.query<{ metadata: { heldBy?: string } }>(
        `SELECT metadata FROM audit_logs WHERE action = 'api_key.created' AND target_id = $1`,
        [installed.id],
      )
      expect(audit.rows[0]?.metadata.heldBy).toBe('site')
    })

    it('calls a tracking key the site’s, whatever the column holds', async () => {
      const tracking = await createApiKey(db, {
        siteId,
        type: 'tracking_write',
        createdByUserId: userId,
      })
      // Migration 0044 backfills the column; this proves the reading holds even
      // for a row an older api build inserted under the default in the deploy
      // window, which is the case the backfill cannot reach.
      await pool.query(`UPDATE api_keys SET held_by = 'user' WHERE id = $1`, [tracking.id])
      const listed = await listApiKeys(db, siteId)
      expect(listed.find((k) => k.id === tracking.id)?.heldBy).toBe('site')
    })

    it('revokes the departing member’s own key and keeps the one they installed', async () => {
      const site = await createSiteWithOwner(db, {
        slug: `s-${newId()}`,
        name: 'D1',
        ownerUserId: userId,
      })
      const personal = await createApiKey(db, {
        siteId: site.siteId,
        type: 'private_read',
        createdByUserId: userId,
      })
      const installed = await createApiKey(db, {
        siteId: site.siteId,
        type: 'private_read',
        createdByUserId: userId,
        heldBy: 'site',
      })
      const tracking = await createApiKey(db, {
        siteId: site.siteId,
        type: 'tracking_write',
        createdByUserId: userId,
      })

      const outcome = await applyDepartureToApiKeys(db, {
        siteId: site.siteId,
        userId,
        actorUserId: userId,
        now: new Date(),
      })
      expect(outcome).toEqual({ revoked: 1, flagged: 1 })

      const listed = await listApiKeys(db, site.siteId)
      const row = (id: string) => listed.find((k) => k.id === id)

      // The leak section 19 asks about: a credential its holder walks away with.
      expect(row(personal.id)?.revokedAt).not.toBeNull()
      expect(row(personal.id)?.rotationRequiredAt).toBeNull()

      // The outage ADR-0043 D1 refuses: a machine's credential taken down by a
      // personnel change. Alive, and saying out loud that it wants rotating.
      expect(row(installed.id)?.revokedAt).toBeNull()
      expect(row(installed.id)?.rotationRequiredAt).toBeInstanceOf(Date)

      // The site's public tracker token is nobody's secret and is untouched.
      expect(row(tracking.id)?.revokedAt).toBeNull()
      expect(row(tracking.id)?.rotationRequiredAt).toBeNull()

      const audit = await pool.query<{ action: string }>(
        `SELECT action FROM audit_logs WHERE target_id = ANY($1::text[]) AND action LIKE 'api_key.%'
           AND action <> 'api_key.created'`,
        [[personal.id, installed.id, tracking.id]],
      )
      expect(audit.rows.map((r) => r.action).sort()).toEqual([
        'api_key.revoked',
        'api_key.rotation_required',
      ])
    })

    it('keeps the earliest unresolved departure rather than restarting the clock', async () => {
      const site = await createSiteWithOwner(db, {
        slug: `s-${newId()}`,
        name: 'D2',
        ownerUserId: userId,
      })
      const installed = await createApiKey(db, {
        siteId: site.siteId,
        type: 'private_read',
        createdByUserId: userId,
        heldBy: 'site',
      })

      const first = new Date('2026-01-01T00:00:00.000Z')
      await applyDepartureToApiKeys(db, { siteId: site.siteId, userId, now: first })
      const second = await applyDepartureToApiKeys(db, {
        siteId: site.siteId,
        userId,
        now: new Date('2026-06-01T00:00:00.000Z'),
      })
      // Still flagged — the key is still exposed — but the instant is the first
      // departure's. An owner answering for this key is answering from January.
      expect(second.flagged).toBe(1)
      const listed = await listApiKeys(db, site.siteId)
      expect(listed.find((k) => k.id === installed.id)?.rotationRequiredAt).toEqual(first)
    })

    it('reaches only the named site when one is given', async () => {
      const kept = await createSiteWithOwner(db, {
        slug: `s-${newId()}`,
        name: 'D3',
        ownerUserId: userId,
      })
      const left = await createSiteWithOwner(db, {
        slug: `s-${newId()}`,
        name: 'D4',
        ownerUserId: userId,
      })
      const elsewhere = await createApiKey(db, {
        siteId: kept.siteId,
        type: 'private_read',
        createdByUserId: userId,
      })
      await createApiKey(db, {
        siteId: left.siteId,
        type: 'private_read',
        createdByUserId: userId,
      })

      // Leaving one site is not leaving the others: the member keeps every
      // credential on every site they still belong to.
      const outcome = await applyDepartureToApiKeys(db, {
        siteId: left.siteId,
        userId,
        now: new Date(),
      })
      expect(outcome.revoked).toBe(1)
      const listed = await listApiKeys(db, kept.siteId)
      expect(listed.find((k) => k.id === elsewhere.id)?.revokedAt).toBeNull()
    })
  })
})
