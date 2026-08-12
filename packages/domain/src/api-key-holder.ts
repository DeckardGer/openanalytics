/**
 * Who holds a key's secret after it was shown (docs snapshot 02 §19,
 * ADR-0043 D3).
 *
 * A key's raw token is returned exactly once, to the session that minted it, and
 * there is no path that reveals it to anybody else. So `created_by_user_id` is
 * already "the person who was shown the secret" — §19's revoke criterion needs
 * no column for that. What it has never been able to say is the *next* thing
 * that happened: whether that person kept the secret, or pasted it into a
 * machine and walked away.
 *
 * §19 answers what to do with each ("the public/write-only tracking key and a
 * site-owned analytics/config key stay with the site") and we have never been
 * able to tell them apart. This is that column's vocabulary.
 *
 * The distinction is not cosmetic: it decides whether a key survives its
 * holder's departure from the site. A `user` key is revoked with their
 * membership; a `site` key outlives it and is flagged for rotation instead,
 * because revoking it would take a working installation down over a personnel
 * change (ADR-0043 D1).
 */

export const API_KEY_HOLDERS = ['user', 'site'] as const

export type ApiKeyHolder = (typeof API_KEY_HOLDERS)[number]

/**
 * The holder a key is minted with when a create request does not say.
 *
 * `user` — the revoking direction, the same reasoning as the minimum scope
 * (ADR-0042 D3). A credential must not survive an eviction because a milestone
 * shipped; the owner who installs a key into a machine is the one who knows they
 * did, and they say so at mint time.
 */
export const DEFAULT_API_KEY_HOLDER: ApiKeyHolder = 'user'

export function isApiKeyHolder(value: unknown): value is ApiKeyHolder {
  return typeof value === 'string' && (API_KEY_HOLDERS as readonly string[]).includes(value)
}

/**
 * What a stored row actually means.
 *
 * **A `tracking_write` key is the site's, always, whatever the column says.**
 * That is not a new rule — `account-deletion.ts` has left tracking keys alone
 * since M10 and says why in a comment: "they are the site's public tracker
 * token, not this person's credential". Migration 0044 backfills them to `site`
 * so the row states it, and this reading is what covers the deploy window in
 * which an older api build inserts one under the column default. The same
 * belt-and-braces pair as `readScopesFrom`, for the same reason and in the
 * same direction: the window must not change what a credential means.
 *
 * An unrecognized string falls back to the default rather than throwing. A row
 * holding a holder this build has never heard of is treated as a person's key —
 * the answer that revokes — because the alternative is to keep a credential
 * alive on the strength of a value we cannot interpret.
 */
export function apiKeyHolderFrom(
  type: 'tracking_write' | 'private_read',
  stored: string | null | undefined,
): ApiKeyHolder {
  if (type === 'tracking_write') return 'site'
  return isApiKeyHolder(stored) ? stored : DEFAULT_API_KEY_HOLDER
}
