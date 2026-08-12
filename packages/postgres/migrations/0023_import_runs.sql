-- Import runs and their staged uploads (ADR-0032, D3/D6/D9).
--
-- Rollout note: expand-only. Two new tables and one nullable column on `sites`.
-- Nothing is backfilled and nothing existing changes shape, so a build that
-- predates this migration keeps working against the same rows -- it simply never
-- writes an import.
--
-- Postgres owns the truth about which import a site is showing. Not ClickHouse:
-- the staged rows are keyed by run id and are invisible until this table's
-- pointer names them, which is what makes publish and rollback single-row
-- transactions instead of fleets of mutations (D2/D3).

CREATE TABLE import_runs (
  id                  uuid PRIMARY KEY,
  site_id             uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  -- Free text against the catalog in `packages/domain/src/import-providers.ts`,
  -- not an enum: adding an adapter is a code change behind one descriptor
  -- framework (D11) and must not also be a migration.
  provider            text NOT NULL,
  state               text NOT NULL DEFAULT 'uploading'
                        CHECK (state IN ('uploading', 'uploaded', 'validating', 'processing',
                                         'ready_for_review', 'publishing', 'published',
                                         'failed', 'discarded', 'superseded', 'rolled_back')),
  -- Per-report row counts, the imported date range and the staging warnings the
  -- reviewer has to see before publishing (dropped city column, dropped
  -- entry/exit reports, rows past the cutover). jsonb because the shape is the
  -- provider adapter's, and a column per report would be a migration per
  -- provider.
  summary             jsonb,
  -- The calendar date that partitions imported from live reads (D4). Chosen at
  -- review time, so NULL until the run reaches `ready_for_review`.
  cutover_date        date,
  -- The chunk size staging started with. Recorded on the row and reused by every
  -- retry: the ClickHouse insert dedup token is `{run}:{report}:{chunk_no}`, so a
  -- deploy that retuned the policy default mid-run would make the same token name
  -- a different set of rows and the retry would duplicate rather than deduplicate
  -- (D7).
  staging_chunk_bytes bigint,
  -- A safe category, never a provider message or a stack fragment: it is
  -- rendered to the customer.
  error_code          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz
);

-- One non-terminal run per site (D3).
--
-- This -- not the jobs table's `(type, subject_id)` unique -- is what makes two
-- concurrent imports impossible. That one is per *type*, and `import_prepare`
-- and `import_publish` are different types, so it would happily admit a publish
-- of one run beside a prepare of another. The predicate here lists exactly the
-- states a run can still move out of by itself, which is why `ready_for_review`
-- is inside it: a review that takes days still holds the site's import slot,
-- even though it holds no job lease.
--
-- The terminal states are outside the index so a *later* import is allowed once
-- the first has settled -- history does not block the future.
CREATE UNIQUE INDEX import_runs_live_site_key ON import_runs (site_id)
  WHERE state IN ('uploading', 'uploaded', 'validating', 'processing',
                  'ready_for_review', 'publishing');

-- The list read: a site's runs, newest first.
CREATE INDEX import_runs_site_idx ON import_runs (site_id, created_at DESC);

-- The abandoned-upload sweep (D7). Its predicate is exactly the sweep's, so the
-- scan is over the runs that can still expire rather than over every run the
-- installation has ever recorded -- which is the set that grows forever while
-- this one stays bounded by the number of imports currently in flight.
CREATE INDEX import_runs_expiry_idx ON import_runs (created_at)
  WHERE state IN ('uploading', 'uploaded');

-- The staged archive. A row per upload rather than columns on the run, because
-- the deletion registry enumerates object keys from Postgres (D9) and a table it
-- can scan by run is what makes that enumeration a query rather than a
-- convention. It is also where a multipart plan's session would be recorded when
-- one exists -- CP1 mints single-PUT URLs only.
CREATE TABLE import_uploads (
  id             uuid PRIMARY KEY,
  import_run_id  uuid NOT NULL REFERENCES import_runs (id) ON DELETE CASCADE,
  -- Id-addressed: `imports/{site_id}/{run_id}/archive.zip`. Nothing customer-
  -- supplied steers it.
  object_key     text NOT NULL,
  -- What the client said it would upload, and what the signed URL therefore
  -- binds. The `complete` call re-reads the object and refuses a mismatch.
  declared_bytes bigint NOT NULL,
  content_type   text NOT NULL,
  -- The ETag observed at `complete` time, NULL until then. The worker verifies
  -- it before parsing, so a client that re-PUTs different bytes through the
  -- still-valid signed URL after the size check fails the run instead of having
  -- unchecked content imported (D6 step 2).
  etag           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  -- **One upload row per run**, and it is a constraint rather than a convention
  -- because two functions already assume it: `pinUploadEtag` updates *the* row
  -- of a run and `readImportUpload` reads *the* row of a run. Without the
  -- unique, a second row would make one of them write what the other does not
  -- read, and the ETag the worker verifies against would be a coin flip. v1
  -- mints exactly one single-PUT URL per run (D6); if a multipart plan ever
  -- needs a row per part, that is an explicit migration, not a silent second
  -- insert.
  CONSTRAINT import_uploads_run_key UNIQUE (import_run_id)
);

-- **The pointer** (D3). Publishing is one transaction that moves it; every
-- analytics read resolves it from the row the membership middleware already
-- loads and binds it as a query parameter, so a publish or rollback changes the
-- gateway cache key on the very next request and the pointer itself is never
-- cached.
--
-- The FK direction is the D9 cycle: `import_runs.site_id` references `sites`
-- while this references `import_runs`. That is why the column is added *here*,
-- after the table it points at exists, and why the site purge nulls it before
-- deleting the runs. `ON DELETE SET NULL` is the schema-level backstop for a
-- path that forgets to -- not the mechanism of record.
ALTER TABLE sites
  ADD COLUMN published_import_run_id uuid REFERENCES import_runs (id) ON DELETE SET NULL;
