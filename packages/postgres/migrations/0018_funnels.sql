-- Stored funnel definitions: the saved half of the funnel feature.
--
-- Rollout note: additive -- one new table, and no change to any existing table,
-- column, constraint or index. It applies to a live database with no backfill,
-- and nothing behaves differently until the funnel endpoints write their first
-- row (forward-only; migrations 0001-0017 are never edited -- D-214).
--
-- Why it exists: M8 shipped funnels as a *computation* — ADR-0012, the
-- `windowFunnel` gateway operation behind `GET /v1/sites/{id}/analytics/funnel`,
-- which takes its steps as query parameters and holds nothing. That endpoint is
-- unchanged and stays the only way a funnel is computed. What was missing is
-- persistence: the dashboard had nowhere to keep "Checkout" so that opening the
-- funnels page tomorrow shows the same four steps, and
-- `docs/frontend/frontend_tasks.md` recorded the gap as "funnel definitions: no
-- endpoints". This table is that store and nothing more. Computing a stored
-- funnel is still a call to the analytics endpoint, with the steps read from
-- here; no query in this checkpoint reads `events_raw`.
--
-- Async funnel jobs over a range longer than the synchronous 92-day cap remain
-- the documented follow-up they were in ADR-0012.

CREATE TABLE funnels (
  id                 uuid PRIMARY KEY,
  site_id            uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  -- Display name only; it is never an identifier and never has to be unique. Two
  -- funnels called "Checkout" are a housekeeping problem for the people who own
  -- the site, not an invariant worth a constraint that would make a rename fail.
  name               text NOT NULL,

  -- The ordered step keys, stored exactly in the shape the compute endpoint
  -- accepts: a JSON array of strings, each a page path or a custom event name.
  -- JSONB rather than text[] because this is the request payload verbatim, and
  -- round-tripping it through a Postgres array type would invent a conversion at
  -- both ends for no gain.
  steps              jsonb NOT NULL,

  scope              text NOT NULL DEFAULT 'visitor' CHECK (scope IN ('visitor', 'session')),

  -- The conversion window. bigint, NOT integer: the domain ceiling is 30 days,
  -- 2_592_000_000 ms, which overflows int4's 2_147_483_647. An integer column
  -- would reject the top of the range the compute endpoint already accepts, so a
  -- funnel that runs as an ad-hoc query could not be saved.
  window_ms          bigint NOT NULL,

  created_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- Archive is the delete. A funnel is a saved question, and the answer to it is
  -- a chart someone may have linked or screenshotted; hard-deleting the row turns
  -- that into a dangling reference. Nullable instant plus the partial index
  -- below, exactly as api_keys.revoked_at and trial_policies.disabled_at do it.
  archived_at        timestamptz,

  -- Named rather than inline so the bootstrap test can assert them by name: the
  -- bounds mirror MIN_FUNNEL_STEPS/MAX_FUNNEL_STEPS and MAX_FUNNEL_WINDOW_MS in
  -- `packages/domain/src/funnel.ts`, which is the same module the compute
  -- endpoint validates against. A definition that could not be computed must
  -- fail here rather than be stored as a funnel that 400s every time it is run.
  CONSTRAINT funnels_name_length_check CHECK (char_length(name) BETWEEN 1 AND 200),
  -- `jsonb_typeof` is checked first because `jsonb_array_length` errors rather
  -- than returning false on a non-array, and an error is a 500 where this wants
  -- a constraint violation. The jsonpath conjunct pins every element to a JSON
  -- string, so a direct SQL write of `'[1,2]'` cannot come back through a read
  -- path typed `string[]`. It is a `strict` path deliberately: lax mode unwraps
  -- a nested array before `type()` sees it, so `'["/a", ["/b"]]'` would slip
  -- through. Per-element length stays an application bound: a CHECK cannot use
  -- a subquery, and a regex over content would make the database stricter than
  -- the wire validator — the disagreement direction that turns a validation
  -- miss into a 500.
  CONSTRAINT funnels_steps_check CHECK (
    jsonb_typeof(steps) = 'array'
      AND jsonb_array_length(steps) BETWEEN 2 AND 8
      AND NOT (steps @? 'strict $[*] ? (@.type() != "string")')
  ),
  CONSTRAINT funnels_window_ms_check CHECK (window_ms BETWEEN 1 AND 2592000000)
);

-- The funnels page: every definition on a site, archived ones included when the
-- caller asks for them.
CREATE INDEX funnels_site_idx ON funnels (site_id);

-- The same page's default, which is the request that actually gets made: live
-- definitions only.
CREATE INDEX funnels_site_active_idx ON funnels (site_id) WHERE archived_at IS NULL;
