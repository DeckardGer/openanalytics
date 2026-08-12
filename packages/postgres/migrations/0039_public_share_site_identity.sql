-- The public site-identity read: a ninth share surface and a site timezone
-- (ADR-0044; docs snapshot 02 §20).
--
-- Rollout note: additive, forward-only (migrations 0001-0038 are never edited --
-- D-214). Two independent columns on two tables, no backfill, no index. It
-- applies to a live database instantly and nothing behaves differently until an
-- owner acts: every existing share reads `share_identity = false` and keeps its
-- generic header, and every existing site reads `reporting_timezone IS NULL`,
-- which means "not configured; the viewer's clock applies".
--
-- ## `site_public_dashboard_settings.share_identity`
--
-- The ninth per-surface opt-in, added as its own column for the reason 0013
-- (`share_realtime`) and 0033 (the five breakdown surfaces) added theirs:
-- `NOT NULL DEFAULT false` means an opt-in already granted still says exactly
-- what it said when it was granted. Folding identity into an existing flag would
-- mean every owner who ticked that box starts publishing their site's name and
-- favicon on a link they may have shared anonymously on purpose (ADR-0044 D3,
-- following ADR-0039 D2).
--
-- The flag gates `display_name` and `favicon_domain` only. `reporting_timezone`
-- and `first_event_at` are rendering facts rather than identity and are served
-- to any live slug -- otherwise an anonymous share would keep cutting its
-- buckets in whichever zone the viewer's browser is set to, and could never
-- offer "All time" (ADR-0044 D1). As with 0011, 0013 and 0033, the
-- `suspended` gate stays in code against `sites.status` and is not a
-- column here.
--
-- ## `sites.reporting_timezone`
--
-- The site's own reporting clock, and the first site-level timezone this
-- repository has ever had. ADR-0026 deliberately made the timezone a property of
-- the **user** ("one human has one mental clock") and rejected a site column as
-- a replacement, while explicitly leaving the door open for a per-site
-- *override*. This is that override and only that: `users.timezone` is
-- unchanged, analytics still take `timezone` as a per-request parameter (02
-- §18), and no private handler reads this column.
--
-- Modelled on `sites.reporting_currency` (0026): a read-side presentation choice
-- written through `PATCH /v1/sites/{site_id}` under `site:settings`, which
-- deliberately does **not** bump `config_version`. `config_version` is the
-- tracker/ingest config generation -- it invalidates the tracker-config ETag,
-- the CDN copy and the collector's ingest-config cache together -- and the
-- collector has never heard of a reporting timezone.
--
-- NULL semantics: "the owner has never chosen", served as `null` on the public
-- read. There is deliberately no server-side default, for ADR-0026 decision 3's
-- reason: a stored 'UTC' would be indistinguishable from an owner who genuinely
-- chose UTC, and no later migration could tell the two apart.

ALTER TABLE site_public_dashboard_settings
  ADD COLUMN share_identity boolean NOT NULL DEFAULT false;

ALTER TABLE sites
  ADD COLUMN reporting_timezone text,
  -- Shape and length only, a literal mirror of `users_timezone_format`
  -- (migration 0017). Whether an identifier actually exists in the IANA database
  -- is a question only a tz-aware runtime can answer, and the API answers it on
  -- write with `isValidTimezone` (packages/contracts/src/time.ts) before
  -- anything reaches here. This constraint is the floor under that check: it
  -- bounds the column to the same 1..64 characters the wire schema allows and
  -- refuses anything that is not identifier-shaped -- including an offset zone
  -- such as '+05:00', which `Intl` accepts as a time zone and this product does
  -- not (ADR-0026) -- so a direct SQL write cannot store a value the read path
  -- would have to defend against.
  ADD CONSTRAINT sites_reporting_timezone_format
    CHECK (
      reporting_timezone IS NULL
      OR (
        char_length(reporting_timezone) BETWEEN 1 AND 64
        AND reporting_timezone ~ '^[A-Za-z][A-Za-z0-9._+-]*(/[A-Za-z0-9._+-]+)*$'
      )
    );
