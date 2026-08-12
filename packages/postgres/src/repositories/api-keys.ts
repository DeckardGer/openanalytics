import { createHash, randomBytes } from 'node:crypto'
import {
  DEFAULT_API_KEY_HOLDER,
  MINIMUM_READ_SCOPES,
  apiKeyHolderFrom,
  readScopesFrom,
  type ApiKeyHolder,
  type ReadScope,
} from '@openanalytics/domain'
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm'
import type { Database } from '../client.ts'
import { writeAudit } from './audit.ts'
import { apiKeys, type ApiKeyType } from '../schema/api-keys.ts'

export type { ApiKeyType }

/**
 * API key service.
 *
 * Two distinct security objects (docs snapshot 02 §20, plan Milestone 2 item 8):
 *
 * - `tracking_write` — public. It ships in the browser tracker, so its raw value
 *   is retained (in `public_token`) to be re-displayed. It is an ingest
 *   identifier only; `resolveReadApiKey` never accepts it, which is what makes
 *   "the public tracking key works on no read endpoint" true in one place.
 * - `private_read` — secret. Only its SHA-256 hash is stored; the raw token is
 *   returned once from `createApiKey` and never persisted or logged again. The
 *   schema CHECK (migration 0004) backs this at the database level, and
 *   `listApiKeys` never selects the hash.
 */

const SCHEME_PREFIXES: Readonly<Record<ApiKeyType, string>> = {
  tracking_write: 'oa_pk_',
  private_read: 'oa_sk_',
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function generateToken(type: ApiKeyType): { raw: string; prefix: string } {
  const scheme = SCHEME_PREFIXES[type]
  const random = randomBytes(type === 'private_read' ? 32 : 24).toString('base64url')
  const raw = `${scheme}${random}`
  // A non-secret display prefix: the scheme plus a few identifying characters,
  // enough to recognize a key in the UI without revealing it.
  return { raw, prefix: raw.slice(0, scheme.length + 6) }
}

export interface CreateApiKeyInput {
  readonly siteId: string
  readonly type: ApiKeyType
  readonly name?: string
  readonly createdByUserId?: string
  readonly expiresAt?: Date
  /**
   * Scopes for a `private_read` key (ADR-0042, D3). Omitted, the key is minted
   * with the minimum — `site:read` — which is what docs snapshot 02 §20 asks
   * for. Ignored for a `tracking_write` key, which carries none.
   */
  readonly scopes?: readonly ReadScope[]
  /**
   * Who will hold the secret (ADR-0043, D8). Omitted, `user` — the value that
   * revokes when its holder leaves the site. `site` is the declaration an owner
   * makes when they are about to paste the token into a machine, and it is what
   * keeps a WordPress installation alive through a personnel change. Ignored for
   * a `tracking_write` key, which is the site's by construction.
   */
  readonly heldBy?: ApiKeyHolder
}

export interface CreatedApiKey {
  readonly id: string
  readonly type: ApiKeyType
  readonly keyPrefix: string
  /** The raw token — returned exactly once, never stored for a private key. */
  readonly rawToken: string
}

/**
 * The subset of the database surface a key creation needs — satisfied by both
 * the pool-backed database and an open transaction, exactly like
 * `AuditExecutor`.
 */
export type ApiKeyExecutor = Pick<Database, 'insert'>

/**
 * Mint a key and write its audit row against an arbitrary executor.
 *
 * Internal to this package; `createApiKey` is the public entry point. It exists
 * because `createSite` mints the site's first `tracking_write` key in the SAME
 * transaction as the site, and calling `createApiKey` from there would open a
 * nested transaction — a savepoint whose rollback semantics differ from the
 * caller's intent, and a second place this insert and its audit row would be
 * spelled out. One definition, two callers, and the key can never exist without
 * the site it belongs to.
 */
export async function insertApiKey(
  executor: ApiKeyExecutor,
  input: CreateApiKeyInput,
): Promise<CreatedApiKey> {
  const { raw, prefix } = generateToken(input.type)
  const keyHash = sha256Hex(raw)
  const isPublic = input.type === 'tracking_write'
  // A public tracking key carries no scopes at all — `resolveReadApiKey` rejects
  // it by type before scopes are consulted, and the ingest path never consults
  // them — so writing one would state a grant nothing honours. A private key
  // always states its own, defaulting to the minimum (ADR-0042, D3).
  const scopes = isPublic ? null : [...(input.scopes ?? MINIMUM_READ_SCOPES)]
  // A tracking key is the site's whatever the caller asks for: it ships in the
  // HTML of every page and outlives everybody who ever touched the dashboard.
  // A private key is the person's unless they say otherwise (ADR-0043, D8).
  const heldBy: ApiKeyHolder = isPublic ? 'site' : (input.heldBy ?? DEFAULT_API_KEY_HOLDER)

  const [row] = await executor
    .insert(apiKeys)
    .values({
      siteId: input.siteId,
      type: input.type,
      keyPrefix: prefix,
      keyHash,
      publicToken: isPublic ? raw : null,
      scopes,
      heldBy,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.createdByUserId === undefined ? {} : { createdByUserId: input.createdByUserId }),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    })
    .returning({ id: apiKeys.id })
  if (!row) throw new Error('api key insert returned no row')

  await writeAudit(executor, {
    action: 'api_key.created',
    actorUserId: input.createdByUserId ?? null,
    actorType: input.createdByUserId ? 'user' : 'system',
    siteId: input.siteId,
    targetType: 'api_key',
    targetId: row.id,
    // Never the raw token — a key id, its type, its non-secret prefix, and what
    // it was granted. The grant belongs in the audit trail precisely because it
    // is the part an owner may later dispute.
    metadata: { type: input.type, keyPrefix: prefix, heldBy, ...(scopes ? { scopes } : {}) },
  })

  return { id: row.id, type: input.type, keyPrefix: prefix, rawToken: raw }
}

export async function createApiKey(db: Database, input: CreateApiKeyInput): Promise<CreatedApiKey> {
  return db.transaction(async (tx) => insertApiKey(tx, input))
}

export interface ResolvedApiKey {
  readonly id: string
  readonly siteId: string
  readonly type: ApiKeyType
  /**
   * What this key may do (ADR-0042, D3). Never null and never empty: a stored
   * `NULL` resolves to the minimum, `site:read`, so a row that predates scopes
   * grants what it always granted rather than everything or nothing.
   */
  readonly scopes: readonly ReadScope[]
}

async function resolveApiKey(db: Database, rawToken: string): Promise<ResolvedApiKey | null> {
  const keyHash = sha256Hex(rawToken)
  const [row] = await db
    .select({
      id: apiKeys.id,
      siteId: apiKeys.siteId,
      type: apiKeys.type,
      scopes: apiKeys.scopes,
    })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.keyHash, keyHash),
        sql`revoked_at IS NULL`,
        sql`(expires_at IS NULL OR expires_at > now())`,
      ),
    )
  if (!row) return null
  return { id: row.id, siteId: row.siteId, type: row.type, scopes: readScopesFrom(row.scopes) }
}

/** Resolves a key for a READ endpoint. A `tracking_write` key is write-only and
 * is never accepted here. */
export async function resolveReadApiKey(
  db: Database,
  rawToken: string,
): Promise<ResolvedApiKey | null> {
  const resolved = await resolveApiKey(db, rawToken)
  return resolved && resolved.type === 'private_read' ? resolved : null
}

/** Resolves a key for the collector ingest path — only a `tracking_write` key. */
export async function resolveTrackingKey(
  db: Database,
  rawToken: string,
): Promise<ResolvedApiKey | null> {
  const resolved = await resolveApiKey(db, rawToken)
  return resolved && resolved.type === 'tracking_write' ? resolved : null
}

/**
 * Records that a key was just used, if the stored instant is stale enough to be
 * worth a write (ADR-0042, D7).
 *
 * `api_keys.last_used_at` has existed since migration 0004 and nothing has ever
 * written it, so the API-keys page has shown `null` for keys in daily use. §20
 * lists "last-used" among the things a private key has, and an owner deciding
 * which of three old keys to revoke is exactly who needs it.
 *
 * The staleness predicate lives in the `WHERE`, so the throttle is a property of
 * the statement rather than of a read-then-write the next caller could race: two
 * concurrent requests both issue the `UPDATE`, and at most one row is written
 * per window either way.
 *
 * Returns whether a write happened, which is what the tests assert on — a
 * caller has no reason to branch on it, and none does.
 */
export async function touchApiKeyUsage(
  db: Database,
  input: { id: string; staleAfterSeconds: number },
): Promise<{ touched: boolean }> {
  const updated = await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, input.id),
        sql`(last_used_at IS NULL OR last_used_at < now() - make_interval(secs => ${input.staleAfterSeconds}))`,
      ),
    )
    .returning({ id: apiKeys.id })
  return { touched: updated.length > 0 }
}

/**
 * The site's live public tracking token, for the install block (ADR-0042, D8).
 *
 * The newest un-revoked `tracking_write` key — the predicate
 * `api_keys_tracking_live_idx` (migration 0014) already indexes. `null` when the
 * site has none, which is a fact the caller renders rather than an error.
 *
 * Only ever the *public* token: the column holds a raw value for
 * `tracking_write` alone, and migration 0004's CHECK is what makes that
 * structural rather than a promise.
 */
export async function getLiveTrackingToken(db: Database, siteId: string): Promise<string | null> {
  const [row] = await db
    .select({ publicToken: apiKeys.publicToken })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.siteId, siteId),
        eq(apiKeys.type, 'tracking_write'),
        isNull(apiKeys.revokedAt),
        sql`public_token IS NOT NULL`,
      ),
    )
    .orderBy(desc(apiKeys.createdAt))
    .limit(1)
  return row?.publicToken ?? null
}

/** Revokes a key. Scoped to `siteId` so a caller authorized on one site cannot
 * revoke another site's key by id. Returns whether a live key was revoked. */
export async function revokeApiKey(
  db: Database,
  input: { id: string; siteId: string; actorUserId?: string },
): Promise<{ revoked: boolean }> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(apiKeys.id, input.id), eq(apiKeys.siteId, input.siteId), isNull(apiKeys.revokedAt)),
      )
      .returning({ id: apiKeys.id })
    if (updated.length === 0) return { revoked: false }

    await writeAudit(tx, {
      action: 'api_key.revoked',
      actorUserId: input.actorUserId ?? null,
      actorType: input.actorUserId ? 'user' : 'system',
      siteId: input.siteId,
      targetType: 'api_key',
      targetId: input.id,
    })
    return { revoked: true }
  })
}

export interface ApiKeySummary {
  readonly id: string
  readonly type: ApiKeyType
  readonly name: string | null
  readonly keyPrefix: string
  /** Present only for the public tracking key; null for a private key. */
  readonly publicToken: string | null
  /**
   * What a private key may do; `null` for a tracking key, which carries none
   * (ADR-0042, D3). A private row stored before scopes existed reads as
   * `['site:read']` rather than as an absence the UI would have to interpret.
   */
  readonly scopes: readonly ReadScope[] | null
  /**
   * Who holds this key's secret (ADR-0043, D8). Always stated, for both types:
   * a tracking key reads `site` whatever the column says, and a private key
   * stored before this existed reads `user` — the value that revokes.
   */
  readonly heldBy: ApiKeyHolder
  /**
   * When somebody who had been shown this site-held key's secret left the site.
   *
   * Null is the ordinary state. Non-null is the only thing that makes ADR-0043
   * D8's carve-out honest: the key was kept alive rather than revoked, so the
   * owner has to be able to *see* that a stranger still knows its value. Cleared
   * by rotation, which is revoke-then-mint (ADR-0042, D2) — this row is not
   * updated, it is replaced.
   */
  readonly rotationRequiredAt: Date | null
  readonly createdAt: Date
  readonly lastUsedAt: Date | null
  readonly revokedAt: Date | null
  readonly expiresAt: Date | null
}

/** Lists a site's keys for the UI. The hash is deliberately not selected, and a
 * private key's raw value is not stored, so neither can be returned here. */
export async function listApiKeys(db: Database, siteId: string): Promise<ApiKeySummary[]> {
  const rows = await db
    .select({
      id: apiKeys.id,
      type: apiKeys.type,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      publicToken: apiKeys.publicToken,
      scopes: apiKeys.scopes,
      heldBy: apiKeys.heldBy,
      rotationRequiredAt: apiKeys.rotationRequiredAt,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
      expiresAt: apiKeys.expiresAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.siteId, siteId))
  return rows.map((row) => ({
    ...row,
    // The same reading the resolver applies, so the page shows the grant the
    // key actually has rather than the column's spelling of it.
    scopes: row.type === 'tracking_write' ? null : readScopesFrom(row.scopes),
    // Likewise: a tracking key is the site's whatever the column holds, which
    // matters for a row inserted by an older build during the 0044 window.
    heldBy: apiKeyHolderFrom(row.type, row.heldBy),
  }))
}

/**
 * What a departure does to the departing person's private keys
 * (docs snapshot 02 §19, ADR-0043 D8).
 *
 * One function for both departures — leaving a site and deleting the account —
 * because the rule is one rule, and two copies of it would be two places for it
 * to drift. `siteId` narrows it to a single site's membership removal; omitted,
 * it reaches every site the user minted a key on, which is what account deletion
 * means.
 *
 * Two statements, and which one a key gets is the whole of the decision:
 *
 * - **`held_by = 'user'` is revoked.** This is §19's first clause and the leak
 *   it was written about: an evicted admin holding a live `analytics:read`
 *   credential. Revoked rather than deleted, for the reason every other
 *   revocation here is: `api_keys` is what an audit of "who could read this
 *   site" is reconstructed from.
 * - **`held_by = 'site'` survives, and is stamped.** §19's second and third
 *   clauses: the site's things stay with the site, and a suspect site credential
 *   is kept only through an explicit rotate/reissue. Revoking it instead would
 *   take down a WordPress installation over a personnel change — the outage
 *   ADR-0043 D1 exists to prevent.
 *
 * The stamp is `COALESCE`d rather than overwritten: two departures in a year
 * are not a reason to restart the clock on the first one, and the oldest
 * unresolved exposure is the one an owner should be answering for.
 *
 * `tracking_write` keys are untouched by both statements, excluded by the `type`
 * filter rather than by their holder. Both would reach the same verdict — they
 * are `held_by = 'site'` — but the type check is the stronger statement and the
 * one that survives somebody later changing what a holder means: a public
 * tracker token carries no read authorization to revoke and no secret to be
 * exposed, so neither branch of this function has anything to say about it.
 */
export async function applyDepartureToApiKeys(
  executor: Pick<Database, 'update' | 'insert'>,
  input: {
    readonly userId: string
    /** A single site (membership removal), or every site (account deletion). */
    readonly siteId?: string
    readonly actorUserId?: string | null
    readonly now: Date
  },
): Promise<{ revoked: number; flagged: number }> {
  const scope = [
    eq(apiKeys.createdByUserId, input.userId),
    eq(apiKeys.type, 'private_read'),
    isNull(apiKeys.revokedAt),
    ...(input.siteId === undefined ? [] : [eq(apiKeys.siteId, input.siteId)]),
  ]

  const revoked = await executor
    .update(apiKeys)
    .set({ revokedAt: input.now })
    .where(and(...scope, ne(apiKeys.heldBy, 'site')))
    .returning({ id: apiKeys.id, siteId: apiKeys.siteId })

  const flagged = await executor
    .update(apiKeys)
    .set({ rotationRequiredAt: sql`COALESCE(rotation_required_at, ${input.now})` })
    .where(and(...scope, eq(apiKeys.heldBy, 'site')))
    .returning({ id: apiKeys.id, siteId: apiKeys.siteId })

  // One audit row per key, not one per statement: the question an owner asks
  // later is about a key, and a count would not answer it.
  for (const row of revoked) {
    await writeAudit(executor, {
      action: 'api_key.revoked',
      actorUserId: input.actorUserId ?? null,
      actorType: input.actorUserId ? 'user' : 'system',
      siteId: row.siteId,
      targetType: 'api_key',
      targetId: row.id,
      metadata: { reason: input.siteId === undefined ? 'account_deleted' : 'member_removed' },
    })
  }
  for (const row of flagged) {
    await writeAudit(executor, {
      action: 'api_key.rotation_required',
      actorUserId: input.actorUserId ?? null,
      actorType: input.actorUserId ? 'user' : 'system',
      siteId: row.siteId,
      targetType: 'api_key',
      targetId: row.id,
      metadata: { reason: input.siteId === undefined ? 'account_deleted' : 'member_removed' },
    })
  }

  return { revoked: revoked.length, flagged: flagged.length }
}
