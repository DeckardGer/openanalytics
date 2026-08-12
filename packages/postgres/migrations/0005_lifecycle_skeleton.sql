-- Lifecycle skeleton: jobs, deletion_requests, deletion_targets.
--
-- Rollout note: additive creation on an empty database, no backfill.
--
-- These tables are created as skeletons so their shape and the invariants that
-- reference them exist early; the machinery that drives them lands later — the
-- job runner redesigns `jobs` in migration 0020, and deletion_requests /
-- deletion_targets get their state machine with fenced deletion (docs snapshot
-- 05 D-210, migration 0021). The status vocabularies match the job contract
-- (docs snapshot 03 §13) so those later migrations widen behaviour, not shape.

CREATE TABLE jobs (
  id           uuid PRIMARY KEY,
  type         text NOT NULL,
  status       text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'running', 'succeeded',
                                   'failed_retryable', 'failed_terminal', 'cancelled')),
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  phase        text,
  attempts     integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz
);

CREATE INDEX jobs_due_idx ON jobs (status, available_at);

CREATE TABLE deletion_requests (
  id                    uuid PRIMARY KEY,
  subject_type          text NOT NULL CHECK (subject_type IN ('site', 'account')),
  subject_id            uuid NOT NULL,
  status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  requested_by_user_id  uuid,
  requested_at          timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz
);

CREATE INDEX deletion_requests_status_idx ON deletion_requests (status);

CREATE TABLE deletion_targets (
  id                  uuid PRIMARY KEY,
  deletion_request_id uuid NOT NULL REFERENCES deletion_requests (id) ON DELETE CASCADE,
  store               text NOT NULL,
  target              text NOT NULL,
  phase               text NOT NULL DEFAULT 'pending',
  attempts            integer NOT NULL DEFAULT 0,
  verified            boolean NOT NULL DEFAULT false,
  verification        jsonb,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX deletion_targets_request_idx ON deletion_targets (deletion_request_id);
