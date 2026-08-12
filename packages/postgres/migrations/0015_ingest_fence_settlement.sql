-- The write fence gains a fourth, terminal state: `abandoned`.
--
-- Rollout note: additive — one widened CHECK on `ingest_batch_sites.state`, no
-- new column, no backfill, no change to any existing row. The old vocabulary is
-- a strict subset of the new one, so a rolled-back app writes only values the
-- new constraint still accepts (forward-only; 0001-0014 are never edited —
-- D-214).
--
-- Why it exists: the M10 deletion drain waits for every `registered` row on a
-- site below the new generation to reach a terminal state. Two paths left rows
-- in `registered` forever, and either one would have stalled a deletion behind a
-- writer that had already stopped:
--
--   * a dead-lettered batch. `markDeadLettered` moved the manifest to its
--     terminal state and never touched the fence rows, so the registrations of a
--     batch that had permanently given up stayed in flight by the drain's
--     definition;
--   * a crash between `markInserted` and `markBatchSitesWritten`. Recovery reads
--     the manifest and resumes at `record_usage`, which skipped the settle step
--     entirely — the batch then completed with its fence rows still `registered`.
--
-- `written` was not reusable for the dead-letter case. It states that the rows
-- this registration described are durable in ClickHouse, and for a batch that
-- died in `pending` or `inserting` that is exactly what nobody knows. `dropped`
-- was not reusable either: it means the fence refused the write, and the
-- `(state = 'dropped') = (drop_reason IS NOT NULL)` invariant would demand a
-- D-210 reason that never applied. So the honest fourth answer: the batch
-- stopped, no further write will be issued under this registration, and the
-- drain may stop waiting for it.
--
-- What the drain must NOT conclude from `abandoned` is that nothing was written.
-- A batch dead-lettered from `inserting` may have landed rows before it failed;
-- deletion removes a site's ClickHouse rows by site id regardless of which batch
-- produced them, so the two facts never have to be reconciled.

ALTER TABLE ingest_batch_sites
  DROP CONSTRAINT ingest_batch_sites_state_check;

ALTER TABLE ingest_batch_sites
  ADD CONSTRAINT ingest_batch_sites_state_check CHECK (
    state IN ('registered', 'written', 'dropped', 'abandoned')
  );
