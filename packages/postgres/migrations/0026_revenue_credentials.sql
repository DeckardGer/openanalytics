-- Revenue provider credentials and the site's reporting currency
-- (ADR-0033, D2c/D3/D8). Milestone 12 CP1.
--
-- Rollout note: expand-only. One new table, and one NOT NULL column with a
-- constant DEFAULT on `sites` -- which Postgres 11+ applies as a catalog change
-- rather than a table rewrite, so it does not lock the site table for the length
-- of a scan. Nothing is backfilled and nothing existing changes shape: a build
-- that predates this migration keeps working against the same rows and simply
-- never connects a revenue provider. 0023-0025 are applied and are therefore
-- never edited (D-214).
--
-- This is the first table in the repository that stores an encrypted value.
-- The cipher, the keyring and the AAD binding live in
-- `packages/integrations/src/credential-vault.ts`; what lives here is the
-- shape that makes the guarantees checkable: the key version is plaintext
-- beside the ciphertext (so a rotation sweep can find every row still on an old
-- key with a SELECT), and a disabled row is forbidden from holding ciphertext at
-- all (so "disconnect erases the secret" is a database rule rather than an
-- application habit).

CREATE TABLE revenue_credentials (
  id                       uuid PRIMARY KEY,
  site_id                  uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  -- Free text against the catalog in
  -- `packages/domain/src/revenue-providers.ts`, not an enum: adding a provider
  -- is an adapter plus a catalog flip (D1) and must not also be a migration.
  provider                 text NOT NULL,
  -- AES-256-GCM under the keyring, AAD-bound to
  -- `revenue_credential:{id}:{site_id}`. Both are NULLABLE because disconnect
  -- ERASES them in the same UPDATE that disables the row (D3) -- the row stays
  -- for history and for the status surface, the secret does not.
  encrypted_api_key        text,
  encrypted_webhook_secret text,
  -- Which keyring version wrote the ciphertexts above. Plaintext on purpose:
  -- "is key k1 still referenced by any row?" has to be answerable before an
  -- operator may remove it from the ring (D3's rotation path).
  key_version              text NOT NULL,
  -- Display only, and the ONLY part of the secret any read surface ever returns.
  -- Empty string for a secret too short to have a meaningful tail.
  api_key_last4            text NOT NULL,
  -- The opaque per-credential webhook address (D4): 32 random bytes, base64url.
  -- It resolves the credential AND the site, so every customer has their own
  -- endpoint under their own signing secret -- the blast radius of a leaked
  -- secret is one site, which is the property D1 chose over Connect's single
  -- shared platform secret.
  webhook_token            text NOT NULL,
  -- `degraded` is the state this milestone exists for: a provider outage is a
  -- status, never a revenue of zero (D4's outage semantics, snapshot 01 §12.3).
  status                   text NOT NULL DEFAULT 'active',
  -- The owner who connected it. NO ACTION rather than CASCADE or SET NULL:
  -- account deletion scrubs the users row instead of deleting it (ADR-0030 D8),
  -- so this survives as the tombstoned id and "who connected this provider"
  -- stays answerable. Snapshot 02 Section 19 additionally rules that removing
  -- this owner from the site revokes the credential with them, which the
  -- ownership cutover and member removal now do.
  created_by_user_id       uuid NOT NULL REFERENCES users (id),
  connected_at             timestamptz NOT NULL DEFAULT now(),
  -- The last successful live probe. Set at connect and at every rotation.
  last_verified_at         timestamptz,
  -- The last successful sync. Deliberately NOT touched by a failure: a degraded
  -- credential must keep reporting when its data was last actually correct,
  -- which is what lets the read surface say `stale` instead of implying fresh
  -- zeroes (D4).
  last_synced_at           timestamptz,
  last_webhook_at          timestamptz,
  -- A safe category, never a raw provider body (D3). It is rendered to the
  -- customer and it is read by an operator beside a log line.
  last_error               text,
  disabled_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT revenue_credentials_status_check
    CHECK (status IN ('active', 'degraded', 'disabled')),

  -- The webhook address is globally unique: it is what the CP2 endpoint resolves
  -- a credential from, so two rows sharing one would make that lookup ambiguous
  -- and one site's events reachable through another's URL.
  CONSTRAINT revenue_credentials_webhook_token_key UNIQUE (webhook_token),

  -- **Disconnect erases the secret, enforced.** A disabled row holds no
  -- decryptable provider key, whatever code path put it there.
  --
  -- Only this direction is constrained, deliberately. The mirror rule ("a live
  -- row always holds both ciphertexts") is not written, because it would make a
  -- future key-only connection or a webhook secret supplied after the fact a
  -- migration rather than a route change -- and it protects nothing: a live row
  -- with a missing secret degrades, while a disabled row with a live secret is
  -- the security failure this table was designed around.
  CONSTRAINT revenue_credentials_disabled_erased_check
    CHECK (
      status <> 'disabled'
      OR (encrypted_api_key IS NULL AND encrypted_webhook_secret IS NULL)
    )
);

-- **One live credential per (site, provider)** (D3).
--
-- Partial on `status <> 'disabled'` rather than a plain UNIQUE, and that is the
-- whole disconnect design: the row survives a disconnect so the history and the
-- status surface survive with it, and a fresh connect afterwards inserts a NEW
-- row rather than resurrecting the old one. Resurrection would mean a credential
-- whose `connected_at` predates the disconnection it went through, and whose
-- audit trail describes two different secrets.
CREATE UNIQUE INDEX revenue_credentials_live_key
  ON revenue_credentials (site_id, provider)
  WHERE status <> 'disabled';

-- The history read: a site's connections, newest first, whatever their status.
CREATE INDEX revenue_credentials_site_idx
  ON revenue_credentials (site_id, connected_at DESC);

-- The rotation sweep's scan (D3): every row still encrypted under a given key
-- version. Partial, because a disabled row holds no ciphertext and therefore
-- pins no key -- so the index is the size of the live credential set rather than
-- of the installation's whole connection history.
CREATE INDEX revenue_credentials_key_version_idx
  ON revenue_credentials (key_version)
  WHERE encrypted_api_key IS NOT NULL;

-- The site's dashboard currency (D2c).
--
-- Every fact keeps its original currency and amounts untouched; this chooses
-- what the reporting amounts beside them are materialized into. ISO-4217 shape
-- only -- whether the code is one ECB publishes a rate for is a question the
-- conversion layer answers per transaction (`conversion_source = 'unavailable'`
-- is visible, never a silent zero), not one this constraint can decide.
ALTER TABLE sites
  ADD COLUMN reporting_currency text NOT NULL DEFAULT 'USD';

ALTER TABLE sites
  ADD CONSTRAINT sites_reporting_currency_format
  CHECK (reporting_currency ~ '^[A-Z]{3}$');
