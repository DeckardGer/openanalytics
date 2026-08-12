-- What a custom-events row may say beyond a count (ADR-0038, D5).
--
-- Rollout note: additive -- two new tables and two new materialized views, and
-- **nothing existing is altered, dropped or recreated**. The three fields the
-- dashboard wants (last_seen_at, sample_page_path, sample_properties) could have
-- been columns on custom_events_1h/1d, and that is exactly what makes this a
-- separate family: ClickHouse cannot alter a materialized view's SELECT in
-- place, so those columns would mean dropping and recreating
-- custom_events_1h_mv and custom_events_1d_mv, and every event inserted between
-- the drop and the create is permanently missing from the rollup a customer's
-- whole custom-events surface reads. Migration 0020 refused the same trade for
-- events_preview, thirteen views at a time.
--
-- Nor is the answer an argMax family over events_raw at read time. Dashboards
-- never GROUP BY raw events (AGENTS.md, docs snapshot 05 D-211): that read scans
-- every event of every visitor in the range, at a cost that grows with the
-- site's traffic rather than with the size of the answer, on the table every
-- ingest writes to.
--
-- Nothing backfills these tables and nothing is meant to. A materialized view
-- aggregates what is inserted after it exists, so a range that ends before this
-- migration ran has no row here and the API answers null for all three fields --
-- which is the honest answer, and the reason the contract makes them nullable.
--
-- Note on style: no comment in a migration file may contain a semicolon. The
-- runner splits statements on the semicolon before it strips comments
-- (splitStatements in packages/clickhouse), so one inside a comment cuts a
-- statement in half.

-- Keyed exactly as custom_events_1h is -- site, bucket, event_name, event_type
-- -- so a row here joins a row there without a translation and the api can merge
-- the two lists on the response's own key.
--
-- `events` is carried and never served. It exists so this table's ORDER BY /
-- LIMIT cuts the *same* top-N the counts operation cuts, from the same numbers
-- over the same WHERE. Ranking by recency instead would decorate a different
-- fifty names than the table it decorates, and every mismatch would render as a
-- null on a row that has data.
--
-- argMax, not anyLast: anyLast is insertion order, so a retried batch or a late
-- arrival would make the "newest" event an older one. occurred_at is the instant
-- the row itself claims, and it is the clock the buckets already use.
CREATE TABLE IF NOT EXISTS custom_event_samples_1h
(
  site_id           UUID,
  bucket_start      DateTime('UTC'),
  event_name        String,
  event_type        LowCardinality(String),
  events            SimpleAggregateFunction(sum, UInt64),
  last_seen_at      SimpleAggregateFunction(max, DateTime64(3, 'UTC')),
  sample_page_path  AggregateFunction(argMax, String, DateTime64(3, 'UTC')),
  sample_properties AggregateFunction(argMax, String, DateTime64(3, 'UTC'))
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start, event_name, event_type)
-- Mandatory on every dependent target, not only on the raw table (ADR-0005).
SETTINGS non_replicated_deduplication_window = 1000;

-- The same WHERE and GROUP BY as custom_events_1h_mv (migration 0011): rows that
-- carry a name, which is custom_event and conversion and nothing else.
CREATE MATERIALIZED VIEW IF NOT EXISTS custom_event_samples_1h_mv TO custom_event_samples_1h AS
SELECT
  site_id,
  toStartOfHour(toDateTime(occurred_at, 'UTC')) AS bucket_start,
  name                                          AS event_name,
  type                                          AS event_type,
  count()                                       AS events,
  max(occurred_at)                              AS last_seen_at,
  argMaxState(page_path, occurred_at)           AS sample_page_path,
  argMaxState(properties, occurred_at)          AS sample_properties
FROM events_raw
WHERE name != ''
GROUP BY site_id, bucket_start, event_name, event_type;

CREATE TABLE IF NOT EXISTS custom_event_samples_1d
(
  site_id           UUID,
  bucket_start      DateTime('UTC'),
  event_name        String,
  event_type        LowCardinality(String),
  events            SimpleAggregateFunction(sum, UInt64),
  last_seen_at      SimpleAggregateFunction(max, DateTime64(3, 'UTC')),
  sample_page_path  AggregateFunction(argMax, String, DateTime64(3, 'UTC')),
  sample_properties AggregateFunction(argMax, String, DateTime64(3, 'UTC'))
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start, event_name, event_type)
SETTINGS non_replicated_deduplication_window = 1000;

-- The day twin, for the ranges the hour grain does not serve. A day-only family
-- could not answer a two-hour range at all -- its bucket falls outside the
-- filter -- and "what did this event last do" is asked most often about today.
CREATE MATERIALIZED VIEW IF NOT EXISTS custom_event_samples_1d_mv TO custom_event_samples_1d AS
SELECT
  site_id,
  toStartOfDay(toDateTime(occurred_at, 'UTC')) AS bucket_start,
  name                                         AS event_name,
  type                                         AS event_type,
  count()                                      AS events,
  max(occurred_at)                             AS last_seen_at,
  argMaxState(page_path, occurred_at)          AS sample_page_path,
  argMaxState(properties, occurred_at)         AS sample_properties
FROM events_raw
WHERE name != ''
GROUP BY site_id, bucket_start, event_name, event_type
