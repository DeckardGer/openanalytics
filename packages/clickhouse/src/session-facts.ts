import { createHash } from 'node:crypto'
import { createClient, type ClickHouseClient } from '@clickhouse/client'
import type { SessionizerEvent } from '@openanalytics/domain'

/**
 * The session finalizer's ClickHouse surface (docs snapshot 02 §10, §15, 05
 * D-211; migrations 0013 and 0014). Milestone 8 Checkpoint B.
 *
 * The finalizer never re-implements session logic — it drives the pure
 * `sessionize` from @openanalytics/domain — so this module is only the reads and
 * writes that recompute needs:
 *
 *   - read the raw events of a recompute window from `events_raw` (bucketed on
 *     occurred_at, D-015) and hand them to the sessionizer;
 *   - read the current (latest-version) stored facts of that window, so a run can
 *     tell a changed session from an unchanged one and a vanished id from a live
 *     one;
 *   - insert new fact versions and retraction tombstones under a stable,
 *     content-derived deduplication token;
 *   - recompute an affected rollup bucket from the current non-retracted facts
 *     and swap it in at a higher generation.
 *
 * Every read that selects "the current truth" does it the way migrations 0013
 * and 0014 mandate: argMax over version/generation per key, THEN filter
 * `retracted = 0` — never a pre-filter, never FINAL. Aggregated columns are
 * qualified through the table alias, because CI's ClickHouse resolves a bare
 * name that an alias shadows to the alias and throws ILLEGAL_AGGREGATION.
 *
 * Runs on the `oa_ingest` credential, which ADR-0005 already widened to
 * `SELECT ON analytics.*` beside its `INSERT ON analytics.*`; no new secret.
 */

export const SESSION_FACTS_TABLE = 'session_facts_versions'
export const SESSION_ROLLUP_1H_TABLE = 'session_rollups_1h'
export const SESSION_ROLLUP_1D_TABLE = 'session_rollups_1d'

/** A `session_facts_versions` row (migration 0013). */
export interface SessionFactRow {
  readonly site_id: string
  readonly session_id: string
  readonly version: number
  readonly visitor_id: string
  readonly user_id: string
  readonly anonymous_id: string
  readonly session_hint: string
  readonly midnight_bridged: number
  readonly session_start: string
  readonly session_end: string
  readonly pageviews: number
  readonly engaged: number
  readonly active_duration_ms: number
  readonly session_duration_ms: number
  readonly entry_page_path: string
  readonly exit_page_path: string
  readonly referrer_domain: string
  readonly utm_source: string
  readonly utm_medium: string
  readonly utm_campaign: string
  /** ADR-0033 D6 / migration 0017. Empty when the entry event carried none —
   * the same empty-string absence every other dimension here uses. */
  readonly utm_content: string
  readonly utm_term: string
  readonly device_type: string
  readonly browser: string
  readonly os: string
  readonly country: string
  readonly finalized: number
  readonly retracted: number
  readonly computed_at: string
}

/** A `session_rollups_1h`/`_1d` row (migration 0014). */
export interface SessionRollupRow {
  readonly site_id: string
  readonly bucket_start: string
  readonly generation: number
  readonly sessions: number
  readonly engaged_sessions: number
  readonly bounced_sessions: number
  readonly pageviews: number
  readonly total_session_duration_ms: number
  readonly total_active_duration_ms: number
  readonly computed_at: string
}

/** The current (latest-version) stored fact of a session, for change detection. */
export interface StoredSessionFact {
  readonly sessionId: string
  readonly version: number
  readonly startMs: number
  readonly endMs: number
  readonly visitorId: string
  readonly userId: string
  readonly anonymousId: string
  readonly sessionHint: string
  readonly midnightBridged: number
  readonly pageviews: number
  readonly engaged: number
  readonly activeDurationMs: number
  readonly sessionDurationMs: number
  readonly entryPagePath: string
  readonly exitPagePath: string
  readonly referrerDomain: string
  readonly utmSource: string
  readonly utmMedium: string
  readonly utmCampaign: string
  readonly utmContent: string
  readonly utmTerm: string
  readonly deviceType: string
  readonly browser: string
  readonly os: string
  readonly country: string
  readonly finalized: number
  readonly retracted: number
}

/** A recomputed rollup bucket, keyed by its UTC start. */
export interface RollupBucketAggregate {
  /** Bucket start as epoch seconds (UTC). */
  readonly bucketSeconds: number
  /** Bucket start as a ClickHouse `DateTime` literal, `YYYY-MM-DD HH:MM:SS`. */
  readonly bucketStart: string
  readonly sessions: number
  readonly engagedSessions: number
  readonly bouncedSessions: number
  readonly pageviews: number
  readonly totalSessionDurationMs: number
  readonly totalActiveDurationMs: number
}

/** The current (latest-generation) stored rollup of a bucket. */
export interface StoredRollupBucket extends RollupBucketAggregate {
  readonly generation: number
}

export type SessionRollupUnit = '1h' | '1d'

export interface SessionFactsStoreOptions {
  readonly url: string
  readonly username: string
  readonly password: string
  readonly database: string
  readonly requestTimeoutMs?: number
  /** Overridable for tests that migrate into a throwaway database. */
  readonly factsTable?: string
  readonly rollup1hTable?: string
  readonly rollup1dTable?: string
}

export const DEFAULT_SESSION_REQUEST_TIMEOUT_MS = 60_000

export interface SessionFactsStore {
  /**
   * The session-relevant projection of every event in `[fromMs, ∞)` for a site,
   * deduplicated by `event_id`.
   *
   * Dedup by id is deliberate: `events_raw` is a plain MergeTree, and a client
   * that re-sent a beacon after the collector's dedup window elapsed could leave
   * two rows with one id. The sessionizer's active-duration merge already refuses
   * to inflate on a duplicate, but dropping the duplicate here also keeps a
   * duplicated pageview from being double-counted — the idempotent-read half of
   * acceptance criterion 3.
   */
  readWindowEvents(input: { siteId: string; fromMs: number }): Promise<SessionizerEvent[]>
  /** Latest version per session with `session_start >= fromMs`, tombstones included. */
  readStoredFacts(input: { siteId: string; fromMs: number }): Promise<StoredSessionFact[]>
  /** Insert fact versions/tombstones under a stable content token. */
  insertFactVersions(rows: readonly SessionFactRow[]): Promise<void>
  /** Recompute the rollup buckets intersecting `[loMs, hiMs)` from current facts. */
  aggregateRollupBuckets(input: {
    siteId: string
    unit: SessionRollupUnit
    loMs: number
    hiMs: number
  }): Promise<RollupBucketAggregate[]>
  /** Current generation per rollup bucket intersecting `[loMs, hiMs)`. */
  readStoredRollups(input: {
    siteId: string
    unit: SessionRollupUnit
    loMs: number
    hiMs: number
  }): Promise<StoredRollupBucket[]>
  /** Insert rollup rows under a stable content token. */
  insertRollups(input: {
    unit: SessionRollupUnit
    rows: readonly SessionRollupRow[]
  }): Promise<void>
  /** Sites with events accepted since `acceptedSinceMs`, or a live provisional session. */
  listSitesToFinalize(input: {
    acceptedSinceMs: number
    provisionalFromMs: number
  }): Promise<string[]>
  ping(): Promise<boolean>
  close(): Promise<void>
}

/** The ordered set of `argMax(col, version)` projections that read a fact's current value. */
const FACT_ARGMAX_COLUMNS = `
  max(sfv.version)                                            AS version,
  toUnixTimestamp64Milli(argMax(sfv.session_start, sfv.version)) AS start_ms,
  toUnixTimestamp64Milli(argMax(sfv.session_end, sfv.version))   AS end_ms,
  argMax(sfv.visitor_id, sfv.version)                        AS visitor_id,
  argMax(sfv.user_id, sfv.version)                           AS user_id,
  argMax(sfv.anonymous_id, sfv.version)                      AS anonymous_id,
  argMax(sfv.session_hint, sfv.version)                      AS session_hint,
  argMax(sfv.midnight_bridged, sfv.version)                  AS midnight_bridged,
  argMax(sfv.pageviews, sfv.version)                         AS pageviews,
  argMax(sfv.engaged, sfv.version)                           AS engaged,
  argMax(sfv.active_duration_ms, sfv.version)                AS active_duration_ms,
  argMax(sfv.session_duration_ms, sfv.version)               AS session_duration_ms,
  argMax(sfv.entry_page_path, sfv.version)                   AS entry_page_path,
  argMax(sfv.exit_page_path, sfv.version)                    AS exit_page_path,
  argMax(sfv.referrer_domain, sfv.version)                   AS referrer_domain,
  argMax(sfv.utm_source, sfv.version)                        AS utm_source,
  argMax(sfv.utm_medium, sfv.version)                        AS utm_medium,
  argMax(sfv.utm_campaign, sfv.version)                      AS utm_campaign,
  argMax(sfv.utm_content, sfv.version)                       AS utm_content,
  argMax(sfv.utm_term, sfv.version)                          AS utm_term,
  argMax(sfv.device_type, sfv.version)                       AS device_type,
  argMax(sfv.browser, sfv.version)                           AS browser,
  argMax(sfv.os, sfv.version)                                AS os,
  argMax(sfv.country, sfv.version)                           AS country,
  argMax(sfv.finalized, sfv.version)                         AS finalized,
  argMax(sfv.retracted, sfv.version)                         AS retracted
`

function tokenFor(namespace: string, rows: readonly object[]): string {
  const hash = createHash('sha256')
  hash.update(namespace)
  hash.update('\n')
  hash.update(JSON.stringify(rows))
  return hash.digest('hex').slice(0, 32)
}

const bucketFn = (unit: SessionRollupUnit): string =>
  unit === '1h' ? 'toStartOfHour' : 'toStartOfDay'

export function createSessionFactsStore(options: SessionFactsStoreOptions): SessionFactsStore {
  const factsTable = options.factsTable ?? SESSION_FACTS_TABLE
  const rollupTable = (unit: SessionRollupUnit): string =>
    unit === '1h'
      ? (options.rollup1hTable ?? SESSION_ROLLUP_1H_TABLE)
      : (options.rollup1dTable ?? SESSION_ROLLUP_1D_TABLE)

  const client: ClickHouseClient = createClient({
    url: options.url,
    username: options.username,
    password: options.password,
    database: options.database,
    request_timeout: options.requestTimeoutMs ?? DEFAULT_SESSION_REQUEST_TIMEOUT_MS,
    clickhouse_settings: {
      // The finalizer's inserts must be durable before the run advances its
      // watermark, exactly like the batch insert path (ingest.ts). An async
      // insert would let the watermark move past data ClickHouse had not
      // committed.
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
    async readWindowEvents({ siteId, fromMs }): Promise<SessionizerEvent[]> {
      const rows = await query<{
        event_id: string
        type: string
        occurred_ms: string
        anonymous_id: string
        user_id: string
        session_hint: string
        page_path: string
        referrer_domain: string
        utm_source: string
        utm_medium: string
        utm_campaign: string
        utm_content: string
        utm_term: string
        device_type: string
        browser: string
        os: string
        country: string
        active_ms: string
      }>(
        `SELECT
           event_id,
           type,
           toUnixTimestamp64Milli(occurred_at) AS occurred_ms,
           anonymous_id,
           user_id,
           session_id AS session_hint,
           page_path,
           referrer_domain,
           utm_source,
           utm_medium,
           utm_campaign,
           utm_content,
           utm_term,
           device_type,
           browser,
           os,
           country,
           JSONExtractInt(properties, 'oa_active_ms') AS active_ms
         FROM events_raw
         WHERE site_id = {siteId:String}
           AND occurred_at >= fromUnixTimestamp64Milli({fromMs:Int64})
         ORDER BY occurred_at, event_id`,
        { siteId, fromMs },
      )

      const seen = new Set<string>()
      const events: SessionizerEvent[] = []
      for (const row of rows) {
        if (seen.has(row.event_id)) continue
        seen.add(row.event_id)
        const activeMs = Number(row.active_ms)
        events.push({
          eventId: row.event_id,
          type: row.type,
          occurredAt: Number(row.occurred_ms),
          anonymousId: row.anonymous_id,
          userId: row.user_id,
          sessionHint: row.session_hint,
          pagePath: row.page_path,
          referrerDomain: row.referrer_domain,
          utmSource: row.utm_source,
          utmMedium: row.utm_medium,
          utmCampaign: row.utm_campaign,
          utmContent: row.utm_content,
          utmTerm: row.utm_term,
          deviceType: row.device_type,
          browser: row.browser,
          os: row.os,
          country: row.country,
          engagement: row.type === 'engagement' ? { activeMs, visibleMs: 0 } : null,
        })
      }
      return events
    },

    async readStoredFacts({ siteId, fromMs }): Promise<StoredSessionFact[]> {
      const rows = await query<Record<string, string>>(
        `SELECT
           sfv.session_id AS session_id,
           ${FACT_ARGMAX_COLUMNS}
         FROM ${factsTable} AS sfv
         WHERE sfv.site_id = {siteId:String}
           AND sfv.session_start >= fromUnixTimestamp64Milli({fromMs:Int64})
         GROUP BY sfv.site_id, sfv.session_id`,
        { siteId, fromMs },
      )

      return rows.map((row) => ({
        sessionId: row['session_id'] as string,
        version: Number(row['version']),
        startMs: Number(row['start_ms']),
        endMs: Number(row['end_ms']),
        visitorId: row['visitor_id'] as string,
        userId: row['user_id'] as string,
        anonymousId: row['anonymous_id'] as string,
        sessionHint: row['session_hint'] as string,
        midnightBridged: Number(row['midnight_bridged']),
        pageviews: Number(row['pageviews']),
        engaged: Number(row['engaged']),
        activeDurationMs: Number(row['active_duration_ms']),
        sessionDurationMs: Number(row['session_duration_ms']),
        entryPagePath: row['entry_page_path'] as string,
        exitPagePath: row['exit_page_path'] as string,
        referrerDomain: row['referrer_domain'] as string,
        utmSource: row['utm_source'] as string,
        utmMedium: row['utm_medium'] as string,
        utmCampaign: row['utm_campaign'] as string,
        utmContent: row['utm_content'] as string,
        utmTerm: row['utm_term'] as string,
        deviceType: row['device_type'] as string,
        browser: row['browser'] as string,
        os: row['os'] as string,
        country: row['country'] as string,
        finalized: Number(row['finalized']),
        retracted: Number(row['retracted']),
      }))
    },

    async insertFactVersions(rows): Promise<void> {
      if (rows.length === 0) return
      await client.insert({
        table: factsTable,
        values: rows,
        format: 'JSONEachRow',
        clickhouse_settings: { insert_deduplication_token: tokenFor('facts', rows) },
      })
    },

    async aggregateRollupBuckets({ siteId, unit, loMs, hiMs }): Promise<RollupBucketAggregate[]> {
      const rows = await query<{
        bucket_seconds: string
        bucket_start: string
        sessions: string
        engaged_sessions: string
        bounced_sessions: string
        pageviews: string
        total_session_duration_ms: string
        total_active_duration_ms: string
      }>(
        `SELECT
           toUnixTimestamp(cur.bucket)                   AS bucket_seconds,
           formatDateTime(cur.bucket, '%F %T')           AS bucket_start,
           count()                                       AS sessions,
           countIf(cur.engaged = 1)                      AS engaged_sessions,
           countIf(cur.engaged = 0)                      AS bounced_sessions,
           sum(cur.pageviews)                            AS pageviews,
           sum(cur.session_duration_ms)                  AS total_session_duration_ms,
           sum(cur.active_duration_ms)                   AS total_active_duration_ms
         FROM (
           SELECT
             ${bucketFn(unit)}(argMax(sfv.session_start, sfv.version)) AS bucket,
             argMax(sfv.engaged, sfv.version)              AS engaged,
             argMax(sfv.pageviews, sfv.version)            AS pageviews,
             argMax(sfv.session_duration_ms, sfv.version)  AS session_duration_ms,
             argMax(sfv.active_duration_ms, sfv.version)   AS active_duration_ms,
             argMax(sfv.retracted, sfv.version)            AS retracted
           FROM ${factsTable} AS sfv
           WHERE sfv.site_id = {siteId:String}
             AND sfv.session_start >= fromUnixTimestamp64Milli({loMs:Int64})
             AND sfv.session_start <  fromUnixTimestamp64Milli({hiMs:Int64})
           GROUP BY sfv.site_id, sfv.session_id
         ) AS cur
         WHERE cur.retracted = 0
         GROUP BY cur.bucket`,
        { siteId, loMs, hiMs },
      )

      return rows.map((row) => ({
        bucketSeconds: Number(row.bucket_seconds),
        bucketStart: row.bucket_start,
        sessions: Number(row.sessions),
        engagedSessions: Number(row.engaged_sessions),
        bouncedSessions: Number(row.bounced_sessions),
        pageviews: Number(row.pageviews),
        totalSessionDurationMs: Number(row.total_session_duration_ms),
        totalActiveDurationMs: Number(row.total_active_duration_ms),
      }))
    },

    async readStoredRollups({ siteId, unit, loMs, hiMs }): Promise<StoredRollupBucket[]> {
      const rows = await query<{
        bucket_seconds: string
        bucket_start: string
        generation: string
        sessions: string
        engaged_sessions: string
        bounced_sessions: string
        pageviews: string
        total_session_duration_ms: string
        total_active_duration_ms: string
      }>(
        `SELECT
           toUnixTimestamp(sr.bucket_start)                  AS bucket_seconds,
           formatDateTime(sr.bucket_start, '%F %T')          AS bucket_start,
           max(sr.generation)                                AS generation,
           argMax(sr.sessions, sr.generation)                AS sessions,
           argMax(sr.engaged_sessions, sr.generation)        AS engaged_sessions,
           argMax(sr.bounced_sessions, sr.generation)        AS bounced_sessions,
           argMax(sr.pageviews, sr.generation)               AS pageviews,
           argMax(sr.total_session_duration_ms, sr.generation) AS total_session_duration_ms,
           argMax(sr.total_active_duration_ms, sr.generation)  AS total_active_duration_ms
         FROM ${rollupTable(unit)} AS sr
         WHERE sr.site_id = {siteId:String}
           AND sr.bucket_start >= toDateTime(intDiv({loMs:Int64}, 1000))
           AND sr.bucket_start <  toDateTime(intDiv({hiMs:Int64}, 1000) + 1)
         GROUP BY sr.site_id, sr.bucket_start`,
        { siteId, loMs, hiMs },
      )

      return rows.map((row) => ({
        bucketSeconds: Number(row.bucket_seconds),
        bucketStart: row.bucket_start,
        generation: Number(row.generation),
        sessions: Number(row.sessions),
        engagedSessions: Number(row.engaged_sessions),
        bouncedSessions: Number(row.bounced_sessions),
        pageviews: Number(row.pageviews),
        totalSessionDurationMs: Number(row.total_session_duration_ms),
        totalActiveDurationMs: Number(row.total_active_duration_ms),
      }))
    },

    async insertRollups({ unit, rows }): Promise<void> {
      if (rows.length === 0) return
      await client.insert({
        table: rollupTable(unit),
        values: rows,
        format: 'JSONEachRow',
        clickhouse_settings: { insert_deduplication_token: tokenFor(`rollup:${unit}`, rows) },
      })
    },

    async listSitesToFinalize({ acceptedSinceMs, provisionalFromMs }): Promise<string[]> {
      const sites = new Set<string>()

      const recent = await query<{ site_id: string }>(
        `SELECT DISTINCT site_id
           FROM events_raw
          WHERE accepted_at >= fromUnixTimestamp64Milli({sinceMs:Int64})`,
        { sinceMs: acceptedSinceMs },
      )
      for (const row of recent) sites.add(row.site_id)

      // Sites whose latest facts still carry a provisional session need another
      // pass even with no new events, because finalization is driven by the
      // wall-clock horizon, not by fresh data.
      const provisional = await query<{ site_id: string }>(
        `SELECT DISTINCT site_id FROM (
           SELECT
             sfv.site_id AS site_id,
             sfv.session_id,
             argMax(sfv.finalized, sfv.version) AS finalized,
             argMax(sfv.retracted, sfv.version) AS retracted
           FROM ${factsTable} AS sfv
           WHERE sfv.session_start >= fromUnixTimestamp64Milli({fromMs:Int64})
           GROUP BY sfv.site_id, sfv.session_id
         )
         WHERE finalized = 0 AND retracted = 0`,
        { fromMs: provisionalFromMs },
      )
      for (const row of provisional) sites.add(row.site_id)

      return [...sites]
    },

    async ping(): Promise<boolean> {
      const result = await client.ping()
      return result.success
    },

    async close(): Promise<void> {
      await client.close()
    },
  }
}
