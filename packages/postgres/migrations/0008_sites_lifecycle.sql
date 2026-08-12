-- Site lifecycle, ingest fencing and config-version fields.
--
-- Rollout note: additive columns on an existing table (expand). Every column has
-- a default or is nullable, so the ALTER rewrites no existing row's meaning; an
-- empty database is unaffected. No backfill.
--
--   * ingest_generation — bumped on deletion to fence in-flight writers (docs
--     snapshot 05, D-210); every accepted event snapshots it. Starts at 1.
--   * config_version — bumped when tracker/site config changes so the versioned
--     ingest-config cache can be invalidated (docs snapshot 02 §11). Starts at 1.
--   * suspended_at — when the site was moved to `suspended`, or NULL if it never
--     was. Nothing in the product sets `suspended` on its own; the column exists
--     so the state, when set, carries its instant and every surface can refuse
--     the site consistently.

ALTER TABLE sites
  ADD COLUMN ingest_generation integer     NOT NULL DEFAULT 1,
  ADD COLUMN config_version    integer     NOT NULL DEFAULT 1,
  ADD COLUMN suspended_at      timestamptz;
