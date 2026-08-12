-- Revenue rollups: the attribution job's recompute/swap targets (ADR-0033, D7,
-- docs snapshot 05, D-211/D-212). Milestone 12 Checkpoint 5.
--
-- ## NO SEMICOLON MAY APPEAR IN A COMMENT LINE IN THIS DIRECTORY
--
-- Read this before editing any prose below. `splitStatements` in
-- `packages/clickhouse/src/migrate.ts` splits on the statement terminator FIRST
-- and strips `--` lines from each fragment AFTERWARDS, so one inside a comment
-- shatters the
-- file into fragments of prose. The first fragment is then sent to ClickHouse as
-- a statement, fails, and aborts the whole migration run. The DDL below is
-- perfectly valid and would never execute.
--
-- The first draft of this file had eight such semicolons and split into seven
-- garbage fragments plus one table, with `revenue_1h` swallowed entirely.
-- `tests/unit/clickhouse-migration-statements.test.ts` now pins the invariant for
-- every file in this directory, so a future migration cannot repeat it.
-- Everywhere a semicolon would read naturally below, there is an em dash or a
-- full stop instead.
--
-- Rollout note: additive creation of two plain aggregate targets. As with 0013
-- and 0014 there is NO materialized view here, and for revenue the reason is
-- stronger than it was for sessions. A refund does not merely revise a number,
-- it REVERSES money that a previous read already reported, and the fact it
-- reverses is itself versioned (`revenue_events` is ReplacingMergeTree(version),
-- migration 0016). An insert-only view cannot un-count either one. D7 says this
-- in one line -- "the facts are versioned and refundable, so an insert-only MV
-- is structurally wrong" -- and `tests/unit/revenue-migration-order.test.ts`
-- enforces it structurally. No migration whose name mentions revenue may contain
-- a CREATE MATERIALIZED VIEW at all.
--
-- ## Why these tables cannot predate 0016
--
-- Plan 04 Milestone 12, acceptance criterion 4 is "the revenue rollup does not
-- exist before the normalized fact", and the proof the ADR names is this ledger.
-- The runner applies ClickHouse migrations in version order and refuses to skip,
-- so a database holding `revenue_1h` necessarily holds `revenue_events` already.
-- 0018 is greater than 0016, and the guard test above asserts the relation from
-- the directory contents rather than from a pair of constants somebody typed.
--
-- ## 0016's re-materialization warning is closed by this checkpoint
--
-- Migration 0016 records at length that a reporting-currency change was NOT yet
-- safe, because `resetRevenueProjection` did not bump `revenue_objects.version`
-- and a restated fact therefore TIED with the row it replaced -- a tie that
-- per-column `argMax` can resolve into a row that never existed. CP5 closes it.
-- The reset bumps the version, so a restated fact supersedes outright, and
-- Postgres 0037 adds the cursor that re-rolls the buckets older than the
-- attribution job's rolling horizon, which the version bump alone does not reach.
--
-- The warning text in 0016 is deliberately left as written. An applied migration
-- is never edited -- its checksum is in the ledger and a change would stop every
-- future run (D-214) -- so the correction lives here, in
-- `resetRevenueProjection` and in migration 0037, and 0016 remains an accurate
-- record of what was true when it shipped.
--
-- ## The swap mechanism is 0014's, with one deliberate difference
--
-- `ReplacingMergeTree(generation)` keyed on `(site_id, bucket_start)`. The
-- rollup step of the attribution job recomputes an affected bucket from the
-- argMax-read facts and inserts it at a strictly greater `generation`, and the
-- engine keeps the highest per key. Readers select the current generation
-- EXPLICITLY with `argMax(col, generation) GROUP BY site_id, bucket_start` and
-- then sum those current rows across the range -- never `FINAL`, never a
-- reliance on a merge having run (ADR-0005's read-before-merge rule).
--
-- THE DIFFERENCE: 0014 mints its generation as `max(stored) + 1`. This family
-- mints it from a per-site monotonic counter,
-- `revenue_attribution_state.rollup_generation_seq`, bumped inside the lease
-- claim. `max(stored) + 1` is only collision-free while exactly one writer is
-- awake, and this job's lease is a five-minute TTL that nothing renews. A run
-- that outlives its lease keeps writing beside the thief that took it, both
-- having read the same stored maximum, both computing the same next generation
-- -- a tie, which is the one thing ReplacingMergeTree cannot resolve. A counter
-- bumped by the claim itself gives the newer run the higher number by
-- construction, so the newer answer wins and the older one is superseded rather
-- than tied with.
--
-- REPLACE PARTITION was rejected for 0014's reason and it applies here
-- identically. It swaps a whole partition across ALL sites, so making it
-- per-(site, bucket) would need `site_id` in the partition key, and sites times
-- days is an unbounded partition count.
--
-- A recompute that produces the same aggregates writes NOTHING (the planner
-- compares before it writes), so a re-run over an unchanged range is a no-op
-- rather than a new generation of identical rows.
--
-- ## What is stored: additive totals only, in the site's reporting currency
--
-- The 0014 rule, restated for money. Every column is a sum that merges across
-- buckets by addition. Nothing is pre-divided and nothing is pre-averaged. An
-- average transaction value is `charge_gross_minor / charge_count` at read time,
-- so merging two buckets is a plain sum rather than a mean of means.
--
-- All amounts are integer minor units in the site's `reporting_currency`
-- (03 6.5 forbids float money, D2c makes the reporting currency a site setting).
-- The original currency is deliberately NOT a dimension here. See the
-- unconverted note below for where the original-currency remainder lives and why
-- it is not in this table.
--
-- ### The sign rule (D2d), pinned here because two places must agree
--
-- Each fact contributes to the bucket of its OWN `occurred_at`. A refund lands
-- in the refund's bucket, never retroactively in the charge's. That is what
-- makes a July report stay what it was when September's refund arrives, and it
-- is how Stripe's own reporting behaves.
--
--   sign(charge)              = +1
--   sign(refund)              = -1
--   sign(dispute, withdrawn)  = -1
--   sign(dispute, reinstated) = +1   (a won dispute returns the money)
--
--   charge_gross_minor        += reporting_gross          (charges only)
--   refund_minor              += reporting_gross          (refunds only, magnitude)
--   dispute_withdrawn_minor   += reporting_gross          (magnitude)
--   dispute_reinstated_minor  += reporting_gross          (magnitude)
--   fee_minor                 += sign * (reporting_gross - reporting_net)
--   net_minor                 += sign * reporting_net
--
-- which makes the identity a reader will check hold exactly:
--
--   net_minor = charge_gross_minor - refund_minor
--             - dispute_withdrawn_minor + dispute_reinstated_minor
--             - fee_minor
--
-- In practice `fee_minor` is charge-only, and that is the provider's doing
-- rather than ours. The adapter normalizes a refund and a dispute with `fee: 0`
-- (Stripe reverses no fee on a refund, and the dispute fee is not on the dispute
-- object), so `gross - net` is zero for both kinds and the signed term
-- contributes nothing. The expression stays general so a provider that DOES
-- report a reversed fee lands in the right column without a schema change.
--
-- A REFUNDED CHARGE IS NOT DOUBLE-NEGATIVE. A charge whose status became
-- `refunded` or `partially_refunded` keeps contributing its FULL gross to
-- `charge_gross_minor` in its own bucket. The refund object carries the negative
-- in its own. Deducting on both sides would remove the money twice, and the
-- charge's status is a description of what later happened to it, not a second
-- money movement. `tests/unit/revenue-rollup.test.ts` pins this.
--
-- A DISPUTE IS THE OPPOSITE CASE, and it is the one asymmetry in D2d. A refund
-- is a SEPARATE object with its own occurrence, so its money lands in its own
-- bucket. A dispute is ONE object whose status changes -- opened, then won or
-- lost -- and `occurred_at` stays the opening. So resolving a dispute REWRITES
-- the bucket it opened in rather than crediting the bucket it resolved in. That
-- is unavoidable (there is no second object to hang the reinstatement on) and it
-- is why the rollup range has to be able to reach back to a dispute that closes
-- sixty or ninety days after it opened, long outside the rolling horizon. The
-- job does that through `readOldestChangedRevenueObjectOccurrence`, which is the
-- charge-only escape hatch widened to every object kind for exactly this case.
--
-- A `failed` or `canceled` object contributes nothing and is not counted. It
-- moved no money, and counting it would make `charge_gross_minor / charge_count`
-- -- the average order value -- silently wrong.
--
-- ## The unconverted remainder is a COUNT here and a total elsewhere
--
-- A fact whose `conversion_source = 'unavailable'` (D2c: the ECB does not list
-- its currency, or the newest rate predates the transaction by more than the
-- lookback) carries zeroed reporting amounts. Folding those zeros into a total
-- would be the confident-zero failure this milestone is named after, so such a
-- fact contributes ZERO to every money column and to every kind count, and
-- increments `unconverted_count` instead.
--
-- The per-original-currency unconverted TOTALS are deliberately not stored here.
-- They would need `currency` in the sort key, and that breaks the swap. The unit
-- of replacement would become `(site, bucket, currency)`, so a currency that
-- disappears from a recomputed bucket could not be replaced away -- only a
-- tombstone row per vanished currency would do it, over an unbounded currency
-- set, for a remainder that by construction has no reporting value to add up.
-- The read layer therefore reads the remainder from the FACTS at query time, per
-- original currency, for the range summary only (the one surface that shows it).
-- `unconverted_count` in the bucket is what lets a chart say "part of this bucket
-- is not in the total" without a second query.
--
-- ## Bucketing
--
-- Bucketed on `occurred_at` in UTC, like every other rollup. A non-UTC local day
-- is composed from the hour rollup with `toStartOfDay(bucket_start, tz)`, the
-- same whole-hour-offset rule `chooseResolution` already encodes.
--
-- non_replicated_deduplication_window is mandatory on every MergeTree-family
-- table (ADR-0005). The bootstrap test enforces it, and the rollup insert's
-- content-derived token is silently ignored without it.

CREATE TABLE IF NOT EXISTS revenue_1h
(
  site_id                   UUID,
  bucket_start              DateTime('UTC'),
  -- The rollup step's swap generation, minted from the per-site counter in
  -- `revenue_attribution_state`. Readers take argMax over it per
  -- (site_id, bucket_start), and ReplacingMergeTree keeps the highest.
  generation                UInt64,

  -- Gross of every non-failed charge occurring in this bucket, reporting
  -- currency, minor units. A refunded charge is here in full -- see the sign rule.
  charge_gross_minor        Int64,
  -- Magnitude of refunds occurring in this bucket. Positive. The sign is applied
  -- by the net identity, not stored.
  refund_minor              Int64,
  -- Magnitudes of dispute money movement, split so a dashboard can show
  -- "withheld" separately from "returned to us" rather than only their
  -- difference. A won dispute contributes to BOTH -- the funds were withdrawn
  -- and then reinstated, and collapsing that to zero would hide that it happened.
  dispute_withdrawn_minor   Int64,
  dispute_reinstated_minor  Int64,
  -- Provider fees, signed by the movement they belong to, so `net` closes.
  -- Charge-only in practice -- see the note in the sign rule above.
  fee_minor                 Int64,
  -- The single additive answer: charges minus refunds minus withdrawn plus
  -- reinstated minus fees.
  net_minor                 Int64,

  charge_count              UInt64,
  refund_count              UInt64,
  dispute_count             UInt64,
  -- Facts in this bucket with no usable exchange rate. They are in NO money
  -- column and in NO kind count above. Their original-currency totals are read
  -- from the facts by the summary endpoint.
  unconverted_count         UInt64,

  computed_at               DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(generation)
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start)
SETTINGS non_replicated_deduplication_window = 1000;

CREATE TABLE IF NOT EXISTS revenue_1d
(
  site_id                   UUID,
  bucket_start              DateTime('UTC'),
  generation                UInt64,

  charge_gross_minor        Int64,
  refund_minor              Int64,
  dispute_withdrawn_minor   Int64,
  dispute_reinstated_minor  Int64,
  fee_minor                 Int64,
  net_minor                 Int64,

  charge_count              UInt64,
  refund_count              UInt64,
  dispute_count             UInt64,
  unconverted_count         UInt64,

  computed_at               DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(generation)
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start)
SETTINGS non_replicated_deduplication_window = 1000
