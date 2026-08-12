-- A site dimension for the usage ledger (M10.5, part A).
--
-- Rollout note: expand-only -- one nullable column and a unique-constraint swap
-- on a table whose row count is one per (batch, user, window), not per event.
-- No backfill, deliberately: the ledger never recorded which site a delta's
-- events came from, and the split cannot be reconstructed -- the analytics rows
-- in ClickHouse are bucketed by a different clock (`occurred_at` vs the
-- `accepted_at` that decides billing, D-015), so any recomputed split would be
-- an estimate wearing a ledger's clothes. Rows from before this migration keep
-- site_id NULL and read as "the pre-split historical aggregate"; the read API
-- reports their remainder as `unattributed` rather than pretending precision.
--
-- Why the column: the dashboard wants a per-site usage bar, and the ledger's
-- (batch, user, window) grain -- chosen in 0007 when nothing needed the split --
-- cannot answer it. The worker already knows each event's site; from this
-- migration on it writes one delta per (batch, user, window, site) instead of
-- collapsing sites together. The counter semantics do not change: the window
-- total is still the sum of the window's deltas, whatever their grain.
--
-- The unique swap keeps the exactly-once guard (D-209 step 5) across the grain
-- change. NULLS NOT DISTINCT matters during the deploy window: a worker built
-- before this migration still inserts site_id NULL, and under the default
-- distinct-NULLs rule two such rows for the same (batch, user, window) would
-- both land -- a retried batch would double-count precisely while the fleet is
-- mid-upgrade. With NULLS NOT DISTINCT the old writer keeps the old guarantee
-- and the new writer gets the per-site one.
--
-- The FK is safe against site deletion: a deleted site's row becomes a
-- tombstone (ADR-0030), it is never hard-deleted, so billing history keeps a
-- valid referent. No ON DELETE action is the correct action.

ALTER TABLE usage_batch_deltas
  ADD COLUMN site_id uuid REFERENCES sites (id);

ALTER TABLE usage_batch_deltas
  DROP CONSTRAINT usage_batch_deltas_batch_user_window_key;

ALTER TABLE usage_batch_deltas
  ADD CONSTRAINT usage_batch_deltas_batch_user_window_site_key
  UNIQUE NULLS NOT DISTINCT (batch_id, billing_user_id, usage_window_id, site_id);

-- No new index. The read path aggregates a single window's deltas and the
-- existing usage_batch_deltas_window_idx already serves that; a site-keyed
-- index would be maintained on every ingest batch to serve no current query.
