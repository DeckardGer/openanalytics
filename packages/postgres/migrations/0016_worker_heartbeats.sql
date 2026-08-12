-- The ingest pipeline's liveness heartbeat (docs snapshot 02 §18 freshness
-- metadata; ADR-0025).
--
-- Rollout note: additive -- one new table, and no change to any existing table,
-- column, constraint or index. It applies to a live database with no backfill,
-- and nothing behaves differently until the worker writes its first row: the
-- read API keeps its old watermark rule while this table is empty (forward-only;
-- migrations 0001-0015 are never edited -- D-214).
--
-- Why it exists. `meta.freshness.state` was derived from one number: the age of
-- the newest rollup bucket *the site* has. That number is the age of the site's
-- last visitor, not the age of the pipeline. A perfectly healthy site with no
-- traffic for ten minutes therefore read as `stale` -- an accusation against our
-- own infrastructure, told to the customer whose site is merely quiet. The
-- inverse is the worse half: once `stale` fires on every quiet night, a real
-- ingest stall is indistinguishable from one, and the field stops being read.
--
-- Separating "nobody visited" from "we are behind" needs a signal that ticks
-- whether or not anyone visits. The ingest consumer loop is exactly that: it
-- wakes on a blocking stream read roughly every 1.5 seconds and reports the
-- queue age on every iteration, empty or not. This table is where that tick is
-- recorded so a process that is *not* the worker -- the read API, which shares
-- Postgres and nothing else with it -- can observe it.
--
-- The grain is the pipeline, not the worker instance. `id` is a pipeline name
-- ('ingest'), so N workers share one row and the most recent writer wins. The
-- question a reader asks is "is ingest running at all", which the newest tick
-- across the fleet answers exactly; a row per instance would answer "is
-- instance-7 running", which nobody asked and which a rescheduled container
-- would answer wrong forever after. `consumer` records which instance wrote the
-- row last: a diagnostic for an operator reading the table by hand, never a key
-- and never something a reader branches on.
--
-- queue_oldest_age_ms rides along because "the loop is ticking" and "the loop is
-- keeping up" are different failures wearing the same customer-visible symptom.
-- A worker spinning happily in front of a million-message backlog is not fresh,
-- so the freshness read treats a backlog older than its threshold exactly as it
-- treats a dead loop.
--
-- Retention: bounded by construction. One row per pipeline, updated in place,
-- so there is nothing here for a sweeper to do.

CREATE TABLE worker_heartbeats (
  -- The pipeline's name, e.g. 'ingest'. Deliberately not an instance id.
  id                   text PRIMARY KEY,

  -- The consumer instance that wrote this row last. Diagnostic only.
  consumer             text NOT NULL,

  -- The instant of the tick this row records: the liveness signal itself. Taken
  -- from the worker's own clock, because it is the worker's liveness being
  -- claimed -- `now()` here would record when Postgres was written to, which is
  -- true even of a write issued by a loop that then hung.
  last_tick_at         timestamptz NOT NULL,

  -- Age of the oldest unprocessed queue message at that tick; 0 when the queue
  -- was empty, which is the same convention the G-006 gauge reports (a metric
  -- that stops being emitted is indistinguishable from one that cannot be
  -- scraped).
  queue_oldest_age_ms  bigint NOT NULL DEFAULT 0,

  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- An age is a duration and never a negative one. Without this, a clock skew
  -- that produced one would be stored and read back as "the queue is ahead of
  -- now", which the freshness comparison would silently accept as healthy.
  CONSTRAINT worker_heartbeats_queue_age_check CHECK (queue_oldest_age_ms >= 0)
);
