-- Versioned canonical session facts (docs snapshot 02 §10 and §15, 04 Milestone
-- 8 items 1-2, docs snapshot 05, D-211). Checkpoint A schema half.
--
-- Rollout note: additive creation on the analytics database. No backfill and no
-- materialized view -- this table is deliberately NOT an MV target. §15 and D-211
-- are explicit that session and bounce numbers cannot come from an incremental
-- view, because a late second pageview must be able to undo a recorded bounce,
-- which an insert-once view can never do. Rows are written by the finalizer
-- (Checkpoint B), which recomputes a session from the full raw event set with the
-- pure sessionizer in @openanalytics/domain and inserts a NEW VERSION of the
-- affected session. There is no CREATE MATERIALIZED VIEW anywhere in this file.
--
-- One row is one VERSION of one canonical session. The session's identity is
-- (site_id, session_id). version is monotonic. A recompute inserts a strictly
-- greater version, and the current truth is the highest version per session.
--
-- Engine: ReplacingMergeTree(version), and this choice is deliberate against the
-- events_raw precedent (0001), so the reasoning is written out here.
--
--   * events_raw is a plain MergeTree because there the ONLY reason to reach for
--     ReplacingMergeTree would be insert dedup, which merge-time replacement does
--     not reliably provide before a merge, so naming the engine after it would be
--     dishonest (ADR-0005). The insert token does that job instead.
--   * Here the situation is the opposite: producing many versions of one session
--     over time is the intended behaviour, and once a higher version exists the
--     lower ones are pure garbage awaiting reclamation. ReplacingMergeTree(version)
--     is the honest fit -- its background merge is used only to RECLAIM SPACE from
--     superseded versions, never as the correctness mechanism.
--   * Read-before-merge correctness (ADR-0005) is preserved because the reader
--     never trusts the merge and never relies on FINAL. It selects the current
--     version explicitly, e.g.
--         SELECT ... FROM session_facts_versions
--          WHERE site_id = {site} AND session_start >= {from} AND session_start < {to}
--          ORDER BY site_id, session_id, version DESC LIMIT 1 BY site_id, session_id
--     or the equivalent argMax(col, version) GROUP BY site_id, session_id. That is
--     correct whether or not any merge has happened -- the merge only makes the
--     same answer cheaper. A read that used FINAL for correctness would be wrong
--     between merges, which is exactly what this comment forbids.
--
-- non_replicated_deduplication_window is set for the same reason it is on every
-- other table: on a non-replicated MergeTree family, insert deduplication is off
-- by default, so the finalizer's stable per-(site,bucket,generation) insert token
-- would be accepted and ignored without it. tests/migration/clickhouse-analytics
-- .test.ts fails any MergeTree-family table that forgets it.
--
-- Times are UTC DateTime64(3) like events_raw. Nullable is avoided the way the
-- raw table avoids it: an absent string dimension is the empty string, not NULL,
-- to save a mark stream per read.

CREATE TABLE IF NOT EXISTS session_facts_versions
(
  site_id                 UUID,
  -- Canonical session id: the domain sessionizer's stable hash of
  -- (site_id, earliest-event-id). Stable across recompute because the earliest
  -- event does not change when a later one arrives.
  session_id              String,
  -- Monotonic version. A later finalizer recompute writes a strictly greater
  -- value, and the current row is argMax over this. ReplacingMergeTree(version) keeps
  -- the highest per (site_id, session_id).
  version                 UInt64,

  -- Resolved identity if(user_id != '', user_id, anonymous_id) (docs snapshot 02
  -- §10, ADR-0011). Carried explicitly so a session rollup or a visitor query
  -- does not have to recompute the expression.
  visitor_id              String,
  -- Empty when the visitor is anonymous.
  user_id                 String,
  anonymous_id            String,
  -- Site-scoped HMAC of the client session hint (persisted session_id).
  session_hint            String,
  -- The visitor was joined across a UTC-midnight anonymous-id rotation by the
  -- D-102 midnight bridge. Flagged so that the one place default cookieless
  -- identity is intentionally linked across its daily rotation is visible in the
  -- data rather than implicit.
  midnight_bridged        UInt8,

  -- First and last meaningful activity, occurred_at (D-015), millisecond precise.
  session_start           DateTime64(3, 'UTC'),
  session_end             DateTime64(3, 'UTC'),

  pageviews               UInt32,
  -- Engaged per §10 (>=10s active, OR a meaningful custom_event/conversion, OR
  -- 2+ pageviews). Bounce is the negation and is derived at read (countIf) rather
  -- than stored twice.
  engaged                 UInt8,
  -- Deduped visible+active time, not open time (§10). Never a sum of raw beacons.
  active_duration_ms      UInt64,
  -- Last-minus-first meaningful activity (§10).
  session_duration_ms     UInt64,

  entry_page_path         String,
  exit_page_path          String,

  -- Entry attribution/geo/device dimensions, cheap and low-cardinality, so a
  -- session-scoped source/geo/device breakdown does not need a raw join.
  referrer_domain         LowCardinality(String),
  utm_source              LowCardinality(String),
  utm_medium              LowCardinality(String),
  utm_campaign            LowCardinality(String),
  device_type             LowCardinality(String),
  browser                 LowCardinality(String),
  os                      LowCardinality(String),
  country                 LowCardinality(String),

  -- 1 when this session is past the finalizer's inactivity + 24h lateness
  -- watermark and will not change again (docs snapshot 02 §10, D-211). A
  -- provisional (0) row can still be superseded by a later version.
  finalized               UInt8,

  -- Retraction tombstone. A session_id is NOT permanently stable -- it hashes
  -- (site, earliest event id), so a late EARLIER event (an offline flush older
  -- than the current first) mints a new id, and the midnight bridge / identity
  -- stitch merge two spans a prior finalizer run may already have written under
  -- two ids. In both cases one id must disappear, or its last version lingers as
  -- the current truth forever and a finalized range double-counts a session --
  -- which would violate acceptance criterion 2 (finalized range unchanged AND
  -- duplicate-free on a repeat run).
  --
  -- So Checkpoint B's finalizer, after recomputing a window, inserts a
  -- strictly-higher version with retracted = 1 for every session_id present in
  -- the stored window but ABSENT from the recomputed set. The row is a tombstone,
  -- not data.
  --
  -- READ CONTRACT, and the trap: every reader filters retracted = 0 AFTER the
  -- latest-version selection, never before. Selecting the current version per
  -- (site_id, session_id) with argMax/LIMIT 1 BY version and THEN dropping
  -- retracted = 1 removes a retracted session. Filtering retracted = 0 first
  -- would discard the tombstone and resurrect the older, un-retracted version --
  -- the exact bug the tombstone exists to prevent. The data-level test proves the
  -- argMax-then-filter read returns zero while a naive pre-filter read wrongly
  -- returns the stale version.
  retracted               UInt8,

  -- When the finalizer produced this version. Diagnostic and a source for the
  -- freshness/provisional metadata the read layer returns (§15).
  computed_at             DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(version)
-- session_start is stable, so a session always lands in the same monthly
-- partition and version replacement stays within it (Replacing dedups only
-- within a partition).
PARTITION BY toYYYYMM(session_start)
-- Identity is (site_id, session_id): the replacing key. version is the engine's
-- replacing column, not part of the sort key.
ORDER BY (site_id, session_id)
SETTINGS non_replicated_deduplication_window = 1000
