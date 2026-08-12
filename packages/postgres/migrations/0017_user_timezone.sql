-- A user's home timezone (ADR-0026).
--
-- Rollout note: additive -- one nullable column on an existing table, no
-- backfill, no default, no index. It applies to a live database instantly and
-- nothing behaves differently until a user picks a zone: every existing row is
-- NULL, and NULL means "not chosen yet" (forward-only; migrations 0001-0016 are
-- never edited -- D-214).
--
-- Why on `users` rather than on `sites`. A timezone is a property of the person
-- reading the chart, not of the traffic being charted. One human has one mental
-- clock and carries it across every site they can see; a per-site preference
-- would ask the same person the same question once per site and then disagree
-- with itself when they switch tabs. The analytics query surface is unchanged --
-- timezone stays a per-request parameter (02 §18), and the frontend sends this
-- stored value on each read.
--
-- Why `users` and not a side table. Better Auth owns writes to this table
-- (migration 0001), and its adapter is configured with an `additionalFields`
-- entry for exactly this column, so the value rides along on the session
-- response the frontend already fetches instead of costing a second round trip.
-- A side table would be a join on every session read for one nullable string.
--
-- NULL semantics: "the user has never chosen". The frontend then falls back to
-- the browser's `Intl.DateTimeFormat().resolvedOptions().timeZone`. There is
-- deliberately no server-side default: a server that guessed UTC would be
-- confidently wrong for everyone outside it, and indistinguishable from a user
-- who genuinely chose UTC.

ALTER TABLE users
  ADD COLUMN timezone text,
  -- Shape and length only. Whether an identifier actually exists in the IANA
  -- database is a question only a tz-aware runtime can answer, and the API
  -- answers it on write with `isValidTimezone` (packages/contracts/src/time.ts)
  -- before anything reaches here. This constraint is the floor under that check:
  -- it bounds the column to the same 1..64 characters the wire schema allows and
  -- refuses anything that is not identifier-shaped, so a direct SQL write cannot
  -- store a value the read path would have to defend against.
  ADD CONSTRAINT users_timezone_format
    CHECK (
      timezone IS NULL
      OR (
        char_length(timezone) BETWEEN 1 AND 64
        AND timezone ~ '^[A-Za-z][A-Za-z0-9._+-]*(/[A-Za-z0-9._+-]+)*$'
      )
    );
