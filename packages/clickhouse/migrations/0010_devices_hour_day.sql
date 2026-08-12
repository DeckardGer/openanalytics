-- The devices rollups (plan Milestone 7 items 1-2).
--
-- Rollout note: additive, direct-from-raw, no backfill. Family reasoning in 0006
-- and 0005.
--
-- Dimensions are device_type, browser and os -- the technology breakdown the
-- devices report shows. All three are already LowCardinality on events_raw
-- (migration 0001), so the rollup key stays small. Filtered to page_view so the
-- breakdown is by page-viewing visitor rather than by beacon volume.
--
-- Additive measures only: a view count and a mergeable unique-visitor state.

CREATE TABLE IF NOT EXISTS devices_1h
(
  site_id      UUID,
  bucket_start DateTime('UTC'),
  device_type  LowCardinality(String),
  browser      LowCardinality(String),
  os           LowCardinality(String),
  views        SimpleAggregateFunction(sum, UInt64),
  visitors     AggregateFunction(uniq, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start, device_type, browser, os)
-- Mandatory on every dependent target, not only on the raw table (ADR-0005).
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS devices_1h_mv TO devices_1h AS
SELECT
  site_id,
  toStartOfHour(toDateTime(occurred_at, 'UTC'))       AS bucket_start,
  device_type,
  browser,
  os,
  count()                                             AS views,
  uniqState(if(user_id != '', user_id, anonymous_id)) AS visitors
FROM events_raw
WHERE type = 'page_view'
GROUP BY site_id, bucket_start, device_type, browser, os;

CREATE TABLE IF NOT EXISTS devices_1d
(
  site_id      UUID,
  bucket_start DateTime('UTC'),
  device_type  LowCardinality(String),
  browser      LowCardinality(String),
  os           LowCardinality(String),
  views        SimpleAggregateFunction(sum, UInt64),
  visitors     AggregateFunction(uniq, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start, device_type, browser, os)
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS devices_1d_mv TO devices_1d AS
SELECT
  site_id,
  toStartOfDay(toDateTime(occurred_at, 'UTC'))        AS bucket_start,
  device_type,
  browser,
  os,
  count()                                             AS views,
  uniqState(if(user_id != '', user_id, anonymous_id)) AS visitors
FROM events_raw
WHERE type = 'page_view'
GROUP BY site_id, bucket_start, device_type, browser, os
