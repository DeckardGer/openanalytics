/**
 * What a credential may ask the read surface for (docs snapshot 02 §20,
 * ADR-0042 D3, ADR-0043 D4 and D5).
 *
 * This file used to be `api-key-scopes.ts` and its constant used to be
 * `API_KEY_SCOPES`. **The strings did not change** — ADR-0042 D9's first
 * condition is that `analytics:read` is the contract, and it still is. What
 * changed is a file name that said these belong to keys, one milestone before
 * they stopped belonging only to keys: M16's OAuth tokens carry these same
 * strings rather than a parallel vocabulary, so there is one dictionary here and
 * not a second one beside it.
 *
 * Two rules govern everything below, and neither is a detail:
 *
 * - **`site:read` is the minimum and is implied.** A `NULL` stored column reads
 *   as exactly it, and a grant that names other scopes gets it folded in.
 * - **A scope is a ceiling, never a floor** (ADR-0043 D4). It narrows what a
 *   credential may ask for; the underlying authorization still decides whether
 *   it gets it, and the two are intersected rather than substituted. This is
 *   what lets `revenue:read` exist here *and* exist as an owner-only membership
 *   capability in `authz.ts` without the scope becoming a second way to grant
 *   what the capability withholds.
 */

export const READ_SCOPES = ['site:read', 'analytics:read', 'realtime:read', 'revenue:read'] as const

export type ReadScope = (typeof READ_SCOPES)[number]

/**
 * The scope every read credential has, and the one a create request that names
 * none is minted with. `GET /v1/read/site`, `GET /v1/read/sites`, and nothing
 * else.
 */
export const MINIMUM_READ_SCOPE: ReadScope = 'site:read'

export const MINIMUM_READ_SCOPES: readonly ReadScope[] = [MINIMUM_READ_SCOPE]

export function isReadScope(value: unknown): value is ReadScope {
  return typeof value === 'string' && (READ_SCOPES as readonly string[]).includes(value)
}

/**
 * The scopes a `private_read` key may hold — a strict subset, permanently
 * (ADR-0043 D5).
 *
 * Both exclusions are the same fact from D1 — **a key resolves to a site and
 * never to a user** — and neither is a policy a later milestone could soften
 * without changing what a key is:
 *
 * - `realtime:read` mints a token anchored to a *subject's* access epoch, and
 *   revocation is a membership event replayed from the outbox (ADR-0030 D5). A
 *   key has no subject to mint under and no membership to revoke against, so
 *   granting it realtime would mean inventing a second revocation system for a
 *   credential whose revocation is already "delete the row".
 * - `revenue:read` is owner-only, and "owner" is a role on a membership. A key
 *   has no membership, so there is nothing to check — and a capability check
 *   with nothing behind it is exactly what ADR-0042 D3 refused when it declined
 *   to define a revenue scope at all.
 *
 * Derived by filtering `READ_SCOPES` rather than written out, so a scope added
 * to the vocabulary without a decision about which credentials may hold it is a
 * type error here rather than a silent grant.
 */
const KEY_INELIGIBLE_SCOPES: readonly ReadScope[] = ['realtime:read', 'revenue:read']

export const KEY_SCOPES: readonly ReadScope[] = READ_SCOPES.filter(
  (scope) => !KEY_INELIGIBLE_SCOPES.includes(scope),
)

/** Whether a `private_read` key may be minted with this scope (ADR-0043 D5). */
export function isKeyEligibleScope(scope: ReadScope): boolean {
  return KEY_SCOPES.includes(scope)
}

/**
 * Why a key may not hold this scope, in the words the create endpoint returns.
 *
 * The refusal names the reason and not only the rule: a `400` saying "not
 * allowed" sends an integrator looking for a plan upgrade or a setting, and
 * there is none — the answer is a different credential kind.
 */
export function keyScopeRefusal(scope: ReadScope): string {
  return scope === 'realtime:read'
    ? 'realtime:read needs a user to mint a realtime token for; a key belongs to a site, not a person. Use an OAuth token.'
    : 'revenue:read is owner-only, and a key has no membership to hold a role on. Use an OAuth token.'
}

/**
 * The scopes a stored grant actually confers.
 *
 * **`NULL` means the minimum, not "everything".** Migration 0042 backfills every
 * existing `private_read` row to `{site:read}`, so in a migrated database this
 * branch is unreachable for a row that predates M14 — it is here for the one
 * that does not: a row inserted by an older api build in the window between the
 * migration running and the new build being live. Reading `NULL` as the minimum
 * makes that window widen nothing.
 *
 * An unrecognized string is dropped rather than rejected. A credential whose
 * grant somehow holds a scope this build has never heard of gets what this build
 * can name and no more; failing the read instead would turn a
 * forward-compatibility question into an outage for a credential that is
 * otherwise fine.
 */
export function readScopesFrom(stored: readonly string[] | null | undefined): ReadScope[] {
  if (stored === null || stored === undefined) return [...MINIMUM_READ_SCOPES]
  const known = stored.filter(isReadScope)
  // A grant holding only unknown strings still gets the minimum: `site:read` is
  // what every read credential has by construction, and an empty grant would
  // make `GET /v1/read/site` — the endpoint the key was minted for — start
  // failing.
  return known.includes(MINIMUM_READ_SCOPE) ? known : [MINIMUM_READ_SCOPE, ...known]
}

export function hasReadScope(scopes: readonly ReadScope[], required: ReadScope): boolean {
  return scopes.includes(required)
}

/**
 * The OAuth grant string this vocabulary travels in, and back.
 *
 * RFC 6749 spells a scope grant as a space-delimited string, and Better Auth
 * stores exactly that in `oauth_access_tokens.scopes`. Parsing it here rather
 * than at the resolver keeps one reading of the vocabulary: an OAuth token
 * carrying a string this build cannot name gets the same treatment a key's
 * column does — the scope is dropped, the credential still works, and
 * `site:read` is still implied.
 *
 * The OIDC scopes Better Auth requires of every request (`openid`, `profile`,
 * `email`, `offline_access`) are not read scopes and fall out here as unknown
 * strings, which is exactly right: they authorize the identity claim, not the
 * analytics.
 */
export function readScopesFromGrant(grant: string | null | undefined): ReadScope[] {
  if (!grant) return [...MINIMUM_READ_SCOPES]
  return readScopesFrom(grant.split(/[\s,]+/u).filter((part) => part.length > 0))
}

export function readScopesToGrant(scopes: readonly ReadScope[]): string {
  return scopes.join(' ')
}
