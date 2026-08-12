-- The attribution job's per-site control state (ADR-0033, D6).
-- Milestone 12 Checkpoint 4.
--
-- Rollout note: additive creation, no backfill. Before the job runs for a site
-- there is simply no row here, and the first run inserts one --
-- `computed_through` defaults to the epoch, so a fresh site's first pass covers
-- every charge it has ever ingested, including a ninety-day backfill that landed
-- before this table existed. 0023-0028 are applied and are therefore never
-- edited (D-214).
--
-- This is `session_finalizer_state` (migration 0012) again, deliberately and
-- almost column for column, because the attribution job is the finalizer idiom
-- applied to a different fact: per-site discovery, a conditional lease, a
-- monotonic watermark, a pure planner, fingerprint-compared versioned writes. A
-- second shape for the same problem would be a second set of lease bugs.
--
-- ============================================================================
-- Why Postgres, when both the inputs and the output are ClickHouse
-- ============================================================================
--
-- The attribution job reads `revenue_events`, `session_facts_versions` and
-- `events_raw` and writes `revenue_attributions` -- four ClickHouse tables and
-- not one Postgres one. Its CONTROL state still belongs here, for migration
-- 0012's reason: a small, mutating, per-site row with a lease is the exact shape
-- ClickHouse is the wrong store for. The version the job writes is still derived
-- from ClickHouse's own `max(version)` in the horizon at write time, never from
-- anything in this table -- so a stale read here can redo idempotent work and
-- can never mint a duplicate version.
--
-- ============================================================================
-- What `computed_through` means, and what it does NOT mean
-- ============================================================================
--
-- It is NOT "every charge before this instant is finished". An attribution is a
-- function of data that arrives after the charge -- a conversion event may be up
-- to 24 hours late (D-016), and the session that is its touchpoint is not
-- finalized until inactivity plus that same lateness has passed. A watermark
-- that meant "done" would be a promise the inputs cannot keep.
--
-- It means: THE INSTANT WHOSE INPUTS THIS SITE HAS BEEN COMPUTED AGAINST. Two
-- things read it:
--
--   1. Discovery. A site is due when a charge head or a checkout hint changed
--      after this instant (a new purchase, immediately), or when this instant is
--      older than the refresh interval (the periodic sweep that catches late
--      conversion events and late-finalized sessions, which live in ClickHouse
--      and cannot be discovered from Postgres at all).
--   2. The horizon's floor. The job re-reads a ROLLING window of charges on
--      every run -- `now - (attribution window + lateness)` -- so that a late
--      signal flips an attribution that had been `none`. On a fresh site this
--      column is the epoch, which is what makes the first run read everything.
--
-- Monotonic, enforced with `GREATEST` in the repository the same way the
-- finalizer's is, so a regressed caller cannot move it backwards.

CREATE TABLE revenue_attribution_state (
  -- The site's own id is the primary key: exactly one control row per site.
  -- The reference is migration 0021's shape (ADR-0030, decision 3): integrity
  -- only, no cascade -- the sites row is never hard-deleted (it becomes a
  -- tombstone), and the deletion job's `postgres_purge` removes this row
  -- explicitly, which is what lets the target row record how many it removed.
  site_id            uuid PRIMARY KEY REFERENCES sites (id),

  -- The watermark. See the note above: "computed against inputs as of", not
  -- "finished". Epoch default so a site's first run covers its whole history.
  computed_through   timestamptz NOT NULL DEFAULT 'epoch',

  -- Monotonic run counter. A durable, race-free proof that the site advanced,
  -- and a diagnostic. Deliberately NOT the source of the ClickHouse version --
  -- that comes from `max(version)` in the horizon at write time, so a lost
  -- update here cannot desynchronise the attributions.
  run_seq            bigint NOT NULL DEFAULT 0 CHECK (run_seq >= 0),

  -- Ownership lease. A run that finds a live lease held by another worker leaves
  -- the site alone. NULL means unclaimed.
  claimed_by         text,
  lease_expires_at   timestamptz,

  last_run_at        timestamptz,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- A held lease names its holder, and a released one names neither: the two
  -- columns cannot disagree, or the reclaim predicate would read a half-released
  -- lease as live forever. Identical to migration 0012's constraint, and it is
  -- identical on purpose.
  CONSTRAINT revenue_attribution_state_lease_check CHECK (
    (claimed_by IS NULL) = (lease_expires_at IS NULL)
  )
);

-- The reclaim scan's companion index: sites whose lease has expired (or which
-- were never claimed) are the ones a run may take. Kept small -- most rows are
-- unclaimed most of the time -- by indexing the lease expiry directly.
CREATE INDEX revenue_attribution_state_lease_idx
  ON revenue_attribution_state (lease_expires_at);

-- Discovery's other half: "which sites have not been recomputed lately?". The
-- periodic refresh is what catches a late conversion event or a
-- late-finalized session, neither of which Postgres can observe, so this
-- predicate has to be cheap on every tick.
CREATE INDEX revenue_attribution_state_computed_idx
  ON revenue_attribution_state (computed_through);
