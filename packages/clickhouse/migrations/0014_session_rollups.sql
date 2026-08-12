-- Session rollups: the finalizer's recompute/swap targets (docs snapshot 02 §15,
-- 04 Milestone 8 items 2 and 4, docs snapshot 05, D-211). Checkpoint A schema.
--
-- Rollout note: additive creation of two plain aggregate targets. As with 0013
-- there is NO materialized view here, by design. §15 and D-211 forbid deriving
-- session/bounce numbers from an incremental view. These tables are recomputed by
-- the finalizer (Checkpoint B) from the latest version per session in
-- session_facts_versions, one affected bucket at a time, and swapped in.
--
-- ## The swap mechanism, and why a generation column rather than REPLACE PARTITION
--
-- The finalizer recompute is per (site, bucket): when a session in a bucket
-- changes, that site's row for that bucket must be replaced idempotently, and a
-- re-run over an already-finalized bucket must leave it byte-identical
-- (acceptance criterion 2: "finalized range unchanged and duplicate-free on a
-- repeat run").
--
-- REPLACE PARTITION is ClickHouse's classic per-bucket swap, but it swaps a whole
-- table partition across ALL sites at once. To make it per-(site, bucket) the
-- partition key would have to include site_id, and sites x days is an unbounded
-- partition count that ClickHouse degrades badly on. Recomputing every site for a
-- bucket just because one site changed is the opposite of the bounded,
-- affected-only recompute D-211 asks for.
--
-- So the swap is a GENERATION COLUMN the reader filters on, the same shape 0013
-- uses for session versions. The finalizer inserts the recomputed row for a
-- (site, bucket) with a strictly greater `generation`, and ReplacingMergeTree(generation)
-- keeps the highest per (site_id, bucket_start). This is per-(site, bucket) with
-- no partition explosion, and it is idempotent: a re-run that computes the same
-- aggregates writes an identical row (Replacing collapses it) and a re-run with a
-- higher generation supersedes cleanly.
--
-- Read-before-merge correctness (ADR-0005) is preserved exactly as in 0013: the
-- reader selects the current generation per (site, bucket) explicitly with
-- argMax(col, generation) GROUP BY site_id, bucket_start (or LIMIT 1 BY ...
-- ORDER BY generation DESC) and then sums those current rows across the range. It
-- never relies on FINAL or on a merge having run. The engine's replacement only
-- reclaims space from superseded generations.
--
-- ## What is stored
--
-- Every measure is additive across buckets and across the finalized/provisional
-- layer merge (§15: long range reads finalized rollup, recent window reads the
-- provisional layer). Averages are never stored pre-divided: average session and
-- active duration are total_*_ms / sessions at read time, and bounce rate is
-- bounced_sessions / sessions -- so merging two buckets is a plain sum, never a
-- mean of means (docs snapshot 02 §10: average duration from session facts, not a
-- mean of duration messages). Unique visitors are intentionally NOT stored here:
-- the additive metrics rollups (0006-0011) already carry a mergeable uniq state,
-- and a session-scoped uniq is a Checkpoint C read concern, not a swap-table
-- column.
--
-- Bucketed on session_start in UTC, like every other rollup. A non-UTC local day
-- is composed from the hour rollup with toStartOfDay(bucket_start, tz), the same
-- whole-hour-offset rule chooseResolution already encodes for the additive family.
--
-- non_replicated_deduplication_window is mandatory on every MergeTree-family
-- table (ADR-0005), the bootstrap test enforces it.

CREATE TABLE IF NOT EXISTS session_rollups_1h
(
  site_id                    UUID,
  bucket_start               DateTime('UTC'),
  -- The finalizer's monotonic swap generation. Reader takes argMax over it per
  -- (site_id, bucket_start), and ReplacingMergeTree keeps the highest.
  generation                 UInt64,

  sessions                   UInt64,
  engaged_sessions           UInt64,
  bounced_sessions           UInt64,
  pageviews                  UInt64,
  -- Totals, so average duration is a sum divided by a sum at read, never a stored
  -- average and never a mean of per-message durations (§10).
  total_session_duration_ms  UInt64,
  total_active_duration_ms   UInt64,

  computed_at                DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(generation)
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start)
SETTINGS non_replicated_deduplication_window = 1000;

CREATE TABLE IF NOT EXISTS session_rollups_1d
(
  site_id                    UUID,
  bucket_start               DateTime('UTC'),
  generation                 UInt64,

  sessions                   UInt64,
  engaged_sessions           UInt64,
  bounced_sessions           UInt64,
  pageviews                  UInt64,
  total_session_duration_ms  UInt64,
  total_active_duration_ms   UInt64,

  computed_at                DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(generation)
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start)
SETTINGS non_replicated_deduplication_window = 1000
