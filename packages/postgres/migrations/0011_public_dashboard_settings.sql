-- Per-site public-dashboard sharing settings (docs snapshot 02 §20; plan
-- Milestone 7 item 8).
--
-- Rollout note: additive creation on an existing database, no backfill. Public
-- sharing is off for every site by default: a site with no row here is not
-- shared, and a row appears only when an owner opts in from the dashboard. So
-- existing sites keep their private-only behaviour the moment this migration
-- lands (expand-only, forward-only — migrations 0001–0010 are never edited).
--
-- The share slug is the public address of a shared dashboard and is deliberately
-- NOT the internal site_id (§18/§20): it is opaque, unguessable, rotatable and
-- revocable. It is unique across sites so a slug resolves to exactly one site.
-- Nullable because a site that has never enabled sharing has no slug; a partial
-- unique index enforces uniqueness only over the rows that have one.
--
-- Opt-in is per surface, not one master flag: overview and geography are shared
-- independently (§20 — overview and geography sharing are separate opt-in flags). `enabled`
-- is the master switch; a surface flag has effect only while it is on. The public
-- read path additionally re-checks the site's billing status at request time, so
-- a `suspended` site's public share is closed even with these flags on
-- (§20) — that gate lives in code against sites.status, not as a column here.
--
-- City privacy: the coarsening threshold is a G-008 privacy default and is NOT
-- stored per site — it is an operator-set, injectable config applied at read
-- time (packages/domain/src/public-dashboard.ts). Nothing here encodes a gated
-- value.

CREATE TABLE site_public_dashboard_settings (
  site_id         uuid PRIMARY KEY REFERENCES sites (id) ON DELETE CASCADE,
  -- Master switch. Off by default; a shared dashboard is opt-in.
  enabled         boolean NOT NULL DEFAULT false,
  -- Opaque public slug, distinct from site_id. Null until sharing is first
  -- enabled; rotating it mints a new value and revokes the old address.
  share_slug      text,
  -- Per-surface opt-in, effective only while `enabled`.
  share_overview  boolean NOT NULL DEFAULT false,
  share_geography boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- A slug, when present, matches the same public-slug shape the frontend routes
  -- use, so a malformed value cannot be stored and later fail to resolve.
  CONSTRAINT site_public_dashboard_slug_format
    CHECK (share_slug IS NULL OR share_slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$')
);

-- The public read path resolves a slug to a site on every request, so the lookup
-- must be an index hit. Partial + unique: only rows that actually carry a slug
-- are indexed, and no two sites can share one.
CREATE UNIQUE INDEX site_public_dashboard_slug_key
  ON site_public_dashboard_settings (share_slug)
  WHERE share_slug IS NOT NULL;
