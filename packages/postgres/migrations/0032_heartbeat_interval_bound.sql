-- Narrow the heartbeat-interval CHECK to what the presence window can hold.
--
-- ADR-0035, D8. Migration 0009 set `BETWEEN 5 AND 300` to mirror the M4
-- contract's bounds, against a presence window fixed at 60 seconds. ADR-0035 D1
-- moved that window to 300 seconds, and 300 was still the whole of it: an
-- interval equal to the window means every visitor's presence expires exactly as
-- their next beat arrives, which is a board that flickers permanently and a
-- setting nobody would suspect.
--
-- The rule is stated once and derived everywhere: **the window must hold three
-- heartbeat intervals**, so a visitor survives two consecutive lost heartbeats
-- (the third beat after the last successful one still lands inside the window).
-- 300 / 3 = 100. The named constants are
-- `PRESENCE_WINDOW_HEARTBEAT_RATIO` / `MAX_HEARTBEAT_INTERVAL_SECONDS` in
-- @openanalytics/contracts, pinned against `VISITOR_PRESENCE_WINDOW_MS` by a
-- unit test; SQL cannot import them, so the derivation is written out here
-- instead of the number appearing as a bare literal with no reason attached.
--
-- Rollout note: 0009 is not edited, and could not be (D-214) — this drops the
-- constraint it created and adds the narrower one under the same name, so the
-- schema ends in one state rather than two overlapping CHECKs.
--
-- This cannot fail on a row, and that was verified rather than assumed:
-- `site_ingest_settings` has **zero rows** in production and no HTTP surface
-- writes the column, so every site runs the 15-second default through the
-- repository fallback in `repositories/ingest-config.ts`. The same reason M13
-- could narrow the no-code rule cap from 200 to 50. If a row ever did sit
-- outside the new bound this would fail loudly at migrate time, which is the
-- correct outcome: a value the presence model cannot honour should not survive
-- a deploy quietly.

ALTER TABLE site_ingest_settings
  DROP CONSTRAINT site_ingest_settings_heartbeat_interval_seconds_check;

ALTER TABLE site_ingest_settings
  ADD CONSTRAINT site_ingest_settings_heartbeat_interval_seconds_check
    CHECK (heartbeat_interval_seconds BETWEEN 5 AND 100);
