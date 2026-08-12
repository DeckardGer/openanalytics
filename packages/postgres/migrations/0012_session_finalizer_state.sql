-- The session finalizer's per-site bookkeeping (docs snapshot 02 §10, §15, 04
-- Milestone 8 items 2-4, docs snapshot 05, D-211). Milestone 8 Checkpoint B.
--
-- Rollout note: additive creation, no backfill. The finalizer is a new worker
-- job; before it runs for a site there is simply no row here, and the first run
-- inserts one (finalized_through defaults to the epoch, so the first window
-- covers everything the site has ever sent).
--
-- Why Postgres and not ClickHouse. The versioned facts and the rollups live in
-- ClickHouse (migrations 0013, 0014), but the finalizer's *control state* is a
-- small, mutating, per-site row with a lease -- exactly the shape ClickHouse is
-- the wrong store for and the Postgres control plane is the right one, the same
-- reasoning the batch manifest followed (migration 0010). The versions and
-- generations the finalizer writes are still derived from ClickHouse's own
-- max(version)/max(generation) at write time, never from anything in this table
-- -- this row records how far the site has been finalized, not what version to
-- write next, so a stale read here can never mint a duplicate version.
--
-- finalized_through is the watermark and it means one precise thing: every
-- canonical session whose session_start is strictly before it is FINAL and will
-- never be recomputed again. It is therefore BOTH the lower bound of the next
-- recompute window AND the value Checkpoint C returns as the API's
-- finalized_through metadata. A session is final once
-- now >= session_end + inactivity (30 min) + lateness (24 h): past that horizon
-- no new event for the session can legitimately arrive (the collector rejects an
-- occurred_at older than the 24 h lateness allowance), so the session can never
-- change. Each run advances the watermark to
-- min(finalize_horizon, earliest still-provisional session_start), then pulls it
-- back so that no recomputed session's event span straddles it. That pull-back is
-- the real invariant the window read needs: the next run reads events and stored
-- facts by session_start/occurred_at >= watermark, so a session overlapping the
-- watermark in wall-clock time (e.g. an already-finalized session of a different
-- visitor whose tail sits above the earliest provisional session's start) would
-- otherwise be bisected -- its tail re-sessionized under a new id, the stored
-- original invisible to the diff -- and permanently double-counted. The
-- pull-back re-reads such a session next run, where it recomputes byte-identical
-- and writes nothing. The result stays monotonic because every recomputed
-- session started at or after the window it was read from.
--
-- The lease is the batch-manifest idiom (migration 0010): a run claims a site
-- with a conditional update, renews nothing (finalize is short), and releases on
-- completion. A crashed run leaves a lease that simply expires, and the next run
-- reclaims the site -- the whole recompute is a pure function of the events, so
-- re-running a half-finished site is safe rather than merely tolerated.

CREATE TABLE session_finalizer_state (
  site_id            uuid PRIMARY KEY,

  -- The watermark. Sessions with session_start < this are finalized and are
  -- never re-read. Also the API's finalized_through (Checkpoint C). Defaults to
  -- the epoch so a site's first run recomputes its whole history.
  finalized_through  timestamptz NOT NULL DEFAULT 'epoch',

  -- Monotonic run counter. A durable, race-free proof that the site advanced,
  -- and a diagnostic. Deliberately NOT the source of the ClickHouse version or
  -- generation -- those come from max(version)/max(generation) in the affected
  -- window at write time, so a lost update here cannot desynchronise the facts.
  run_seq            bigint NOT NULL DEFAULT 0 CHECK (run_seq >= 0),

  -- Ownership lease. A run that finds a live lease held by another worker leaves
  -- the site alone (the conditional claim below). NULL means unclaimed.
  claimed_by         text,
  lease_expires_at   timestamptz,

  last_run_at        timestamptz,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- A held lease names its holder, and a released one names neither: the two
  -- columns cannot disagree, or the reclaim predicate would read a half-released
  -- lease as live forever.
  CONSTRAINT session_finalizer_state_lease_check CHECK (
    (claimed_by IS NULL) = (lease_expires_at IS NULL)
  )
);

-- The discovery query's companion index: sites whose lease has expired (or which
-- were never claimed) are the ones a run may take. Kept small -- most rows are
-- unclaimed most of the time -- by indexing the lease expiry directly.
CREATE INDEX session_finalizer_state_lease_idx
  ON session_finalizer_state (lease_expires_at)
