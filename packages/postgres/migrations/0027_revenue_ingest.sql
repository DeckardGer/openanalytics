-- Revenue ingest: the delivery ledger, the object head, the sync cursors and
-- the global currency-rate table (ADR-0033, D2c/D4/D8). Milestone 12 CP2.
--
-- Rollout note: expand-only, four brand-new tables, nothing existing is
-- touched and nothing is backfilled. A build that predates this migration keeps
-- working against the same rows and simply has no revenue ingest; a build that
-- follows it finds every table empty, which is the correct starting state for a
-- pipeline whose first write comes from a customer connecting a provider.
-- 0023-0026 are applied and are therefore never edited (D-214).
--
-- Three of the four are site-scoped and join the deletion vocabulary (D8:
-- 48 targets become 51). The fourth, `currency_rates`, is GLOBAL reference data
-- and is deliberately NOT a deletion target -- see the note above it.
--
-- Two idempotency layers are created here and they compose on purpose (D4):
-- `revenue_provider_events` dedupes a *delivery*, `revenue_objects` dedupes and
-- orders a *state*. The acceptance criterion "a duplicate or out-of-order event
-- never counts twice" is enforced twice, which is what makes it survive a crash
-- between the two.

-- ============================================================================
-- The delivery ledger
-- ============================================================================
--
-- A per-site webhook idempotency ledger. The site column is load-bearing: an
-- account-global `(provider, provider_event_id)` key would make the same
-- Stripe account connected to two OA sites collide on the same `evt_...`, and
-- the second site would silently never ingest. Here the same `evt_...` is
-- processed once PER SITE, by design.

CREATE TABLE revenue_provider_events (
  id                uuid PRIMARY KEY,
  site_id           uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  -- The credential the delivery arrived under. CASCADE like the site: a
  -- credential row is removed only when its site is purged, and by then the
  -- ledger is going with it.
  credential_id     uuid NOT NULL REFERENCES revenue_credentials (id) ON DELETE CASCADE,
  provider          text NOT NULL,
  -- The provider's own delivery id for a webhook (`evt_...`), or the synthetic
  -- deterministic id a sync row is recorded under (`backfill:{resource}:{id}`,
  -- `revenueBackfillEventId`). List endpoints deliver no event id at all, so
  -- without the synthetic form the sync path could not use this ledger and D4's
  -- "one ledger for both paths" would collapse into two. Deterministic rather
  -- than per-run, which is what makes the reconcile sweep's 48h overlap free:
  -- re-listing the same charge produces the same id and inserts nothing.
  provider_event_id text NOT NULL,
  -- sha256 of what was observed. The BODY is never stored (D5's privacy
  -- boundary): a raw provider payload carries customer emails and addresses,
  -- and the only question this column has to answer is "is this byte-identical
  -- to what we already processed?".
  payload_hash      text NOT NULL,
  source            text NOT NULL,
  status            text NOT NULL DEFAULT 'received',
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  -- A categorized outcome: counts, decisions, an ignore reason. Never a raw
  -- provider body and never an error string that could carry one.
  result            jsonb,

  CONSTRAINT revenue_provider_events_source_check
    CHECK (source IN ('webhook', 'backfill')),

  CONSTRAINT revenue_provider_events_status_check
    CHECK (status IN ('received', 'processed', 'ignored', 'failed')),

  -- **The site dimension is the point.** One delivery per site.
  CONSTRAINT revenue_provider_events_site_event_key
    UNIQUE (site_id, provider, provider_event_id)
);

-- The site's delivery history, newest first: the operator read behind "did this
-- customer's webhook actually arrive, and what did we do with it?".
CREATE INDEX revenue_provider_events_site_idx
  ON revenue_provider_events (site_id, received_at DESC);

-- The stuck-delivery scan: rows a crash or a failed tie-break re-fetch left
-- `received`. Partial, so it is the size of the UNFINISHED set rather than of
-- the whole history -- on a busy site a difference of several orders of
-- magnitude.
--
-- **It has no consumer in CP2.** The recovery for a row left `received` is the
-- provider redelivering, and a provider eventually stops retrying; the sweep
-- that closes that gap belongs with CP3, where the fact writer exists to say
-- what re-driving a delivery should produce. The index is created now so that
-- sweep is a cheap query rather than a table scan, and so the gap is recorded
-- in the schema rather than only in a comment somebody may not read.
CREATE INDEX revenue_provider_events_unsettled_idx
  ON revenue_provider_events (credential_id, received_at)
  WHERE status = 'received';

-- ============================================================================
-- The object head
-- ============================================================================
--
-- One row per money object per site, carrying the state we believe is current
-- and the locally minted version that ordered it.
--
-- `version` is what CP3's `ReplacingMergeTree(version)` orders by. Minted HERE,
-- under this row's lock, rather than derived from a provider timestamp -- Stripe
-- `created` is second-granular, so two genuinely different states of one charge
-- routinely share a second and a timestamp-derived version could not tell them
-- apart. With a locally minted counter ClickHouse never needs a read-modify-
-- write, a duplicate insert of the same state is harmless, and a stale insert
-- cannot win.

CREATE TABLE revenue_objects (
  id             uuid PRIMARY KEY,
  site_id        uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  provider       text NOT NULL,
  -- The provider's object id (`ch_...`, `re_...`, `du_...`).
  object_id      text NOT NULL,
  object_kind    text NOT NULL,
  -- The ordering input. For a webhook this is the EVENT's `created` (when the
  -- provider said this state was true); for a sync row it is the OBJECT's own
  -- `created`. Using the fetch time for sync rows would make every sweep look
  -- newer than every webhook and let a stale list row overwrite a live update --
  -- with the object's own creation time, a backfill row can never outrank a
  -- webhook by construction of the three-way rule.
  snapshot_at    timestamptz NOT NULL,
  payload_hash   text NOT NULL,
  -- Monotonic per row, never reused, never decreasing. bigint rather than int
  -- because it counts observations rather than objects: a subscription charge
  -- observed by webhook and by every reconcile sweep for years still fits, and
  -- an overflow here would be a silent ClickHouse ordering failure.
  version        bigint NOT NULL DEFAULT 1,
  -- The canonical provider-agnostic snapshot (`RevenueNormalizedObject`).
  -- NO raw provider body, NO raw email, NO raw PII: amounts in integer minor
  -- units, an opaque provider customer id, ids and display names. The hashed
  -- external-identity hint D5 wants is deliberately ABSENT in CP2 -- its
  -- derivation needs ANONYMOUS_IDENTITY_SECRET, which is on the api's and the
  -- worker's FORBIDDEN_KEYS lists, and inventing a second secret to fill the
  -- field would be exactly the kind of fabricated gate value AGENTS.md forbids.
  -- CP4 answers it, as a recompute over these rows rather than a re-ingest.
  normalized     jsonb NOT NULL,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT revenue_objects_kind_check
    CHECK (object_kind IN ('charge', 'refund', 'dispute')),

  -- A version below 1 would mean an apply path computed one, which is a bug
  -- worth refusing to store rather than one to discover in a ClickHouse read.
  CONSTRAINT revenue_objects_version_check CHECK (version >= 1),

  CONSTRAINT revenue_objects_site_object_key
    UNIQUE (site_id, provider, object_id)
);

-- The CP3 writer's scan: objects whose head moved since it last read. Ordered
-- by `updated_at` rather than by `version`, because versions are per object and
-- only a timestamp gives a cross-object watermark.
CREATE INDEX revenue_objects_site_updated_idx
  ON revenue_objects (site_id, updated_at DESC);

-- Refunds and disputes to their parent charge (D2d's journey entry, D6's
-- matching). Partial: only the two child kinds carry a parent, so a charge-only
-- site pays nothing for this index.
CREATE INDEX revenue_objects_parent_idx
  ON revenue_objects (site_id, provider, (normalized ->> 'parent_object_id'))
  WHERE object_kind <> 'charge';

-- ============================================================================
-- Sync cursors
-- ============================================================================
--
-- One row per (credential, resource), holding the provider's own pagination
-- cursor and the created-range window being walked. Persisted after EVERY page,
-- which is what makes a crashed backfill RESUME rather than restart: a
-- 90-day backfill of a busy account is thousands of objects, and restarting it
-- from the top on every worker restart would be a job that never finishes on
-- exactly the accounts that most need it.

CREATE TABLE revenue_sync_state (
  id            uuid PRIMARY KEY,
  credential_id uuid NOT NULL REFERENCES revenue_credentials (id) ON DELETE CASCADE,
  -- Denormalized from the credential so the deletion purge and every read can
  -- be site-scoped without a join. The credential's own FK is what keeps the
  -- two honest; nothing writes this column except the repository, from the
  -- credential row it just read.
  site_id       uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  resource      text NOT NULL,
  -- The provider's opaque pagination cursor (Stripe's `starting_after` object
  -- id). Stored verbatim and NEVER interpreted: the moment the pipeline parses
  -- a provider cursor it has taken on a compatibility promise the provider
  -- never made.
  cursor        text,
  window_start  timestamptz,
  window_end    timestamptz,
  -- Set when the resource's window has been walked to the end. Cleared when a
  -- new window opens, which is how the reconcile sweep re-walks its trailing
  -- 48 hours without inventing a second state machine.
  completed_at  timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT revenue_sync_state_resource_check
    CHECK (resource IN ('charges', 'refunds', 'disputes')),

  -- One cursor per (credential, resource). The upsert target: a page write is
  -- `ON CONFLICT ... DO UPDATE`, so two workers racing the same resource
  -- converge on one row rather than creating two half-walked cursors.
  CONSTRAINT revenue_sync_state_credential_resource_key
    UNIQUE (credential_id, resource)
);

-- The deletion purge's site-scoped delete, and the operator read "where is this
-- site's sync up to?".
CREATE INDEX revenue_sync_state_site_idx
  ON revenue_sync_state (site_id);

-- ============================================================================
-- Currency rates -- GLOBAL reference data, explicitly NOT a deletion target
-- ============================================================================
--
-- ECB daily reference rates (D2c): ~31 currencies, EUR base, published free
-- with no API key, fetched once a day by a worker loop.
--
-- **There is no `site_id` column and there will never be one.** These are the
-- European Central Bank's published rates, not a customer's bytes: they are
-- shared by every site's conversions, and a site deletion that removed them
-- would corrupt every other tenant's historical reporting. `deletion.ts` names
-- this table in a comment precisely so a future reader who notices its absence
-- from the vocabulary finds the decision instead of assuming an omission.
--
-- The rate is `numeric`, and it stays a STRING all the way from the parsed XML
-- into this column. A rate is one multiplication away from money, float money
-- has been forbidden since M0 (`money.ts`, 03 Section 6.5), and CP3's
-- conversion runs in integer minor units against this exact decimal.

CREATE TABLE currency_rates (
  -- The ECB's own banking-day stamp, not our fetch date. The ECB republishes
  -- the last banking day over a weekend or a holiday, so an idempotent upsert
  -- of the same (date, currency) is the ordinary weekend behaviour rather than
  -- an anomaly -- which is why this is a PRIMARY KEY the loop writes through
  -- rather than an append-only log the loop has to deduplicate.
  rate_date    date NOT NULL,
  currency     text NOT NULL,
  -- Units of `currency` per 1 EUR.
  rate_per_eur numeric NOT NULL,
  fetched_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT currency_rates_pkey PRIMARY KEY (rate_date, currency),

  CONSTRAINT currency_rates_currency_format CHECK (currency ~ '^[A-Z]{3}$'),

  -- Strictly positive. A zero or negative rate would silently convert every
  -- amount in that currency to nothing or to its negation -- the exact "provider
  -- outage renders as a confident zero" failure this milestone is named after,
  -- arriving through the FX door instead of the provider one.
  CONSTRAINT currency_rates_positive CHECK (rate_per_eur > 0)
);

-- "What is the newest rate for USD at or before this date?" -- the lookup CP3's
-- conversion performs per transaction, and the one that has to stay fast when a
-- backfill converts ninety days of history in one pass.
CREATE INDEX currency_rates_currency_date_idx
  ON currency_rates (currency, rate_date DESC);

-- ============================================================================
-- The backfill generation counter
-- ============================================================================
--
-- A monotonic counter on the credential, and the whole reason it exists is a
-- failure the job runner's idempotency key would otherwise make permanent.
--
-- A backfill job is enqueued under `revenue_backfill:{credential_id}:{n}`. With
-- `n` fixed, a job that reached `failed_terminal` has SPENT that key forever:
-- `enqueueJob` finds the terminal row by idempotency key and reports
-- `enqueued: false`, so no later attempt can ever start. That is exactly the
-- state a partial-permission key produces -- the connect probe reads
-- `/v1/charges` and passes, the walk reaches `/v1/disputes` and gets a 403, the
-- job terminals -- and the customer's ninety days of history become
-- unrecoverable while the reconcile sweep goes on reporting a working
-- connection.
--
-- Bumping this column mints a NEW key, so a rotation, a reconnect or an
-- operator's manual re-run each get a fresh job. The
-- `jobs_live_subject_key` partial unique still means one LIVE backfill per
-- credential, so a bump while one is running is a no-op rather than a second
-- concurrent walk.
--
-- An integer on the credential rather than a timestamp: `connected_at` does not
-- move on a key rotation, which is precisely the case that most needs a new
-- generation.

ALTER TABLE revenue_credentials
  ADD COLUMN backfill_generation integer NOT NULL DEFAULT 0;

ALTER TABLE revenue_credentials
  ADD CONSTRAINT revenue_credentials_backfill_generation_check
  CHECK (backfill_generation >= 0);
