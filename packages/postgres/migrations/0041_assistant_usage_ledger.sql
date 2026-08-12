-- How many questions a person has asked the assistant, and what they cost.
--
-- ADR-0046, decision 5. F-306 sets the limit — at most 20 questions per user
-- per day — and asks for two things a counter cannot give: usage that is
-- *measurable and reportable*, and a limit that can later vary by plan. That is
-- a table, not an in-process counter: `GET /v1/assistant/usage` reads this, the
-- accept path enforces from it, and a plan-varying limit later is a lookup
-- where the constant is read rather than a new mechanism.
--
-- **Hourly buckets, not a row per calendar day**, and the argument is the one
-- `read_cost_ledger` (migration 0038) already made and this repository already
-- lives with. A single daily row resets the allowance at midnight UTC, which is
-- a cliff: a user who spends their twentieth question at 23:00 is free in an
-- hour and one who spends it at 00:30 waits twenty-three and a half for the
-- same offence. Summing the buckets of the last rolling day costs at most 24
-- rows per user, makes the window genuinely rolling, and — the reason it is
-- worth the extra rows — lets the `429` report a `Retry-After` that is **true**:
-- the moment the oldest charged bucket leaves the window is a real instant this
-- table knows, not a guess about tomorrow.
--
-- **The key is the user.** F-306 says "per user". A session-keyed quota would
-- reset on sign-out, which is the cheapest possible way around it, and a
-- site-keyed one would misdescribe a question the model answered by reading
-- three sites.
--
-- **Therefore an account-deletion target** (`ACCOUNT_DELETION_POSTGRES_TARGETS`
-- moves 16 -> 17, and the teardown deletes these rows in the same transaction as
-- the rest). The contrast with `read_cost_ledger` is worth being exact about,
-- because the two tables look alike and only one of them is in the registry:
-- that one is keyed by a *credential*, and its own header argues that what
-- remains after the credential is deleted "is a number that describes nothing
-- about anybody". This one is keyed by a *person*. It holds no message text, no
-- tool arguments and no answers — D12 stores no conversation at all — but
-- counts under a user id are that user's data, and the registry is the
-- mechanism for saying so. It is **not** site-scoped, so `SITE_DELETION_TARGETS`
-- stays at 63: deleting a site refunds nobody's questions.
--
-- The foreign key carries **no ON DELETE action**, deliberately, and this is
-- migration 0037's rule applied at the moment the table is written rather than
-- eight milestones later. Account deletion *scrubs* the `users` row instead of
-- deleting it (ADR-0030 D8), so a cascade here could never fire — and a
-- declared cascade that cannot run is worse than none, because it reads as
-- coverage. That is exactly how `idempotency_keys` outlived account deletion
-- until 2026-08-06. The reference stays, without an action, because the
-- relationship is real and worth stating.
--
-- **Tokens are bigint and questions are not.** A question count per user per
-- hour fits an `integer` with room to spare; a token count does not obviously,
-- and a counter that wraps is worse than one that is wide. They are a
-- measurement rather than a budget — nothing refuses on them in v1 — and they
-- exist because "20 questions" is not a cost: a plan tier priced on assistant
-- usage will be priced on tokens, and the data has to have been collected
-- before that decision rather than after it.
--
-- Expand-only: one new table.

CREATE TABLE assistant_usage_ledger (
  -- The person, not the session and not the site. No ON DELETE action; see the
  -- header — the users row is scrubbed, never deleted, and account deletion
  -- names this table explicitly.
  user_id uuid NOT NULL REFERENCES users (id),
  -- `date_trunc('hour', now())`, written by the database so two api instances
  -- cannot bucket the same instant differently.
  hour_bucket timestamptz NOT NULL,
  -- Charged at accept — after validation, before the provider call. Validation
  -- failures are free; provider failures are not, or failure would be the
  -- cheapest way to farm free retries.
  question_count integer NOT NULL DEFAULT 0,
  -- Written as usage arrives, because they are not known at accept.
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, hour_bucket)
);

-- The sweeper's predicate, and only that. Every read names a user, so it uses
-- the primary key; this index exists for the delete that trims the table by age
-- on the same hourly tick that trims `read_cost_ledger`.
CREATE INDEX assistant_usage_ledger_hour_bucket_idx ON assistant_usage_ledger (hour_bucket);
