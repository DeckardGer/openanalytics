import { createHmac } from 'node:crypto'

/**
 * The source fingerprint a credential event records (ADR-0051 D4).
 *
 * G-010's answer includes "first use from a new source", and `AGENTS.md`'s hard
 * rule forbids a raw IP anywhere a log or a table can reach. So the address is
 * turned into a keyed hash here, at the edge of the request, and the address
 * itself goes no further: `packages/postgres` takes a `sourceHash` and has no
 * parameter that could accept an address by mistake.
 *
 * **A dedicated secret, never a derivation.** `CREDENTIAL_SOURCE_SECRET` follows
 * `TRIAL_IDENTITY_SECRET` and `ANONYMOUS_IDENTITY_SECRET`: rotating the one that
 * protects credential telemetry must not rotate the one that protects sessions.
 *
 * **The whole address, and nothing else.** Not a `/24` — a prefix would hide the
 * case this exists to catch, a stolen key replayed from a neighbouring host in
 * the same subnet. Not the user agent — it changes on every CLI and browser
 * upgrade, which would turn a security signal into an upgrade notification.
 *
 * **The key version is part of the identity, not a note beside it.** Hashes are
 * compared only within one version, so a rotation re-baselines every credential:
 * the first use after it looks new, once, for everyone. That is a stated,
 * operator-triggered consequence rather than a surprise.
 */

/**
 * Bumped if the material below ever changes shape.
 *
 * Distinct from the key version: a key rotation changes the secret, this changes
 * what is hashed. Both are in the material, so neither can be mistaken for the
 * other by a hash that happens to collide across a change.
 */
export const CREDENTIAL_SOURCE_DERIVATION_VERSION = 1

export interface CredentialSourceKey {
  readonly secret: string
  readonly keyVersion: number
}

/**
 * The distinct-source cap for one credential (ADR-0051 D9).
 *
 * A roaming CLI, or a stolen key replayed from a botnet, would otherwise add one
 * row per address forever. On reaching this number the credential writes one
 * `credential.source_tracking_capped` audit row and stops being tracked — a
 * stated bound with a record of itself, rather than a silent truncation.
 *
 * A constant rather than an environment variable, on the `read-cost.ts`
 * precedent: one home per number. Nothing about a deployment makes fifty the
 * wrong answer in a way an operator would know before the ADR would.
 */
export const CREDENTIAL_SOURCE_MAX_PER_CREDENTIAL = 50

/**
 * How stale `last_seen_at` must be before a *known* source is written again.
 *
 * The whole reason the read path is affordable: at one minute, a credential
 * polling every second probes an index 59 times out of 60 and writes nothing.
 * The same number and the same argument as `READ_KEY_LAST_USED_STALE_SECONDS`,
 * which throttles the neighbouring write on the same request.
 */
export const CREDENTIAL_SOURCE_REFRESH_SECONDS = 60

/**
 * Normalizes an address enough that the same client is the same source.
 *
 * Case only — IPv6 is hex and a proxy may render it either way. Deliberately no
 * v4-mapped-v6 unwrapping and no zone-id stripping: this system sits behind one
 * proxy whose rendering is consistent, and a normalization that guessed would
 * silently merge two sources into one, which is the failure this signal cannot
 * afford. `unknown` (what `clientAddress` returns when no header is present) is
 * a source like any other — a deployment that cannot see addresses reports one
 * source for everything, which is honest.
 */
function normalizeAddress(address: string): string {
  return address.trim().toLowerCase()
}

/** HMAC-SHA256 over the derivation version, the key version and the address. */
export function credentialSourceHash(input: {
  readonly address: string
  readonly key: CredentialSourceKey
}): string {
  const material = [
    String(CREDENTIAL_SOURCE_DERIVATION_VERSION),
    String(input.key.keyVersion),
    normalizeAddress(input.address),
  ].join('\n')

  return createHmac('sha256', input.key.secret).update(material).digest('hex')
}

/**
 * The identity a source row is keyed by (ADR-0051 D6).
 *
 * An API key is its own id. An OAuth credential is the **person and the
 * application**, never the access-token row: Better Auth's `refresh_token` grant
 * inserts a new row on every refresh, so a ref taken from the token would reset
 * first-use and re-fire "new source" every hour. Refreshing is not a new
 * authorization, and the ref has to say so.
 */
export function apiKeyCredentialRef(apiKeyId: string): string {
  return apiKeyId
}

export function oauthGrantCredentialRef(userId: string, clientId: string): string {
  return `${userId}:${clientId}`
}
