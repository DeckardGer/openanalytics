import { and, eq, sql } from 'drizzle-orm'
import type { Database } from '../client.ts'
import { users } from '../schema/auth.ts'

/** The identity columns a request principal carries (ADR-0048 D2). */
export interface AuthedUserRow {
  readonly id: string
  readonly email: string
  readonly emailVerified: boolean
  readonly createdAt: Date
}

/**
 * The identity a live OAuth grant resolves to, for the grant arm of
 * `principalAuth` (ADR-0048 D2).
 *
 * A session-authenticated request gets these fields from Better Auth's session
 * read; a grant-authenticated one has only a `user_id`, so it reads the same
 * columns here. Fetching them — rather than leaving `user` half-populated —
 * is what makes a grant principal indistinguishable from a session principal
 * to every downstream handler, which is the whole point of "writes ride the
 * real routes". `null` when the row is gone: a grant whose user was deleted
 * between token issuance and now authenticates nobody.
 */
export async function getAuthedUserById(
  db: Database,
  userId: string,
): Promise<AuthedUserRow | null> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      emailVerified: users.emailVerified,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, userId))
  return row ? { ...row, createdAt: new Date(row.createdAt) } : null
}

/**
 * Whether this deployment has anybody in it yet.
 *
 * The one question the first-run screen turns on: an install with no users has
 * no way in at all, so `/login` offers to create the first account instead of
 * asking for one that cannot exist. The moment a row appears the offer is gone
 * and never comes back — which is what makes an unauthenticated create
 * endpoint safe to mount.
 *
 * `limit 1` and no `count`: the answer is a boolean and the table grows. On a
 * hosted deployment with a hundred thousand rows this reads one and stops.
 */
export async function hasAnyUser(db: Database): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(users)
    .limit(1)
  return row !== undefined
}

/**
 * Mark an address verified without a mail round trip.
 *
 * The one thing the first-run account needs that no sign-up flow can do for
 * it: the account exists *because* mail is not configured, so there is nothing
 * to send a verification link with, and `requireEmailVerification` would
 * otherwise refuse it a session forever.
 *
 * Gated on the column still being false, so it can only ever move an account
 * from unverified to verified — never re-open a decision somebody else made,
 * and never touch a row that is already trusted.
 */
export async function markUserEmailVerified(db: Database, email: string): Promise<void> {
  await db
    .update(users)
    .set({ emailVerified: true, updatedAt: new Date() })
    .where(and(eq(sql`lower(${users.email})`, email.toLowerCase()), eq(users.emailVerified, false)))
}

/**
 * User-level preferences (ADR-0026).
 *
 * Better Auth owns the `users` row's identity columns — id, email, verification
 * state, the OAuth-supplied name and image. It does not own the preference
 * columns, which are ours and are written only from here. Keeping the write in a
 * repository rather than routing it through Better Auth's `updateUser` is
 * deliberate: `timezone` is declared to Better Auth with `input: false`, so it is
 * readable on the session and not settable through the auth surface. One writer,
 * and it validates.
 *
 * Only the caller's own row is ever addressed. There is no `userId` parameter
 * that a request body could supply — the route passes the session's user id and
 * nothing else, which is how "self only" is enforced structurally rather than by
 * a comparison someone can forget to write.
 */

export interface UserPreferences {
  /**
   * IANA timezone, or `null` when the user has never chosen one.
   *
   * `null` is not UTC. It means "no stored preference", and the frontend answers
   * it with the browser's own zone. A server-side default would be a guess that
   * is wrong for most of the planet and indistinguishable from a deliberate
   * choice of UTC.
   */
  readonly timezone: string | null
}

/**
 * Reads the caller's preferences. `null` when no such user exists — which, for a
 * session-authenticated caller, means the account was deleted between the
 * session read and this query.
 */
export async function getUserPreferences(
  db: Database,
  userId: string,
): Promise<UserPreferences | null> {
  const [row] = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId))
  return row ? { timezone: row.timezone ?? null } : null
}

export interface SetUserTimezoneInput {
  readonly userId: string
  /** A validated IANA identifier, or `null` to clear the preference. */
  readonly timezone: string | null
}

/**
 * Stores (or clears) the user's timezone and returns the row as it now stands.
 *
 * The value is validated at the route with the same `isValidTimezone` the
 * analytics query surface uses, so this takes an identifier it can trust; the
 * column's CHECK constraint in migration 0023 is the floor under that, not a
 * substitute for it.
 *
 * `updated_at` is bumped here because nothing else will: Better Auth maintains it
 * on the writes it makes, and this is not one of them.
 */
export async function setUserTimezone(
  db: Database,
  input: SetUserTimezoneInput,
): Promise<UserPreferences | null> {
  const [row] = await db
    .update(users)
    .set({ timezone: input.timezone, updatedAt: sql`now()` })
    .where(eq(users.id, input.userId))
    .returning({ timezone: users.timezone })
  return row ? { timezone: row.timezone ?? null } : null
}
