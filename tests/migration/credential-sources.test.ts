import {
  CREDENTIAL_SOURCE_REFRESH_SECONDS,
  apiKeyCredentialRef,
  credentialSourceHash,
  oauthGrantCredentialRef,
} from '@openanalytics/domain'
import {
  createDatabase,
  createPool,
  createSiteWithOwner,
  newId,
  noteCredentialSource,
  purgeAccountPostgres,
  purgeSitePostgres,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * `credential_sources`: the state that makes "first use from a new source" a
 * fact rather than a guess (ADR-0051, D5 and D9).
 *
 * The table is not the journal — `audit_logs` is (D1) — so what is tested here
 * is the decision it produces. Four outcomes come out of one statement, and each
 * one is a different audit row (or none), so getting the boundaries between them
 * wrong is how the journal would say something untrue.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

const KEY = { secret: 'credential-source-test-secret', keyVersion: 1 }
const MAX = 4

describeIfPostgres('credential_sources (ADR-0051 D5)', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `credsrc_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database
  let siteId: string
  let userId: string
  /** A second person, who owns no site — so an account teardown is not blocked
   * by the ownership gate, and the two halves stay genuinely separable. */
  let grantUserId: string

  const hashOf = (address: string): string => credentialSourceHash({ address, key: KEY })

  /** A use of an API key from an address, with the cap lowered so the boundary
   * is reachable in a test without inventing fifty addresses. */
  const useKey = async (ref: string, address: string, refreshAfterSeconds = 0) =>
    noteCredentialSource(db, {
      kind: 'api_key',
      ref,
      keyVersion: KEY.keyVersion,
      sourceHash: hashOf(address),
      siteId,
      maxSources: MAX,
      refreshAfterSeconds,
    })

  /** A use of an OAuth grant, which is keyed by the person rather than a site. */
  const useGrant = async (ref: string, address: string) =>
    noteCredentialSource(db, {
      kind: 'oauth_grant',
      ref,
      keyVersion: KEY.keyVersion,
      sourceHash: hashOf(address),
      userId: grantUserId,
      maxSources: MAX,
      refreshAfterSeconds: 0,
    })

  const countFor = async (ref: string): Promise<number> => {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM credential_sources WHERE credential_ref = $1`,
      [ref],
    )
    return Number(rows[0]?.n ?? 0)
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
    siteId = (
      await createSiteWithOwner(db, { slug: `s-${newId()}`, name: 'S', ownerUserId: userId })
    ).siteId

    grantUserId = newId()
    await pool.query(
      `INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'G', $2, true)`,
      [grantUserId, `${grantUserId}@example.com`],
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

  describe('the four outcomes', () => {
    it('reports first use once, then a new source, then nothing', async () => {
      const ref = apiKeyCredentialRef(newId())

      const first = await useKey(ref, '203.0.113.10')
      expect(first.outcome).toBe('first_use')
      expect(first.priorSources).toBe(0)

      // The same credential from a *different* address is the event G-010 asked
      // for, and it must not be reported as another first use.
      const second = await useKey(ref, '198.51.100.20')
      expect(second.outcome).toBe('new_source')
      expect(second.priorSources).toBe(1)

      // Back to the first address: known, and no row is added.
      const third = await useKey(ref, '203.0.113.10')
      expect(third.outcome).toBe('known')
      expect(await countFor(ref)).toBe(2)
    })

    it('caps a credential once, and says so exactly once', async () => {
      const ref = apiKeyCredentialRef(newId())
      const outcomes: string[] = []
      const capFlags: boolean[] = []

      for (let i = 0; i < MAX + 3; i += 1) {
        const result = await useKey(ref, `192.0.2.${String(i)}`)
        outcomes.push(result.outcome)
        capFlags.push(result.reachedCap)
      }

      // Four distinct sources are recorded, and the fourth is the one that
      // reaches the cap. Everything after it is refused, not recorded.
      expect(outcomes).toEqual([
        'first_use',
        'new_source',
        'new_source',
        'new_source',
        'capped',
        'capped',
        'capped',
      ])
      expect(capFlags.filter(Boolean)).toHaveLength(1)
      expect(capFlags[MAX - 1]).toBe(true)
      expect(await countFor(ref)).toBe(MAX)
    })

    it('leaves a known source alone until last_seen_at is stale', async () => {
      const ref = apiKeyCredentialRef(newId())
      await useKey(ref, '203.0.113.77', CREDENTIAL_SOURCE_REFRESH_SECONDS)

      const before = await pool.query<{ last_seen_at: Date }>(
        `SELECT last_seen_at FROM credential_sources WHERE credential_ref = $1`,
        [ref],
      )
      await useKey(ref, '203.0.113.77', CREDENTIAL_SOURCE_REFRESH_SECONDS)
      const after = await pool.query<{ last_seen_at: Date }>(
        `SELECT last_seen_at FROM credential_sources WHERE credential_ref = $1`,
        [ref],
      )

      // The throttle is the whole reason this is affordable on the read path:
      // the second use inside the window writes no row version at all.
      expect(after.rows[0]?.last_seen_at.getTime()).toBe(before.rows[0]?.last_seen_at.getTime())
    })

    it('re-baselines when the HMAC key version changes', async () => {
      const ref = apiKeyCredentialRef(newId())
      await useKey(ref, '203.0.113.90')

      const rotated = await noteCredentialSource(db, {
        kind: 'api_key',
        ref,
        keyVersion: KEY.keyVersion + 1,
        sourceHash: credentialSourceHash({
          address: '203.0.113.90',
          key: { ...KEY, keyVersion: KEY.keyVersion + 1 },
        }),
        siteId,
        maxSources: MAX,
        refreshAfterSeconds: 0,
      })

      // The same machine, a new key generation: first use again, once, which is
      // the operator-triggered consequence D4 writes down rather than hides.
      expect(rotated.outcome).toBe('first_use')
    })
  })

  /**
   * One table, two deletion vocabularies, two disjoint halves.
   *
   * Driven through the **real** purges rather than a helper written for the
   * test: a target name with no purge statement behind it verifies silently at
   * `deleted: 0`, which is the failure `packages/domain/src/deletion.ts` exists
   * to prevent, and only calling what production calls can catch it.
   */
  describe('the two deletion targets', () => {
    it('purges the site half without reaching a person’s grant rows', async () => {
      const keyRef = apiKeyCredentialRef(newId())
      const grantRef = oauthGrantCredentialRef(grantUserId, 'dcr_test_client')

      await useKey(keyRef, '203.0.113.1')
      await useGrant(grantRef, '203.0.113.2')

      // The purge deletes the site's memberships, and `assert_site_ownership`
      // (OA001) exempts only a site already on its way out — the same state the
      // real job reaches through `startSiteDeletion` before this phase runs.
      await pool.query(`UPDATE sites SET status = 'deleting' WHERE id = $1`, [siteId])

      // Every row this file has recorded for the site, not just this test's:
      // the count the target row carries has to be the count that was there.
      const { rows: before } = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM credential_sources WHERE site_id = $1`,
        [siteId],
      )
      const purged = await purgeSitePostgres(db, { siteId })
      expect(purged.deleted['credential_sources']).toBe(Number(before[0]?.n))
      expect(purged.deleted['credential_sources']).toBeGreaterThan(0)
      expect(await countFor(keyRef)).toBe(0)
      // The grant row is keyed by a person, not a site. A site deletion that
      // took it would be erasing somebody's record of their own machines.
      expect(await countFor(grantRef)).toBe(1)
    })

    it('purges the user half without reaching a site’s key rows', async () => {
      const keyRef = apiKeyCredentialRef(newId())
      const grantRef = oauthGrantCredentialRef(grantUserId, 'dcr_test_client')

      await useKey(keyRef, '203.0.113.3')

      const purged = await purgeAccountPostgres(db, { userId: grantUserId })
      expect(purged.affected['credential_sources_user']).toBe(1)
      expect(await countFor(grantRef)).toBe(0)
      // An account teardown revokes the person's API keys rather than deleting
      // them, and the sites they belong to survive — so this row must too.
      expect(await countFor(keyRef)).toBe(1)
    })
  })

  describe('what is stored', () => {
    it('stores a hash and never anything that looks like an address', async () => {
      const ref = apiKeyCredentialRef(newId())
      const address = '203.0.113.199'
      await useKey(ref, address)

      const { rows } = await pool.query<{ row: Record<string, unknown> }>(
        `SELECT to_jsonb(t) AS row FROM credential_sources t WHERE credential_ref = $1`,
        [ref],
      )
      const serialized = JSON.stringify(rows[0]?.row ?? {})
      expect(serialized).not.toContain(address)
      expect(serialized).toContain(hashOf(address))
      // 32 bytes of SHA-256, hex.
      expect(hashOf(address)).toMatch(/^[0-9a-f]{64}$/u)
    })

    it('gives two addresses two fingerprints, and one address one', () => {
      expect(hashOf('203.0.113.1')).not.toBe(hashOf('203.0.113.2'))
      expect(hashOf('203.0.113.1')).toBe(hashOf('203.0.113.1'))
      // Case only — a proxy may render IPv6 either way, and the same client must
      // not read as two sources.
      expect(hashOf('2001:DB8::1')).toBe(hashOf('2001:db8::1'))
      // A different secret is a different fingerprint for the same address,
      // which is what makes the hash keyed rather than merely opaque.
      expect(
        credentialSourceHash({ address: '203.0.113.1', key: { ...KEY, secret: 'other' } }),
      ).not.toBe(hashOf('203.0.113.1'))
    })
  })
})
