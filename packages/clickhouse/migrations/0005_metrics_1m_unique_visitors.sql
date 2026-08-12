-- Add the unique-visitor state column to metrics_1m (plan Milestone 7 item 1).
--
-- Rollout note: an expand step. It adds a mergeable aggregate column by ALTER
-- and repoints the minute view to populate it -- no target-table swap and no
-- backfill. The collector is not yet deployed (ADR-0010 leaves in-region
-- freshness open precisely because "the worker alone has nothing to consume"),
-- so events_raw carries no live traffic to backfill. A view only ever sees the
-- blocks inserted after it exists, so on a populated table this would need a
-- separate backfill step over the historical partitions -- there is none to run
-- here, and this note records the shape that step would take if that changes.
--
-- Why an ALTER rather than a new target and a swap: migration 0003 chose
-- AggregatingMergeTree with SimpleAggregateFunction counters for exactly this
-- moment. A SummingMergeTree cannot merge an AggregateFunction column, so it
-- would have forced a replacement table and a backfill. AggregatingMergeTree
-- merges both the SimpleAggregateFunction sums already present and the
-- AggregateFunction(uniq) state added here, so the expansion is one ADD COLUMN.
--
-- The visitor identity (docs snapshot 02 §10 "Unique visitors"): the resolved
-- identity is the customer-supplied identify() id when present, otherwise the
-- daily-rotating anonymous id. §10 defines a unique visitor over "unique
-- anonymous_id/resolved identity", and names the resolved identity as taking
-- precedence -- an identified visitor is one visitor across the UTC day
-- boundary the anonymous id rotates on. So the identity expression is
--   if(user_id != '', user_id, anonymous_id)
-- user_id is the site-scoped HMAC of the customer's own user id (never raw PII,
-- migration 0001), anonymous_id is the day-bounded HMAC (D-102). Both are
-- site-scoped, so this never merges identities across sites. This same
-- expression is used by every rollup that carries visitors, so the definition
-- lives in one place per file and never diverges between tables.
--
-- Uniques are kept as a merge state, never a bucket sum: adding a minute's
-- unique count to the next minute's would double-count a visitor active in both
-- (docs snapshot 02 §15, plan item 2). uniqState merges across buckets with
-- uniqMerge, which counts each visitor once over any range the query rolls up.
--
-- A materialized view cannot be edited in place. Repointing metrics_1m_mv is a
-- DROP plus CREATE, which is a forward migration and not an edit to 0003 (an
-- applied migration is never edited -- docs snapshot 05, D-214 -- and
-- CREATE MATERIALIZED VIEW IF NOT EXISTS would not replace a deployed view even
-- if 0003 were changed). Dropping a view does not touch its target table, so
-- metrics_1m keeps every row and every setting it already had (this is the
-- precedent migration 0004 set for performance_events_mv).
--
-- non_replicated_deduplication_window is unchanged and still 1000 on metrics_1m
-- from 0003. It is the raw batch token reaching this target that keeps a retried
-- insert from firing the view twice (ADR-0005) -- the ALTER neither needs nor
-- may restate it, because ALTER TABLE MODIFY SETTING is a separate operation and
-- the window the table was created with still stands.

ALTER TABLE metrics_1m
  ADD COLUMN IF NOT EXISTS visitors AggregateFunction(uniq, String);

DROP TABLE IF EXISTS metrics_1m_mv;

CREATE MATERIALIZED VIEW IF NOT EXISTS metrics_1m_mv TO metrics_1m AS
SELECT
  site_id,
  toStartOfMinute(toDateTime(occurred_at, 'UTC'))        AS bucket_start,
  type                                                    AS event_type,
  count()                                                 AS events,
  countIf(billable = 1)                                   AS billable_events,
  uniqState(if(user_id != '', user_id, anonymous_id))     AS visitors
FROM events_raw
GROUP BY site_id, bucket_start, event_type
