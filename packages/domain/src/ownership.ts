/**
 * Ownership-cutover decisions (docs snapshot 05, D-010–D-013).
 *
 * These are the pure rules the transaction service applies; the transaction
 * itself (locking, assignment history, revocation) lives in
 * `packages/postgres`. Keeping the decision here makes the "no rollback — block
 * instead" and the "24h grace vs no grace" rules testable without a database.
 */

/**
 * The maximum age of the acting owner's session for a sensitive ownership change
 * (docs snapshot 04, Milestone 2 item 7 — recent re-auth). Removing the billing
 * owner is destructive and outward-facing, so it requires a recently
 * authenticated session, not merely a live one.
 */
export const SENSITIVE_ACTION_MAX_SESSION_AGE_SECONDS = 300

/** Whether a session is recent enough to authorize a sensitive action. */
export function isRecentReauth(
  sessionCreatedAt: Date,
  now: Date,
  maxAgeSeconds: number = SENSITIVE_ACTION_MAX_SESSION_AGE_SECONDS,
): boolean {
  const ageSeconds = (now.getTime() - sessionCreatedAt.getTime()) / 1000
  return ageSeconds >= 0 && ageSeconds <= maxAgeSeconds
}
