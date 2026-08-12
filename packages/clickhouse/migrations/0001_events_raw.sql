-- The canonical raw analytics fact table (docs snapshot 02 §15).
--
-- Rollout note: additive creation on an empty database, no backfill. This is the
-- first ClickHouse migration the runner has ever applied.
--
-- One row per accepted, deduplicated, server-enveloped event
-- (`persistedEventSchema` in @openanalytics/contracts). The worker is the only
-- writer, and it inserts synchronously with the manifest's deterministic
-- `batch_id` as `insert_deduplication_token` (docs snapshot 05, D-209 step 4).
--
-- §15's requirements, and where each one is met:
--   * event_id is kept                       -> event_id, in the sort key
--   * DateTime64 UTC time                    -> every instant column
--   * LowCardinality on suitable dimensions  -> type, origin, sdk, device, geo, utm
--   * site + time sort key                   -> ORDER BY (site_id, occurred_at, event_id)
--   * monthly partitions                     -> PARTITION BY toYYYYMM(occurred_at)
--   * bounded properties as JSON/String      -> properties String, bounded by the
--                                               M4 contract (32 keys, 256-byte values)
--   * no raw IP, no plaintext credential     -> there is no address column at any
--                                               depth. The collector discards the
--                                               IP after deriving anonymous_id (D-102)
--
-- Note on style: no comment in a migration file may contain a semicolon. The
-- runner splits statements on the semicolon before it strips comments
-- (splitStatements in packages/clickhouse), so one inside a comment cuts a
-- statement in half.
--   * a separate source origin               -> origin ('live'|'import'|'server'|'widget')
--
-- Engine is a plain MergeTree, not ReplacingMergeTree. Docs snapshot 02 §7.6 is
-- explicit that eventual merge-time replacement is not the correctness mechanism,
-- and naming an engine after deduplication it does not actually provide for a
-- dependent materialized view would be worse than not having it: the insert
-- token is what makes a retry a no-op, and it works per destination table.
--
-- `non_replicated_deduplication_window` is the setting that makes that token do
-- anything at all — on a non-replicated MergeTree, insert deduplication is off by
-- default and the token is accepted and ignored (ADR-0005). It must be set here
-- AND on every dependent materialized-view target, or a retry deduplicates the
-- raw rows while the view fires again and silently multiplies every dashboard
-- number. `tests/migration/clickhouse-analytics.test.ts` fails any future
-- migration that creates a MergeTree table without it.

CREATE TABLE IF NOT EXISTS events_raw
(
  -- Wire/envelope version, so a schema change is visible per row rather than
  -- inferred from a date.
  schema_version              UInt16,

  site_id                     UUID,
  event_id                    UUID,
  -- The manifest token that wrote this row. Carried so the reconciliation job
  -- can compare raw billable counts against the Postgres usage ledger per batch
  -- (plan Milestone 6 item 11) without a join key it would otherwise have to
  -- invent.
  batch_id                    String,

  type                        LowCardinality(String),
  -- Empty rather than Nullable: only custom_event and conversion carry a name,
  -- and a Nullable column costs a second mark stream on every read for a
  -- distinction the type column already makes.
  name                        String,
  origin                      LowCardinality(String),

  -- Analytics is bucketed on occurred_at, usage is billed at accepted_at. They
  -- are different clocks and must not be conflated (docs snapshot 05, D-015).
  occurred_at                 DateTime64(3, 'UTC'),
  received_at                 DateTime64(3, 'UTC'),
  accepted_at                 DateTime64(3, 'UTC'),
  -- The client clock was more than the allowed skew ahead and occurred_at was
  -- clamped to accepted_at (D-016).
  clock_skewed                UInt8,

  -- The deletion fence the row was written under (docs snapshot 05, D-210): a
  -- row's generation is the one the worker verified before writing it.
  ingest_generation           UInt32,

  billing_user_id             UUID,
  billing_assignment_version  UInt32,
  -- Window identity as the collector snapshotted it: the (user, starts_at) pair
  -- migration 0011 makes unique. The worker resolves the row id from it.
  usage_window_start          DateTime64(3, 'UTC'),
  -- Accepted inside a billing_blocked site's 24-hour grace (D-012).
  billing_grace               UInt8,
  -- Server-computed usage class (D-101). Never echoed from a request.
  billable                    UInt8,

  anonymous_id                String,
  session_id                  String,
  -- Site-scoped HMAC of the customer's own user id, never the raw value.
  user_id                     String,

  page_url                    String,
  page_path                   String,
  page_title                  String,

  referrer_domain             LowCardinality(String),
  referrer_path               String,
  utm_source                  LowCardinality(String),
  utm_medium                  LowCardinality(String),
  utm_campaign                LowCardinality(String),
  utm_content                 LowCardinality(String),
  utm_term                    LowCardinality(String),

  properties                  String,

  sdk                         LowCardinality(String),
  sdk_version                 LowCardinality(String),
  device_type                 LowCardinality(String),
  browser                     LowCardinality(String),
  os                          LowCardinality(String),
  country                     LowCardinality(String),
  city                        String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(occurred_at)
-- event_id closes the sort key so two events a site produced in the same
-- millisecond keep a deterministic, stable order.
ORDER BY (site_id, occurred_at, event_id)
SETTINGS non_replicated_deduplication_window = 1000
