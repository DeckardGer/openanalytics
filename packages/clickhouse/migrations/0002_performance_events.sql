-- Web-vital performance facts (docs snapshot 02 §15 raw/fact list).
--
-- Rollout note: additive creation on an empty database, no backfill.
--
-- Populated by an incremental materialized view over events_raw rather than by a
-- second insert from the worker. Two independent inserts would be two acknowledgement
-- boundaries for one batch, and a batch that landed in raw but not in performance
-- would need a reconciliation path of its own. As a view target it inherits the
-- property ADR-0005 measured: deduplication is evaluated per destination table, so
-- a retry with the same token is a no-op for whichever target already has the block
-- and completes whichever does not.
--
-- This is a fact table, not a rollup — it keeps one row per web_vital event.
-- The `performance_1h`/`performance_1d` rollups over it are Milestone 7.

CREATE TABLE IF NOT EXISTS performance_events
(
  site_id          UUID,
  event_id         UUID,
  batch_id         String,

  occurred_at      DateTime64(3, 'UTC'),
  accepted_at      DateTime64(3, 'UTC'),

  metric           LowCardinality(String),
  value            Float64,
  rating           LowCardinality(String),
  navigation_type  LowCardinality(String),

  page_path        String,
  anonymous_id     String,
  session_id       String,

  origin           LowCardinality(String),
  device_type      LowCardinality(String),
  browser          LowCardinality(String),
  os               LowCardinality(String),
  country          LowCardinality(String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (site_id, occurred_at, metric, event_id)
-- Mandatory on every dependent target, not only on the raw table (ADR-0005).
SETTINGS non_replicated_deduplication_window = 1000;

-- The web_vital payload arrives inside the envelope's bounded properties JSON,
-- so the view projects it into typed columns once, here, rather than in every
-- later query. A malformed or absent key yields the JSON extractor's zero value,
-- which is why `metric` is filtered rather than trusted.
CREATE MATERIALIZED VIEW IF NOT EXISTS performance_events_mv TO performance_events AS
SELECT
  site_id,
  event_id,
  batch_id,
  occurred_at,
  accepted_at,
  JSONExtractString(properties, 'metric')          AS metric,
  JSONExtractFloat(properties, 'value')            AS value,
  JSONExtractString(properties, 'rating')          AS rating,
  JSONExtractString(properties, 'navigation_type') AS navigation_type,
  page_path,
  anonymous_id,
  session_id,
  origin,
  device_type,
  browser,
  os,
  country
FROM events_raw
WHERE type = 'web_vital' AND metric != ''
