-- Repoint performance_events_mv at the server-owned property keys.
--
-- Rollout note: replaces a materialized view definition. No target-table change
-- and no backfill -- events_raw held no rows when this shipped, so there is
-- nothing already extracted under the old key names to migrate.
--
-- Migration 0002 read `metric`, `value`, `rating` and `navigation_type` straight
-- out of the properties JSON. That was written before the worker's row mapping
-- existed, and it assumed the wrong thing: `web_vital` is a *separate envelope
-- field*, not a property (contracts persistedEventSchema). The worker folds it
-- into the properties column under the `oa_` prefix the M4 contract reserves --
-- `propertyKeySchema` rejects a client key starting with `oa_`, so a folded
-- server key can neither be shadowed by nor forged as a customer property.
--
-- Reading the unprefixed names would have meant one of two defects: an empty
-- performance table, or -- once the fold used unprefixed keys to match -- a
-- customer property named `metric` on a web_vital event silently overwriting the
-- measurement. The prefix removes the collision instead of ranking it.
--
-- This is a forward migration rather than an edit to 0002 because an applied
-- migration is never edited (docs snapshot 05, D-214) and, more practically,
-- because `CREATE MATERIALIZED VIEW IF NOT EXISTS` would not replace an existing
-- view even if it were edited. Dropping and recreating is the only thing that
-- actually changes a deployed view.
--
-- Dropping a materialized view does not touch its target table. performance_events
-- keeps its rows and its settings -- only the transformation feeding it changes.

DROP TABLE IF EXISTS performance_events_mv;

CREATE MATERIALIZED VIEW IF NOT EXISTS performance_events_mv TO performance_events AS
SELECT
  site_id,
  event_id,
  batch_id,
  occurred_at,
  accepted_at,
  JSONExtractString(properties, 'oa_metric')          AS metric,
  JSONExtractFloat(properties, 'oa_value')            AS value,
  JSONExtractString(properties, 'oa_rating')          AS rating,
  JSONExtractString(properties, 'oa_navigation_type') AS navigation_type,
  page_path,
  anonymous_id,
  session_id,
  origin,
  device_type,
  browser,
  os,
  country
FROM events_raw
WHERE type = 'web_vital' AND metric != ''
