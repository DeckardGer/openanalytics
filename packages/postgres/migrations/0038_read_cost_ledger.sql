-- What a credential's reads have cost, over a rolling day.
--
-- ADR-0043, decision 7, second half. The first half — a declared-range ceiling —
-- needs no storage: the span is in the request. This is the half that can only
-- be known afterwards, because the query gateway reports elapsed time and no
-- ClickHouse row or byte counts, so cost is measurable after a read and merely
-- guessable before one.
--
-- **Hourly buckets, not daily ones, and that is the whole shape of the table.**
-- D7 says "per rolling day". A single row per calendar day would make the budget
-- reset at midnight UTC, which is a cliff: a caller that exhausts it at 23:00 is
-- free at 00:00 and a caller that exhausts it at 00:30 waits twenty-three and a
-- half hours for the same offence. Summing the last 24 hourly rows is a genuine
-- rolling window, costs at most 24 rows per credential, and lets the refusal
-- report a `Retry-After` that is true — the oldest bucket ages out within the
-- hour rather than at some arbitrary midnight.
--
-- **The key is the credential, spelled as the rate limiter spells it** —
-- `key:<id>` or `oauth:<id>`. Deliberately a text column and not two nullable
-- foreign keys: the two credential classes live in different tables, a foreign
-- key to either would be null half the time, and the *point* of this ledger is
-- that a budget belongs to a caller regardless of which kind of credential it
-- proved itself with. It also means a revoked credential's rows do not vanish
-- and re-grant its successor a fresh budget, which a cascade would do.
--
-- Not user-scoped, so account deletion does not name it: the row keys a
-- credential, holds no personal data, no request parameters and no response, and
-- ages out on its own within two days. `api_keys_revoke` and the OAuth token
-- deletes already remove the credential the row refers to; what is left is a
-- number that describes nothing about anybody.
--
-- Expand-only: one new table.

CREATE TABLE read_cost_ledger (
  -- `key:<uuid>` / `oauth:<uuid>` — the same string the rate limiter charges,
  -- so the two gates cannot disagree about who a caller is.
  credential_key text NOT NULL,
  -- `date_trunc('hour', now())`, written by the database so two api instances
  -- cannot bucket the same instant differently.
  hour_bucket timestamptz NOT NULL,
  -- Wall-clock milliseconds this credential spent on reads in this hour.
  elapsed_ms bigint NOT NULL DEFAULT 0,
  request_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (credential_key, hour_bucket)
);

-- The sweeper's predicate, and only that. The read path always names a
-- credential, so it uses the primary key; this index exists for the delete that
-- trims the table by age.
CREATE INDEX read_cost_ledger_hour_bucket_idx ON read_cost_ledger (hour_bucket);
