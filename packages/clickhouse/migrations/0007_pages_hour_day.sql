-- The pages rollups (plan Milestone 7 items 1-2).
--
-- Rollout note: additive, direct-from-raw, no backfill. The family-wide reasons
-- are in 0006 (why every view reads events_raw and not another rollup) and 0005
-- (the visitor identity and why there is nothing to backfill yet).
--
-- The pages report answers "which paths were viewed, and by how many distinct
-- visitors". Its dimension is page_path. page_url and page_title are deliberately
-- not dimensions: a URL carries query strings and a title can change, and either
-- would fracture one logical page across many rollup rows. Path is the stable
-- identity of a page (the title/url of a path is a detail-view lookup, not a
-- grouping key).
--
-- Filtered to page_view. Entries, exits and bounce are session-derived and are
-- deliberately NOT here -- a late second pageview has to be able to undo a
-- recorded bounce, which an additive insert-only view cannot express
-- (docs snapshot 05, D-211). Those come from the versioned session facts and the
-- finalizer in Milestone 8. This rollup keeps only what is additive: a view
-- count and a mergeable unique-visitor state.

CREATE TABLE IF NOT EXISTS pages_1h
(
  site_id      UUID,
  bucket_start DateTime('UTC'),
  page_path    String,
  views        SimpleAggregateFunction(sum, UInt64),
  visitors     AggregateFunction(uniq, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start, page_path)
-- Mandatory on every dependent target, not only on the raw table (ADR-0005).
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS pages_1h_mv TO pages_1h AS
SELECT
  site_id,
  toStartOfHour(toDateTime(occurred_at, 'UTC'))       AS bucket_start,
  page_path,
  count()                                             AS views,
  uniqState(if(user_id != '', user_id, anonymous_id)) AS visitors
FROM events_raw
WHERE type = 'page_view'
GROUP BY site_id, bucket_start, page_path;

CREATE TABLE IF NOT EXISTS pages_1d
(
  site_id      UUID,
  bucket_start DateTime('UTC'),
  page_path    String,
  views        SimpleAggregateFunction(sum, UInt64),
  visitors     AggregateFunction(uniq, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start, page_path)
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS pages_1d_mv TO pages_1d AS
SELECT
  site_id,
  toStartOfDay(toDateTime(occurred_at, 'UTC'))        AS bucket_start,
  page_path,
  count()                                             AS views,
  uniqState(if(user_id != '', user_id, anonymous_id)) AS visitors
FROM events_raw
WHERE type = 'page_view'
GROUP BY site_id, bucket_start, page_path
