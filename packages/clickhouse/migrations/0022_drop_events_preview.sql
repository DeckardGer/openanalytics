-- ADR-0068: test mode and the rule preview die, so no traffic can vanish.
--
-- `events_preview` (migration 0020) was where client-claimed test-mode and
-- rule-preview traffic landed instead of `events_raw` — free, invisible, and
-- expiring on a 7-day TTL. The audit K-01 incident showed what that costs: a
-- paying customer's snippet carried a stale `data-test-mode` attribute and
-- their data vanished with no warning surface anywhere. The mechanism is
-- removed — nothing writes this table any more (the worker has one insert
-- target again) — and the rows worth keeping were migrated to `events_raw`
-- with `billable = 0` preserved before this migration was applied.
--
-- This is the schema's only DROP TABLE to date, and the only TTL leaves with
-- it: analytics data now has no time-based retention anywhere, which makes
-- the retention register's claim unconditional.

DROP TABLE IF EXISTS events_preview;
