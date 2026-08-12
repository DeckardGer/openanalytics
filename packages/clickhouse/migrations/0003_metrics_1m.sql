-- The first additive fact rollup (plan Milestone 6 item 1).
--
-- Rollout note: additive creation on an empty database, no backfill.
--
-- Milestone 6 builds exactly one dependent additive materialized view, because
-- one is what the acceptance criterion needs: "a manifest retry does not double
-- dependent additive MVs" is unprovable without a dependent MV, and it is the
-- failure ADR-0005 found by measurement — the raw token deduplicates while the
-- view fires again, inflating every number the dashboard is built from.
--
-- The rest of the rollup family — 1h/1d, pages, sources, geography, devices,
-- custom events, performance and the unique-visitor merge state — is Milestone 7
-- (docs snapshot 02 §15, plan Milestone 7 item 1). Session, bounce and revenue
-- rollups are deliberately not incremental views at all (D-211, D-212), and
-- nothing here anticipates them.
--
-- AggregatingMergeTree with SimpleAggregateFunction counters rather than
-- SummingMergeTree, so Milestone 7 can add the `uniqState` visitor column by
-- ALTER rather than by building a replacement target and backfilling it. A
-- SummingMergeTree does not merge AggregateFunction columns, so choosing it here
-- would make that expansion a table swap.

CREATE TABLE IF NOT EXISTS metrics_1m
(
  site_id         UUID,
  -- Bucketed on occurred_at: analytics is a visitor-time question, usage is a
  -- server-time one (docs snapshot 05, D-015).
  bucket_start    DateTime('UTC'),
  event_type      LowCardinality(String),
  events          SimpleAggregateFunction(sum, UInt64),
  billable_events SimpleAggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start, event_type)
-- Mandatory on every dependent target, not only on the raw table (ADR-0005).
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS metrics_1m_mv TO metrics_1m AS
SELECT
  site_id,
  toStartOfMinute(toDateTime(occurred_at, 'UTC')) AS bucket_start,
  type                                            AS event_type,
  count()                                         AS events,
  countIf(billable = 1)                           AS billable_events
FROM events_raw
GROUP BY site_id, bucket_start, event_type
