import { createHash } from 'node:crypto'
import { createClient, type ClickHouseClient } from '@clickhouse/client'

/**
 * The attribution layer's ClickHouse surface (ADR-0033, D6; migration 0017).
 * Milestone 12 Checkpoint 4.
 *
 * Four statements and one row type — the reads the attribution job needs and the
 * write it produces. Every decision about *what* an attribution says lives in
 * `packages/domain/src/revenue-attribution.ts`, which is pure; this module only
 * knows how to ask ClickHouse for its inputs and how to make the answer durable.
 *
 * ## Why the session read is here and not in `session-facts.ts`
 *
 * `SessionFactsStore` exists to drive the finalizer's recompute: it reads a
 * window of facts wholesale so the planner can diff them. The attribution job
 * wants a different question answered — "the entry dimensions of THESE visitors'
 * sessions" — with a different projection and a filter the finalizer never
 * applies. Widening the finalizer's store with a second shape would put two
 * unrelated read contracts behind one interface, so the attribution job gets its
 * own store and the two never constrain each other. Both obey the identical
 * migration-0013 read rule.
 *
 * ## The read rule, restated because it has a new trap here
 *
 * Current truth is `argMax(col, version) GROUP BY key`, never `FINAL`, and every
 * filter on a column a version can change is applied AFTER the grouping.
 *
 * That last clause is load-bearing for `readSessionTouchpoints` specifically.
 * `user_id` and `anonymous_id` are *versioned* columns — the identity stitch can
 * give a session a user id it did not have when it was first written — so
 * filtering on them in the `WHERE` would resurrect a superseded version of a
 * session that has since been identified, or drop a session that has since been
 * stitched. The visitor filter therefore sits in the outer query, beside the
 * `retracted = 0` test, which is exactly where migration 0013's contract puts
 * it. `session_start` and `site_id` are safe to filter early: neither ever
 * changes for a stored session, and filtering them is what keeps the scan inside
 * the right partitions.
 *
 * Aggregated columns are qualified through the table alias, because CI's
 * ClickHouse resolves a bare name an alias shadows to the alias and throws
 * ILLEGAL_AGGREGATION.
 *
 * ## The write is synchronous and content-deduplicated
 *
 * Identical to the projection loop's insert (CP3) and for the same two reasons:
 * `async_insert = 0` because the run advances a durable watermark after the
 * insert resolves, and a content-derived `insert_deduplication_token` so a
 * crash-retry of the same batch is dropped rather than doubled. The token works
 * because the row builder is a pure function of the plan — `computed_at` is the
 * run's single clock value and is stamped once per run, so a retry within the
 * same run rebuilds identical bytes.
 */

export const REVENUE_ATTRIBUTIONS_TABLE = 'revenue_attributions'

/** One row of `analytics.revenue_attributions` — one version of one charge's attribution. */
export interface RevenueAttributionRow {
  readonly site_id: string
  readonly provider: string
  readonly object_id: string
  readonly version: number
  /** `YYYY-MM-DD HH:MM:SS.mmm`, UTC. The charge's occurrence, and the partition key. */
  readonly occurred_at: string
  readonly model_version: number
  readonly window_days: number
  readonly matched_via: string
  readonly confidence: string
  readonly identity_scope: string
  readonly visitor_id: string
  readonly user_id: string
  readonly ft_session_id: string
  readonly ft_session_start: string
  readonly ft_referrer_domain: string
  readonly ft_utm_source: string
  readonly ft_utm_medium: string
  readonly ft_utm_campaign: string
  readonly ft_utm_content: string
  readonly ft_utm_term: string
  readonly ft_entry_page: string
  readonly lt_session_id: string
  readonly lt_session_start: string
  readonly lt_referrer_domain: string
  readonly lt_utm_source: string
  readonly lt_utm_medium: string
  readonly lt_utm_campaign: string
  readonly lt_utm_content: string
  readonly lt_utm_term: string
  readonly lt_entry_page: string
  /** The TRUE touchpoint count, even when `journey` was truncated. */
  readonly touchpoint_count: number
  readonly journey_truncated: number
  /** Bounded JSON array, newest 50 touchpoints, oldest first. `[]` when unmatched. */
  readonly journey: string
  readonly computed_at: string
}

/** The current (latest-version) attribution of one charge, for change detection. */
export interface StoredAttributionRow {
  readonly objectId: string
  readonly provider: string
  readonly version: number
  readonly occurredAtMs: number
  readonly modelVersion: number
  readonly windowDays: number
  readonly matchedVia: string
  readonly confidence: string
  readonly identityScope: string
  readonly visitorId: string
  readonly userId: string
  readonly ftSessionId: string
  readonly ftSessionStartMs: number
  readonly ftReferrerDomain: string
  readonly ftUtmSource: string
  readonly ftUtmMedium: string
  readonly ftUtmCampaign: string
  readonly ftUtmContent: string
  readonly ftUtmTerm: string
  readonly ftEntryPage: string
  readonly ltSessionId: string
  readonly ltSessionStartMs: number
  readonly ltReferrerDomain: string
  readonly ltUtmSource: string
  readonly ltUtmMedium: string
  readonly ltUtmCampaign: string
  readonly ltUtmContent: string
  readonly ltUtmTerm: string
  readonly ltEntryPage: string
  readonly touchpointCount: number
  readonly journeyTruncated: number
  readonly journey: string
}

/** A `conversion` event that named an order (D6 signal 1), read from `events_raw`. */
export interface ConversionSignalRow {
  readonly eventId: string
  readonly orderId: string
  readonly occurredAtMs: number
  readonly userId: string
  readonly anonymousId: string
}

/** One current session entry, projected for attribution. */
export interface SessionTouchpointRow {
  readonly sessionId: string
  readonly sessionStartMs: number
  readonly userId: string
  readonly anonymousId: string
  readonly referrerDomain: string
  readonly utmSource: string
  readonly utmMedium: string
  readonly utmCampaign: string
  readonly utmContent: string
  readonly utmTerm: string
  readonly entryPagePath: string
}

export interface RevenueAttributionsStoreOptions {
  readonly url: string
  readonly username: string
  readonly password: string
  readonly database: string
  readonly requestTimeoutMs?: number
  /** Overridable for tests that migrate into a throwaway database. */
  readonly table?: string
  readonly sessionFactsTable?: string
  readonly eventsTable?: string
}

export const DEFAULT_REVENUE_ATTRIBUTIONS_TIMEOUT_MS = 60_000

export interface RevenueAttributionsStore {
  /** Insert a batch under a content-derived deduplication token. */
  insertRows(rows: readonly RevenueAttributionRow[]): Promise<{ readonly token: string | null }>
  /** Current attributions for charges occurring in `[fromMs, toMs)`. */
  readStoredAttributions(input: {
    siteId: string
    fromMs: number
    toMs: number
  }): Promise<StoredAttributionRow[]>
  /**
   * `conversion` events naming one of `orderIds`, over `[fromMs, toMs)`.
   *
   * The order-id filter is what bounds this read: without it the query would be
   * "every conversion event this site ever fired in a month", which on a site
   * that fires conversions for newsletter signups is a great many rows that can
   * match nothing.
   */
  readConversionSignals(input: {
    siteId: string
    fromMs: number
    toMs: number
    orderIds: readonly string[]
  }): Promise<ConversionSignalRow[]>
  /**
   * Current, non-retracted session entries in `[fromMs, toMs]` belonging to one
   * of the given visitor keys.
   *
   * Both bounds inclusive, because the attribution window is closed at both ends
   * (D2a, and the domain module argues the choice). The visitor filter is
   * applied after the argMax — see the module header.
   */
  readSessionTouchpoints(input: {
    siteId: string
    fromMs: number
    toMs: number
    userIds: readonly string[]
    anonymousIds: readonly string[]
  }): Promise<SessionTouchpointRow[]>
  ping(): Promise<boolean>
  close(): Promise<void>
}

/**
 * The batch's deduplication token: sha256 over a namespace and the rows.
 *
 * The same derivation `revenueEventsToken` and the session facts store use.
 * Content-derived rather than counter-derived: two different attempts at the
 * same work produce the same token so a replayed batch is dropped, while
 * genuinely new rows produce a different one and are always written.
 */
export function revenueAttributionsToken(rows: readonly RevenueAttributionRow[]): string {
  const hash = createHash('sha256')
  hash.update('revenue_attributions')
  hash.update('\n')
  hash.update(JSON.stringify(rows))
  return hash.digest('hex').slice(0, 32)
}

/** The ordered `argMax(col, version)` projection that reads an attribution's current value. */
const ATTRIBUTION_ARGMAX_COLUMNS = `
  max(ra.version)                                                AS version,
  toUnixTimestamp64Milli(argMax(ra.occurred_at, ra.version))     AS occurred_ms,
  argMax(ra.model_version, ra.version)                           AS model_version,
  argMax(ra.window_days, ra.version)                             AS window_days,
  argMax(ra.matched_via, ra.version)                             AS matched_via,
  argMax(ra.confidence, ra.version)                              AS confidence,
  argMax(ra.identity_scope, ra.version)                          AS identity_scope,
  argMax(ra.visitor_id, ra.version)                              AS visitor_id,
  argMax(ra.user_id, ra.version)                                 AS user_id,
  argMax(ra.ft_session_id, ra.version)                           AS ft_session_id,
  toUnixTimestamp64Milli(argMax(ra.ft_session_start, ra.version)) AS ft_session_start_ms,
  argMax(ra.ft_referrer_domain, ra.version)                      AS ft_referrer_domain,
  argMax(ra.ft_utm_source, ra.version)                           AS ft_utm_source,
  argMax(ra.ft_utm_medium, ra.version)                           AS ft_utm_medium,
  argMax(ra.ft_utm_campaign, ra.version)                         AS ft_utm_campaign,
  argMax(ra.ft_utm_content, ra.version)                          AS ft_utm_content,
  argMax(ra.ft_utm_term, ra.version)                             AS ft_utm_term,
  argMax(ra.ft_entry_page, ra.version)                           AS ft_entry_page,
  argMax(ra.lt_session_id, ra.version)                           AS lt_session_id,
  toUnixTimestamp64Milli(argMax(ra.lt_session_start, ra.version)) AS lt_session_start_ms,
  argMax(ra.lt_referrer_domain, ra.version)                      AS lt_referrer_domain,
  argMax(ra.lt_utm_source, ra.version)                           AS lt_utm_source,
  argMax(ra.lt_utm_medium, ra.version)                           AS lt_utm_medium,
  argMax(ra.lt_utm_campaign, ra.version)                         AS lt_utm_campaign,
  argMax(ra.lt_utm_content, ra.version)                          AS lt_utm_content,
  argMax(ra.lt_utm_term, ra.version)                             AS lt_utm_term,
  argMax(ra.lt_entry_page, ra.version)                           AS lt_entry_page,
  argMax(ra.touchpoint_count, ra.version)                        AS touchpoint_count,
  argMax(ra.journey_truncated, ra.version)                       AS journey_truncated,
  argMax(ra.journey, ra.version)                                 AS journey
`

/** The argMax projection of one current session entry. */
const TOUCHPOINT_ARGMAX_COLUMNS = `
  toUnixTimestamp64Milli(argMax(sfv.session_start, sfv.version)) AS session_start_ms,
  argMax(sfv.user_id, sfv.version)                           AS user_id,
  argMax(sfv.anonymous_id, sfv.version)                      AS anonymous_id,
  argMax(sfv.referrer_domain, sfv.version)                   AS referrer_domain,
  argMax(sfv.utm_source, sfv.version)                        AS utm_source,
  argMax(sfv.utm_medium, sfv.version)                        AS utm_medium,
  argMax(sfv.utm_campaign, sfv.version)                      AS utm_campaign,
  argMax(sfv.utm_content, sfv.version)                       AS utm_content,
  argMax(sfv.utm_term, sfv.version)                          AS utm_term,
  argMax(sfv.entry_page_path, sfv.version)                   AS entry_page_path,
  argMax(sfv.retracted, sfv.version)                         AS retracted
`

export function createRevenueAttributionsStore(
  options: RevenueAttributionsStoreOptions,
): RevenueAttributionsStore {
  const table = options.table ?? REVENUE_ATTRIBUTIONS_TABLE
  const factsTable = options.sessionFactsTable ?? 'session_facts_versions'
  const eventsTable = options.eventsTable ?? 'events_raw'

  const client: ClickHouseClient = createClient({
    url: options.url,
    username: options.username,
    password: options.password,
    database: options.database,
    request_timeout: options.requestTimeoutMs ?? DEFAULT_REVENUE_ATTRIBUTIONS_TIMEOUT_MS,
    clickhouse_settings: {
      // The run advances its Postgres watermark after this resolves. An async
      // insert would acknowledge before the block was durable.
      async_insert: 0,
      wait_for_async_insert: 1,
    },
  })

  const query = async <T>(sql: string, params: Record<string, unknown>): Promise<T[]> => {
    const resultSet = await client.query({
      query: sql,
      query_params: params,
      format: 'JSONEachRow',
    })
    return await resultSet.json<T>()
  }

  return {
    async insertRows(rows) {
      if (rows.length === 0) return { token: null }
      const token = revenueAttributionsToken(rows)
      await client.insert({
        table,
        values: rows,
        format: 'JSONEachRow',
        clickhouse_settings: { insert_deduplication_token: token },
      })
      return { token }
    },

    async readStoredAttributions({ siteId, fromMs, toMs }) {
      // DEPENDENCY, stated where it is relied on: this filters `occurred_at`
      // BEFORE the grouping, which is only legal because a charge's
      // `occurred_at` NEVER CHANGES ACROSS VERSIONS — the CP3 invariant that a
      // money object's occurrence does not move (migration 0016 partitions the
      // fact on it for the same reason, and this table copies the value from the
      // fact rather than deriving its own).
      //
      // If a provider correction ever moved it, two things break at once and
      // neither is loud: the versions of one attribution would land in different
      // monthly partitions and ReplacingMergeTree — which replaces only within a
      // partition — would keep both alive forever, and this pre-filter would
      // return the stale version whenever the new one fell outside the window.
      // The read would be wrong while looking entirely healthy.
      //
      // Nothing here handles that case, deliberately: handling it means dropping
      // the pre-filter and the partition pruning it buys, for a provider
      // behaviour no adapter has ever produced. What this comment buys is that
      // the day it happens, the dependency is written next to the `WHERE` that
      // stakes on it rather than reconstructed from a bug report.
      const rows = await query<Record<string, string>>(
        `SELECT
           ra.object_id AS object_id,
           ra.provider  AS provider,
           ${ATTRIBUTION_ARGMAX_COLUMNS}
         FROM ${table} AS ra
         WHERE ra.site_id = {siteId:String}
           AND ra.occurred_at >= fromUnixTimestamp64Milli({fromMs:Int64})
           AND ra.occurred_at <  fromUnixTimestamp64Milli({toMs:Int64})
         GROUP BY ra.site_id, ra.provider, ra.object_id`,
        { siteId, fromMs, toMs },
      )

      return rows.map((row) => ({
        objectId: row['object_id'] as string,
        provider: row['provider'] as string,
        version: Number(row['version']),
        occurredAtMs: Number(row['occurred_ms']),
        modelVersion: Number(row['model_version']),
        windowDays: Number(row['window_days']),
        matchedVia: row['matched_via'] as string,
        confidence: row['confidence'] as string,
        identityScope: row['identity_scope'] as string,
        visitorId: row['visitor_id'] as string,
        userId: row['user_id'] as string,
        ftSessionId: row['ft_session_id'] as string,
        ftSessionStartMs: Number(row['ft_session_start_ms']),
        ftReferrerDomain: row['ft_referrer_domain'] as string,
        ftUtmSource: row['ft_utm_source'] as string,
        ftUtmMedium: row['ft_utm_medium'] as string,
        ftUtmCampaign: row['ft_utm_campaign'] as string,
        ftUtmContent: row['ft_utm_content'] as string,
        ftUtmTerm: row['ft_utm_term'] as string,
        ftEntryPage: row['ft_entry_page'] as string,
        ltSessionId: row['lt_session_id'] as string,
        ltSessionStartMs: Number(row['lt_session_start_ms']),
        ltReferrerDomain: row['lt_referrer_domain'] as string,
        ltUtmSource: row['lt_utm_source'] as string,
        ltUtmMedium: row['lt_utm_medium'] as string,
        ltUtmCampaign: row['lt_utm_campaign'] as string,
        ltUtmContent: row['lt_utm_content'] as string,
        ltUtmTerm: row['lt_utm_term'] as string,
        ltEntryPage: row['lt_entry_page'] as string,
        touchpointCount: Number(row['touchpoint_count']),
        journeyTruncated: Number(row['journey_truncated']),
        journey: row['journey'] as string,
      }))
    },

    async readConversionSignals({ siteId, fromMs, toMs, orderIds }) {
      // Trimmed on this side too, so the predicate compares trimmed to trimmed.
      // The provider's ids are never padded, but a symmetric comparison is one
      // fewer thing to reason about than a half-normalized one.
      const wanted = [...new Set(orderIds.map((id) => id.trim()).filter((id) => id !== ''))]
      if (wanted.length === 0) return []

      const rows = await query<{
        event_id: string
        order_id: string
        occurred_ms: string
        user_id: string
        anonymous_id: string
      }>(
        // `trimBoth` in BOTH places, and it has to be in both or it is in
        // neither. The site writes `properties.order_id` by hand — it is copied
        // out of a template, a data attribute or a server-rendered blob — and a
        // stray space is the single most ordinary way for it to arrive. The
        // matcher's own `orderId.trim()` cannot save such a row, because this
        // `IN` is an exact string comparison against the untrimmed value: a
        // padded id never comes back from the database, so the domain trim never
        // sees it. Trimming the predicate alone would match the row and then
        // return a padded key that the matcher's map lookup misses; trimming the
        // projection alone would never find it. The domain trim stays as defence
        // in depth for any caller that does not come through here.
        //
        // Spaces only, which is what `trimBoth` removes and what a copy-paste
        // produces. A tab or a newline inside a JSON string is a different and
        // much rarer accident, and widening this to a character set would make
        // the predicate non-obvious for a case nobody has seen.
        `SELECT
           event_id,
           trimBoth(JSONExtractString(properties, 'order_id')) AS order_id,
           toUnixTimestamp64Milli(occurred_at)                 AS occurred_ms,
           user_id,
           anonymous_id
         FROM ${eventsTable}
         WHERE site_id = {siteId:String}
           AND type = 'conversion'
           AND occurred_at >= fromUnixTimestamp64Milli({fromMs:Int64})
           AND occurred_at <  fromUnixTimestamp64Milli({toMs:Int64})
           AND trimBoth(JSONExtractString(properties, 'order_id')) IN {orderIds:Array(String)}
         ORDER BY occurred_at, event_id`,
        { siteId, fromMs, toMs, orderIds: wanted },
      )

      // `events_raw` is a plain MergeTree, so a beacon re-sent after the
      // collector's dedup window elapsed can leave two rows under one id. The
      // finalizer's window read dedups the same way and for the same reason.
      const seen = new Set<string>()
      const signals: ConversionSignalRow[] = []
      for (const row of rows) {
        if (seen.has(row.event_id)) continue
        seen.add(row.event_id)
        signals.push({
          eventId: row.event_id,
          orderId: row.order_id,
          occurredAtMs: Number(row.occurred_ms),
          userId: row.user_id,
          anonymousId: row.anonymous_id,
        })
      }
      return signals
    },

    async readSessionTouchpoints({ siteId, fromMs, toMs, userIds, anonymousIds }) {
      const users = [...new Set(userIds.filter((id) => id !== ''))]
      const anonymous = [...new Set(anonymousIds.filter((id) => id !== ''))]
      if (users.length === 0 && anonymous.length === 0) return []

      const rows = await query<Record<string, string>>(
        `SELECT
           cur.session_id       AS session_id,
           cur.session_start_ms AS session_start_ms,
           cur.user_id          AS user_id,
           cur.anonymous_id     AS anonymous_id,
           cur.referrer_domain  AS referrer_domain,
           cur.utm_source       AS utm_source,
           cur.utm_medium       AS utm_medium,
           cur.utm_campaign     AS utm_campaign,
           cur.utm_content      AS utm_content,
           cur.utm_term         AS utm_term,
           cur.entry_page_path  AS entry_page_path
         FROM (
           SELECT
             sfv.session_id AS session_id,
             ${TOUCHPOINT_ARGMAX_COLUMNS}
           FROM ${factsTable} AS sfv
           WHERE sfv.site_id = {siteId:String}
             AND sfv.session_start >= fromUnixTimestamp64Milli({fromMs:Int64})
             AND sfv.session_start <= fromUnixTimestamp64Milli({toMs:Int64})
           GROUP BY sfv.site_id, sfv.session_id
         ) AS cur
         WHERE cur.retracted = 0
           AND (cur.user_id IN {userIds:Array(String)}
                OR cur.anonymous_id IN {anonymousIds:Array(String)})
         ORDER BY cur.session_start_ms, cur.session_id`,
        { siteId, fromMs, toMs, userIds: users, anonymousIds: anonymous },
      )

      return rows.map((row) => ({
        sessionId: row['session_id'] as string,
        sessionStartMs: Number(row['session_start_ms']),
        userId: row['user_id'] as string,
        anonymousId: row['anonymous_id'] as string,
        referrerDomain: row['referrer_domain'] as string,
        utmSource: row['utm_source'] as string,
        utmMedium: row['utm_medium'] as string,
        utmCampaign: row['utm_campaign'] as string,
        utmContent: row['utm_content'] as string,
        utmTerm: row['utm_term'] as string,
        entryPagePath: row['entry_page_path'] as string,
      }))
    },

    async ping() {
      const result = await client.ping()
      return result.success
    },

    async close() {
      await client.close()
    },
  }
}
