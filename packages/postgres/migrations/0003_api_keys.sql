-- API keys: the public tracking write key and the private read key, kept apart.
--
-- Rollout note: additive creation on an empty database, no backfill.
--
-- The two kinds are different security objects (docs snapshot 02 §20, plan
-- Milestone 2 item 8):
--   tracking_write — public. It ships in the browser tracker and must be
--     re-displayable in the install snippet, so its raw value is retained in
--     public_token. It is an ingest identifier only, never read authorization.
--   private_read  — secret. Only its SHA-256 hash is stored; the raw token is
--     shown once at creation and never persisted. The CHECK below makes that a
--     schema guarantee: a private key can never carry a raw public_token.
-- No read endpoint accepting a tracking_write key is an authorization rule
-- enforced in code; the `type` column is what lets that check exist.

CREATE TABLE api_keys (
  id                 uuid PRIMARY KEY,
  site_id            uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  type               text NOT NULL CHECK (type IN ('tracking_write', 'private_read')),
  name               text,
  -- Non-secret display prefix (e.g. oa_pk_… / oa_sk_…) so a key is recognizable
  -- in the UI without revealing it; the distinct prefixes make the write/read
  -- split visible.
  key_prefix         text NOT NULL,
  key_hash           text NOT NULL,
  public_token       text,
  scopes             text[],
  created_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz,
  revoked_at         timestamptz,
  expires_at         timestamptz,
  CONSTRAINT api_keys_private_no_raw_check CHECK (
    type = 'tracking_write' OR public_token IS NULL
  )
);

CREATE UNIQUE INDEX api_keys_key_hash_key ON api_keys (key_hash);
CREATE INDEX api_keys_site_type_idx ON api_keys (site_id, type);
CREATE INDEX api_keys_active_idx ON api_keys (site_id) WHERE revoked_at IS NULL;
