-- The authorization server gets its four tables.
--
-- ADR-0043, decision 9. Better Auth 1.6.23 carries `oidc-provider` (clients,
-- consent, PKCE, the authorization-code and refresh grants) and
-- `device-authorization` (RFC 8628's user-facing half), and we mount them rather
-- than writing an authorization server beside the session handling we already
-- built on the same library. Between them they declare four models:
-- `oauthApplication`, `oauthAccessToken`, `oauthConsent` and `deviceCode`.
--
-- Three things this migration does NOT do, each on purpose.
--
-- **No `ON DELETE CASCADE` on any `user_id`.** The declared Better Auth schema
-- puts one on all four. In this database it would be a clause that can never
-- fire: account deletion *scrubs* the `users` row rather than deleting it
-- (ADR-0030 D8 — the tombstone keeps every surviving foreign-key referent
-- valid), so nothing ever cascades from a user. That exact shape is why
-- `idempotency_keys` outlived account deletion until 2026-08-06: a declared
-- cascade that cannot run reads as coverage. These tables are user-scoped —
-- access tokens, consents and device codes are all *a person's* — so account
-- deletion's Postgres teardown names all three explicitly and the snapshot's
-- target count grows with them. The foreign key stays, without an action,
-- because the relationship is real and worth stating; what is removed is the
-- false promise about what happens on delete.
--
-- **No foreign key from `oauth_access_tokens.client_id` (or
-- `oauth_consents.client_id`) to `oauth_applications.client_id`.** Better Auth's
-- declared schema has one, and it would reject every token this system can
-- issue: our CLI and MCP clients are `trustedClients` in configuration, which
-- `getClient` consults *before* the table, so no row exists for them to
-- reference. Configuration rather than seeded rows because a client id seeded by
-- migration is a row an operator can edit out from under the code, and changing
-- a redirect URL would become a migration.
--
-- **No hashing of `access_token` / `refresh_token`.** Better Auth looks both up
-- by plain equality (`/oauth2/userinfo`, the `refresh_token` grant), so hashing
-- them would break the library's own endpoints. ADR-0043 D9 assumed hashes and
-- was wrong about the library; the correction is recorded there, and
-- `sessions.token` has stored a bearer secret in the clear since migration 0001,
-- so this joins an existing class rather than opening a new one. The columns are
-- redacted in logs by `@openanalytics/observability`, like every other secret.
--
-- Expand-only: four new tables, no existing table touched.

CREATE TABLE oauth_applications (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  icon text,
  metadata text,
  client_id text NOT NULL,
  -- NULL for a public client. Both of ours are public and use PKCE: a secret
  -- shipped inside a CLI on a customer's laptop is not a secret.
  client_secret text,
  -- Comma-separated, which is how Better Auth writes and splits it.
  redirect_urls text NOT NULL,
  type text NOT NULL,
  disabled boolean NOT NULL DEFAULT false,
  user_id uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX oauth_applications_client_id_key ON oauth_applications (client_id);
CREATE INDEX oauth_applications_user_id_idx ON oauth_applications (user_id);

CREATE TABLE oauth_access_tokens (
  id uuid PRIMARY KEY,
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  access_token_expires_at timestamptz NOT NULL,
  refresh_token_expires_at timestamptz NOT NULL,
  client_id text NOT NULL,
  user_id uuid REFERENCES users (id),
  -- Space-delimited (RFC 6749). `readScopesFromGrant` is the single reading of
  -- this string, and it drops anything this build cannot name — including the
  -- OIDC scopes, which authorize the identity claim and not the analytics.
  scopes text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX oauth_access_tokens_access_token_key ON oauth_access_tokens (access_token);
CREATE UNIQUE INDEX oauth_access_tokens_refresh_token_key ON oauth_access_tokens (refresh_token);
CREATE INDEX oauth_access_tokens_user_id_idx ON oauth_access_tokens (user_id);
CREATE INDEX oauth_access_tokens_client_id_idx ON oauth_access_tokens (client_id);

CREATE TABLE oauth_consents (
  id uuid PRIMARY KEY,
  client_id text NOT NULL,
  user_id uuid REFERENCES users (id),
  scopes text NOT NULL,
  consent_given boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX oauth_consents_client_id_idx ON oauth_consents (client_id);
CREATE INDEX oauth_consents_user_id_idx ON oauth_consents (user_id);

CREATE TABLE device_codes (
  id uuid PRIMARY KEY,
  device_code text NOT NULL,
  user_code text NOT NULL,
  -- NULL until somebody approves it: the row exists before anyone owns it, which
  -- is the whole shape of RFC 8628.
  user_id uuid REFERENCES users (id),
  expires_at timestamptz NOT NULL,
  status text NOT NULL,
  last_polled_at timestamptz,
  -- Milliseconds, as Better Auth writes it.
  polling_interval integer,
  client_id text,
  scope text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The three states Better Auth writes, stated in the database so a fourth one
-- arriving from a library upgrade is a failed insert rather than a row our
-- token exchange reads as neither approved nor denied.
ALTER TABLE device_codes
  ADD CONSTRAINT device_codes_status_check
  CHECK (status IN ('pending', 'approved', 'denied'));

CREATE UNIQUE INDEX device_codes_device_code_key ON device_codes (device_code);

-- Unique, and this one is load-bearing rather than hygienic. Better Auth
-- generates the user code from an 8-character ambiguity-free alphabet with no
-- collision check, and `/device` looks a device up by it — two live rows sharing
-- a code would let one person approve another person's device. The constraint
-- turns an astronomically unlikely collision into a failed `POST /device/code`
-- that the CLI retries, which is the direction to fail in.
CREATE UNIQUE INDEX device_codes_user_code_key ON device_codes (user_code);

CREATE INDEX device_codes_user_id_idx ON device_codes (user_id);
CREATE INDEX device_codes_expires_at_idx ON device_codes (expires_at);
