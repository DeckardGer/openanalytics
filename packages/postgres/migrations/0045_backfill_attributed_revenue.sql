-- Backfill: a site that has already connected a revenue provider keeps its
-- attribution working (Rahul, 2026-08-13, on the ADR-0064 audit).
--
-- Migration 0044 introduced `attributed_revenue` defaulting to `false`, which is
-- the right default for a site that has never made the choice — but it is the
-- wrong answer for a site that made it long ago by connecting Stripe and
-- wiring `order_id` onto its success page. Left alone, 0044 would have silently
-- stopped those conversions carrying their join key, and the symptom would have
-- been journeys quietly ceasing to appear. Existing connections are therefore
-- read as an existing opt-in; every site from here on starts at `false`.
--
-- Rollout note: data-only. No table, column, constraint or index changes, and
-- the statements are written to be safe to re-run — the insert upserts and the
-- version bump is idempotent in effect if not in value (a config version that
-- moves twice costs one extra tracker revalidation and nothing else).
--
-- `status <> 'disabled'` is the definition of "has connected", and it is the
-- same predicate the partial unique index on `revenue_credentials` uses for
-- "this site's live connection". A `degraded` credential is a working
-- connection having a bad day; a `disabled` one is a disconnection, and
-- re-enabling a linking behaviour for a site that deliberately disconnected
-- would be the opposite of what this backfill is for.

INSERT INTO site_ingest_settings (site_id, attributed_revenue)
SELECT DISTINCT c.site_id, true
  FROM revenue_credentials c
 WHERE c.status <> 'disabled'
    ON CONFLICT (site_id)
    DO UPDATE SET attributed_revenue = true, updated_at = now();

-- The bump is not optional and is the reason this is a migration rather than a
-- one-off UPDATE: `sites.config_version` is what invalidates the tracker-config
-- ETag, the CDN copy, the browser's localStorage copy and the collector's
-- ingest-config cache, all at once (ADR-0008). Writing the setting without it
-- would leave every already-loaded browser on the previous configuration —
-- which is precisely the state this backfill exists to get them out of.
UPDATE sites
   SET config_version = config_version + 1,
       updated_at     = now()
 WHERE id IN (
   SELECT site_id FROM revenue_credentials WHERE status <> 'disabled'
 );
