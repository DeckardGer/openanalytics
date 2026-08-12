-- Preview and test-mode traffic, kept out of every production read path
-- (ADR-0034, D6).
--
-- Rollout note: additive -- one new table and one new column on `events_raw`,
-- both metadata-only operations that apply to a live cluster with no backfill
-- and no rewrite. **No materialized view is dropped or recreated**, which is the
-- property this whole design was chosen for.
--
-- Why a separate table rather than a `test_mode` column and a filter. Thirteen
-- materialized views read `events_raw` (migrations 0002-0012), and ClickHouse
-- cannot alter a materialized view's SELECT in place -- each one would have to
-- be dropped and recreated, and between the drop and the create every row
-- inserted into `events_raw` is permanently missing from that view's target.
-- Thirteen such windows on a production cluster, to add a WHERE clause, is a
-- worse trade than one new table.
--
-- The separate table also buys the filtering everywhere else for free. The
-- sessionizer reads `events_raw` (migrations 0013/0014 create no view -- the
-- worker writes session facts), so session facts, session rollups and every
-- gateway operation exclude preview traffic **by construction**, with no code
-- change and nothing to remember. A filter that must be repeated in fourteen
-- places will eventually be forgotten in one.
--
-- And it closes a live bypass. `context.test_mode` is client-set and was
-- server-believed: a site setting `data-test-mode` paid zero and still saw every
-- chart, which is free analytics for one HTML attribute. Routing that traffic
-- here makes the claim worth nothing -- 0 usage AND 0 dashboard -- which is why
-- `test_mode` can stay client-settable instead of needing a server-side gate.
--
-- Note on style: no comment in a migration file may contain a semicolon. The
-- runner splits statements on the semicolon before it strips comments
-- (splitStatements in packages/clickhouse), so one inside a comment cuts a
-- statement in half.

-- Rule identity on production events (ADR-0034). Empty for every event that no
-- rule produced, which is every row written before this migration -- so the
-- DEFAULT is the honest value rather than a backfill. It is a *column* and not a
-- new value in `origin`, deliberately: `origin` answers "which pipe did this
-- arrive through" (live/import/server/widget) and a no-code event arrives
-- through `live` like any other browser event. Merging the billing vocabulary
-- into the storage one would make one column answer two questions.
ALTER TABLE events_raw ADD COLUMN IF NOT EXISTS rule_id String DEFAULT '';

-- Preview and test-mode events. Column-for-column `events_raw` plus the three
-- fields a preview surface needs, so a row can be compared against the real
-- thing without a translation layer.
CREATE TABLE IF NOT EXISTS events_preview
(
  schema_version              UInt16,

  site_id                     UUID,
  event_id                    UUID,
  batch_id                    String,

  type                        LowCardinality(String),
  name                        String,
  origin                      LowCardinality(String),

  occurred_at                 DateTime64(3, 'UTC'),
  received_at                 DateTime64(3, 'UTC'),
  accepted_at                 DateTime64(3, 'UTC'),
  clock_skewed                UInt8,

  ingest_generation           UInt32,
  billing_user_id             UUID,
  billing_assignment_version  UInt32,
  usage_window_start          DateTime64(3, 'UTC'),
  billing_grace               UInt8,
  -- Always 0 here, and kept anyway. A preview row that ever carried 1 would be a
  -- bug worth being able to see rather than one the schema made unrepresentable
  -- and therefore silent.
  billable                    UInt8,

  anonymous_id                String,
  session_id                  String,
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
  city                        String,

  -- The rule that produced the event, and the definition version it came from.
  -- Together they are what the preview panel filters on: "show me what version 4
  -- of this definition did on my site just now".
  rule_id                     String,
  preview_version             UInt32,

  -- Which kind of non-production traffic this is. `site` means the whole site
  -- runs with `data-test-mode` -- the smoke fixture, or a staging deployment.
  -- `rule` means a dashboard preview session. One table, because both are
  -- answering the same question -- "keep this out of the customer's numbers" --
  -- and two tables would need the same TTL, the same purge target and the same
  -- exclusion everywhere, written twice.
  preview_kind                LowCardinality(String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (site_id, occurred_at, event_id)
-- Seven days. A preview is answered in minutes and a staging site's traffic has
-- no long-term meaning, so this is the one analytics table where forgetting is
-- the feature: without it, smoke traffic accumulates for the life of the
-- cluster in a table nobody reads.
TTL toDateTime(occurred_at) + INTERVAL 7 DAY
SETTINGS non_replicated_deduplication_window = 1000;
