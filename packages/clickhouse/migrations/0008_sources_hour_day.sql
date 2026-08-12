-- The acquisition-source rollups (plan Milestone 7 items 1-2).
--
-- Rollout note: additive, direct-from-raw, no backfill. Family reasoning in 0006
-- and 0005.
--
-- Dimensions are the referrer domain and the UTM campaign tuple
-- (source/medium/campaign). utm_content and utm_term are deliberately excluded:
-- they are ad-level identifiers that multiply cardinality without being part of
-- the top-sources question this rollup answers, and the raw events keep them for
-- a targeted drill-down if one is ever built. Filtered to page_view so a source
-- is counted once per landing view rather than once per web-vital beacon or
-- interaction on the same page.
--
-- Additive measures only: a view count and a mergeable unique-visitor state.
-- Source attribution at the SESSION grain (first-touch, entries, bounce-by-
-- source) is session-derived and belongs to the finalizer, not to an insert-only
-- view (docs snapshot 05, D-211). This rollup does not anticipate it.

CREATE TABLE IF NOT EXISTS sources_1h
(
  site_id         UUID,
  bucket_start    DateTime('UTC'),
  referrer_domain LowCardinality(String),
  utm_source      LowCardinality(String),
  utm_medium      LowCardinality(String),
  utm_campaign    LowCardinality(String),
  views           SimpleAggregateFunction(sum, UInt64),
  visitors        AggregateFunction(uniq, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start, referrer_domain, utm_source, utm_medium, utm_campaign)
-- Mandatory on every dependent target, not only on the raw table (ADR-0005).
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS sources_1h_mv TO sources_1h AS
SELECT
  site_id,
  toStartOfHour(toDateTime(occurred_at, 'UTC'))       AS bucket_start,
  referrer_domain,
  utm_source,
  utm_medium,
  utm_campaign,
  count()                                             AS views,
  uniqState(if(user_id != '', user_id, anonymous_id)) AS visitors
FROM events_raw
WHERE type = 'page_view'
GROUP BY site_id, bucket_start, referrer_domain, utm_source, utm_medium, utm_campaign;

CREATE TABLE IF NOT EXISTS sources_1d
(
  site_id         UUID,
  bucket_start    DateTime('UTC'),
  referrer_domain LowCardinality(String),
  utm_source      LowCardinality(String),
  utm_medium      LowCardinality(String),
  utm_campaign    LowCardinality(String),
  views           SimpleAggregateFunction(sum, UInt64),
  visitors        AggregateFunction(uniq, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start, referrer_domain, utm_source, utm_medium, utm_campaign)
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS sources_1d_mv TO sources_1d AS
SELECT
  site_id,
  toStartOfDay(toDateTime(occurred_at, 'UTC'))        AS bucket_start,
  referrer_domain,
  utm_source,
  utm_medium,
  utm_campaign,
  count()                                             AS views,
  uniqState(if(user_id != '', user_id, anonymous_id)) AS visitors
FROM events_raw
WHERE type = 'page_view'
GROUP BY site_id, bucket_start, referrer_domain, utm_source, utm_medium, utm_campaign
