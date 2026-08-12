-- The canonical revenue fact (ADR-0033, D5). Milestone 12 Checkpoint 3.
--
-- Rollout note: additive creation on the analytics database. No backfill, no
-- materialized view, and there is no CREATE MATERIALIZED VIEW anywhere in this
-- file -- for the same reason 0013 has none. Rows are written by the worker's
-- projection loop (apps/worker/src/revenue/project.ts), which reads changed
-- object heads out of Postgres and inserts ONE ROW PER OBJECT PER VERSION.
--
-- ============================================================================
-- Why ReplacingMergeTree(version) with a Postgres-minted version
-- ============================================================================
--
-- `version` is NOT derived from a provider timestamp and NOT minted here. It is
-- `revenue_objects.version`, a monotonic counter Postgres hands out under a
-- `SELECT ... FOR UPDATE` on `(site_id, provider, object_id)` (D4). Three
-- properties follow, and together they are the whole reason this table can be
-- insert-only:
--
--   * The writer never needs a read-modify-write. It already knows which
--     generation it is inserting, because a row lock in another store decided
--     it. ClickHouse is told, not asked.
--   * A duplicate insert of the same state is harmless. Same version, same
--     values, `argMax` picks either one.
--   * An out-of-order insert cannot win. A stale observation is either refused
--     by the three-way decision before it ever reaches here, or -- if it somehow
--     arrived -- carries a lower version than the state that superseded it.
--
-- A provider timestamp could not do this job. Stripe's `created` is
-- second-granular, so two genuinely different states of one charge routinely
-- share a second, and a version derived from time would make them
-- indistinguishable. That is the same argument 0013 makes for session facts and
-- it lands in the same engine choice.
--
-- ============================================================================
-- The read rule: argMax, never FINAL, never a pre-filter
-- ============================================================================
--
-- Identical to `session_facts_versions` (0013), and identical for the identical
-- reason: ReplacingMergeTree's background merge is used ONLY to reclaim space
-- from superseded versions. It is never the correctness mechanism, because it
-- has not necessarily run. Every reader selects the current version explicitly:
--
--     SELECT site_id, provider, object_id,
--            max(version)                        AS version,
--            argMax(net_minor, version)          AS net_minor,
--            argMax(reporting_net_minor, version) AS reporting_net_minor,
--            ...
--       FROM revenue_events
--      WHERE site_id = {site} AND occurred_at >= {from} AND occurred_at < {to}
--      GROUP BY site_id, provider, object_id
--
-- or the equivalent `ORDER BY ... version DESC LIMIT 1 BY site_id, provider,
-- object_id`. A read that used FINAL for correctness would be wrong between
-- merges, and a read that filtered on a value column BEFORE the argMax would
-- resurrect a superseded version -- the exact trap 0013's `retracted` comment
-- spells out. Aggregated columns are qualified through the table alias, because
-- CI's ClickHouse resolves a bare name an alias shadows to the alias and throws
-- ILLEGAL_AGGREGATION.
--
-- ============================================================================
-- D-212: this fact PRECEDES any revenue rollup
-- ============================================================================
--
-- Docs snapshot 05 D-212 fixes the order long before this milestone existed:
-- credential, then idempotent ingest, then the NORMALIZED FACT, then
-- matching/attribution, then the rollup, then the API. This file is the
-- normalized fact. `revenue_1h` and `revenue_1d` arrive in ClickHouse migration
-- 0018 (CP5) and they cannot predate it, because the migration runner applies
-- files in version order and refuses to skip -- so a database that holds a
-- revenue rollup necessarily holds this table already.
--
-- That is plan 04 M12's fourth acceptance criterion, and the migration ledger is
-- its proof. `tests/unit/revenue-migration-order.test.ts` asserts it directly
-- against the files on disk, so a future CP that tried to land a rollup under a
-- LOWER number than this one fails CI rather than passing review.
--
-- The rollups are also deliberately not incremental materialized views (D-211,
-- D7): revenue is refundable and versioned, so an insert-only view is
-- structurally wrong. They will be generation-swapped recompute targets built by
-- reading THIS table through the argMax rule above.
--
-- ============================================================================
-- Privacy boundary (D5, D-102)
-- ============================================================================
--
-- No raw email, no raw customer identifier, no provider payload blob. The two
-- identity columns are site-scoped HMACs computed in the worker:
--
--   * `customer_hash` is a deliberate PSEUDONYM under its own purpose tag
--     (`revenue_customer`). It is NOT joinable against `events_raw.user_id`, and
--     that is the point -- it groups a site's own transactions by payer without
--     linking a payer to a browsing identity.
--   * `external_user_hash` IS the `identify()` derivation byte for byte
--     (`externalUserIdHash`), so it joins against `events_raw.user_id`. That
--     join is CP4's matcher.
--
-- Raw provider ids that are not identities (`object_id`, `order_id`,
-- `checkout_session_id`, `subscription_id`, `product_id`) are opaque provider
-- handles and are stored as-is. They name money objects, not people.
-- `client_reference_id` is the SITE's own user id and is stored raw exactly as
-- `revenue_objects.normalized` already stores it (CP2) -- it is the customer's
-- own opaque identifier, its hashed form travels in `external_user_hash`, and
-- the read surface never renders it.
--
-- ============================================================================
-- Reporting currency is MATERIALIZED here, and `unavailable` is not zero
-- ============================================================================
--
-- D2c: every fact keeps the original `currency` and amounts untouched, plus
-- amounts restated in the site's `reporting_currency` with the rate and the rate
-- date that produced them. `conversion_source` is the honesty flag:
--
--   * `none`        -- original currency already IS the reporting currency.
--                      `conversion_rate` is exactly 1 and the reporting amounts
--                      equal the originals.
--   * `ecb`         -- converted through the ECB daily reference rates.
--   * `unavailable` -- NO usable rate. `reporting_gross_minor` and
--                      `reporting_net_minor` are 0.
--
-- READ CONTRACT, and it is load-bearing for CP5: a row with
-- `conversion_source = 'unavailable'` MUST be surfaced as an explicit
-- unconverted remainder carrying its ORIGINAL currency and amount. It must never
-- be summed into a reporting-currency total, because its reporting amounts are
-- zeros that mean "unknown", not "nothing". Folding them in is exactly the
-- confident-zero failure this milestone is named after (docs snapshot 01 §12.3).
-- The zeros exist so the columns stay non-nullable and every arithmetic path
-- stays integer, and the flag is what carries the meaning.
--
-- `conversion_rate` is a Float64 and is DIAGNOSTIC ONLY. The conversion itself
-- is exact integer arithmetic over the numeric rate strings
-- (`packages/domain/src/money-conversion.ts`). This column records what was
-- applied so a historical report stays auditable (03 §6.5's rate/time metadata).
-- Nothing may ever recompute an amount from it -- float money has been forbidden
-- since M0.
--
-- ============================================================================
-- Engine settings
-- ============================================================================
--
-- non_replicated_deduplication_window is set for the reason every other table in
-- this directory sets it: on a non-replicated MergeTree family, insert
-- deduplication is OFF by default, so the projection's content-derived
-- `insert_deduplication_token` would be accepted and silently ignored.
--
-- That token is what makes a REPLAYED projection batch a no-op, and it only
-- works because the row is a pure function of the head. In particular
-- `ingested_at` is `revenue_objects.updated_at` -- stable per (head, version) --
-- and NOT the projecting worker's clock. With a clock in it, the replay after
-- "insert succeeded, marker never landed" would build a different row, hash to a
-- different token, and be accepted as a duplicate fact at the same version. That
-- was the shape of the first CP3 draft and it is the reason the column is
-- defined the way it is.
-- `tests/migration/clickhouse-analytics.test.ts` fails any MergeTree-family
-- table that forgets the setting.
--
-- Partitioning on `occurred_at` rather than on ingest time: a money object's
-- occurrence never moves, so every version of one object lands in the same
-- monthly partition -- which ReplacingMergeTree requires, because it only
-- replaces WITHIN a partition. Partitioning by `ingested_at` would scatter the
-- versions of one charge across partitions and the engine would never collapse
-- them.
--
-- Nullable is avoided the way the raw table avoids it: an absent string is the
-- empty string, which saves a mark stream per read.

CREATE TABLE IF NOT EXISTS revenue_events
(
  site_id                UUID,
  provider               LowCardinality(String),
  -- The provider's own opaque id for this money object (`ch_...`, `re_...`,
  -- `dp_...`). Part of the replacing key, so it is not LowCardinality: it is
  -- high-cardinality by construction.
  object_id              String,
  object_kind            LowCardinality(String),

  -- The Postgres-minted monotonic version (D4). The engine's replacing column,
  -- deliberately NOT part of the sort key, exactly as in 0013.
  version                UInt64,

  -- When the money moved. The bucket the amount lands in (D2d): a refund lands
  -- in the REFUND's own bucket, never retroactively in the charge's.
  occurred_at            DateTime64(3, 'UTC'),

  -- charge:  succeeded | pending | failed | refunded | partially_refunded
  -- refund:  succeeded | pending | failed | canceled
  -- dispute: the provider's own status, lowercased (needs_response, won, lost,
  --          ...) -- collapsing it would destroy the distinction between "we are
  --          still arguing" and "we lost", which is what a dispute screen is for.
  status                 LowCardinality(String),
  -- 1 for a real-money object, 0 for a provider test-mode object. Carried so a
  -- sandbox connection is visible in the data rather than mixed into totals.
  livemode               UInt8,

  -- Lowercase ISO-4217, as the provider reports it. The ORIGINAL currency,
  -- never rewritten.
  currency               LowCardinality(String),
  -- MAGNITUDES, always non-negative. The row's sign is a function of
  -- `object_kind` and is applied at rollup/read time (D2d) -- storing a negative
  -- refund here would make `sum(gross_minor)` silently mean something different
  -- per object kind.
  gross_minor            Int64,
  fee_minor              Int64,
  net_minor              Int64,

  -- The site's `reporting_currency` at projection time (D2c), lowercase ISO-4217
  -- exactly like `currency` above.
  --
  -- CASE RULE: both currency columns are lowercase, because the provider reports
  -- the original that way and a row whose two currency columns disagreed on case
  -- would make `currency = reporting_currency` -- the obvious "was this
  -- converted?" predicate -- quietly false for every unconverted row. The site
  -- setting is stored uppercase in Postgres (its CHECK is `^[A-Z]{3}$`) and the
  -- projection lowercases it on the way in.
  --
  -- Stored per row rather than joined at read time, because a site that changes
  -- its reporting currency needs every stored amount restated and the old and
  -- new must not be silently mixed while that runs.
  --
  -- RE-MATERIALIZATION IS NOT YET SAFE, and this is the honest statement of it.
  -- D2c calls the restatement a recompute rather than a re-ingest, which is
  -- right about the DATA FLOW -- the object heads are untouched -- but CP3 does
  -- NOT bump `revenue_objects.version` when it re-queues them
  -- (`resetRevenueProjection`). So a re-materialized row TIES with the row it
  -- was meant to replace, and a tie under this engine is not merely
  -- "arbitrary winner": `argMax` is evaluated PER COLUMN, so one read can
  -- resolve `reporting_currency` from one version and `reporting_gross_minor`
  -- from the other and return a row that never existed -- a EUR label beside a
  -- USD amount -- with the answer free to change between identical queries as
  -- parts merge.
  --
  -- CP3 therefore ships no caller for the reset. TODO(CP5): the
  -- reporting-currency PATCH must bump `revenue_objects.version` in the same
  -- statement that resets the projection marker and epoch, so the restated rows
  -- carry a strictly greater version and win outright.
  reporting_currency     LowCardinality(String),
  reporting_gross_minor  Int64,
  reporting_net_minor    Int64,
  -- ecb | none | unavailable. See the read contract above.
  conversion_source      LowCardinality(String),
  -- DIAGNOSTIC ONLY. Reporting units per one original unit. Never re-multiply.
  conversion_rate        Float64,
  -- The ECB banking day the rate came from, which is at or before the
  -- transaction's date and may be up to a week earlier over a holiday. Stored so
  -- a reader can see WHICH day's rate was used instead of assuming it matched.
  -- `1970-01-01` when there was no conversion at all.
  conversion_rate_date   Date,

  -- refund/dispute -> the charge it belongs to. Empty on a charge.
  parent_object_id       String,
  -- The PaymentIntent. Order identity across charge retries, and what a site's
  -- `oa.conversion('purchase', { order_id })` names (D6 signal 1).
  order_id               String,
  -- Checkout Session (D6 signal 2). On a charge these two arrive from the
  -- `revenue_match_hints` side table, not from the charge payload -- Stripe does
  -- not put them on the charge.
  checkout_session_id    String,
  client_reference_id    String,
  subscription_id        String,
  product_id             String,
  product_name           String,

  -- Site-scoped HMAC of the provider customer id, under the `revenue_customer`
  -- purpose tag. A pseudonym, deliberately NOT joinable against `user_id`.
  customer_hash          String,
  -- The `identify()` derivation (`externalUserIdHash`), byte for byte, so it
  -- JOINS against `events_raw.user_id` (D6). Empty when nothing identifying was
  -- available.
  external_user_hash     String,

  -- webhook | backfill. Which path last produced this version.
  ingested_via           LowCardinality(String),
  -- When this STATE became ours: `revenue_objects.updated_at`, the instant the
  -- object head applied this version. Deliberately not "when a worker copied
  -- it" -- a clock here would break the deduplication token (see the engine
  -- note below), and the head's own stamp is the more useful number anyway,
  -- being what the CP5 freshness metadata wants.
  ingested_at            DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(occurred_at)
-- The object's identity, and therefore the replacing key. `provider` is in it
-- because one site may connect two providers whose object ids could collide.
ORDER BY (site_id, provider, object_id)
SETTINGS non_replicated_deduplication_window = 1000
