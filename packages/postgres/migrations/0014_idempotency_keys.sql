-- Inbound request idempotency ledger (docs snapshot 02 §18).
--
-- Rollout note: additive — one new table, and no change to any existing table,
-- column, constraint or index. It applies to a live database with no backfill,
-- and nothing behaves differently until a route starts writing to it
-- (forward-only; migrations 0001-0013 are never edited — D-214).
--
-- Why it exists: §18 requires create/update/payment endpoints to support an
-- idempotency key, and nothing implemented it on the *inbound* side. The
-- repository already has an outbox with an idempotency key and a batch ledger
-- with a deterministic token, but both of those make an OUTBOUND effect
-- exactly-once. A client that retries `POST /v1/sites` after a timeout it could
-- not interpret had no protection at all: it either created a second site or
-- collided on the slug and could not tell which of the two had happened. This
-- table is the missing half — the durable record of "this caller already asked
-- me this exact question, and here is the answer I gave".
--
-- The grain is (user_id, scope, key), not (key) alone:
--
--   * user_id, because an idempotency key is client-generated and two customers
--     may pick the same string. Scoping it to the caller means one tenant can
--     neither read another's stored response nor block their key.
--   * scope, because the same client may reuse one key generator across
--     endpoints. It names the operation ("sites.create"), so a key that is
--     replayed against a different endpoint is a fresh claim rather than a
--     confusing conflict.
--
-- request_hash is what distinguishes a genuine retry from a key reused with a
-- different payload: equal hash replays the stored response, a different hash is
-- a client bug and answers 409 rather than silently returning someone else's
-- result. Storing the hash rather than the request means no request body — which
-- may carry customer data — is retained here.
--
-- A row is claimed BEFORE the handler runs, so response_status/response_body are
-- null while the request is in flight; a concurrent second request sees the
-- in-flight claim and is refused deterministically instead of racing. A handler
-- that fails deletes its claim, so the caller may correct the payload and retry
-- with the same key.
--
-- Retention: rows accumulate. No sweeper is wired in this pass; the worker's
-- existing retention trimmer is the natural home for one, and the created_at
-- index below is the query it will need.

CREATE TABLE idempotency_keys (
  id              uuid PRIMARY KEY,
  -- The caller. A key is only ever visible to, and blocking for, its own user.
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The operation the key was presented to, e.g. 'sites.create'.
  scope           text NOT NULL,
  -- The client-generated key, verbatim.
  key             text NOT NULL,
  -- SHA-256 over the canonical request (method, path, and the JSON body with
  -- object keys sorted). Never the request itself.
  request_hash    text NOT NULL,
  -- Null while the request is in flight; set together when the handler succeeds.
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,

  CONSTRAINT idempotency_keys_user_scope_key UNIQUE (user_id, scope, key),
  -- A completed claim without its status — or a status without a completion
  -- instant — would make "is this replayable yet?" ambiguous, and the replay
  -- path would either return a null status or refuse a request it had already
  -- answered. The two move together, exactly as ingest_batches ties its terminal
  -- states to their timestamps. response_body is deliberately NOT part of this:
  -- a handler may legitimately answer with no body (204), and a stored SQL NULL
  -- body is a real answer rather than an incomplete row.
  CONSTRAINT idempotency_keys_completion_check CHECK (
    (response_status IS NULL) = (completed_at IS NULL)
  )
);

-- The sweeper's query: everything older than the retention horizon.
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);
