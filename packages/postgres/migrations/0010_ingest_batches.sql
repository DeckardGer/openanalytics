-- The batch manifest: the durable record that turns at-least-once queue delivery
-- into exactly one raw row and exactly one usage unit.
--
-- Rollout note: additive creation on an empty database, no backfill.
--
-- Docs snapshot 02 §7.5 and 05 D-209 step 3. The manifest is the truth. A worker
-- writes it *before* the ClickHouse insert, so every later decision — retry,
-- reclaim, crash recovery, disaster replay — reads a durable statement of which
-- stream messages belong to which batch, in what order, under which token.
-- Without it a crashed worker's messages would be re-read and re-batched into a
-- different grouping with a different token, and the ClickHouse insert-dedup
-- token would protect nothing (docs snapshot 02 §7.5: crash recovery completes
-- the saved manifest; it never silently splits messages into different batches).
--
-- Three tables, three distinct jobs:
--
--   ingest_batches      the batch and its state machine
--   ingest_batch_items  which messages it holds, in which order  (the D-209 guard)
--   ingest_batch_sites  the D-210 write fence, per site and generation

-- The manifest state machine.
--
-- Deliberately more than "open/closed": each state names a distinct crash
-- recovery, and the plan's acceptance criteria enumerate exactly these points.
--
--   pending         manifest durable, nothing written downstream. Recovery
--                   re-issues the ClickHouse insert with the same token.
--   inserting       the insert was issued and its outcome is unknown — an
--                   ambiguous timeout, the case the stable token exists for.
--                   Recovery retries the SAME manifest and the SAME token,
--                   never a new one.
--   inserted        ClickHouse confirmed. Recovery continues at the usage ledger.
--   usage_recorded  the usage transaction committed. Recovery only has to XACK.
--   completed       XACKed. Terminal, and the state D-216 selects on: a batch
--                   completed before a restore point is never replayed.
--   dead_lettered   retries exhausted. Terminal but not successful — the manifest
--                   and its audit survive, which is what makes manual replay
--                   possible (docs snapshot 02 §7.4).
--
-- There is no state between "usage committed" and "ACKed" other than
-- usage_recorded, because the ACK is the last thing that happens and it is the
-- one step that is safe to repeat.

CREATE TABLE ingest_batches (
  id                uuid PRIMARY KEY,
  -- The deterministic token derived from the stream identity and the ordered
  -- message list (docs snapshot 05, D-209 step 3). Also the ClickHouse
  -- insert_deduplication_token and the usage_batches key, so one value ties the
  -- three stores together and a retry is a no-op in all of them.
  batch_id          text NOT NULL,
  stream_name       text NOT NULL,
  consumer_group    text NOT NULL,

  state             text NOT NULL DEFAULT 'pending' CHECK (
    state IN ('pending', 'inserting', 'inserted', 'usage_recorded', 'completed', 'dead_lettered')
  ),

  message_count     integer NOT NULL CHECK (message_count > 0),
  -- Decoded payload bytes the batch carried. Recorded because the flush rule is
  -- a byte rule (docs snapshot 02 §7.5) and a batcher whose sizing has drifted
  -- is otherwise only visible as latency.
  byte_size         integer NOT NULL CHECK (byte_size >= 0),
  -- Hash over the ordered payload hashes. The message list decides the batch_id
  -- the token is derived from, this proves the *content* is the same content on
  -- a retry, so a payload substituted underneath a reclaim is detectable rather
  -- than silently re-inserted under a token that says it is unchanged.
  payload_hash      text NOT NULL,

  attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- Exponential retry (plan Milestone 6 item 10). NULL means "runnable now".
  next_attempt_at   timestamptz,
  last_error_code   text,

  -- Ownership lease (docs snapshot 02 §7.5: pending claim idle timeout exceeds
  -- normal batch processing, and a long operation renews its lease). A reclaimer
  -- that finds a live lease leaves the batch alone.
  claimed_by        text,
  lease_expires_at  timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  inserted_at       timestamptz,
  -- Terminal timestamps. completed_at is what bounded disaster replay selects on
  -- (docs snapshot 05, D-216): a batch completed before the ClickHouse restore
  -- point is not replayed, and the insert-dedup window is explicitly not the
  -- correctness mechanism at that scale.
  completed_at      timestamptz,
  dead_lettered_at  timestamptz,

  CONSTRAINT ingest_batches_batch_id_key UNIQUE (batch_id),
  -- A terminal state without its timestamp would make the replay selection above
  -- silently wrong, so the two cannot disagree.
  CONSTRAINT ingest_batches_completed_check CHECK (
    (state = 'completed') = (completed_at IS NOT NULL)
  ),
  CONSTRAINT ingest_batches_dead_lettered_check CHECK (
    (state = 'dead_lettered') = (dead_lettered_at IS NOT NULL)
  )
);

-- The reclaimer's query: batches not yet terminal, ordered by when they may run.
CREATE INDEX ingest_batches_runnable_idx ON ingest_batches (state, next_attempt_at)
  WHERE state NOT IN ('completed', 'dead_lettered');

-- The D-216 replay query: completed batches after a restore point.
CREATE INDEX ingest_batches_completed_idx ON ingest_batches (completed_at)
  WHERE state = 'completed';

-- Which queue messages a manifest holds, and in what order.
--
-- (stream_name, message_id) is UNIQUE across the whole table, not per batch.
-- That is the constraint D-209 step 3 names, and it is the one that makes
-- "never silently re-split into new batches" enforceable rather than merely
-- intended: a second manifest claiming a message already in one cannot be
-- inserted, so a reclaimer discovers the existing manifest and continues it.
--
-- site_id and event_id carry no foreign key. The manifest is an audit record of
-- what the queue delivered, and it has to outlive the site deletion D-210
-- performs — a cascade here would erase the evidence of what was written just as
-- the deletion needs to prove it removed it.

CREATE TABLE ingest_batch_items (
  id            uuid PRIMARY KEY,
  batch_id      text NOT NULL REFERENCES ingest_batches (batch_id) ON DELETE CASCADE,
  stream_name   text NOT NULL,
  message_id    text NOT NULL,
  -- Row order inside the batch. Preserved across every retry, because the
  -- insert has to be byte-identical for the ClickHouse token to recognise it
  -- (docs snapshot 02 §7.5: same manifest, same row order, same batch_id).
  position      integer NOT NULL CHECK (position >= 0),

  site_id       uuid NOT NULL,
  event_id      uuid NOT NULL,
  payload_hash  text NOT NULL,
  accepted_at   timestamptz NOT NULL,

  created_at    timestamptz NOT NULL DEFAULT now(),

  -- The D-209 step 3 guard: one queue message belongs to exactly one manifest.
  CONSTRAINT ingest_batch_items_stream_message_key UNIQUE (stream_name, message_id),
  -- Row order is a set of positions with no gaps or repeats.
  CONSTRAINT ingest_batch_items_batch_position_key UNIQUE (batch_id, position)
);

CREATE INDEX ingest_batch_items_batch_idx ON ingest_batch_items (batch_id);
CREATE INDEX ingest_batch_items_site_idx ON ingest_batch_items (site_id);

-- The D-210 write fence.
--
-- Before any ClickHouse write, the worker checks the site's current status and
-- ingest_generation and registers itself here, in the same transaction. Deletion
-- bumps the generation, marks the site `deleting` and then waits for every
-- in-flight registration at the old generation to reach a terminal state.
-- Without this a worker holding a batch across the deletion could write rows
-- after the delete mutation ran, and the deletion would report a success it did
-- not achieve.
--
-- Milestone 6 builds the registration and the drop path. The drain itself is
-- Milestone 10.

CREATE TABLE ingest_batch_sites (
  id                   uuid PRIMARY KEY,
  batch_id             text NOT NULL REFERENCES ingest_batches (batch_id) ON DELETE CASCADE,
  site_id              uuid NOT NULL,
  -- The generation the batch's events were accepted under (their snapshot).
  ingest_generation    integer NOT NULL,
  -- What the site actually carried when the fence was checked. Equal to
  -- ingest_generation on the ordinary path, different on a mismatch drop —
  -- keeping both is what makes the drop auditable after the fact.
  observed_generation  integer,
  observed_status      text,

  state                text NOT NULL DEFAULT 'registered' CHECK (
    state IN ('registered', 'written', 'dropped')
  ),
  -- Set only on a drop. The rows were not written and never will be.
  drop_reason          text CHECK (
    drop_reason IN ('site_deleting', 'site_deleted', 'site_missing', 'generation_mismatch')
  ),
  row_count            integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),

  registered_at        timestamptz NOT NULL DEFAULT now(),
  settled_at           timestamptz,

  CONSTRAINT ingest_batch_sites_batch_site_key UNIQUE (batch_id, site_id),
  -- Not `..._drop_reason_check`: the inline CHECK on the column above already
  -- takes that auto-generated name, and Postgres rejects the duplicate.
  CONSTRAINT ingest_batch_sites_drop_state_check CHECK (
    (state = 'dropped') = (drop_reason IS NOT NULL)
  )
);

-- The M10 drain's query: is any writer still in flight for this site below the
-- new generation?
CREATE INDEX ingest_batch_sites_inflight_idx
  ON ingest_batch_sites (site_id, ingest_generation)
  WHERE state = 'registered';
