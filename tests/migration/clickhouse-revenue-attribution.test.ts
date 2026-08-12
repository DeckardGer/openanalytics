import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createClient } from '@clickhouse/client'
import {
  createRevenueAttributionsStore,
  migrateClickHouse,
  revenueAttributionsToken,
  type RevenueAttributionRow,
  type SessionFactRow,
} from '@openanalytics/clickhouse'
import { planRevenueAttributions, revenueAttributionFingerprintsEqual } from '@openanalytics/domain'
import { toAttributionRow } from '../../apps/worker/src/revenue/attribute.ts'
import { createCapturedLogger } from '@openanalytics/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Migration 0017's two halves against a live ClickHouse (ADR-0033, D6).
 * Milestone 12 Checkpoint 4.
 *
 * Only a real server can answer any of these, because every one is about the
 * engine rather than about our code:
 *
 * 1. **The session fact really gained `utm_content` and `utm_term`**, as
 *    `LowCardinality(String)` with the empty-string default that makes the
 *    fingerprint rule hold — a unit test could only assert that we typed a
 *    string. And the argMax read still resolves the pre-existing columns
 *    correctly across versions, which is what "in lockstep" has to mean.
 * 2. **`revenue_attributions` is what D6 specifies**: engine, partition key,
 *    sort key, deduplication window.
 * 3. **A higher version supersedes a lower one under the argMax read, BEFORE
 *    any merge has run.** ReplacingMergeTree's replacement is a space
 *    reclamation, not a correctness mechanism, and `FINAL` is deliberately never
 *    used. This is the property the late-flip design depends on: a `none`
 *    attribution re-versioned to `exact` has to read as `exact` immediately.
 * 4. **Every version of one attribution lands in ONE partition.** The whole
 *    reason `occurred_at` exists on this table rather than partitioning on
 *    `computed_at`: Replacing only replaces within a partition, so a recompute
 *    that moved partitions would leave two live versions that never collapse.
 * 5. **The visitor filter is applied AFTER the argMax**, so a session that was
 *    identified by a later version is found by its new `user_id` and not by its
 *    old one — the trap migration 0013's read contract warns about, in a place
 *    where it is easy to get wrong.
 *
 * Runs on the migration/default credential like every other ClickHouse suite:
 * `oa_ingest`'s grant on these tables is a users-file entry on the deployed
 * server (CP7) and does not exist in CI. The grant is proven by the deploy step;
 * the statements are proven here.
 *
 * Skipped without `TEST_CLICKHOUSE_URL`; CI always provides one.
 */

const URL_ = process.env['TEST_CLICKHOUSE_URL']
const USERNAME = process.env['TEST_CLICKHOUSE_USER'] ?? 'default'
const PASSWORD = process.env['TEST_CLICKHOUSE_PASSWORD'] ?? ''

const describeIfClickHouse = URL_ ? describe : describe.skip

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../packages/clickhouse/migrations/', import.meta.url),
)

function attributionRow(
  overrides: Partial<RevenueAttributionRow> & Pick<RevenueAttributionRow, 'site_id'>,
): RevenueAttributionRow {
  return {
    provider: 'stripe',
    object_id: 'ch_1',
    version: 1,
    occurred_at: '2026-07-30 12:00:00.000',
    model_version: 1,
    window_days: 30,
    matched_via: 'none',
    confidence: 'none',
    identity_scope: '',
    visitor_id: '',
    user_id: '',
    ft_session_id: '',
    ft_session_start: '1970-01-01 00:00:00.000',
    ft_referrer_domain: '',
    ft_utm_source: '',
    ft_utm_medium: '',
    ft_utm_campaign: '',
    ft_utm_content: '',
    ft_utm_term: '',
    ft_entry_page: '',
    lt_session_id: '',
    lt_session_start: '1970-01-01 00:00:00.000',
    lt_referrer_domain: '',
    lt_utm_source: '',
    lt_utm_medium: '',
    lt_utm_campaign: '',
    lt_utm_content: '',
    lt_utm_term: '',
    lt_entry_page: '',
    touchpoint_count: 0,
    journey_truncated: 0,
    journey: '[]',
    computed_at: '2026-07-31 09:00:00.000',
    ...overrides,
  }
}

function factRow(
  overrides: Partial<SessionFactRow> & Pick<SessionFactRow, 'site_id' | 'session_id'>,
): SessionFactRow {
  return {
    version: 1,
    visitor_id: 'v1',
    user_id: '',
    anonymous_id: 'anon1',
    session_hint: '',
    midnight_bridged: 0,
    session_start: '2026-07-20 10:00:00.000',
    session_end: '2026-07-20 10:05:00.000',
    pageviews: 2,
    engaged: 1,
    active_duration_ms: 30_000,
    session_duration_ms: 300_000,
    entry_page_path: '/pricing',
    exit_page_path: '/checkout',
    referrer_domain: 'google.com',
    utm_source: 'google',
    utm_medium: 'cpc',
    utm_campaign: 'summer',
    utm_content: 'banner-a',
    utm_term: 'analytics',
    device_type: 'desktop',
    browser: 'chrome',
    os: 'macos',
    country: 'AZ',
    finalized: 1,
    retracted: 0,
    computed_at: '2026-07-21 00:00:00.000',
    ...overrides,
  }
}

describeIfClickHouse('revenue attribution (ClickHouse 0017)', () => {
  const url = URL_ as string
  const database = `m12attr_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let client: ReturnType<typeof createClient>
  let store: ReturnType<typeof createRevenueAttributionsStore>

  const queryRows = async <T>(query: string): Promise<T[]> => {
    const resultSet = await client.query({ query, format: 'JSONEachRow' })
    return await resultSet.json<T>()
  }

  const scalar = async (query: string): Promise<number> => {
    const [row] = await queryRows<Record<string, string>>(query)
    return Number(Object.values(row ?? {})[0] ?? 0)
  }

  const insertFacts = async (rows: readonly SessionFactRow[]): Promise<void> => {
    await client.insert({
      table: 'session_facts_versions',
      values: rows,
      format: 'JSONEachRow',
      clickhouse_settings: { insert_deduplication_token: randomUUID() },
    })
  }

  /**
   * `events_raw` rows, defaults spread under the caller's overrides.
   *
   * The same shape `clickhouse-rollups` and `query-gateway-sessions` use, and it
   * is worth copying rather than hand-rolling for one specific reason:
   * **`event_id` is a `UUID` column, not a `String`.** A readable placeholder
   * there does not fail with "cannot parse UUID" — the JSONEachRow reader
   * consumes a fixed shape, desynchronises, and reports a parse error pointing at
   * whatever key came next, which reads exactly like malformed JSON and sends you
   * hunting escaping bugs that are not there. `site_id` is a UUID too.
   *
   * `properties` is a `String` holding JSON, so it is double-encoded: the value
   * handed over is already a JSON string, and the client's own `JSON.stringify`
   * of the row escapes it a second time. The client does that — nothing here
   * builds JSON by hand.
   */
  const insertRawEvents = async (rows: readonly Record<string, unknown>[]): Promise<void> => {
    await client.insert({
      table: 'events_raw',
      values: rows.map((row) => ({
        schema_version: 1,
        batch_id: 'b',
        name: '',
        origin: 'browser',
        billable: 1,
        anonymous_id: '',
        session_id: '',
        user_id: '',
        page_url: '',
        page_path: '',
        page_title: '',
        referrer_domain: '',
        referrer_path: '',
        utm_source: '',
        utm_medium: '',
        utm_campaign: '',
        utm_content: '',
        utm_term: '',
        properties: '{}',
        sdk: '',
        sdk_version: '',
        device_type: '',
        browser: '',
        os: '',
        country: '',
        city: '',
        ...row,
      })),
      format: 'JSONEachRow',
      clickhouse_settings: { insert_deduplication_token: randomUUID() },
    })
  }

  beforeAll(async () => {
    const { logger } = createCapturedLogger()
    await migrateClickHouse({
      url,
      username: USERNAME,
      password: PASSWORD,
      database,
      directory: MIGRATIONS_DIR,
      logger,
    })
    client = createClient({
      url,
      username: USERNAME,
      password: PASSWORD,
      database,
      clickhouse_settings: { async_insert: 0, wait_for_async_insert: 1 },
    })
    store = createRevenueAttributionsStore({
      url,
      username: USERNAME,
      password: PASSWORD,
      database,
    })
  }, 180_000)

  afterAll(async () => {
    await store?.close()
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database}` })
      await client.close()
    }
  })

  describe('part A — the session fact widening', () => {
    it('added utm_content and utm_term as LowCardinality(String)', async () => {
      const rows = await queryRows<{ name: string; type: string }>(
        `SELECT name, type FROM system.columns
          WHERE database = '${database}' AND table = 'session_facts_versions'
            AND name IN ('utm_content', 'utm_term')
          ORDER BY name`,
      )
      expect(rows.map((row) => row.name)).toEqual(['utm_content', 'utm_term'])
      for (const row of rows) {
        expect(row.type, row.name).toBe('LowCardinality(String)')
      }
    })

    it('defaults an unwritten value to the empty string, which is what the fingerprint rule rests on', async () => {
      // The migration's whole safety argument: ClickHouse's default for the added
      // column is the same byte `sessionize` produces for an absent utm, so a
      // pre-extension row compares EQUAL to its recompute and the first pass
      // after the deploy does not re-version the world.
      const siteId = randomUUID()
      await client.command({
        query: `INSERT INTO session_facts_versions (site_id, session_id, version, session_start)
                VALUES ('${siteId}', 's_default', 1, toDateTime64('2026-07-20 10:00:00.000', 3, 'UTC'))`,
      })
      const empty = await scalar(
        `SELECT count() FROM session_facts_versions
          WHERE site_id = '${siteId}' AND utm_content = '' AND utm_term = ''`,
      )
      expect(empty).toBe(1)
    })

    it('reads both new columns back through the argMax rule, with the old ones intact', async () => {
      const siteId = randomUUID()
      await insertFacts([factRow({ site_id: siteId, session_id: 's_1' })])
      // A second version that changed only the new columns, which is exactly the
      // shape the migration produces for a session that carried a utm_content.
      await insertFacts([
        factRow({
          site_id: siteId,
          session_id: 's_1',
          version: 2,
          utm_content: 'banner-b',
          utm_term: 'privacy',
        }),
      ])

      const touchpoints = await store.readSessionTouchpoints({
        siteId,
        fromMs: Date.parse('2026-07-01T00:00:00.000Z'),
        toMs: Date.parse('2026-08-01T00:00:00.000Z'),
        userIds: [],
        anonymousIds: ['anon1'],
      })

      expect(touchpoints).toHaveLength(1)
      // The newer version wins without any merge having run...
      expect(touchpoints[0]?.utmContent).toBe('banner-b')
      expect(touchpoints[0]?.utmTerm).toBe('privacy')
      // ...and the columns that existed before 0017 still resolve correctly.
      expect(touchpoints[0]?.utmSource).toBe('google')
      expect(touchpoints[0]?.referrerDomain).toBe('google.com')
      expect(touchpoints[0]?.entryPagePath).toBe('/pricing')
    })

    it('drops a retracted session after the argMax, never before it', async () => {
      const siteId = randomUUID()
      await insertFacts([factRow({ site_id: siteId, session_id: 's_gone' })])
      await insertFacts([
        factRow({ site_id: siteId, session_id: 's_gone', version: 2, retracted: 1 }),
      ])

      const touchpoints = await store.readSessionTouchpoints({
        siteId,
        fromMs: Date.parse('2026-07-01T00:00:00.000Z'),
        toMs: Date.parse('2026-08-01T00:00:00.000Z'),
        userIds: [],
        anonymousIds: ['anon1'],
      })
      // A pre-filter would have discarded the tombstone and resurrected the
      // older, un-retracted version as a touchpoint.
      expect(touchpoints).toHaveLength(0)
    })

    it('finds a session by the identity its LATEST version carries', async () => {
      // `user_id` is a versioned column — the identity stitch can give a session
      // one it did not have when it was first written. Filtering on it before the
      // grouping would find the session by its OLD identity and miss its new one,
      // which is why the store applies the visitor filter to the grouped result.
      const siteId = randomUUID()
      await insertFacts([
        factRow({ site_id: siteId, session_id: 's_stitch', anonymous_id: 'anon2', user_id: '' }),
      ])
      await insertFacts([
        factRow({
          site_id: siteId,
          session_id: 's_stitch',
          version: 2,
          anonymous_id: 'anon2',
          user_id: 'user_hash_9',
          visitor_id: 'user_hash_9',
        }),
      ])

      const byNewIdentity = await store.readSessionTouchpoints({
        siteId,
        fromMs: Date.parse('2026-07-01T00:00:00.000Z'),
        toMs: Date.parse('2026-08-01T00:00:00.000Z'),
        userIds: ['user_hash_9'],
        anonymousIds: [],
      })
      expect(byNewIdentity).toHaveLength(1)
      expect(byNewIdentity[0]?.userId).toBe('user_hash_9')
    })
  })

  describe('part B — the revenue_attributions schema (D6)', () => {
    it('is a ReplacingMergeTree(version) partitioned and sorted as decided', async () => {
      const [table] = await queryRows<{
        engine_full: string
        partition_key: string
        sorting_key: string
      }>(
        `SELECT engine_full, partition_key, sorting_key
           FROM system.tables
          WHERE database = '${database}' AND name = 'revenue_attributions'`,
      )
      expect(table?.engine_full).toContain('ReplacingMergeTree(version)')
      // NOT `computed_at` — that moves on every recompute, so the versions of one
      // attribution would scatter across partitions and never collapse.
      expect(table?.partition_key).toContain('toYYYYMM(occurred_at)')
      expect(table?.sorting_key.replace(/\s+/gu, '')).toBe('site_id,provider,object_id')
      expect(table?.sorting_key).not.toContain('version')
    })

    it('carries the deduplication window without which the insert token is ignored', async () => {
      const [table] = await queryRows<{ create_table_query: string }>(
        `SELECT create_table_query FROM system.tables
          WHERE database = '${database}' AND name = 'revenue_attributions'`,
      )
      expect(table?.create_table_query).toMatch(/non_replicated_deduplication_window\s*=\s*[1-9]/u)
    })

    it('holds the D6 column list, with the two CP4 additions', async () => {
      const rows = await queryRows<{ name: string; type: string }>(
        `SELECT name, type FROM system.columns
          WHERE database = '${database}' AND table = 'revenue_attributions'`,
      )
      const byName = new Map(rows.map((row) => [row.name, row.type]))

      for (const column of [
        'site_id',
        'provider',
        'object_id',
        'version',
        'model_version',
        'window_days',
        'matched_via',
        'confidence',
        'identity_scope',
        'visitor_id',
        'user_id',
        'touchpoint_count',
        'journey',
        'computed_at',
      ]) {
        expect(byName.has(column), column).toBe(true)
      }
      for (const prefix of ['ft', 'lt']) {
        for (const suffix of [
          'session_id',
          'session_start',
          'referrer_domain',
          'utm_source',
          'utm_medium',
          'utm_campaign',
          'utm_content',
          'utm_term',
          'entry_page',
        ]) {
          expect(byName.has(`${prefix}_${suffix}`), `${prefix}_${suffix}`).toBe(true)
        }
      }
      // The two the ADR's list does not name and CP4 decided.
      expect(byName.get('occurred_at')).toBe("DateTime64(3, 'UTC')")
      expect(byName.get('journey_truncated')).toBe('UInt8')

      // The enumerable dimensions are LowCardinality; the high-cardinality
      // identifiers deliberately are not.
      expect(byName.get('matched_via')).toBe('LowCardinality(String)')
      expect(byName.get('confidence')).toBe('LowCardinality(String)')
      expect(byName.get('identity_scope')).toBe('LowCardinality(String)')
      expect(byName.get('object_id')).toBe('String')
      expect(byName.get('visitor_id')).toBe('String')
      expect(byName.get('journey')).toBe('String')

      // Nothing nullable: absence is the empty string, as everywhere else here.
      expect(rows.some((row) => row.type.startsWith('Nullable'))).toBe(false)
    })

    it('is not a materialized view target and has no view beside it', async () => {
      const views = await queryRows<{ name: string }>(
        `SELECT name FROM system.tables
          WHERE database = '${database}' AND engine = 'MaterializedView'
            AND name LIKE 'revenue_attributions%'`,
      )
      // An attribution depends on data that arrives AFTER the row it describes,
      // so an insert-once view could never express it (D-211's argument, one
      // fact further along).
      expect(views).toHaveLength(0)
    })
  })

  describe('versioning', () => {
    it('supersedes a lower version under argMax before any merge has run', async () => {
      const siteId = randomUUID()
      await store.insertRows([attributionRow({ site_id: siteId })])
      await store.insertRows([
        attributionRow({
          site_id: siteId,
          version: 2,
          matched_via: 'conversion_event',
          confidence: 'exact',
          identity_scope: 'identified',
          visitor_id: 'user_hash_1',
          user_id: 'user_hash_1',
          ft_session_id: 's_1',
          ft_session_start: '2026-07-20 10:00:00.000',
          ft_utm_content: 'banner-a',
          lt_session_id: 's_1',
          lt_session_start: '2026-07-20 10:00:00.000',
          touchpoint_count: 1,
          journey: '[{"session_id":"s_1"}]',
        }),
      ])

      // Both versions are physically present — this is exactly the pre-merge
      // state the read rule has to be correct in.
      expect(
        await scalar(`SELECT count() FROM revenue_attributions WHERE site_id = '${siteId}'`),
      ).toBe(2)

      const stored = await store.readStoredAttributions({
        siteId,
        fromMs: Date.parse('2026-07-01T00:00:00.000Z'),
        toMs: Date.parse('2026-08-01T00:00:00.000Z'),
      })
      expect(stored).toHaveLength(1)
      // The late flip, at the storage layer: `none` re-versioned to `exact` reads
      // as `exact` immediately, with no merge and no FINAL.
      expect(stored[0]?.version).toBe(2)
      expect(stored[0]?.matchedVia).toBe('conversion_event')
      expect(stored[0]?.confidence).toBe('exact')
      expect(stored[0]?.ftUtmContent).toBe('banner-a')
      expect(stored[0]?.touchpointCount).toBe(1)
    })

    it('keeps every version of one attribution in a single partition', async () => {
      const siteId = randomUUID()
      await store.insertRows([attributionRow({ site_id: siteId, object_id: 'ch_part' })])
      await store.insertRows([
        attributionRow({
          site_id: siteId,
          object_id: 'ch_part',
          version: 2,
          // A recompute months later. With `computed_at` as the partition key
          // this row would land somewhere else and the two versions would never
          // collapse — and a stale one would stay visible to a partition-pruned
          // read forever.
          computed_at: '2026-11-15 04:00:00.000',
        }),
      ])

      const partitions = await queryRows<{ partition_id: string }>(
        `SELECT DISTINCT _partition_id AS partition_id
           FROM revenue_attributions
          WHERE site_id = '${siteId}' AND object_id = 'ch_part'`,
      )
      expect(partitions).toHaveLength(1)
      expect(partitions[0]?.partition_id).toBe('202607')
    })

    it('drops a replayed batch under the content-derived token and accepts a changed one', async () => {
      const siteId = randomUUID()
      const rows = [attributionRow({ site_id: siteId, object_id: 'ch_dedup' })]

      const first = await store.insertRows(rows)
      const second = await store.insertRows(rows)
      expect(first.token).toBe(revenueAttributionsToken(rows))
      expect(second.token).toBe(first.token)
      expect(
        await scalar(
          `SELECT count() FROM revenue_attributions
            WHERE site_id = '${siteId}' AND object_id = 'ch_dedup'`,
        ),
      ).toBe(1)

      // A genuinely different answer must never be deduplicated away.
      await store.insertRows([
        attributionRow({ site_id: siteId, object_id: 'ch_dedup', version: 2, confidence: 'exact' }),
      ])
      expect(
        await scalar(
          `SELECT count() FROM revenue_attributions
            WHERE site_id = '${siteId}' AND object_id = 'ch_dedup'`,
        ),
      ).toBe(2)
    })

    it('round-trips a computed attribution so its fingerprint compares EQUAL on re-read', async () => {
      // The property the whole idempotence story rests on and that nothing else
      // proves: the attribution job compares what it just computed against what
      // it reads back, and every value crosses several conversions on the way --
      // epoch ms to a `DateTime64` literal and back, a boolean to a `UInt8` and
      // back, an empty `identity_scope` through `LowCardinality`, and the journey
      // document through a `String` byte for byte. If any of them is lossy the
      // fingerprints never match, every one of the 96 daily refresh passes writes
      // a new version of every attribution forever, and the table grows without
      // bound while nothing is wrong with the data.
      const siteId = randomUUID()
      const occurredAtMs = Date.parse('2026-07-30T12:00:00.000Z')
      const plan = planRevenueAttributions({
        charges: [
          {
            objectId: 'ch_roundtrip',
            provider: 'stripe',
            occurredAtMs,
            status: 'succeeded',
            orderId: 'pi_roundtrip',
            checkoutSessionId: '',
            clientReferenceUserHash: '',
            customerIdentityUserHash: '',
          },
        ],
        conversions: [
          {
            orderId: 'pi_roundtrip',
            eventId: 'ev_1',
            occurredAtMs: occurredAtMs - 1_000,
            userId: 'user_hash_rt',
            anonymousId: 'anon_hash_rt',
          },
        ],
        sessions: [
          {
            sessionId: 'sess_rt',
            sessionStartMs: occurredAtMs - 86_400_000,
            userId: 'user_hash_rt',
            anonymousId: 'anon_hash_rt',
            referrerDomain: 'google.com',
            utmSource: 'google',
            utmMedium: 'cpc',
            utmCampaign: 'summer',
            utmContent: 'banner-a',
            utmTerm: 'analytics',
            entryPagePath: '/pricing',
          },
        ],
        stored: [],
      })
      const computed = plan.attributions[0]!

      await store.insertRows([
        toAttributionRow({ siteId, attribution: computed, computedAtMs: Date.now() }),
      ])
      const [stored] = await store.readStoredAttributions({
        siteId,
        fromMs: occurredAtMs - 1,
        toMs: occurredAtMs + 1,
      })

      expect(stored).toBeDefined()
      // The three enum-ish columns come back as plain strings, so they are
      // asserted directly and then carried into the comparator's union type.
      expect(stored?.matchedVia).toBe(computed.matchedVia)
      expect(stored?.confidence).toBe(computed.confidence)
      expect(stored?.identityScope).toBe(computed.identityScope)

      // Rebuilt into the domain's shape exactly as the job does, then compared
      // with the job's own comparator -- not field by field here, because what is
      // under test is that comparator returning true across the boundary.
      const roundTripped = {
        occurredAtMs: stored!.occurredAtMs,
        modelVersion: stored!.modelVersion,
        windowDays: stored!.windowDays,
        matchedVia: computed.matchedVia,
        confidence: computed.confidence,
        identityScope: computed.identityScope,
        visitorId: stored!.visitorId,
        userId: stored!.userId,
        firstTouch: {
          sessionId: stored!.ftSessionId,
          sessionStartMs: stored!.ftSessionStartMs,
          referrerDomain: stored!.ftReferrerDomain,
          utmSource: stored!.ftUtmSource,
          utmMedium: stored!.ftUtmMedium,
          utmCampaign: stored!.ftUtmCampaign,
          utmContent: stored!.ftUtmContent,
          utmTerm: stored!.ftUtmTerm,
          entryPage: stored!.ftEntryPage,
        },
        lastTouch: {
          sessionId: stored!.ltSessionId,
          sessionStartMs: stored!.ltSessionStartMs,
          referrerDomain: stored!.ltReferrerDomain,
          utmSource: stored!.ltUtmSource,
          utmMedium: stored!.ltUtmMedium,
          utmCampaign: stored!.ltUtmCampaign,
          utmContent: stored!.ltUtmContent,
          utmTerm: stored!.ltUtmTerm,
          entryPage: stored!.ltEntryPage,
        },
        touchpointCount: stored!.touchpointCount,
        journeyTruncated: stored!.journeyTruncated === 1,
        journey: stored!.journey,
      }
      expect(revenueAttributionFingerprintsEqual(roundTripped, computed)).toBe(true)
    })
  })

  describe('the conversion signal read', () => {
    it('matches an order id the site wrote with surrounding spaces', async () => {
      // The site writes `properties.order_id` by hand and a stray space is the
      // most ordinary way for it to arrive. The `IN` is an exact string
      // comparison, so without `trimBoth` on BOTH sides the padded row never
      // comes back and the matcher's own trim never gets to see it -- a silently
      // unattributable purchase with nothing anywhere saying why.
      const siteId = randomUUID()
      // Real UUIDs: `events_raw.event_id` is a `UUID` column. See
      // `insertRawEvents` for why a readable placeholder there fails as a JSON
      // parse error rather than as a type error.
      const paddedEventId = randomUUID()
      const cleanEventId = randomUUID()

      await insertRawEvents([
        {
          site_id: siteId,
          event_id: paddedEventId,
          type: 'conversion',
          name: 'purchase',
          occurred_at: '2026-07-30 11:59:00.000',
          received_at: '2026-07-30 11:59:01.000',
          accepted_at: '2026-07-30 11:59:01.000',
          anonymous_id: 'anon_pad',
          user_id: 'user_pad',
          properties: JSON.stringify({ order_id: '  pi_padded  ' }),
        },
        {
          site_id: siteId,
          event_id: cleanEventId,
          type: 'conversion',
          name: 'purchase',
          occurred_at: '2026-07-30 11:58:00.000',
          received_at: '2026-07-30 11:58:01.000',
          accepted_at: '2026-07-30 11:58:01.000',
          anonymous_id: 'anon_pad',
          user_id: 'user_pad',
          properties: JSON.stringify({ order_id: 'pi_clean' }),
        },
      ])

      const signals = await store.readConversionSignals({
        siteId,
        fromMs: Date.parse('2026-07-30T00:00:00.000Z'),
        toMs: Date.parse('2026-07-31T00:00:00.000Z'),
        orderIds: ['pi_padded', 'pi_clean'],
      })

      const byOrder = new Map(signals.map((signal) => [signal.orderId, signal]))
      // Found despite the padding, and returned TRIMMED -- the matcher keys its
      // lookup on the charge's own order id, so a padded key would miss.
      expect(byOrder.get('pi_padded')?.eventId).toBe(paddedEventId)
      expect(byOrder.get('pi_clean')?.eventId).toBe(cleanEventId)
      expect(signals).toHaveLength(2)
    })
  })
})
