-- Audit log and the transactional outbox.
--
-- Rollout note: additive creation on an empty database, no backfill.
--
-- audit_logs is an append-only ledger of permission, ownership, key and
-- credential changes (docs snapshot 02 §6, plan Milestone 2 item 10). It holds
-- actor and site as bare uuids with no foreign keys on purpose: an audit record
-- must outlive the row it describes, including through the account/site deletion
-- of Milestone 10. metadata is safe, categorized detail only — never a token,
-- raw email or credential (redaction is centralized in observability).
--
-- outbox is the single seam for transactional side effects (docs snapshot 02
-- §6, plan Milestone 2 item 2): a row is written in the same transaction as the
-- state change that causes it, and a worker delivers it idempotently. The
-- Milestone 2 user here is verification/invite email through the Resend adapter
-- (G-007); every send goes through this table.

CREATE TABLE audit_logs (
  id           uuid PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  actor_type   text NOT NULL DEFAULT 'user'
                 CHECK (actor_type IN ('user', 'system', 'service')),
  site_id      uuid,
  action       text NOT NULL,
  target_type  text,
  target_id    text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id   text
);

CREATE INDEX audit_logs_site_time_idx ON audit_logs (site_id, occurred_at);
CREATE INDEX audit_logs_actor_time_idx ON audit_logs (actor_user_id, occurred_at);
CREATE INDEX audit_logs_action_idx ON audit_logs (action);

CREATE TABLE outbox (
  id              uuid PRIMARY KEY,
  topic           text NOT NULL,
  payload         jsonb NOT NULL,
  -- Makes a side effect exactly-once end to end: a retried producer writes the
  -- same key, and a retried consumer recognizes it.
  idempotency_key text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'dead')),
  attempts        integer NOT NULL DEFAULT 0,
  available_at    timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz
);

CREATE UNIQUE INDEX outbox_idempotency_key ON outbox (idempotency_key);
CREATE INDEX outbox_due_idx ON outbox (status, available_at);
