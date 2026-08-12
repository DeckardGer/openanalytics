-- The job runner's table: `jobs` is redesigned, not extended (ADR-0030, D3).
--
-- Rollout note: DROP TABLE followed by CREATE TABLE, and this is the one place
-- in the ledger where that is written down as safe rather than assumed. Read the
-- next paragraph before concluding it violates the forward-only rule.
--
-- Why dropping is safe. Forward-only (D-214) is a statement about *applied
-- state*: a migration file that has been applied is never edited, and a later
-- migration never assumes it can undo an earlier one. It is not a rule that a
-- table can never be replaced. The 0005 `jobs` table was created as an early
-- skeleton for a runner that had not been designed yet; since then:
--
--   * no repository function anywhere in `packages/postgres/src/repositories`
--     references it -- there is no writer;
--   * nothing selects from it -- there is no reader, in any app or script;
--   * it is consequently empty in every environment (local, CI and production),
--     because the only way a row could exist is a hand-written INSERT.
--
-- Dropping an empty table with no code path attached destroys nothing. The
-- alternative -- ALTER TABLE to add eight columns, one CHECK and two indexes to
-- a shape that was a guess -- would leave the skeleton's `payload`/`phase`
-- ordering and its index name embedded in the real design forever, for the sake
-- of preserving zero rows.
--
-- What the redesign adds over the skeleton, and why each is load-bearing:
--
--   subject_id       The job's target. The partial unique below is what makes
--                    "one live deletion per site" a database fact rather than an
--                    application convention, and it needs a column to key on.
--   idempotency_key  The producer's handle. `site_deletion:{siteId}` means a
--                    second enqueue -- a retried API call, a second sweeper --
--                    finds the first job instead of minting a twin.
--   claimed_by /     The lease. Without it a worker that dies mid-job holds the
--   lease_expires_at row forever; with it another worker steals the lease once it
--                    expires, and every state-changing statement is guarded by
--                    `claimed_by` so the dispossessed worker cannot clobber the
--                    new holder (the `session_finalizer_state` idiom, 0012).
--   updated_at       Ordinary bookkeeping, and the column an operator reads to
--                    see whether a `running` job is progressing at all.
--
-- Deletion is the first consumer (CP3), but nothing here is deletion-specific:
-- `type` is free text dispatched through a registry in the worker, so a second
-- job kind costs an executor rather than a migration.

-- The emptiness argued for above, checked rather than assumed: if any row exists,
-- this is not the dead 0005 skeleton and the drop must not proceed silently.
DO $$ BEGIN IF EXISTS (SELECT 1 FROM jobs) THEN RAISE EXCEPTION 'jobs table is not empty - migration 0020 expects the dead 0005 skeleton'; END IF; END $$;

DROP TABLE jobs;

CREATE TABLE jobs (
  id               uuid PRIMARY KEY,
  type             text NOT NULL,
  -- Nullable: a job that acts on the whole system rather than one row has no
  -- subject. Only a job WITH a subject participates in the liveness unique.
  subject_id       uuid,
  status           text NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'running', 'succeeded',
                                       'failed_retryable', 'failed_terminal', 'cancelled')),
  -- The executor's own progress marker (`fence_drain`, `redis_purge`, …). The
  -- vocabulary belongs to the job type, so there is no CHECK here: a table-level
  -- enum would have to be widened by a migration every time a phase is added.
  phase            text,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key  text NOT NULL UNIQUE,
  attempts         integer NOT NULL DEFAULT 0,
  available_at     timestamptz NOT NULL DEFAULT now(),
  claimed_by       text,
  lease_expires_at timestamptz,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,

  -- A lease is all-or-nothing: a held lease names its holder and an expiry, and
  -- a released one names neither. The half-state is what a crash between two
  -- UPDATEs would otherwise leave behind, and it reads as "claimed by nobody,
  -- forever" or "expires never", both of which strand the job. Mirrors
  -- `session_finalizer_state_lease_check` (0012) deliberately -- one lease idiom,
  -- one shape.
  CONSTRAINT jobs_lease_check CHECK ((claimed_by IS NULL) = (lease_expires_at IS NULL))
);

-- One non-terminal job per (type, subject). This is the structural half of
-- idempotency and it catches what the key cannot: two producers that legitimately
-- mint different keys for the same subject (an operator-triggered deletion and
-- the retention sweeper's, say) still cannot produce two live jobs racing each
-- other through the same purge phases.
--
-- The predicate lists exactly the statuses from which a job can still run.
-- `succeeded`/`failed_terminal`/`cancelled` are excluded so a *later* job for the
-- same subject is allowed once the first has finished -- history does not block
-- the future. `failed_retryable` is INCLUDED: such a job is waiting on a backoff,
-- not finished, and a second one enqueued beside it would double-execute.
--
-- NULL `subject_id` rows are outside the index (Postgres treats NULLs in a
-- multi-column unique as distinct), which is the wanted behaviour: a subjectless
-- job is deduplicated by its idempotency key alone.
CREATE UNIQUE INDEX jobs_live_subject_key ON jobs (type, subject_id)
  WHERE status IN ('queued', 'running', 'failed_retryable');

-- The claim query's index: it scans by status and orders by `available_at`.
-- Same shape and name as the skeleton's, because the claim's access pattern is
-- the one thing the 0005 guess got right.
CREATE INDEX jobs_due_idx ON jobs (status, available_at);
