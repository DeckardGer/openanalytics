-- Private read keys say what they may do.
--
-- ADR-0042, decision 3. `api_keys.scopes` has existed since migration 0003 and
-- has been written by nothing and read by nothing ever since — docs snapshot 02
-- §20 says a key is bound to a scope and that the default is the *minimum*
-- scope, and that has been true on paper and absent from the database for
-- thirteen migrations. M14 gives the column meaning, because the WordPress
-- plugin is the first credential holder that must be granted more than site
-- metadata and must not be granted everything.
--
-- **Why a backfill and not a code-side default alone.** `apiKeyScopesFrom`
-- (`packages/domain/src/api-key-scopes.ts`) reads NULL as `{site:read}`, so the
-- product would behave correctly without this statement. It runs anyway: a
-- column whose meaning lives only in one TypeScript function is a column the
-- next reader — a psql session, an export, a support query — will read as
-- "unscoped", and "unscoped" is exactly the wrong guess to make about a
-- credential. After this, the row states its own grant.
--
-- The two are not redundant in the other direction either. Between this
-- migration running and the new api build going live, the old build keeps
-- inserting NULL, and the code-side reading is what keeps those rows narrow
-- rather than accidentally wide.
--
-- **The direction is deliberate: no key widens.** Every existing `private_read`
-- key was handed to somebody under a contract where it read `GET /v1/read/site`
-- and nothing else. Backfilling `{site:read}` keeps that promise exactly;
-- backfilling `{site:read,analytics:read}` would have granted analytics reads to
-- credentials whose holders never asked for them, on the day a milestone
-- shipped. Analytics access arrives only when an owner mints a new key for it.
--
-- `tracking_write` rows are deliberately left NULL. They carry no scopes:
-- `resolveReadApiKey` rejects them by type before scopes are consulted, and the
-- write path never consults scopes at all. Giving them `{site:read}` would state
-- a grant that nothing honours.
--
-- Forward-only and additive: no column is added, dropped or re-typed, and
-- re-running the statement is a no-op because the predicate excludes rows it has
-- already touched.

UPDATE api_keys
SET scopes = ARRAY['site:read']
WHERE type = 'private_read'
  AND scopes IS NULL;
