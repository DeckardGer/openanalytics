-- Usage batch idempotency ledger.
--
-- Rollout note: additive creation on an empty database, no backfill.
--
-- The worker turns at-least-once queue delivery into an exactly-once usage
-- increment (docs snapshot 05, D-209 step 5; 02 §6/§7.5). A batch has a
-- deterministic batch_id derived from its ordered stream message ids — the same
-- token used as the ClickHouse insert dedup key. usage_batches records that a
-- batch's usage was applied; usage_batch_deltas records the per-user increment,
-- and its UNIQUE (batch_id, billing_user_id, usage_window_id) is what makes a
-- retried batch add usage only once.
--
-- Usage here is a plain traffic counter: how many billable events a batch
-- contributed to a user. `usage_window_id` is an optional grouping dimension —
-- an installation that partitions usage into windows records which window a
-- delta fell into; one that does not leaves it NULL. This ledger deliberately
-- carries no FK on it: the column is a grouping key, not a reference this
-- schema owns.
--
-- batch_id keeps a uuid surrogate primary key per ADR-0006 while the
-- deterministic worker token lives in the UNIQUE batch_id column that deltas
-- reference.

CREATE TABLE usage_batches (
  id         uuid PRIMARY KEY,
  -- Deterministic worker-derived token (ordered stream message ids / hash),
  -- shared with the ClickHouse insert dedup token (docs snapshot 05, D-209).
  batch_id   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_batches_batch_id_key UNIQUE (batch_id)
);

CREATE TABLE usage_batch_deltas (
  id              uuid PRIMARY KEY,
  batch_id        text NOT NULL REFERENCES usage_batches (batch_id) ON DELETE CASCADE,
  billing_user_id uuid NOT NULL REFERENCES users (id),
  usage_window_id uuid,
  -- Billable events this batch contributed to this user.
  delta           integer NOT NULL CHECK (delta >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- The exactly-once guard (docs snapshot 05, D-209 step 5).
  CONSTRAINT usage_batch_deltas_batch_user_window_key
    UNIQUE (batch_id, billing_user_id, usage_window_id)
);

CREATE INDEX usage_batch_deltas_window_idx ON usage_batch_deltas (usage_window_id);
