-- The performance (web-vital) rollups (plan Milestone 7 items 1-2).
--
-- Rollout note: additive, direct-from-raw, no backfill. Family reasoning in 0006
-- and 0005.
--
-- These read FROM events_raw, not FROM performance_events, even though
-- performance_events is the web-vital fact table. Reading from the fact table
-- would make raw -> performance_events -> performance_1h a two-level cascade,
-- which is the exact dedup-token uncertainty 0006 keeps the family out of.
-- events_raw is the one source whose retried-insert dedup ADR-0005 measured, so
-- the rollup extracts the same server-owned oa_ keys the performance_events view
-- extracts (migration 0004) straight from the raw properties instead. The two
-- views therefore agree by construction because they read the same fields from
-- the same source, not because one feeds the other.
--
-- Dimensions are the metric name and device_type. Web vitals are read per metric
-- (LCP, INP, CLS, ...) and the desktop/mobile split is the standard second axis.
-- page_path is deliberately not a dimension here, because per-metric-per-path
-- would explode the key, and page-level web vitals are a bounded detail query
-- over the performance_events fact when one is built, not an overview rollup.
--
-- Percentiles are stored as a t-digest aggregate state, not as a fixed p75.
-- quantilesTDigestState keeps one mergeable sketch per bucket, so the read layer
-- can ask for p50/p75/p90/p95/p99 from the same stored state and merge sketches
-- across buckets with quantilesTDigestMerge -- a percentile of a union, never an
-- average of per-bucket percentiles, which is the wrong number. The params in
-- the column type and in the State call must match. value_sum plus samples gives
-- the mean without a second state (mean is additive, so a SimpleAggregateFunction
-- sum suffices), and the good/needs_improvement/poor sample counts carry the
-- rating distribution the "percent good" view needs. All counts are additive
-- sums, and none is a percentage stored pre-divided.

CREATE TABLE IF NOT EXISTS performance_1h
(
  site_id                    UUID,
  bucket_start               DateTime('UTC'),
  metric                     LowCardinality(String),
  device_type                LowCardinality(String),
  samples                    SimpleAggregateFunction(sum, UInt64),
  value_sum                  SimpleAggregateFunction(sum, Float64),
  value_quantiles            AggregateFunction(quantilesTDigest(0.5, 0.75, 0.9, 0.95, 0.99), Float64),
  good_samples               SimpleAggregateFunction(sum, UInt64),
  needs_improvement_samples  SimpleAggregateFunction(sum, UInt64),
  poor_samples               SimpleAggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start, metric, device_type)
-- Mandatory on every dependent target, not only on the raw table (ADR-0005).
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS performance_1h_mv TO performance_1h AS
SELECT
  site_id,
  toStartOfHour(toDateTime(occurred_at, 'UTC'))            AS bucket_start,
  JSONExtractString(properties, 'oa_metric')               AS metric,
  device_type,
  count()                                                  AS samples,
  sum(JSONExtractFloat(properties, 'oa_value'))            AS value_sum,
  quantilesTDigestState(0.5, 0.75, 0.9, 0.95, 0.99)(JSONExtractFloat(properties, 'oa_value')) AS value_quantiles,
  countIf(JSONExtractString(properties, 'oa_rating') = 'good')              AS good_samples,
  countIf(JSONExtractString(properties, 'oa_rating') = 'needs-improvement') AS needs_improvement_samples,
  countIf(JSONExtractString(properties, 'oa_rating') = 'poor')              AS poor_samples
FROM events_raw
WHERE type = 'web_vital' AND metric != ''
GROUP BY site_id, bucket_start, metric, device_type;

CREATE TABLE IF NOT EXISTS performance_1d
(
  site_id                    UUID,
  bucket_start               DateTime('UTC'),
  metric                     LowCardinality(String),
  device_type                LowCardinality(String),
  samples                    SimpleAggregateFunction(sum, UInt64),
  value_sum                  SimpleAggregateFunction(sum, Float64),
  value_quantiles            AggregateFunction(quantilesTDigest(0.5, 0.75, 0.9, 0.95, 0.99), Float64),
  good_samples               SimpleAggregateFunction(sum, UInt64),
  needs_improvement_samples  SimpleAggregateFunction(sum, UInt64),
  poor_samples               SimpleAggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start, metric, device_type)
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS performance_1d_mv TO performance_1d AS
SELECT
  site_id,
  toStartOfDay(toDateTime(occurred_at, 'UTC'))             AS bucket_start,
  JSONExtractString(properties, 'oa_metric')               AS metric,
  device_type,
  count()                                                  AS samples,
  sum(JSONExtractFloat(properties, 'oa_value'))            AS value_sum,
  quantilesTDigestState(0.5, 0.75, 0.9, 0.95, 0.99)(JSONExtractFloat(properties, 'oa_value')) AS value_quantiles,
  countIf(JSONExtractString(properties, 'oa_rating') = 'good')              AS good_samples,
  countIf(JSONExtractString(properties, 'oa_rating') = 'needs-improvement') AS needs_improvement_samples,
  countIf(JSONExtractString(properties, 'oa_rating') = 'poor')              AS poor_samples
FROM events_raw
WHERE type = 'web_vital' AND metric != ''
GROUP BY site_id, bucket_start, metric, device_type
