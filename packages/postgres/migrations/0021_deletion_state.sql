-- The deletion state machine's shape (ADR-0030, decisions 3, 4 and 7).
--
-- Rollout note: additive plus one CREATE OR REPLACE of an existing function.
-- `deletion_targets` and `deletion_requests` are the 0005 skeleton and are empty
-- in every environment -- nothing has ever written them, because the writer
-- (`startSiteDeletion`) arrives in this same checkpoint -- so the constraints
-- below are added to rows that do not exist and cannot fail on a live database.
-- `session_finalizer_state` is written, but it holds one row per site that has
-- ever been finalized: the validating scan its foreign key needs is measured in
-- rows, not gigabytes. Forward-only: 0001-0020 are never edited (D-214).
--
-- Three separate things, all of which the deletion job needs to be true before it
-- may run at all.

-- ---------------------------------------------------------------------------
-- 1. `deletion_targets` becomes a state machine row rather than a note.
-- ---------------------------------------------------------------------------
--
-- The 0005 skeleton gave the table a `phase text NOT NULL DEFAULT 'pending'`
-- with no vocabulary and no uniqueness. Both gaps are load-bearing for a
-- *resumable* purge:
--
--   * The CHECK pins the vocabulary to `pending|running|completed`. The worker
--     decides what to skip on resume by reading this column, so a typo'd phase
--     would read as "not completed" and silently re-run a purge phase forever --
--     or, worse, as an unrecognised value the executor's switch falls through.
--     There is deliberately no `failed` phase: a target that failed is `running`
--     with `last_error` set, because failure here is always transient by
--     construction (a ClickHouse mutation that could not start, a Redis instance
--     that was unreachable) and the job retries it. A permanently impossible
--     target is a decision a human makes, not a status the machine writes.
--
--   * The unique `(deletion_request_id, store, target)` makes the snapshot a
--     *set*. The start transaction writes twenty ClickHouse rows, five Redis
--     rows and ten Postgres rows in one statement; a retried or double-executed
--     start would otherwise double the snapshot, and the verify phase's "every
--     target completed" check would then pass on a half-purged site whose
--     duplicate rows happened to be marked done.
--
-- `mutation_id` and `last_error` are the ClickHouse polling bookkeeping. A
-- `ALTER TABLE ... DELETE` is asynchronous: submitting it returns immediately and
-- the work is done by a background mutation whose progress lives in
-- `system.mutations`. Storing the mutation id is what makes the phase resumable
-- across a worker restart -- without it, a resumed job cannot tell "the mutation
-- I submitted is still running" from "no mutation was ever submitted", and
-- re-submitting is not free (a second mutation over the same part set).
-- `last_error` carries `latest_fail_reason` so an operator reading the table sees
-- why a target is stuck without correlating logs.
--
-- Both are nullable and store-agnostic: the Redis and Postgres targets have no
-- mutation, and a NULL there is a statement ("this store does not work that
-- way"), not a gap.

ALTER TABLE deletion_targets
  ADD CONSTRAINT deletion_targets_phase_check
  CHECK (phase IN ('pending', 'running', 'completed'));

ALTER TABLE deletion_targets
  ADD CONSTRAINT deletion_targets_request_store_target_key
  UNIQUE (deletion_request_id, store, target);

ALTER TABLE deletion_targets
  ADD COLUMN mutation_id text,
  ADD COLUMN last_error  text;

-- ---------------------------------------------------------------------------
-- 2. `session_finalizer_state` gets its foreign key.
-- ---------------------------------------------------------------------------
--
-- 0012 created the table with `site_id uuid PRIMARY KEY` and no reference,
-- because at the time nothing deleted a site and the finalizer only ever wrote
-- rows for sites it had just read events for. M10 makes the table a deletion
-- target (decision 7) and gives the deletion job a phase that claims its lease
-- (decision 4, `finalizer_fence`), so the row's relationship to the site row is
-- now something two subsystems reason about. An orphan row here would be a lease
-- nobody can interpret and a watermark for a site that does not exist.
--
-- **No cascade, deliberately.** The sites row is never hard-deleted (decision 8:
-- deletion produces a tombstone, and ADR-0027's rule that a deleted site id never
-- returns depends on the row surviving). So ON DELETE has nothing to do here; the
-- constraint is an integrity statement, and the `postgres_purge` phase deletes
-- this row explicitly as one of its ten targets. RESTRICT (the default) is also
-- the honest choice: if a future path ever did try to hard-delete a site row, the
-- right outcome is a loud refusal, not a silent removal of finalizer state.
--
-- A plain ADD CONSTRAINT, deliberately, and not the NOT VALID + VALIDATE idiom.
-- That idiom buys exactly nothing here: this runner executes each migration file
-- inside ONE transaction (see `migrate.ts` -- BEGIN, the file, the ledger insert,
-- COMMIT), and both statements would therefore run under the same ACCESS
-- EXCLUSIVE lock and release it at the same commit. The lock-free validating scan
-- the idiom is famous for only exists when the VALIDATE runs in a *separate*
-- transaction, which for this runner means a separate migration file. The table
-- holds one row per site that has ever been finalized, so the scan is trivial and
-- one statement is the honest choice. A large table would need the split: one
-- migration adds it NOT VALID, the next validates it.

ALTER TABLE session_finalizer_state
  ADD CONSTRAINT session_finalizer_state_site_id_fkey
  FOREIGN KEY (site_id) REFERENCES sites(id);

-- ---------------------------------------------------------------------------
-- 3. `assert_site_ownership` exempts a site that is being deleted.
-- ---------------------------------------------------------------------------
--
-- The 0006 invariants say a site has at least one owner (OA001) and that its
-- owner is an accepted owner member (OA002). Both are correct for every site a
-- customer can act on, and both are unsatisfiable for a site being torn down:
-- `postgres_purge` deletes every `site_members` row, and `verify_finalize` then
-- UPDATEs the sites row to the tombstone -- which fires the sites trigger on a
-- row that now has zero members. Without this exemption the deletion job could
-- not commit either statement, and the invariant designed to protect live sites
-- would make deletion structurally impossible.
--
-- The exemption is keyed on `sites.status IN ('deleting','deleted')` rather than
-- on a session flag or a GUC, because status is the durable fact the rest of the
-- system already fences on: the collector drops for it (D-210), the read surface
-- 404s for it (decision 9), and the finalizer skips for it (decision 7). Reusing
-- it means there is exactly one answer to "is this site alive", and no way to
-- suppress the invariant on a site that is.
--
-- What is deliberately unchanged: the site-missing early return, both raises,
-- their SQLSTATEs (OA001/OA002 -- the repository maps them to typed errors), the
-- `RETURN NULL` (an AFTER trigger's return value is ignored), and the fact that
-- the same function backs both constraint triggers. The status read is folded
-- into the existing SELECT rather than added as a second query: the row is
-- already being fetched for `owner_user_id`, and a second SELECT would double
-- the per-statement cost of every membership write on every live site to serve
-- a state almost no site is ever in.
--
-- CREATE OR REPLACE keeps both 0006 triggers pointing at the new body without
-- dropping and recreating them, so there is no window in which a concurrent
-- membership write is unguarded.

CREATE OR REPLACE FUNCTION assert_site_ownership() RETURNS trigger AS $$
DECLARE
  target_site uuid;
  site_owner  uuid;
  site_status text;
  owner_count integer;
BEGIN
  IF TG_TABLE_NAME = 'sites' THEN
    target_site := COALESCE(NEW.id, OLD.id);
  ELSE
    target_site := COALESCE(NEW.site_id, OLD.site_id);
  END IF;

  -- The site may be gone (e.g. a cascade delete of its members). Nothing to
  -- check then; the deletion itself is the intended end state.
  SELECT s.owner_user_id, s.status INTO site_owner, site_status
    FROM sites s WHERE s.id = target_site;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- ADR-0030, decision 7: a site under teardown is exempt. Its membership is
  -- being removed on purpose and its tombstone UPDATE fires this trigger on a
  -- row with zero members; enforcing "at least one owner" there would forbid the
  -- deletion the customer asked for. Every other status is enforced exactly as
  -- 0006 wrote it.
  IF site_status IN ('deleting', 'deleted') THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO owner_count
  FROM site_members m
  WHERE m.site_id = target_site AND m.role = 'owner';

  IF owner_count < 1 THEN
    RAISE EXCEPTION 'site % must have at least one owner', target_site
      USING ERRCODE = 'OA001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM site_members m
    WHERE m.site_id = target_site
      AND m.user_id = site_owner
      AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'owner % of site % must be an accepted owner member',
      site_owner, target_site
      USING ERRCODE = 'OA002';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
