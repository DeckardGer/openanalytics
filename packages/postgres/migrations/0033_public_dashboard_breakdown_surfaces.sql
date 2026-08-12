-- Five more public-dashboard opt-in surfaces (ADR-0039; docs snapshot 02 §20).
--
-- The public share surface answered `overview` and `geography` only, which left
-- the shared dashboard with an empty chart slot and three breakdown cards it
-- could not render. ADR-0039 adds `timeseries`, `sessions`, `pages`, `sources`
-- and `devices`, reversing the "and nothing else" clause of ADR-0024 D7 for
-- exactly those five (the clause's actual argument — no individual visitors on
-- an anonymous slug — is untouched; `recent-visitors` and `visitor` stay
-- private).
--
-- Rollout note: additive, forward-only (migrations 0001-0032 are never edited —
-- D-214). `NOT NULL DEFAULT false` means every existing row is private on all
-- five surfaces the moment this lands: no backfill, and a share that was already
-- enabled keeps publishing exactly what it published before.
--
-- One column per surface rather than one combined flag (ADR-0039 D2). The cost
-- is five columns paid once; what it buys is that an opt-in given today cannot
-- be widened later by us. A combined flag would mean the day a sixth surface is
-- added, every owner who ticked that box starts publishing something they never
-- saw — a per-surface column defaults to false and says only what it said when
-- it was granted. This is why 0013 added `share_realtime` as a column rather
-- than widening the meaning of an existing one, and this migration follows it.
--
-- As with 0011 and 0013, the `suspended` gate stays in code against
-- `sites.status` and is not a column here, and no privacy threshold is stored
-- per site: the G-008/ADR-0017 city coarsening is an operator-set read-time
-- config and applies to geography alone. ADR-0039 D3 records why none of the
-- five surfaces added here takes an analogous rule.

ALTER TABLE site_public_dashboard_settings
  ADD COLUMN share_timeseries boolean NOT NULL DEFAULT false,
  ADD COLUMN share_sessions   boolean NOT NULL DEFAULT false,
  ADD COLUMN share_pages      boolean NOT NULL DEFAULT false,
  ADD COLUMN share_sources    boolean NOT NULL DEFAULT false,
  ADD COLUMN share_devices    boolean NOT NULL DEFAULT false;
