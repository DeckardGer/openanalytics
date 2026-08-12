-- The imported aggregate family (ADR-0032, D2). Milestone 11 CP2.
--
-- Rollout note: additive creation of eight plain MergeTree tables. Nothing reads
-- them yet -- the union/merge read path is CP3 -- and nothing writes them except
-- the `import_prepare` job. A build that predates this migration keeps working
-- against the same rows, because no existing table, view or query is touched.
--
-- ## Why a separate family at all
--
-- Every additive rollup materialized view selects from `events_raw` with only a
-- `type` filter, and an insert into an MV target can never be retracted short of
-- a mutation on every one of them. Staging imported rows in `events_raw` would
-- therefore mean: publish could not be atomic, rollback would be a fleet of
-- mutations racing live reads, and a *failed* import would already be visible on
-- the customer's dashboard. ADR-0032 records that design as **rejected**, not
-- pending. These tables are the alternative: keyed by run, read only when the
-- Postgres pointer names the run, so publish and rollback are pointer moves.
--
-- **No materialized view reads from these tables and they feed none.** That is a
-- property to preserve, not an omission -- an MV here would fire on the staging
-- insert and make the pointer a fiction.
--
-- ## Keys and types
--
-- `site_id` is UUID, matching `events_raw` and every rollup, so the deletion
-- purge's `ALTER TABLE ... DELETE WHERE site_id = '<uuid>'` (packages/clickhouse
-- maintenance) works on these tables byte-for-byte as it does on the other
-- twenty. `import_run_id` is UUID for the same reason: cleanup deletes a run's
-- rows with the same interpolated-literal statement shape.
--
-- The run id plays the role `ingest_generation` plays on the live path
-- (ADR-0032 D2): these rows never pass the ingest fence, so the generation
-- column would have no writer -- the run **is** the staging generation, and it
-- leads every sort key after the site.
--
-- Counts are UInt64 including `visit_duration`, which is **total seconds** and
-- not an average. Averages are never stored pre-divided anywhere in this schema:
-- a sum divided by a sum at read time merges across days, a mean of means does
-- not (the same rule 0014 states for session durations).
--
-- Every dimension is a plain column with no Nullable anywhere. An absent
-- provider value is the empty string, which is what the live tables already do
-- and what keeps a second mark stream off every read for a distinction the
-- staging summary records anyway.
--
-- ## The dedup window, and how it is sized
--
-- `non_replicated_deduplication_window` is what makes `insert_deduplication_token`
-- do anything at all: on a non-replicated MergeTree, insert deduplication is off
-- by default and the token is accepted and silently ignored (ADR-0005). The
-- staging retry guarantee -- a reclaimed lease re-inserting the same chunk under
-- the token `{run_id}:{report}:{chunk_no}` must not duplicate rows -- rests
-- entirely on it.
--
-- **The unit is a partition-block, not a chunk.** An INSERT is split by the
-- partition key before anything is written, one part per partition, and the
-- deduplication record is computed per part: the key is the partition id
-- combined with the token, so one chunk spanning twelve months writes TWELVE
-- records, not one. The window counts those records. This is also why the writer
-- sets `max_partitions_per_insert_block = 0` -- the server otherwise refuses any
-- block touching more than 100 partitions, which a multi-year history import
-- reaches on its own -- and lifting that limit removes the refusal without
-- changing the arithmetic here: the same chunk still writes one record per month
-- it covers.
--
-- Sizing, then, is over the horizon a retry actually spans, and that horizon is
-- **one chunk**. Chunk progress is recorded on the run row after each insert
-- returns, so a resumed run skips every chunk below the recorded number and
-- re-inserts only the one that was in flight -- never the whole report. What has
-- to still be inside the window at that moment is:
--
--   * that chunk's own records, at most one per month it covers, and
--   * whatever OTHER runs inserted into the same table in between.
--
-- Cross-run concurrency is bounded by one non-terminal run per site (D3) times
-- the number of sites importing simultaneously. At 1000 -- the value every other
-- table in this schema carries -- a ten-year import chunk (120 monthly
-- partitions) still leaves room for seven more such chunks from other sites
-- between an attempt and its retry, and a normal single-year chunk leaves room
-- for dozens. Raising it is a per-table setting change.
--
-- Getting it too small is invisible: the retry is accepted as new data and every
-- number the customer sees for those months silently doubles.
--
-- Note on style: no comment in a migration file may contain a semicolon. The
-- runner splits statements on the semicolon BEFORE it strips comments
-- (splitStatements in packages/clickhouse), so one inside a comment cuts a
-- statement in half.

-- Site-day totals. The only table the timeseries/overview read path unions in
-- SQL (D2b) -- everything below is read through its own imported-only operation
-- and merged in the api, because a blank-padded union would seat fabricated
-- dimension tuples beside real ones.
CREATE TABLE IF NOT EXISTS imported_metrics_1d
(
  site_id         UUID,
  import_run_id   UUID,
  date            Date,

  visitors        UInt64,
  visits          UInt64,
  pageviews       UInt64,
  bounces         UInt64,
  -- Total seconds across the day's visits, never an average.
  visit_duration  UInt64
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(date)
ORDER BY (site_id, import_run_id, date)
SETTINGS non_replicated_deduplication_window = 1000;

-- Pages. `hostname` is carried because a provider export can span several hosts
-- of one property and dropping it would merge two different pages into one row.
CREATE TABLE IF NOT EXISTS imported_pages_1d
(
  site_id         UUID,
  import_run_id   UUID,
  date            Date,

  hostname        LowCardinality(String),
  -- Path, not URL. High enough cardinality that LowCardinality would cost more
  -- than it saves, exactly as `page_path` on the live side.
  page            String,

  visitors        UInt64,
  visits          UInt64,
  pageviews       UInt64
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(date)
ORDER BY (site_id, import_run_id, date, hostname, page)
SETTINGS non_replicated_deduplication_window = 1000;

-- Acquisition. `source` is the provider's own resolved name and `referrer` its
-- raw host/path -- both are kept because the live side distinguishes them too,
-- and collapsing them would make an imported "Google" indistinguishable from a
-- referral from a page that merely mentions it.
CREATE TABLE IF NOT EXISTS imported_sources_1d
(
  site_id         UUID,
  import_run_id   UUID,
  date            Date,

  source          LowCardinality(String),
  referrer        String,
  utm_source      LowCardinality(String),
  utm_medium      LowCardinality(String),
  utm_campaign    LowCardinality(String),
  utm_content     LowCardinality(String),
  utm_term        LowCardinality(String),

  visitors        UInt64,
  visits          UInt64,
  pageviews       UInt64,
  bounces         UInt64,
  visit_duration  UInt64
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(date)
ORDER BY (site_id, import_run_id, date, source, referrer, utm_source, utm_medium, utm_campaign)
SETTINGS non_replicated_deduplication_window = 1000;

-- Geography, country and region only.
--
-- **There is no city column, on purpose** (D2). Plausible ships city as a
-- GeoNames id and nothing in this system resolves that id to the name the live
-- geography dimension uses -- GeoLite2 resolves IP addresses, not GeoNames ids.
-- An empty or fabricated city name sitting beside real live city names would be
-- worse than the absence, so the value is dropped at staging and the run's
-- summary carries the warning the reviewer sees.
CREATE TABLE IF NOT EXISTS imported_geography_1d
(
  site_id         UUID,
  import_run_id   UUID,
  date            Date,

  -- ISO-3166-1 alpha-2, as on the live side.
  country         LowCardinality(String),
  region          LowCardinality(String),

  visitors        UInt64,
  visits          UInt64,
  pageviews       UInt64,
  bounces         UInt64,
  visit_duration  UInt64
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(date)
ORDER BY (site_id, import_run_id, date, country, region)
SETTINGS non_replicated_deduplication_window = 1000;

-- Device class, browser and operating system are **three tables**, one per
-- provider report, and that is D2b's whole point: the live devices operation
-- groups (device_type, browser, os) jointly, while an aggregate-only export
-- carries one dimension per file with no way to recover the other two. Union
-- them into one table and every row would have to invent the missing pair.
CREATE TABLE IF NOT EXISTS imported_devices_1d
(
  site_id         UUID,
  import_run_id   UUID,
  date            Date,

  device          LowCardinality(String),

  visitors        UInt64,
  visits          UInt64,
  pageviews       UInt64,
  bounces         UInt64,
  visit_duration  UInt64
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(date)
ORDER BY (site_id, import_run_id, date, device)
SETTINGS non_replicated_deduplication_window = 1000;

CREATE TABLE IF NOT EXISTS imported_browsers_1d
(
  site_id         UUID,
  import_run_id   UUID,
  date            Date,

  browser         LowCardinality(String),
  browser_version LowCardinality(String),

  visitors        UInt64,
  visits          UInt64,
  pageviews       UInt64,
  bounces         UInt64,
  visit_duration  UInt64
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(date)
ORDER BY (site_id, import_run_id, date, browser, browser_version)
SETTINGS non_replicated_deduplication_window = 1000;

CREATE TABLE IF NOT EXISTS imported_os_1d
(
  site_id          UUID,
  import_run_id    UUID,
  date             Date,

  operating_system LowCardinality(String),
  os_version       LowCardinality(String),

  visitors         UInt64,
  visits           UInt64,
  pageviews        UInt64,
  bounces          UInt64,
  visit_duration   UInt64
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(date)
ORDER BY (site_id, import_run_id, date, operating_system, os_version)
SETTINGS non_replicated_deduplication_window = 1000;

-- Custom events. `events` rather than `pageviews`: the provider counts
-- occurrences, and naming the column after the live pageview measure would
-- invite a read that sums the two.
CREATE TABLE IF NOT EXISTS imported_custom_events_1d
(
  site_id         UUID,
  import_run_id   UUID,
  date            Date,

  name            LowCardinality(String),
  -- Plausible's two special properties for the built-in outbound-link and
  -- file-download goals. Empty for an ordinary custom event.
  link_url        String,
  path            String,

  visitors        UInt64,
  events          UInt64
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(date)
ORDER BY (site_id, import_run_id, date, name, link_url, path)
SETTINGS non_replicated_deduplication_window = 1000
