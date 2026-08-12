-- Deployment settings an operator can type into the dashboard.
--
-- The self-host dry run (2026-08-09) found the same wall four times: a fresh
-- install has no mail transport and no model provider, both are configured only
-- through `worker.env` and `api.env`, and every one of those files is read once
-- at boot. So the first thing a new operator wants to do -- invite a colleague,
-- ask the assistant a question -- requires editing a file on the host and
-- restarting a container, and nothing in the product says so. This table is the
-- other door: **anything the operator supplies from a third party should be
-- enterable from the dashboard, not only from an env file.**
--
-- Env is not being replaced. It stays the way a fleet is configured, it is what
-- our own hosted deployment uses, and a stored row is read only when
-- `DEPLOYMENT_SETTINGS=enabled`. What changes is that it is no longer the only
-- way.
--
-- **One row per scope, and `scope` is the primary key.** There is no id column
-- because there is no second row to tell apart: 'email' is the deployment's mail
-- transport, singular, and a table that permitted two would need a rule for
-- which one wins. The natural key is also what makes the AAD below bind row
-- identity exactly (see `encrypted_secret`).
--
-- **The secret is encrypted with the same primitive as a customer's Stripe key**
-- (ADR-0033 D3, `packages/integrations/src/credential-vault.ts`): AES-256-GCM
-- under `OA_CREDENTIAL_KEYRING`, versioned so a rotation is additive, and
-- AAD-bound so a ciphertext copied onto another row stops decrypting. The AAD is
-- `deployment_setting:{scope}`. This is the second caller of that vault and the
-- first outside revenue, which is why it was built with a caller-supplied AAD
-- rather than a revenue-shaped one.
--
-- **`settings` holds only what is not a secret**: an SMTP host, port, TLS mode,
-- username and From address; the assistant's model and base URL. The password
-- and the API key never appear there, and the read surface returns `settings`
-- verbatim plus `secret_last4` -- never the secret, on the `revenue_credentials`
-- precedent.
--
-- Not a site-scoped table and not an account-scoped one: these settings belong
-- to the *deployment*, so neither the site-deletion nor the account-deletion
-- vocabulary gains a target. `updated_by_user_id` carries no ON DELETE action
-- for migration 0041's reason -- a `users` row is scrubbed rather than deleted,
-- so a declared cascade could never fire, and a cascade that cannot run reads as
-- coverage it does not provide.

CREATE TABLE deployment_settings (
  -- The setting this row configures. A CHECK rather than an enum type, matching
  -- every other status column in this schema: adding a scope is then an
  -- ordinary migration instead of an ALTER TYPE that cannot run in a
  -- transaction on older Postgres.
  scope text PRIMARY KEY
    CHECK (scope IN ('email', 'assistant')),
  -- The non-secret half, verbatim as the dashboard sent it. jsonb because the
  -- two scopes have genuinely different fields and a column per field would
  -- make every new scope a migration.
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- AES-256-GCM, AAD-bound to 'deployment_setting:{scope}'. Nullable because an
  -- SMTP relay on the same host frequently wants no credential at all, and
  -- because "configured, no secret" is a real state rather than an incomplete
  -- one.
  encrypted_secret text,
  -- Which keyring version wrote the ciphertext. Plaintext, so a rotation sweep
  -- finds every row still on an old key with a SELECT.
  key_version text,
  -- Display only, and the only part of the secret any read surface returns.
  -- Empty when there is no secret, and empty for a secret too short for a tail
  -- to be a tail rather than most of it (`credentialLast4`).
  secret_last4 text NOT NULL DEFAULT '',
  -- Who last wrote it. No ON DELETE action; see the header.
  updated_by_user_id uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The two ciphertext columns are written together or not at all. Without this
  -- a row could carry a ciphertext no build knows the version of, and the
  -- failure would surface at decrypt time as 'malformed' -- which is the reason
  -- for a value that was stored perfectly well.
  CONSTRAINT deployment_settings_key_version_check
    CHECK ((encrypted_secret IS NULL) = (key_version IS NULL)),
  -- A last4 without a secret is a display value describing nothing.
  CONSTRAINT deployment_settings_last4_check
    CHECK (encrypted_secret IS NOT NULL OR secret_last4 = '')
);

-- No index beyond the primary key, deliberately. The table holds one row per
-- scope -- two, today -- and every read is a point lookup on `scope`. The one
-- scan a rotation sweep would want is over a table small enough that an index
-- on `key_version` would never be chosen.
