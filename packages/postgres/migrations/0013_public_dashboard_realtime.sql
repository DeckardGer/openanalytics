-- Public-dashboard realtime opt-in (docs snapshot 02 §17/§20, 05 D-213).
--
-- Milestone 9 adds a public realtime stream alongside the historical public
-- surfaces. Sharing realtime is opt-in exactly like overview and geography: a
-- separate per-surface flag, effective only while the `enabled` master switch is
-- on and the site is not `suspended` (that gate stays in code against
-- sites.status, not a column here).
--
-- Rollout note: additive, forward-only (migrations 0001–0012 are never edited —
-- D-214). NOT NULL DEFAULT false means every existing row is realtime-private the
-- moment this lands; no backfill, no behaviour change for a site that has not
-- opted in.

ALTER TABLE site_public_dashboard_settings
  ADD COLUMN share_realtime boolean NOT NULL DEFAULT false;
