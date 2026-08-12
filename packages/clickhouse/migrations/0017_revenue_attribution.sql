-- Matching and attribution (ADR-0033, D6). Milestone 12 Checkpoint 4.
--
-- Two parts, and they ship together because they are two halves of one decision:
-- the touchpoints an attribution names are session-fact rows, so widening the
-- fact and creating the table that points at it must not be separable.
--
--   a. `session_facts_versions` gains `utm_content` and `utm_term`.
--   b. `revenue_attributions` is created.
--
-- Rollout note: expand-only. Two additive `ALTER TABLE ... ADD COLUMN IF NOT
-- EXISTS` on an existing table plus one `CREATE TABLE IF NOT EXISTS`. No
-- backfill, no materialized view, and no `CREATE MATERIALIZED VIEW` anywhere in
-- this file -- for the reason 0013 and 0016 both give, and one more that is
-- specific to attribution: an attribution is a function of data that arrives
-- LATER than the row it describes (a conversion event, a session that finalizes
-- a day after the charge), so an insert-once view could never express it.
--
-- The runner applies every statement in this file in order with the configured
-- database as the session default. Multi-statement files are ordinary here
-- (0005 is the precedent: one ALTER plus a DROP plus a CREATE). Remember the
-- directory rule while reading the prose below: NO SEMICOLON MAY APPEAR INSIDE A
-- COMMENT, because the runner splits on the semicolon before it strips comments.
--
-- ============================================================================
-- PART A -- why the session fact gains two columns rather than gaining a table
-- ============================================================================
--
-- D6 refuses snapshot 02 §15's sketched `attribution_touchpoints` table. A
-- visitor's touchpoints ARE their session entry rows: first-touch source at the
-- session grain already lives in `session_facts_versions`, versioned,
-- retraction-aware, with the deterministic `(session_start, session_id)` order
-- an ordered journey needs. A second table would be a second source of truth
-- that the finalizer would have to keep honest forever.
--
-- What the layer lacked was width. `events_raw` has carried `utm_content` and
-- `utm_term` since 0001, and 02 §13 wants both at the touchpoint level, but the
-- fact stopped at source/medium/campaign. So they are added here, and they are
-- added in LOCKSTEP with every place that reads or writes a fact -- the row
-- type, the argMax projection, the finalizer's fingerprint, its tombstone
-- carry, and the events read that feeds the sessionizer. A column added to the
-- table but not to the fingerprint would be a column that never fills for an
-- existing session.
--
-- THE EMPTY-STRING RULE, and why this migration does not re-version every
-- session on the planet.
--
-- ClickHouse gives an added column its type default in every part written
-- before the ALTER, so a pre-extension row reads back as `utm_content = ''`.
-- That is EXACTLY the value the domain already uses for "this session's entry
-- event carried no utm_content" -- `sessionize` runs every dimension through a
-- null-to-empty-string normalizer, and the fact table has avoided `Nullable`
-- since 0013 for the mark-stream reason. The two spellings of absence are
-- therefore the same byte, which makes the naive thing the correct thing:
--
--   * a stored pre-extension fact whose session genuinely had no
--     utm_content/utm_term recomputes to `''` and compares EQUAL, so the
--     finalizer writes nothing,
--   * a stored pre-extension fact whose session DID carry one recomputes to the
--     real value and compares UNEQUAL, so it gets a new version -- which is
--     correct, because the stored row is genuinely missing data.
--
-- Had the columns been `Nullable` (NULL for old parts, `''` for a recompute) or
-- had the sessionizer used a sentinel other than the empty string, every single
-- stored session would have compared unequal and the first finalizer pass after
-- this migration would have re-versioned the entire table. It does not, and the
-- reason is a property of the two defaults agreeing rather than of anything the
-- planner does.
--
-- THE BLAST RADIUS, as a figure rather than as a reassurance. The finalizer only
-- ever recomputes sessions at or after the site's `finalized_through` watermark,
-- and that watermark can never fall further behind than
--
--     session cap (24 h, ADR-0018) + inactivity (30 min) + lateness (24 h)
--       = about 48.5 hours
--
-- so at most that much of a site's session history is re-read on the first pass
-- after this migration -- once -- and of that, only the sessions that actually
-- carried a utm_content or utm_term get a new version. Everything older is below
-- the watermark and is never read again by anything.
--
-- The rollup swap that follows writes ZERO rows for those re-versions, which is
-- worth knowing because it is the expensive half. `planRollupSwap` compares
-- `aggregatesEqual`, which looks only at session/engaged/bounced counts,
-- pageviews and the two duration sums -- none of which a utm column can move. So
-- the affected buckets are recomputed, compare equal and are not written, and
-- `session_rollups_1h`/`_1d` do not gain a generation from this migration at all.

ALTER TABLE session_facts_versions
  ADD COLUMN IF NOT EXISTS utm_content LowCardinality(String);

ALTER TABLE session_facts_versions
  ADD COLUMN IF NOT EXISTS utm_term LowCardinality(String);

-- ============================================================================
-- PART B -- `revenue_attributions`
-- ============================================================================
--
-- One row per charge per attribution COMPUTATION. The charge is the subject
-- because money is what a journey explains, and because D2b's model v1 stores
-- everything and computes first plus last: the ordered journey is preserved on
-- the row, so a later model (linear, time-decay, data-driven) is a recompute
-- under a new `model_version` and never a re-ingest.
--
-- ----------------------------------------------------------------------------
-- Engine, and the ONE CHARGE PER ORDER grain
-- ----------------------------------------------------------------------------
--
-- `ReplacingMergeTree(version)` over `(site_id, provider, object_id)`, the same
-- shape as 0016 and for the same reasons: a recompute inserts a strictly higher
-- version, the current truth is `argMax(col, version) GROUP BY key`, `FINAL` is
-- never used for correctness, and the merge only reclaims space.
--
-- The key is the charge, NOT the order. Several charges can share one
-- PaymentIntent -- a declined attempt followed by a successful retry is the
-- ordinary case -- and each of them is a real money object that CP5 must be able
-- to render. So each gets a row, and the matcher decides which ONE of them owns
-- the journey (the succeeded attempt, deterministically). The losers carry
-- `matched_via = 'none'`, `confidence = 'none'` and an empty journey. That is
-- the (session, order) grain D6 asks for, expressed at the charge key rather
-- than by discarding rows.
--
-- ----------------------------------------------------------------------------
-- PARTITION BY toYYYYMM(occurred_at) -- and why `occurred_at` exists at all
-- ----------------------------------------------------------------------------
--
-- D6's column list does not name a partition key and does not name
-- `occurred_at`. Both are decided here, and the second is what makes the first
-- possible.
--
-- ReplacingMergeTree replaces only WITHIN a partition. So the partition
-- expression must be a value that is IDENTICAL across every version of one row,
-- or the versions scatter and the engine can never collapse them -- and, worse,
-- a stale version in another partition stays visible to the argMax read forever
-- because the read groups across partitions and the higher version is simply in
-- a different part. Three candidates were available:
--
--   * `computed_at` -- REJECTED. It moves on every recompute BY DEFINITION, so
--     every re-attribution of one charge lands in a new partition. A charge
--     attributed in July and re-attributed in August would hold two live
--     versions in two partitions, and the monthly partition count would grow
--     with recompute passes rather than with data.
--   * `ft_session_start` -- REJECTED. A charge with no journey has no
--     first-touch at all, so every unmatched charge would pile into the 1970-01
--     partition -- and the moment a late conversion event matched it, its
--     partition would CHANGE, which is precisely the scatter above. An
--     attribution flipping from `none` to `exact` is the central late-data case
--     of this checkpoint, so a partition key that breaks on it is disqualified.
--   * `occurred_at` of the CHARGE -- CHOSEN. A money object's occurrence never
--     moves, so it is stable across every version of the attribution, exactly
--     as it is for the fact in 0016. It is also the natural query axis: every
--     journey read arrives as "the transactions in this range", so the same
--     column that keeps the engine correct also prunes the scan.
--
-- The column is therefore not decoration. It mirrors `revenue_events.occurred_at`
-- for the same charge and is copied from it at attribution time -- the matcher
-- already holds the fact, so no join is needed to fill it.
--
-- ----------------------------------------------------------------------------
-- The journey is bounded, and the bound is visible
-- ----------------------------------------------------------------------------
--
-- `journey` is a JSON array of session entries -- the snapshot CP5's journey API
-- serves -- and it is capped at 50 touchpoints, KEEP-NEWEST. Three reasons for a
-- cap at all: a String column in a wide-row table has no natural bound, an
-- identified visitor on a busy site can accumulate hundreds of sessions in
-- thirty days, and an API that renders a journey has to be able to promise a
-- bounded response. Keep-newest rather than keep-oldest because the sessions
-- adjacent to the purchase are the ones a journey view is read for, and because
-- first-touch is preserved separately in the `ft_` block regardless -- so the
-- truncation never costs the one touchpoint the model actually computes with.
--
-- `touchpoint_count` is the TRUE count, never the truncated one, so a reader can
-- always tell how much journey exists. `journey_truncated` is a column rather
-- than a field inside the JSON so the question "did we drop touchpoints?" is
-- answerable without parsing a string in a WHERE clause.
--
-- ----------------------------------------------------------------------------
-- Privacy boundary (D-102), unchanged from 0016
-- ----------------------------------------------------------------------------
--
-- `visitor_id` and `user_id` are the pseudonyms `events_raw` and
-- `session_facts_versions` already hold -- a site-scoped `identify()` HMAC or a
-- daily-rotating anonymous id. No raw customer identifier, no email, no IP, no
-- provider payload. `identity_scope` is the D2a honesty flag and it exists so a
-- reader can never be misled about what a 30-day window means for a visitor
-- whose id rotates at UTC midnight.
--
-- `non_replicated_deduplication_window` for the reason every table in this
-- directory sets it: on a non-replicated MergeTree, insert deduplication is off
-- by default and the attribution job's content-derived token would be accepted
-- and silently ignored. `tests/migration/clickhouse-analytics.test.ts` fails any
-- MergeTree-family table that forgets it.

CREATE TABLE IF NOT EXISTS revenue_attributions
(
  site_id                UUID,
  provider               LowCardinality(String),
  -- The CHARGE this attribution explains. High-cardinality by construction, so
  -- not LowCardinality, exactly as in 0016.
  object_id              String,

  -- Monotonic recompute version, minted by the attribution job as
  -- `max(stored in the horizon) + 1`. The engine's replacing column, and
  -- deliberately NOT part of the sort key.
  version                UInt64,

  -- The charge's own occurrence. Stable across every version of this row, which
  -- is what makes it the partition key. See the note above.
  occurred_at            DateTime64(3, 'UTC'),

  -- v1 = 1 (D2b). A model change is a recompute under a higher value, never a
  -- re-ingest and never a schema change.
  model_version          UInt16,
  -- 30 (D2a). Stored per row so a historical attribution stays readable after
  -- the policy moves, and so the UI can state the window it is showing.
  window_days            UInt16,

  -- conversion_event | client_reference | customer_identity | none (D6).
  matched_via            LowCardinality(String),
  -- exact | linked | none. `none` is a FIRST-CLASS OUTCOME, not an error: an
  -- unmatched transaction appears in every total and in the transactions list,
  -- it simply has no journey.
  confidence             LowCardinality(String),
  -- identified | anonymous_day (D2a, D-102), empty when nothing matched. Both
  -- values mean something NARROWER than "the window is real", and a read surface
  -- that renders them has to know which:
  --
  --   * `anonymous_day` -- the visitor key is a daily-rotating anonymous id and
  --     nothing else, so the journey cannot span a UTC midnight at all, no
  --     matter what `window_days` says.
  --   * `identified` -- the key is a stable `identify()` hash. The journey DOES
  --     include the sessions before the visitor identified (the matcher merges
  --     the conversion event's anonymous-id history in, or first touch would
  --     name the sign-in session rather than the ad click for every identified
  --     buyer), but only those sharing the visitor's CURRENT anonymous id --
  --     the rotation is still a rotation. So it reads as "the journey from the
  --     last anonymous-id rotation before identification onward", and from the
  --     moment of identification the full window is genuinely covered.
  identity_scope         LowCardinality(String),

  -- The resolved identity `if(user_id != '', user_id, anonymous_id)`, matching
  -- what the session fact carries. Empty when nothing matched.
  visitor_id             String,
  -- The stable `identify()` HMAC when the visitor was identified, empty
  -- otherwise -- the same column semantics as `session_facts_versions.user_id`.
  user_id                String,

  -- First touch: the earliest session entry inside the window (D2b).
  ft_session_id          String,
  ft_session_start       DateTime64(3, 'UTC'),
  ft_referrer_domain     LowCardinality(String),
  ft_utm_source          LowCardinality(String),
  ft_utm_medium          LowCardinality(String),
  ft_utm_campaign        LowCardinality(String),
  ft_utm_content         LowCardinality(String),
  ft_utm_term            LowCardinality(String),
  ft_entry_page          String,

  -- Last touch: the latest session entry at or before the charge. Identical
  -- shape, `lt_` prefix. On a single-touchpoint journey the two blocks are equal
  -- and that is correct rather than redundant.
  lt_session_id          String,
  lt_session_start       DateTime64(3, 'UTC'),
  lt_referrer_domain     LowCardinality(String),
  lt_utm_source          LowCardinality(String),
  lt_utm_medium          LowCardinality(String),
  lt_utm_campaign        LowCardinality(String),
  lt_utm_content         LowCardinality(String),
  lt_utm_term            LowCardinality(String),
  lt_entry_page          String,

  -- The TRUE number of touchpoints in the window, even when `journey` was
  -- truncated. 0 when nothing matched.
  touchpoint_count       UInt16,
  -- 1 when `journey` holds fewer entries than `touchpoint_count`. A column
  -- rather than a JSON field so the question is a predicate, not a parse.
  journey_truncated      UInt8,
  -- Bounded JSON array, newest 50 touchpoints, oldest first. One object per
  -- session entry with the session id, its start, the entry page and the five
  -- source dimensions -- the snapshot CP5's journey endpoint renders through the
  -- 03 §11 display contract. `[]` when nothing matched.
  journey                String,

  -- When the attribution job produced this version. Diagnostic and the source of
  -- CP5's attribution freshness metadata. Deliberately NOT the partition key.
  computed_at            DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (site_id, provider, object_id)
SETTINGS non_replicated_deduplication_window = 1000
