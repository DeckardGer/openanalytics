-- Publish, rollback and the cleanup backstop (ADR-0032, D3/D7). Milestone 11 CP2.
--
-- Rollout note: expand-only. Three nullable columns and one partial index on
-- `import_runs`. Nothing is backfilled, no existing column changes shape, and a
-- build that predates this migration keeps working -- it simply never publishes.
-- 0023 is applied and is therefore never edited (D-214).

-- **The rollback generation, named explicitly.**
--
-- D3 keeps exactly ONE rollback generation: publishing run C supersedes B and
-- cleans A. Without this column, "which run does a rollback restore?" would have
-- to be inferred -- most obviously as "the most recent `superseded` run of this
-- site" -- and that inference is wrong in the case that matters. A site whose
-- history is A superseded by B superseded by C has two superseded runs, and only
-- one of them is C's predecessor. Ordering by a timestamp would usually agree
-- and would stop agreeing exactly when a cleanup failed, a run was published out
-- of order after a rollback, or two runs settled in the same millisecond.
--
-- Written during the publish swap, it makes rollback a lookup rather than a
-- guess, and it gives cleanup the distinction it needs: a `superseded` run that
-- IS some run's `superseded_run_id` is the live rollback generation and must be
-- kept, while one that is not is the grandparent and may be erased.
--
-- Self-referential FK. `ON DELETE SET NULL` rather than CASCADE: the pointed-at
-- run being deleted must not take the pointing run with it -- that would delete
-- the site's *published* run because its long-dead predecessor was purged.
ALTER TABLE import_runs
  ADD COLUMN superseded_run_id uuid REFERENCES import_runs (id) ON DELETE SET NULL;

-- Which chunk of which report staging has durably inserted (D7).
--
-- `{"pages": 3}` means chunks 0, 1 and 2 of the pages report are committed and a
-- resumed run starts at 3. Recorded AFTER each insert returns, so the worst case
-- is a chunk re-inserted under the token it already used -- which the table's
-- `non_replicated_deduplication_window` turns into a no-op. Recorded before the
-- insert, a crash in between would skip a chunk forever, and the run would
-- publish with a hole in it that nothing would ever detect.
--
-- jsonb rather than a `import_run_chunks` table: the whole object is read and
-- written as one value by one writer holding the job lease, so a row per chunk
-- would be a join and a delete for data that has no independent lifetime.
ALTER TABLE import_runs
  ADD COLUMN staging_progress jsonb;

-- When the sweeper's backstop last cleaned this run's staged rows and object.
--
-- Its purpose is to make the backstop's scan *terminate*. A terminal run's
-- ClickHouse rows are deleted by the job that failed it or by the publish that
-- superseded it, but a job can die between the state change and the cleanup, so
-- something has to look again later. Without a marker, "look again later" means
-- every terminal run the installation has ever recorded, forever -- a scan whose
-- cost grows with history and whose work is almost always zero. With it, a run
-- is examined once and then leaves the candidate set.
--
-- It is deliberately NOT a state: a swept run is still `failed` or `superseded`,
-- and adding a `cleaned` state would have made the rollback generation and the
-- customer-visible history depend on whether a background sweep had run yet.
ALTER TABLE import_runs
  ADD COLUMN swept_at timestamptz;

-- The backstop's own index, predicate-matched to its query for the reason
-- `import_runs_expiry_idx` gives: the scan is over runs that can still need
-- cleaning rather than over every run that has ever existed. `published` is
-- outside it because a published run's rows are the site's live data, and
-- `uploading`/`uploaded` are the abandoned-upload sweep's, not this one's.
CREATE INDEX import_runs_sweep_idx ON import_runs (updated_at)
  WHERE swept_at IS NULL
    AND state IN ('failed', 'discarded', 'rolled_back', 'superseded');

-- Rollback's lookup: the run a given run superseded. Also what the grandparent
-- cleanup asks the other way round -- "is this superseded run still the
-- *published* run's predecessor?" -- which without an index is a sequential scan
-- of the site's whole import history on every publish.
CREATE INDEX import_runs_superseded_idx ON import_runs (superseded_run_id)
  WHERE superseded_run_id IS NOT NULL;

-- The publish-time cleanup scan, which is site-scoped rather than global and so
-- cannot use `import_runs_sweep_idx` above (that one leads with `updated_at`,
-- for the sweeper's ordered global page). This query filters on the site first,
-- then on the state, over rows not yet claimed -- so the index leads the same
-- way. Partial on `swept_at IS NULL` because a cleaned run is never a candidate
-- again, which keeps the index the size of the outstanding work rather than of
-- the installation's whole import history.
--
-- The state is in the key rather than the predicate on purpose: this query asks
-- for `superseded` OR the three self-terminal states, and a predicate naming a
-- fixed set would stop being usable the day the cleanable set changes.
CREATE INDEX import_runs_site_sweep_idx ON import_runs (site_id, state)
  WHERE swept_at IS NULL;
