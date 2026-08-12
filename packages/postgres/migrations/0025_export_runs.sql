-- Export runs (ADR-0032, D8/D9). Milestone 11 CP4.
--
-- Rollout note: expand-only. One new table, no backfill, nothing existing
-- changes shape -- a build that predates this migration keeps working against
-- the same rows and simply never exports. 0023 and 0024 are applied and are
-- therefore never edited (D-214).
--
-- The row is the export's whole durable state. The bytes live in object storage
-- for seven days and the row outlives them, which is deliberate: "this customer
-- exported their data on the 3rd" is an audit fact, and it must not disappear
-- when the artefact does.

CREATE TABLE export_runs (
  id                    uuid PRIMARY KEY,
  site_id               uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  -- **Nullable, and ON DELETE SET NULL.** Account deletion scrubs the users row
  -- rather than deleting it (ADR-0030, D8), so in practice this survives as the
  -- tombstoned user's id and the audit trail stays joinable. The FK is the
  -- backstop for the one path that ever does delete a user: an export that
  -- outlives its requester is still a real export of a still-real site, and
  -- taking the row with the user would erase the site's history to record the
  -- person's departure.
  requested_by          uuid REFERENCES users (id) ON DELETE SET NULL,
  state                 text NOT NULL DEFAULT 'queued'
                          CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'expired')),
  -- **The consistency pin, half one** (D8). Every events query the job issues
  -- binds `accepted_at <= cutoff`, so a chunk written in the tenth minute of an
  -- export covers exactly the same event set as one written in the first.
  --
  -- Stamped from the DATABASE clock at insert, never from the api's: `accepted_at`
  -- is written by the worker against the same clock family, and a cutoff taken
  -- from a service whose clock runs a minute fast would silently exclude a
  -- minute of the customer's most recent data.
  cutoff                timestamptz NOT NULL,
  -- **The consistency pin, half two** (D8). The site's `published_import_run_id`
  -- as it stood in the same snapshot the cutoff was taken in. Without it, a
  -- publish or a rollback landing mid-export would make the imported chunks
  -- disagree with each other -- some from the old generation, some from the new.
  --
  -- ON DELETE SET NULL rather than CASCADE, and rather than RESTRICT: a run
  -- cleaned up while an export was reading it must not delete the export row
  -- (CASCADE) and must not block the cleanup either (RESTRICT). The export
  -- degrades honestly instead -- its already-written chunks stay valid, because
  -- rows are keyed by run id and the cleanup deleted exactly those rows, so a
  -- later chunk simply reads empty.
  pinned_import_run_id  uuid REFERENCES import_runs (id) ON DELETE SET NULL,
  -- The chunk list, written ONCE at success: key, kind, month/report, rows,
  -- sha256, bytes. jsonb because it is one value read and written whole by one
  -- writer holding the job lease, and a row per chunk would be a join and a
  -- delete for data with no independent lifetime.
  --
  -- Its presence on the row means the same thing its presence in the bucket
  -- does: the export is complete.
  manifest              jsonb,
  -- The same chunk records, appended as each object LANDS rather than at the
  -- end -- which is what makes an unfinished export's bytes addressable at all.
  --
  -- The storage port deliberately has no `list` (D9), so an object whose key
  -- was never recorded in Postgres is an object nothing can ever find again. An
  -- export that dies half way has written real bytes into the customer's bucket,
  -- and this column is the only thing that lets a site deletion enumerate them.
  -- It also serves the resume path: a reclaimed lease skips the chunks recorded
  -- here after verifying each is still present.
  progress              jsonb,
  -- `exports/{site_id}/{export_id}/`. Recorded rather than recomputed, so a
  -- deletion enumerates the keys this export actually wrote and not the ones
  -- today's build would write.
  object_prefix         text NOT NULL,
  -- A safe category, never a provider message or a stack fragment: it is
  -- rendered to the customer.
  error_code            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  started_at            timestamptz,
  finished_at           timestamptz,
  -- Reserved for the lifecycle backstop, in the shape `import_runs.swept_at`
  -- already has: its only job is to make a repeated sweep terminate. The bucket's
  -- `exports/` expiry rule is the mechanism of record for these bytes (D1), so
  -- nothing sets this yet -- it exists so a future sweep does not need a
  -- migration to become resumable.
  swept_at              timestamptz
);

-- The list read: a site's exports, newest first.
CREATE INDEX export_runs_site_idx ON export_runs (site_id, created_at DESC);

-- The live-export lookup. Deliberately NOT a unique index: ADR-0032 D8 makes the
-- jobs table's `(type, subject_id)` liveness index the serializer, and unlike
-- the import case it genuinely applies -- an export is ONE job type, so one live
-- `export_run` job per site is one live export per site. A second unique here
-- would be a second mechanism claiming the same guarantee, and the two would
-- disagree the first time a job was settled without its run being moved.
--
-- What this index is for is the api's answer: naming the run that is in the way
-- so a 409 has something to act on.
CREATE INDEX export_runs_live_idx ON export_runs (site_id)
  WHERE state IN ('queued', 'running');

-- The lazy-expiry read, and the future sweep's scan. Partial on the one state
-- that can still expire, so the index is the size of the outstanding downloads
-- rather than of the installation's whole export history.
CREATE INDEX export_runs_expiry_idx ON export_runs (finished_at)
  WHERE state = 'succeeded';
