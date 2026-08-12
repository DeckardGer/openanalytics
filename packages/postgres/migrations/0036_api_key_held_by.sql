-- A key says whose it is, and a surviving one says it wants rotating.
--
-- ADR-0043, decision 8. Docs snapshot 02 §19 has one sentence about what happens
-- to a departing member's credentials, and it has four clauses. The first —
-- revoke the removed owner's private keys — has never run: `removeMember`
-- revokes their revenue credentials and their realtime access in one
-- transaction and leaves `api_keys` alone. The second and third have never been
-- expressible at all:
--
--   the public/write-only tracking key and the site-owned analytics/config
--   keys stay with the site;
--   a suspect site service credential survives an ownership change only
--   through the new owner's explicit rotate/reissue flow.
--
-- These two columns are those clauses.
--
-- **Why the missing column is the second clause's and not the first's.** The
-- first clause's criterion is "`created_by_user_id` is this user AND the secret
-- was shown to them", which reads like two facts and is one: `insertApiKey`
-- returns the raw token exactly once, to the session that called it, and no
-- reveal-to-another-member path exists anywhere in the product. Those two
-- conjuncts name the same person in every row this system can produce, so a
-- `secret_shown_to_user_id` column would hold no information. What genuinely
-- cannot be recovered from the existing row is what happened *after* the token
-- was shown — whether its holder kept it or installed it into a machine.
--
-- That is what decides whether revoking is correct. Revoking every key of a
-- departing member takes down the WordPress plugin they installed, on a site
-- where nothing went wrong, over a personnel change (ADR-0043 D1). Revoking
-- none leaves an evicted admin holding a live `analytics:read` credential.
-- `held_by` is what lets each get the answer §19 already chose for it.
--
-- **`rotation_required_at` is why the carve-out is not simply a leak.** A
-- surviving site key is still a secret the departed person once saw. The column
-- does not pretend otherwise; it makes the exposure a state an owner can see and
-- act on, and the action is revoke-then-mint (ADR-0042 D2), which is the whole
-- of rotation and leaves no window with no working credential. §19's third
-- clause says a suspect site credential is kept *only* through that explicit
-- flow, and an invisible flag would not be that.
--
-- **Direction.** The default is `'user'`, the value that revokes. Defaulting to
-- `'site'` would make every key ever minted survive an eviction on the day this
-- migration ran, silently — the mistake ADR-0042 D3's backfill direction exists
-- to prevent, in the other register.
--
-- **`tracking_write` rows are set to `'site'`, and this asserts nothing new.**
-- `account-deletion.ts` has excluded them from its revocation sweep since M10
-- and states the reason in a comment: "they are the site's public tracker token,
-- not this person's credential". This moves that sentence out of the comment and
-- into the row, after which the private-key rule stops being a special case and
-- becomes the same rule reading a different value. `apiKeyHolderFrom` returns
-- `'site'` for a tracking key regardless of the column, which is what covers the
-- window between this migration and the new api build — the same belt-and-braces
-- pair migration 0034 used for scopes, in the same direction.
--
-- Expand-only: two nullable-or-defaulted columns and one CHECK. The old api
-- build keeps inserting rows without either column and they land on the default,
-- which is the safe value. Nothing is dropped or re-typed.

ALTER TABLE api_keys
  ADD COLUMN held_by text NOT NULL DEFAULT 'user',
  ADD COLUMN rotation_required_at timestamptz;

ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_held_by_check CHECK (held_by IN ('user', 'site'));

UPDATE api_keys
SET held_by = 'site'
WHERE type = 'tracking_write'
  AND held_by <> 'site';

-- The flag is read on one screen and written by one event, so the index is the
-- partial one that matches how it is asked about: "does this site have keys
-- waiting to be rotated". Rows without a flag — every row, almost always — are
-- not in it.
CREATE INDEX api_keys_rotation_required_idx
  ON api_keys (site_id)
  WHERE rotation_required_at IS NOT NULL AND revoked_at IS NULL;
