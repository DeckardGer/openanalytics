-- Per-site tracker/ingest settings: the storage behind GET /v1/tracker/config.
--
-- Rollout note: additive creation on an existing database, no backfill. Every
-- column has a default and the whole row is optional — a site with no row is
-- served the defaults in `packages/domain/src/tracker-settings.ts`, so existing
-- sites keep working the moment this migration lands and a row appears only
-- when a dashboard change writes one. Nothing here is required for ingest to
-- function; it configures what the browser tracker does.
--
-- This table exists because Milestone 5 supplies the real TrackerConfigStore
-- behind the port ADR-0008 left open, and the M4 contract (`TrackerConfig`)
-- needs values no table held: site timezone, the query keys to redact, the
-- heatmap sampling fraction, the heartbeat interval and the feature flags.
--
-- Cache invalidation is `sites.config_version` (migration 0008), not a column
-- here: the version is what the ETag and the collector's short-TTL ingest-config
-- cache are keyed by, and it must change when *any* part of a site's config
-- does. Keeping it on `sites` means one counter for the whole config rather than
-- two that can disagree (docs snapshot 02 §11, ADR-0008).
--
-- no_code_rules are deliberately absent. The dashboard rule builder is M13; the
-- endpoint serves an empty list until then rather than inventing storage for a
-- feature whose shape that milestone decides.

CREATE TABLE site_ingest_settings (
  site_id                    uuid PRIMARY KEY REFERENCES sites (id) ON DELETE CASCADE,
  -- IANA identifier. Dashboard grouping only: the anonymous identity's rotation
  -- day is always the UTC calendar date (docs snapshot 05, D-102), so this
  -- cannot be used to shift a visitor into another site's identity bucket.
  timezone                   text NOT NULL DEFAULT 'UTC',
  -- Query keys stripped from URLs in the browser, before anything leaves it.
  -- Extends the server-side default list, never replaces it.
  redact_query_keys          text[] NOT NULL DEFAULT '{}',
  -- Fraction of clicks reported as heatmap `interaction` signals (F-314).
  -- Sampling is opt-in per site: ADR-0008 rejected sampling by default because
  -- it silently distorts a heatmap, so the default here reports every click and
  -- the tracker's throttle bounds the volume.
  interaction_sampling       real NOT NULL DEFAULT 1,
  -- Realtime presence interval. Bounds mirror the M4 contract's 5…300s.
  heartbeat_interval_seconds integer NOT NULL DEFAULT 15,
  feature_web_vitals         boolean NOT NULL DEFAULT true,
  feature_engagement         boolean NOT NULL DEFAULT true,
  feature_interactions       boolean NOT NULL DEFAULT true,
  feature_heartbeat          boolean NOT NULL DEFAULT true,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  -- Named rather than inline so the bootstrap test can assert them by name: the
  -- bounds mirror the M4 contract, and a value outside them must fail here
  -- rather than reach a browser as a configuration the tracker silently clamps.
  CONSTRAINT site_ingest_settings_interaction_sampling_check
    CHECK (interaction_sampling >= 0 AND interaction_sampling <= 1),
  CONSTRAINT site_ingest_settings_heartbeat_interval_seconds_check
    CHECK (heartbeat_interval_seconds BETWEEN 5 AND 300)
);

-- The collector resolves a public tracking key to a site on every batch, so the
-- lookup has to be an index hit rather than a scan. `api_keys_key_hash_key`
-- (migration 0003) already covers the hash; this index covers the second half of
-- the same query — the live public key for a site, used when the dashboard
-- re-displays it and when a site's keys are listed during resolution.
CREATE INDEX api_keys_tracking_live_idx
  ON api_keys (site_id)
  WHERE type = 'tracking_write' AND revoked_at IS NULL;
