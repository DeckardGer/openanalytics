-- The hour and day overview rollups (plan Milestone 7 items 1-2).
--
-- Rollout note: additive creation of two AggregatingMergeTree targets and their
-- views. No backfill -- see 0005 for why the raw table carries no live traffic
-- yet, and for the backfill step this would need on a populated table.
--
-- Direct-from-raw, not cascaded from metrics_1m. This is the family-wide
-- decision, argued here once and inherited by 0007-0012.
--
-- Every rollup view in this family reads FROM events_raw. None reads FROM
-- another rollup. The reason is the dedup-token model ADR-0005 measured, which
-- it measured for a SINGLE-LEVEL dependent view (raw -> target): a retried raw
-- insert under a stable token still fires the view, and it is the target table's
-- own non_replicated_deduplication_window that collapses the view's block so the
-- rollup does not double. A cascade (raw -> metrics_1m -> metrics_1h) is a
-- TWO-level chain. Whether the second-level view's block deduplicates on a
-- retry depends on how ClickHouse derives the dependent block's token through a
-- chain and on deduplicate_blocks_in_dependent_materialized_views -- neither of
-- which ADR-0005 measured, and the second (set vs unset) made no difference to
-- the single level it did measure, so its behaviour two levels down is exactly
-- the unmeasured territory a silent double-count hides in. Reading every rollup
-- straight from events_raw keeps the entire family inside the one dedup
-- behaviour that has been measured and is asserted by a test, at the cost of
-- firing a dozen views per raw insert instead of a chain of three. Each view
-- only ever sees the freshly inserted block, so a day rollup reading from raw
-- costs the same per insert as one reading from the hour rollup -- there is no
-- table scan. tests/migration/clickhouse-rollups.test.ts proves a deduplicated
-- raw retry leaves every table in this family unchanged.
--
-- Two further reasons the direct read is the honest one: a cascaded uniq state
-- would have to be uniqMergeState over metrics_1m's state rather than a plain
-- uniqState over identities, adding a second combinator layer for no gain, and
-- deletion already treats every rollup target as a separate object to purge
-- (docs snapshot 05, D-210) rather than a chain to unwind.
--
-- Dimensions match metrics_1m exactly (site_id, bucket, event_type) so the three
-- resolutions answer the same overview and timeseries question at three grains
-- (docs snapshot 02 §15 dashboard query rule: minute/hour for today, hour/day
-- for 7-30 days, day for long ranges). Bucketed on occurred_at, never
-- accepted_at (docs snapshot 05, D-015). Visitors is a uniq merge state, never a
-- summed bucket count (plan item 2). The identity expression is the one 0005
-- documents.

CREATE TABLE IF NOT EXISTS metrics_1h
(
  site_id         UUID,
  bucket_start    DateTime('UTC'),
  event_type      LowCardinality(String),
  events          SimpleAggregateFunction(sum, UInt64),
  billable_events SimpleAggregateFunction(sum, UInt64),
  visitors        AggregateFunction(uniq, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start, event_type)
-- Mandatory on every dependent target, not only on the raw table (ADR-0005).
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS metrics_1h_mv TO metrics_1h AS
SELECT
  site_id,
  toStartOfHour(toDateTime(occurred_at, 'UTC'))       AS bucket_start,
  type                                                AS event_type,
  count()                                             AS events,
  countIf(billable = 1)                               AS billable_events,
  uniqState(if(user_id != '', user_id, anonymous_id)) AS visitors
FROM events_raw
GROUP BY site_id, bucket_start, event_type;

CREATE TABLE IF NOT EXISTS metrics_1d
(
  site_id         UUID,
  bucket_start    DateTime('UTC'),
  event_type      LowCardinality(String),
  events          SimpleAggregateFunction(sum, UInt64),
  billable_events SimpleAggregateFunction(sum, UInt64),
  visitors        AggregateFunction(uniq, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start, event_type)
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS metrics_1d_mv TO metrics_1d AS
SELECT
  site_id,
  toStartOfDay(toDateTime(occurred_at, 'UTC'))        AS bucket_start,
  type                                                AS event_type,
  count()                                             AS events,
  countIf(billable = 1)                               AS billable_events,
  uniqState(if(user_id != '', user_id, anonymous_id)) AS visitors
FROM events_raw
GROUP BY site_id, bucket_start, event_type
