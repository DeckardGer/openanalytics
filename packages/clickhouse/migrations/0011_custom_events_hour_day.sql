-- The custom-event rollups (plan Milestone 7 items 1-2).
--
-- Rollout note: additive, direct-from-raw, no backfill. Family reasoning in 0006
-- and 0005.
--
-- Dimensions are the event name and the event type. name is the stable event
-- identifier a customer defines (docs snapshot 02 §12). The type distinguishes a
-- plain custom_event from a conversion, which the dashboard reports separately.
-- Filtered to rows that carry a name -- only custom_event and conversion do
-- (migration 0001 keeps name empty for page_view and the typed signal events),
-- so this is the named-event population without enumerating the type list here.
--
-- Measures keep billable_events alongside events, because a custom event can be
-- billable (D-101) while a page_view rollup's billable split lives in metrics_*.
-- visitors is the same mergeable uniq state as the rest of the family. Conversion
-- VALUE and revenue are not here: revenue is a separate normalize -> fact ->
-- attribution -> rollup sequence and is explicitly not part of this additive-MV
-- milestone (docs snapshot 05, D-212 and plan item 3).

CREATE TABLE IF NOT EXISTS custom_events_1h
(
  site_id         UUID,
  bucket_start    DateTime('UTC'),
  event_name      String,
  event_type      LowCardinality(String),
  events          SimpleAggregateFunction(sum, UInt64),
  billable_events SimpleAggregateFunction(sum, UInt64),
  visitors        AggregateFunction(uniq, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start, event_name, event_type)
-- Mandatory on every dependent target, not only on the raw table (ADR-0005).
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS custom_events_1h_mv TO custom_events_1h AS
SELECT
  site_id,
  toStartOfHour(toDateTime(occurred_at, 'UTC'))       AS bucket_start,
  name                                                AS event_name,
  type                                                AS event_type,
  count()                                             AS events,
  countIf(billable = 1)                               AS billable_events,
  uniqState(if(user_id != '', user_id, anonymous_id)) AS visitors
FROM events_raw
WHERE name != ''
GROUP BY site_id, bucket_start, event_name, event_type;

CREATE TABLE IF NOT EXISTS custom_events_1d
(
  site_id         UUID,
  bucket_start    DateTime('UTC'),
  event_name      String,
  event_type      LowCardinality(String),
  events          SimpleAggregateFunction(sum, UInt64),
  billable_events SimpleAggregateFunction(sum, UInt64),
  visitors        AggregateFunction(uniq, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start, event_name, event_type)
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS custom_events_1d_mv TO custom_events_1d AS
SELECT
  site_id,
  toStartOfDay(toDateTime(occurred_at, 'UTC'))        AS bucket_start,
  name                                                AS event_name,
  type                                                AS event_type,
  count()                                             AS events,
  countIf(billable = 1)                               AS billable_events,
  uniqState(if(user_id != '', user_id, anonymous_id)) AS visitors
FROM events_raw
WHERE name != ''
GROUP BY site_id, bucket_start, event_name, event_type
