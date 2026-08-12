-- Embeddable widgets: one public read with its own address (ADR-0045; docs
-- snapshot 02 §20, widgets).
--
-- Rollout note: additive, forward-only -- one new table, and no change to any
-- existing table, column, constraint or index (migrations 0001-0039 are never
-- edited -- D-214). It applies to a live database with no backfill, and nothing
-- behaves differently until the widget endpoints write their first row.
--
-- Why it exists: §20 fixed the security boundary for widgets before any of them
-- existed, and its first line says widget config is stored in Postgres. This is
-- that store. A widget is `(surface, range, limit, title)` plus an origin
-- allowlist and a reversible on/off, and nothing more (ADR-0045 D2): a composite
-- widget would republish whatever a later surface adds, and a widget an owner
-- created in 2026 must mean in 2027 exactly what it meant when they created it.
--
-- No numbers are stored here and none are cached here. What a widget publishes
-- is computed on every anonymous read through the *existing* public read
-- pipeline (ADR-0043 D10: one pipeline, not a lookalike), so no statement in
-- this checkpoint reads `events_raw`.
--
-- ## The id is the primary key, and that is a decision
--
-- `site_public_dashboard_settings` keeps its `share_slug` as a *secondary*
-- column behind a partial unique index, because a share is keyed by the site it
-- belongs to -- one board per site. A widget is not: there are many per site,
-- and ADR-0045 D1 says the public address and the management handle are the same
-- string, so that "the string in the dashboard's widget list is the string in
-- the embed snippet" and nothing has to be translated. A `uuid` surrogate beside
-- an opaque `widget_id` would be exactly the translation D1 refuses, and it would
-- invite a second addressing path (`/widgets/{uuid}`) that leaks nothing today
-- and would leak the moment somebody joined the two.
--
-- So the key is the opaque id itself: 96 random bits in base36 behind a `w`,
-- minted the way `generateShareSlug` mints a slug, and carrying that function's
-- stated property -- opaque by design, never an encoding of the `site_id`. The
-- format CHECK is a literal mirror of the contract's `WidgetId` pattern, so a
-- direct SQL write cannot plant an id the public route would have to defend
-- against.
--
-- ## What is a CHECK here and what is not
--
-- The three parameter constraints below encode the ADR's own invariants, which
-- are the invariants the public read depends on: an unrecognised surface has no
-- route to serve it, a `realtime` widget has no window, and a `limit` on a
-- surface with no rows is a stored value nothing reads. Each is named rather than
-- inline so the bootstrap test can assert it by name, exactly as `funnels`
-- (migration 0018) does.
--
-- Deliberately NOT constraints:
--
--   * **The flat cap of fifty widgets per site** (ADR-0045 D9). A CHECK cannot
--     count sibling rows, and the cap exists to bound a settings screen rather
--     than to price anything -- so it is application code
--     (`MAX_WIDGETS_PER_SITE`), which means raising it is a change to a constant
--     and not a migration. The same judgement `MAX_PUBLISHED_RULES_PER_SITE`
--     made in ADR-0034 D2.
--   * **Origin syntax.** `allowed_origins` is bounded in cardinality here and
--     validated element by element by the API (`isWidgetOrigin`), for the reason
--     `funnels_steps_check` states about per-element rules: a regex in the
--     database that disagreed with the wire validator turns a validation miss
--     into a 500, and the disagreement direction that matters is "the database
--     is stricter". Uniqueness is an application bound for the same reason.
--
-- ## Why `range` and `row_limit` are spelled that way
--
-- `range` is a non-reserved keyword in PostgreSQL and is safe unquoted, so it
-- keeps the wire name. `limit` is fully reserved -- a column called `limit` would
-- need quoting in every hand-written query forever -- so the column is
-- `row_limit` and the repository maps it to the wire's `limit`. This repository
-- has never had a quoted-identifier column and this table does not introduce the
-- first one.

CREATE TABLE widgets (
  -- The opaque public credential AND the management handle (ADR-0045, D1).
  -- A literal mirror of the contract's `WidgetId` pattern.
  id                 text PRIMARY KEY,
  site_id            uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,

  -- Which public read this widget publishes. Fixed at creation: `PATCH` cannot
  -- carry it, because changing it alters *what* is published rather than how
  -- much of it, on a page that already carries the old embed (ADR-0045, D2).
  surface            text NOT NULL,

  -- The relative window key, resolved on every read in the site's reporting
  -- timezone (ADR-0045, D10). Never an absolute from/to: an embed is a living
  -- thing on somebody's page, and a frozen window that ages silently is worse
  -- than a report that says its date. NULL exactly when `surface = 'realtime'`.
  range              text,

  -- Rows a breakdown widget shows; NULL on every other surface. `row_limit`
  -- rather than `limit`, which is a reserved word (see the note above).
  row_limit          integer,

  -- An owner-authored label rendered inside the embed, or NULL for none.
  -- Deliberately not the site's name: publishing a widget is not publishing
  -- whose site it is (ADR-0044 D1), and a title is a string the owner typed in
  -- order to publish it.
  title              text,

  -- Where a browser may render this widget. **Empty means nowhere** (ADR-0045
  -- D4), which is why the default is the empty array rather than a wildcard: an
  -- embed is made for a page the owner is looking at, and the direction a
  -- missing value must fail in is closed. `text[]`, as `api_keys.scopes` stores
  -- the other allowlist of short opaque strings this schema carries; entries are
  -- compared as whole strings and never by prefix or suffix.
  allowed_origins    text[] NOT NULL DEFAULT '{}',

  -- The reversible revoke. `false` makes every read of this widget the same 404
  -- an invented id gets; `DELETE` is the permanent one.
  enabled            boolean NOT NULL DEFAULT true,

  -- Exactly what `funnels` does with its creator column, and for the contract's
  -- stated reason: "Null once the creating user's account is gone." A widget an
  -- owner published must keep publishing after the colleague who created it
  -- closes their account -- `ON DELETE CASCADE` would silently blank an embed on
  -- a customer's page as a side effect of an unrelated account deletion.
  created_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT widgets_id_format CHECK (id ~ '^w[a-z0-9]{10,31}$'),
  CONSTRAINT widgets_surface_check CHECK (
    surface IN (
      'overview', 'timeseries', 'sessions', 'pages',
      'sources', 'devices', 'geography', 'realtime'
    )
  ),
  -- Two clauses in one constraint because they are one rule: a range is present
  -- exactly when the surface has a window, and its value comes from the
  -- dashboard's own nine interval keys. Splitting them would let a row exist
  -- with a realtime surface and a valid-looking range, which is the state the
  -- read path would have to decide about.
  --
  -- `range IS NOT NULL AND range IN (...)` and not `range IN (...)` alone: a
  -- CHECK passes on NULL, and `NULL IN (...)` is NULL rather than false, so the
  -- shorter spelling silently admitted a range-less `overview` widget — a
  -- constraint that existed, was asserted by name, and enforced half of what it
  -- claimed. The explicit NOT NULL is what makes the ELSE branch a requirement.
  CONSTRAINT widgets_range_check CHECK (
    CASE
      WHEN surface = 'realtime' THEN range IS NULL
      ELSE range IS NOT NULL
        AND range IN ('today', 'yesterday', '24h', '7d', '30d', '90d', '6mo', '12mo', 'all')
    END
  ),
  -- NULL is allowed on a breakdown surface as well as required off one: the
  -- application supplies the default of 10 on create, and a database that
  -- refused NULL there would be stricter than the wire schema, which is the
  -- disagreement direction that turns a validation miss into a 500.
  CONSTRAINT widgets_row_limit_check CHECK (
    row_limit IS NULL
    OR (
      surface IN ('pages', 'sources', 'devices', 'geography')
      AND row_limit BETWEEN 1 AND 50
    )
  ),
  -- Length only, and deliberately no lower bound. The contract's `title` is
  -- `[string, 'null']` with a `maxLength` and no `minLength`, so `""` is a legal
  -- wire value; a `BETWEEN 1 AND 80` copied from `funnels_name_length_check`
  -- would make the database refuse something the validator admits, which is the
  -- disagreement direction that turns a validation miss into a 500 rather than a
  -- 400. A funnel's name is required and identifies the row; a widget's title is
  -- optional decoration.
  CONSTRAINT widgets_title_length_check CHECK (
    title IS NULL OR char_length(title) <= 80
  ),
  -- Cardinality only; element syntax and uniqueness are application bounds (see
  -- the note above). `cardinality` returns NULL for a NULL array, which the
  -- NOT NULL on the column already refuses.
  CONSTRAINT widgets_allowed_origins_check CHECK (cardinality(allowed_origins) <= 20)
);

-- The site's widget list -- the one query the management surface makes, and the
-- one the per-site cap counts against.
CREATE INDEX widgets_site_idx ON widgets (site_id);
