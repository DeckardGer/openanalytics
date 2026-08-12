-- Where a credential has been used from, so that "somewhere new" is a fact.
--
-- ADR-0051, decision 5. G-010 chose variant (b) — credential events only — and
-- one of those events is *first use from a new source*. Answering "has this
-- credential been seen from this source before?" on the read path needs a point
-- lookup, and this table is that lookup. It is **not** a second journal: the
-- journal is `audit_logs`, whose retention (forever, by three independent
-- mechanisms — see D1) is exactly the retention a credential event wants. What
-- could not live there is the *index*. `audit_logs` is indexed on site-and-time,
-- actor-and-time and action; a fingerprint would sit inside `metadata` jsonb,
-- and the question would degrade to a scan of a table whose whole design is that
-- it grows forever. Indexing the ledger for this would turn the ledger into an
-- index, which is the one thing an append-only ledger must not become.
--
-- **`source_hash` is an HMAC, never an address** (D4). `AGENTS.md`'s hard rule
-- forbids a raw IP in a log, and it would be no better in a table. The key is
-- `CREDENTIAL_SOURCE_SECRET` — its own secret, never derived from `AUTH_SECRET`,
-- on the `TRIAL_IDENTITY_SECRET` precedent — and `key_version` travels on the
-- row so a rotation re-baselines rather than corrupting: hashes are only ever
-- compared within one version, so the first use after a rotation looks new for
-- every credential, once, on purpose.
--
-- **`credential_ref` is deliberately opaque, and the two kinds spell it
-- differently.** An API key is its own uuid. An OAuth credential is
-- `<user_id>:<client_id>` and **not** the access-token row id, because Better
-- Auth's `refresh_token` grant *creates a new row* on every refresh
-- (verified in the vendored plugin, D6): keyed by the token row, every refresh
-- would reset first-use and re-fire "new source". The stable identity of an
-- authorization is the person and the application.
--
-- **`site_id` and `user_id` exist only so deletion can find these rows.**
-- Nothing reads them for authorization, and exactly one of the two is set per
-- row. They are what make this table a member of both deletion vocabularies
-- (ADR-0030 D7): `SITE_DELETION_TARGETS` moves 63 -> 64 as `credential_sources`
-- (the api-key rows for that site), and `ACCOUNT_DELETION_POSTGRES_TARGETS`
-- moves 17 -> 18 as `credential_sources_user` (the oauth-grant rows for that
-- person). The names differ for the reason `memberships` and `invites` differ
-- from their table names: the two purges remove different row sets from the same
-- table, and an identical name would make the snapshots look interchangeable.
-- An account deletion *revokes* rather than deletes the user's API keys
-- (`api_keys_revoke`), so those source rows correctly stay with the site.
--
-- Neither foreign key carries an ON DELETE action, which is migration 0041's
-- rule and 0037's before it: a `sites` row becomes a tombstone and a `users` row
-- is scrubbed, so neither is ever deleted and a declared cascade could never
-- fire. A cascade that cannot run is worse than none, because it reads as
-- coverage — the way `idempotency_keys` outlived account deletion until
-- 2026-08-06. The references stay, without an action, because the relationships
-- are real.
--
-- Expand-only: one new table, no backfill. Rows begin accumulating from the
-- first authenticated read after deploy, which means every live credential
-- reports one `credential.first_used` on its next use. That is honest — this
-- system has never known where a credential was used from — and it is a
-- one-time event per credential rather than a standing state.

CREATE TABLE credential_sources (
  id uuid PRIMARY KEY,
  credential_kind text NOT NULL
    CHECK (credential_kind IN ('api_key', 'oauth_grant')),
  -- The api key's uuid, or '<user_id>:<client_id>' for an OAuth grant. Opaque
  -- to this table on purpose: it is an identity, not a join key, and the two
  -- kinds are told apart by `credential_kind` rather than by parsing it.
  credential_ref text NOT NULL,
  -- The HMAC key version this hash was produced under. Part of the identity, so
  -- a rotation cannot make two key generations look like the same source.
  key_version integer NOT NULL,
  -- HMAC-SHA256 of the client address. Never the address.
  source_hash text NOT NULL,
  -- Set for 'api_key' only; see the header. No ON DELETE action.
  site_id uuid REFERENCES sites (id),
  -- Set for 'oauth_grant' only; see the header. No ON DELETE action.
  user_id uuid REFERENCES users (id),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

-- The read path's only index, and it serves both of the path's questions.
--
-- As a whole it is what the upsert infers its conflict from: a credential used
-- repeatedly from its usual source probes this and the ON CONFLICT clause
-- updates `last_seen_at` only when it is already stale, so the steady state
-- writes **no new row version** — no heap tuple, no index entry, nothing for
-- autovacuum to clean up later.
--
-- It is not literally zero WAL, and the difference is worth stating rather than
-- rounding off: `ON CONFLICT DO UPDATE` takes a tuple lock on the conflicting
-- row *before* it evaluates the `WHERE`, and that lock is itself WAL-logged. So
-- the steady state costs one lock record, not a row rewrite. That is the
-- property the read path is affordable on.
--
-- Its three leading columns are also the distinct-source count that decides
-- between "first use" and "first use from a new source" and enforces the cap
-- (D9). No second index for that count, deliberately — a prefix of this one is
-- the same index pages, and a redundant index on the write path would cost every
-- insert for nothing.
CREATE UNIQUE INDEX credential_sources_identity_idx
  ON credential_sources (credential_kind, credential_ref, key_version, source_hash);

-- The two deletion predicates, partial because exactly one of the columns is set
-- per row and a purge never scans for the null half.
CREATE INDEX credential_sources_site_idx
  ON credential_sources (site_id) WHERE site_id IS NOT NULL;
CREATE INDEX credential_sources_user_idx
  ON credential_sources (user_id) WHERE user_id IS NOT NULL;
