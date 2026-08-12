-- Dashboard-defined custom events: the definition and its immutable versions
-- (ADR-0034, D3; docs snapshot 02 §12).
--
-- Rollout note: additive -- two new tables, and no change to any existing table,
-- column, constraint or index. It applies to a live database with no backfill,
-- and nothing behaves differently until the event-definition endpoints write
-- their first row (forward-only; migrations 0001-0030 are never edited -- D-214).
--
-- This is the storage `0009_site_ingest_settings.sql` deliberately left out:
-- "no_code_rules are deliberately absent. The dashboard rule builder is M13".
-- The endpoint has served an empty list ever since, and this is what fills it.
--
-- The split between the two tables is the whole design. `event_definitions`
-- holds only what must stay stable across every edit -- the site and the
-- canonical `event_name` that ClickHouse's `custom_events_*` rollups group by.
-- Everything a person can change lives in `event_definition_versions`, one
-- immutable row per save. Rollback is therefore a *publish of a copy* rather
-- than a pointer moved backwards (ADR-0034, D3): the tracker-config ETag is
-- `"oa-{site}-{config_version}"` and that epoch only ever increases, so a
-- rollback that reused an older version number would either reuse an ETag a
-- browser has already cached -- and so never reach the visitors it was for --
-- or move the epoch forward while the version moved backward, leaving "which
-- rules are live" answerable only by reading two rows in the right order.

CREATE TABLE event_definitions (
  id                   uuid PRIMARY KEY,
  site_id              uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,

  -- The canonical name every produced event carries, and the key the
  -- `custom_events_1h`/`custom_events_1d` rollups already group by. Unique per
  -- site **including archived definitions**: two definitions sharing a name
  -- would make "how many pricing_cta_clicked events" a question with two
  -- answers, and archiving one of them does not un-write the rows it produced.
  event_name           text NOT NULL,

  status               text NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'archived')),

  -- Which version is live, by version number rather than by id: the number is
  -- what the dashboard shows, what a rollback names and what the publication
  -- query joins on. NULL means "drafted but never published", which is a real
  -- state -- a definition can exist with rules nobody has turned on yet.
  published_version    integer CHECK (published_version >= 1),

  created_by_user_id   uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- Archive is the delete, exactly as `funnels.archived_at` does it (migration
  -- 0018). A definition is the meaning of events already stored in ClickHouse;
  -- hard-deleting it would turn every historical `pricing_cta_clicked` row into
  -- an event whose display name and template no longer exist.
  archived_at          timestamptz,

  -- Named rather than inline so the bootstrap test can assert them by name. The
  -- bounds mirror `eventNameSchema` in `packages/domain/src/no-code-rule.ts`,
  -- which is the module the API validates against; a name that could not be
  -- produced must fail here rather than be stored as a definition whose events
  -- the collector would reject.
  CONSTRAINT event_definitions_event_name_length_check
    CHECK (char_length(event_name) BETWEEN 1 AND 64),
  CONSTRAINT event_definitions_site_event_name_key UNIQUE (site_id, event_name)
);

-- Every definition on a site: the event-builder list screen.
CREATE INDEX event_definitions_site_idx ON event_definitions (site_id);

-- The publication query, which the collector's ingest-config resolution runs
-- for every tracking key it has not cached: a site's live, published
-- definitions. Partial, because that query never wants the other rows.
CREATE INDEX event_definitions_site_published_idx
  ON event_definitions (site_id)
  WHERE archived_at IS NULL AND published_version IS NOT NULL;

CREATE TABLE event_definition_versions (
  id                   uuid PRIMARY KEY,
  definition_id        uuid NOT NULL REFERENCES event_definitions (id) ON DELETE CASCADE,

  -- Monotonic per definition, allocated as `max(version) + 1` under the unique
  -- constraint below. Two concurrent saves cannot both become v3; the loser
  -- retries and becomes v4 (ADR-0034, D3).
  version              integer NOT NULL CHECK (version >= 1),

  display_name         text NOT NULL,
  description          text,
  category             text,

  -- The property allowlist: `[{key, type}]`. A rule may map only to a key
  -- declared here, and an ingested property this does not declare is dropped
  -- rather than rejected (ADR-0034, D8) -- browsers keep evaluating the
  -- previous rule set for up to ~10 minutes after an edit (D4), and a
  -- configuration change must never reject a customer's traffic.
  property_schema      jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- The human sentence, rendered server-side in the read API and never as HTML
  -- (ADR-0034, D7). `{{property}}` interpolation only.
  display_template     text,

  -- The rule set, stored exactly in the shape the tracker is served, for the
  -- same reason `funnels.steps` is JSONB: this is the published payload
  -- verbatim, and round-tripping it through relational columns would invent a
  -- conversion at both ends. Per-rule validation -- the selector grammar, the
  -- complexity bound, the property allowlist -- is application-side in
  -- `packages/domain/src/no-code-rule.ts`; a CHECK cannot express a CSS grammar
  -- and one that tried would be a second, subtly different implementation of it.
  rules                jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Set when this version was created by copying an older one forward, which is
  -- what a rollback is. It is provenance, not a pointer: reading it tells an
  -- operator "v3 is v1 again", and nothing joins on it.
  source_version       integer CHECK (source_version >= 1),

  created_by_user_id   uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- Deliberately no `updated_at`. A version row is never updated after insert;
  -- the column would be a standing invitation to make it one, and the whole
  -- rollback design rests on history being immutable.

  CONSTRAINT event_definition_versions_definition_version_key
    UNIQUE (definition_id, version),
  CONSTRAINT event_definition_versions_display_name_length_check
    CHECK (char_length(display_name) BETWEEN 1 AND 200),
  CONSTRAINT event_definition_versions_display_template_length_check
    CHECK (display_template IS NULL OR char_length(display_template) <= 200),
  CONSTRAINT event_definition_versions_description_length_check
    CHECK (description IS NULL OR char_length(description) <= 1000),
  -- `jsonb_typeof` is checked first because `jsonb_array_length` errors rather
  -- than returning false on a non-array, and an error is a 500 where this wants
  -- a constraint violation -- the same reasoning `funnels_steps_check` records.
  -- The 50 mirrors `MAX_PUBLISHED_RULES_PER_SITE`, the flat cap the ADR-0034
  -- gate closed on: the database bounds one version, and the domain bounds the
  -- site total at publish time, where it can see every definition.
  CONSTRAINT event_definition_versions_rules_check CHECK (
    jsonb_typeof(rules) = 'array' AND jsonb_array_length(rules) <= 50
  ),
  CONSTRAINT event_definition_versions_property_schema_check CHECK (
    jsonb_typeof(property_schema) = 'array' AND jsonb_array_length(property_schema) <= 32
  )
);

-- The version list screen, and the `max(version) + 1` allocation, both read a
-- definition's versions newest first.
CREATE INDEX event_definition_versions_definition_idx
  ON event_definition_versions (definition_id, version DESC);

-- The published pointer, added after both tables exist because the reference is
-- circular. `MATCH SIMPLE` is the default and is what makes it correct here: a
-- NULL `published_version` skips the check entirely, so an unpublished
-- definition is unconstrained, while a published one must name a version that
-- exists. Version rows are never deleted except by the cascade from their
-- definition, so no `ON DELETE` action can ever fire.
ALTER TABLE event_definitions
  ADD CONSTRAINT event_definitions_published_version_fk
  FOREIGN KEY (id, published_version)
  REFERENCES event_definition_versions (definition_id, version);
