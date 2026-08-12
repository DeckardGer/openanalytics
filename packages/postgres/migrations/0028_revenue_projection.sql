-- Revenue projection state and checkout match hints (ADR-0033, D5/D6/D8).
-- Milestone 12 Checkpoint 3.
--
-- Rollout note: expand-only. One additive column with a default on an existing
-- table, two indexes, and one brand-new table. Nothing existing is rewritten
-- and nothing is backfilled -- `projected_version` defaults to 0, which is
-- exactly the state "this head has never been projected", so every row that
-- exists when this migration lands is correctly queued for its first
-- projection. 0023-0027 are applied and are therefore never edited (D-214).
--
-- The plan table in ADR-0033 D10 books the next slot for CP4. CP3 takes it because
-- CP3 needs durable projection state, and CP4's `revenue_attribution_state`
-- moves one later. The numbers in D10 are an execution order, not a contract --
-- what D10 actually proves is that the ClickHouse rollups (0018) come after the
-- fact (0016), and that is untouched.

-- ============================================================================
-- The projection watermark: a per-ROW marker, not a per-site timestamp
-- ============================================================================
--
-- The projection loop drains changed object heads into `analytics.revenue_events`
-- and has to answer one question on every tick: which heads have moved since I
-- last looked? Three shapes were available and the choice is worth writing down,
-- because the two rejected ones both have a silent-loss mode.
--
-- REJECTED -- a per-site timestamp watermark on `revenue_objects.updated_at`.
--   `updated_at` is assigned in application code (`new Date()`) INSIDE the
--   transaction that writes the head, and it is written before the transaction
--   commits. Under concurrency the commit order and the timestamp order are
--   therefore not the same order: a transaction that stamped T1 can commit AFTER
--   one that stamped T2 > T1. A watermark advanced to T2 skips the T1 row
--   permanently, and nothing downstream ever notices -- the head is correct in
--   Postgres and simply absent from ClickHouse. The usual mitigation is a
--   lateness margin (advance only to `now - margin`, re-read the overlap), which
--   makes the loss *unlikely* rather than impossible: it is a bet that no
--   transaction outlives the margin, and the day one does the bet loses silently.
--
-- REJECTED -- a `revenue_projection_state` table keyed by site. Same timestamp
--   problem, plus one more site-scoped table in the deletion vocabulary buying
--   nothing the column below does not already give.
--
-- CHOSEN -- `revenue_objects.projected_version`, a monotonic marker beside the
--   monotonic `version` the head already mints under its row lock. A head needs
--   projecting exactly when `projected_version < version`. There is no clock in
--   the predicate at all, so there is nothing to skew:
--
--     * A row written at any time by any transaction is visible to the next scan
--       the moment it commits, and is selected until it has been projected.
--     * The marker is written with the LITERAL version that was projected and
--       guarded `WHERE projected_version < that literal`, so a concurrent
--       `applyRevenueObservation` that bumped the head to version+1 between the
--       read and the mark leaves the row selected rather than losing the bump.
--     * Order of operations is insert-then-mark, the same rule the sync walk's
--       cursor follows: a crash between them re-projects rows that are already
--       in ClickHouse, where the content-derived deduplication token makes the
--       re-insert a no-op. The reverse order would mark rows that were never
--       written, which is the one direction that loses data.
--
--       That no-op depends on the projected row being a pure function of the
--       head, which is why the fact's `ingested_at` is THIS TABLE's `updated_at`
--       rather than the projecting worker's clock: `updated_at` is stable per
--       (head, version), so the replay rebuilds byte-identical rows and hashes
--       to the same token. A clock would have made every replay a new token and
--       a duplicate fact.
--     * Re-materialization (D2c: changing a site's reporting currency is a
--       recompute, not a re-ingest) is one statement -- zero the marker and bump
--       the epoch below for the site -- instead of a watermark rewind whose
--       meaning depends on clocks. See `resetRevenueProjection`, which also
--       records why that statement is NOT yet sufficient on its own and carries
--       the TODO(CP5) for the version bump it still needs.
--
-- The cost is one UPDATE per projected row. At revenue volumes (a site's
-- charges, refunds and disputes -- tens to thousands per day, not millions) that
-- is nothing, and it is paid in exchange for removing an entire class of silent
-- loss.

ALTER TABLE revenue_objects
  ADD COLUMN projected_version bigint NOT NULL DEFAULT 0;

-- A marker can never claim to have projected a version that was never minted.
-- `version >= 1` is already checked, so 0 means "never projected" unambiguously.
ALTER TABLE revenue_objects
  ADD CONSTRAINT revenue_objects_projected_version_check
  CHECK (projected_version >= 0 AND projected_version <= version);

-- ----------------------------------------------------------------------------
-- The re-materialization epoch, and the race it closes
-- ----------------------------------------------------------------------------
--
-- The marker alone is not enough, because a reset and an in-flight batch can
-- interleave destructively:
--
--   1. the projection reads head H at version 3 and starts building its row,
--   2. a re-materialization runs (D2c: the site changed its reporting currency)
--      and sets `projected_version = 0` for every head, H included,
--   3. the batch finishes and marks H with `projected_version = 3`, which the
--      `projected_version < 3` guard happily accepts because 0 < 3.
--
-- H is now marked as projected while the row in ClickHouse still carries the OLD
-- reporting currency, and nothing will ever pick it up again. The customer's
-- dashboard shows one transaction denominated in a currency they stopped using,
-- forever, with no error anywhere.
--
-- A monotonic epoch closes it exactly. A reset bumps it in the same statement
-- that zeroes the marker; the projection carries the epoch it READ alongside the
-- version it projected, and the mark additionally requires `projection_epoch`
-- to be unchanged. Step 3 above then matches nothing, H stays due, and the
-- re-materialization completes.
--
-- Chosen over the alternatives for the reason the marker itself was chosen: it
-- is a comparison of two stored integers with no clock and no lock. A `SELECT …
-- FOR UPDATE` per head would serialize the projection against every ingest
-- write on the hot path, and a "reset only when no batch is in flight" rule
-- would need a lease nobody else needs.

ALTER TABLE revenue_objects
  ADD COLUMN projection_epoch bigint NOT NULL DEFAULT 0;

ALTER TABLE revenue_objects
  ADD CONSTRAINT revenue_objects_projection_epoch_check
  CHECK (projection_epoch >= 0);

-- The projection loop's whole discovery query, and it is partial so the index is
-- the size of the UNFINISHED set rather than of the table. On a steady-state
-- installation that set is empty between ticks, so this index is a few pages and
-- the scan that drives the loop is a scan of nothing.
--
-- `(site_id, updated_at)` inside the partial predicate because the loop works
-- one site at a time -- it needs the site's `reporting_currency` and its rate
-- lookups, which are per site -- and takes the oldest-changed heads first so a
-- large backfill drains in arrival order rather than in physical order.
CREATE INDEX revenue_objects_unprojected_idx
  ON revenue_objects (site_id, updated_at)
  WHERE projected_version < version;

-- ============================================================================
-- Checkout match hints
-- ============================================================================
--
-- D6's second matching signal is Stripe's Checkout `client_reference_id`: the
-- site passes the same stable user id it gives `identify()` into Checkout, and
-- the server joins its HMAC against `user_id`. The signal arrives on
-- `checkout.session.completed`, which carries NO money object -- and the charge
-- it eventually refers to carries neither the session id nor the reference.
--
-- CP2 therefore persisted nothing from that event. This table is where it goes.
--
-- WHY A SEPARATE TABLE RATHER THAN AN OBSERVATION ON THE OBJECT HEAD
--
-- The head is guarded by a three-way decision over `(snapshot_at, payload_hash)`
-- whose entire premise is that ONE payload hash describes ONE complete state.
-- Feeding a checkout event through `applyRevenueObservation` would break that in
-- two ways at once, and both corrupt money:
--
--   1. The observation carries the checkout event's `created` as `snapshot_at`.
--      For a charge created in the same second -- the ordinary case, since the
--      charge is created BY the checkout -- that is an equal-timestamp tie with
--      a different payload, which the three-way rule answers by re-fetching the
--      object from the provider. So a hint would cost a provider request per
--      checkout, to resolve a tie that is not about money at all.
--   2. If it applied, it would bump `version` and REWRITE `normalized` -- the
--      document that holds `gross_minor`, `fee_minor`, `net_minor`. A hint
--      payload has no money fields, so the head would either be overwritten with
--      zeros or need a partial-merge path, and a partial merge dissolves the
--      one-hash-one-state invariant the whole decision rests on. Every later
--      three-way comparison would then be against a hash describing a state that
--      never existed.
--
-- A separate table cannot do either. It is written by its own statement, it has
-- no column that money is stored in, and the projection reads it as a LEFT JOIN
-- on `(site_id, provider, order_id)`. A hint that is wrong, duplicated or absent
-- changes which journey a charge is attributed to -- it can never change what
-- the charge was worth.
--
-- WHAT IS STORED, AND WHAT IS NOT
--
-- `client_reference_id` is stored RAW, and that is not a new decision: it is the
-- site's own opaque user id, and `revenue_objects.normalized.client_reference_id`
-- already holds it raw (CP2). Its hashed form is computed in the WORKER at
-- projection time and travels to ClickHouse as `external_user_hash` -- the api
-- computes no hashes, because the api does not hold
-- `ANONYMOUS_IDENTITY_SECRET` and must keep not holding it.
--
-- An EMAIL is never stored here, in any form. D-102 forbids the raw value and
-- the api cannot produce the hashed one, so the email matching path of D6
-- signal 3 is structurally unavailable in CP3 and is recorded as CP4's problem:
-- CP4's matcher runs in the worker, which holds both the credential keyring and
-- the identity secret, so it can fetch a Customer and hash the address without
-- anything at rest ever seeing it.

CREATE TABLE revenue_match_hints (
  id                   uuid PRIMARY KEY,
  site_id              uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  provider             text NOT NULL,
  -- The Checkout Session id (`cs_...`). The hint's own identity: one session
  -- completes once, so this is what makes a redelivery a no-op.
  checkout_session_id  text NOT NULL,
  -- The PaymentIntent (`pi_...`) the session created, which is also the charge's
  -- `order_id`. This is the join key the projection uses. Empty string when the
  -- session completed without a payment (a zero-amount or async session), in
  -- which case the hint is stored anyway and simply joins to nothing -- dropping
  -- it would make a later async payment unmatchable.
  order_id             text NOT NULL DEFAULT '',
  -- The site's own user id, raw, exactly as the object head already stores it.
  client_reference_id  text NOT NULL DEFAULT '',
  -- The provider's opaque customer id (`cus_...`). Never an email. Carried so a
  -- checkout whose charge lacks a customer still yields a `customer_hash`.
  customer_id          text NOT NULL DEFAULT '',
  -- The session's own completion time. Diagnostic, and the ordering input if a
  -- future provider ever emits two hints for one session.
  occurred_at          timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- One hint per session per site. A redelivered `checkout.session.completed`
-- updates the row rather than inserting a second one, which is what keeps an
-- unbounded provider retry from becoming unbounded rows.
CREATE UNIQUE INDEX revenue_match_hints_session_key
  ON revenue_match_hints (site_id, provider, checkout_session_id);

-- The projection's lookup: "is there a hint for this charge's PaymentIntent?"
-- Partial, because a hint with no order id can never satisfy this predicate and
-- indexing it would only make the index bigger than the set it answers for.
CREATE INDEX revenue_match_hints_order_idx
  ON revenue_match_hints (site_id, provider, order_id)
  WHERE order_id <> '';

-- The purge's scan. Site-scoped like every other deletion target -- and it IS a
-- target (D8, amended in CP3): 17 Postgres names become 18, and the whole
-- snapshot goes from 51 to 53 together with `revenue_events` on the ClickHouse
-- side.
CREATE INDEX revenue_match_hints_site_idx
  ON revenue_match_hints (site_id, occurred_at DESC);
