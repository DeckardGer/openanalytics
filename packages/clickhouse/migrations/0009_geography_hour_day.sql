-- The geography rollups (plan Milestone 7 items 1-2).
--
-- Rollout note: additive, direct-from-raw, no backfill. Family reasoning in 0006
-- and 0005.
--
-- Dimensions are country and city. The city privacy policy -- a public dashboard
-- must not expose a city below a threshold -- is a query-time rule (plan
-- Milestone 7 item 8) applied by the read API, not a storage-time one: the
-- rollup keeps the full granularity and the gateway decides what a given caller
-- may see. Storing it coarsened would make the private dashboard, which is
-- allowed the detail, permanently unable to recover it. country is
-- LowCardinality (a bounded ISO set), city is a plain String (unbounded).
--
-- Additive measures only: a view count and a mergeable unique-visitor state,
-- filtered to page_view.

CREATE TABLE IF NOT EXISTS geography_1h
(
  site_id      UUID,
  bucket_start DateTime('UTC'),
  country      LowCardinality(String),
  city         String,
  views        SimpleAggregateFunction(sum, UInt64),
  visitors     AggregateFunction(uniq, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start, country, city)
-- Mandatory on every dependent target, not only on the raw table (ADR-0005).
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS geography_1h_mv TO geography_1h AS
SELECT
  site_id,
  toStartOfHour(toDateTime(occurred_at, 'UTC'))       AS bucket_start,
  country,
  city,
  count()                                             AS views,
  uniqState(if(user_id != '', user_id, anonymous_id)) AS visitors
FROM events_raw
WHERE type = 'page_view'
GROUP BY site_id, bucket_start, country, city;

CREATE TABLE IF NOT EXISTS geography_1d
(
  site_id      UUID,
  bucket_start DateTime('UTC'),
  country      LowCardinality(String),
  city         String,
  views        SimpleAggregateFunction(sum, UInt64),
  visitors     AggregateFunction(uniq, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start, country, city)
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS geography_1d_mv TO geography_1d AS
SELECT
  site_id,
  toStartOfDay(toDateTime(occurred_at, 'UTC'))        AS bucket_start,
  country,
  city,
  count()                                             AS views,
  uniqState(if(user_id != '', user_id, anonymous_id)) AS visitors
FROM events_raw
WHERE type = 'page_view'
GROUP BY site_id, bucket_start, country, city
