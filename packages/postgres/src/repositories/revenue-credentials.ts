import { randomBytes } from 'node:crypto'
import { and, desc, eq, ne, sql, type SQL } from 'drizzle-orm'
import type { RevenueCredentialStatus } from '@openanalytics/domain'
import type { Database, Executor } from '../client.ts'
import { writeAudit } from './audit.ts'
import { enqueueRevenueBackfill } from './revenue-objects.ts'
import { revenueCredentials } from '../schema/revenue.ts'

/**
 * Revenue credential storage (ADR-0033, D3).
 *
 * This module never sees a plaintext secret and never holds a key. The api
 * encrypts before calling in and the worker decrypts after reading out; what
 * lives here is the row's lifecycle — connect, verify, rotate, disconnect,
 * revoke-with-the-owner — and the transactional guarantees each of them needs.
 *
 * Two of those guarantees are the whole reason the functions are not inline
 * updates at the call sites:
 *
 * - **Disconnect erases both ciphertexts in the same UPDATE that disables the
 *   row.** Split into two statements, a crash between them leaves a disabled
 *   credential still holding a decryptable provider key — the exact state the
 *   table's CHECK constraint exists to make impossible.
 * - **Rotation swaps the ciphertext and the key version together**, guarded on
 *   the row not being disabled, so a rotation racing a disconnect loses rather
 *   than resurrecting an erased credential with a fresh secret.
 */

export interface RevenueCredentialRow {
  readonly id: string
  readonly siteId: string
  readonly provider: string
  readonly encryptedApiKey: string | null
  readonly encryptedWebhookSecret: string | null
  readonly keyVersion: string
  readonly apiKeyLast4: string
  readonly webhookToken: string
  readonly status: RevenueCredentialStatus
  readonly createdByUserId: string
  readonly connectedAt: Date
  readonly lastVerifiedAt: Date | null
  readonly lastSyncedAt: Date | null
  readonly lastWebhookAt: Date | null
  readonly lastError: string | null
  readonly disabledAt: Date | null
  /** Which backfill generation this credential is on; part of the job's
   * idempotency key, so bumping it mints a new job (ADR-0033, D4). */
  readonly backfillGeneration: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

const COLUMNS = {
  id: revenueCredentials.id,
  siteId: revenueCredentials.siteId,
  provider: revenueCredentials.provider,
  encryptedApiKey: revenueCredentials.encryptedApiKey,
  encryptedWebhookSecret: revenueCredentials.encryptedWebhookSecret,
  keyVersion: revenueCredentials.keyVersion,
  apiKeyLast4: revenueCredentials.apiKeyLast4,
  webhookToken: revenueCredentials.webhookToken,
  status: revenueCredentials.status,
  createdByUserId: revenueCredentials.createdByUserId,
  connectedAt: revenueCredentials.connectedAt,
  lastVerifiedAt: revenueCredentials.lastVerifiedAt,
  lastSyncedAt: revenueCredentials.lastSyncedAt,
  lastWebhookAt: revenueCredentials.lastWebhookAt,
  lastError: revenueCredentials.lastError,
  disabledAt: revenueCredentials.disabledAt,
  backfillGeneration: revenueCredentials.backfillGeneration,
  createdAt: revenueCredentials.createdAt,
  updatedAt: revenueCredentials.updatedAt,
}

/**
 * `and()` narrowed to a definite predicate.
 *
 * Drizzle types `and()` as possibly-undefined because it *drops* undefined
 * operands, which is precisely the hazard the erase statement must not inherit:
 * an empty predicate there would erase every credential in the installation.
 * Narrowing once, loudly, is what lets `eraseRevenueCredentials` demand an `SQL`.
 */
function all(...conditions: SQL[]): SQL {
  const combined = and(...conditions)
  if (!combined) throw new Error('a revenue credential predicate must not be empty')
  return combined
}

/**
 * The opaque webhook address (D4): 32 random bytes, base64url.
 *
 * base64url rather than hex so it fits a URL path segment with no escaping and
 * stays 43 characters; random rather than derived from the credential id so a
 * customer holding one site's URL learns nothing about another's.
 */
export function mintWebhookToken(): string {
  return randomBytes(32).toString('base64url')
}

export interface CreateRevenueCredentialInput {
  /** Minted by the CALLER, because the AAD binds it: the ciphertexts must be
   * produced against the id this row will actually carry, which means the id
   * exists before the encryption does. */
  readonly id: string
  readonly siteId: string
  readonly provider: string
  readonly encryptedApiKey: string
  /**
   * The webhook signing secret's ciphertext, or **null** when the customer has
   * not created the provider endpoint yet (CP6).
   *
   * Null is the ordinary first state rather than an edge case, and the ordering
   * is why: a Stripe signing secret exists only once the customer has created an
   * endpoint pointing at this site's `webhook_url`, and that URL is minted from
   * the token this very insert carries. Requiring it on connect asked for a
   * value the customer provably could not have yet.
   *
   * CP1's schema already allowed it — the column is nullable and the
   * disabled-erased CHECK is one-directional (`status <> 'disabled' OR both
   * ciphertexts NULL`), so an active row with no signing secret has always been
   * legal and no migration is needed to start writing one.
   */
  readonly encryptedWebhookSecret: string | null
  readonly keyVersion: string
  readonly apiKeyLast4: string
  readonly webhookToken: string
  readonly createdByUserId: string
  /** The instant the live probe succeeded — connect verifies before it stores,
   * so a fresh row is never "connected but never proven". */
  readonly verifiedAt?: Date
  readonly now?: Date
}

export type CreateRevenueCredentialResult =
  | { readonly ok: true; readonly credential: RevenueCredentialRow }
  | { readonly ok: false; readonly conflict: 'already_connected' }

/**
 * Store a verified connection.
 *
 * The conflict is decided by `revenue_credentials_live_key`, not by a read: two
 * concurrent connects would otherwise each find no live credential and both
 * insert. The partial unique is what makes "one live credential per (site,
 * provider)" true rather than usually true.
 */
export async function createRevenueCredential(
  db: Database,
  input: CreateRevenueCredentialInput,
): Promise<CreateRevenueCredentialResult> {
  const now = input.now ?? new Date()

  return await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(revenueCredentials)
      .values({
        id: input.id,
        siteId: input.siteId,
        provider: input.provider,
        encryptedApiKey: input.encryptedApiKey,
        encryptedWebhookSecret: input.encryptedWebhookSecret,
        keyVersion: input.keyVersion,
        apiKeyLast4: input.apiKeyLast4,
        webhookToken: input.webhookToken,
        status: 'active',
        createdByUserId: input.createdByUserId,
        connectedAt: now,
        ...(input.verifiedAt === undefined ? {} : { lastVerifiedAt: input.verifiedAt }),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning(COLUMNS)

    const credential = inserted[0]
    if (!credential) return { ok: false, conflict: 'already_connected' as const }

    // The 90-day backfill (ADR-0033, D2e/D4), enqueued **inside this
    // transaction**. Composed here rather than at the route for the reason every
    // other job in this repository is: a crash between the insert and a separate
    // enqueue would leave a connected provider whose history nobody is walking,
    // and nothing downstream would ever notice — the credential looks perfect,
    // the dashboard just stays empty until the first webhook arrives.
    //
    // `enqueueJob` never throws on either uniqueness rule, which is what makes
    // it safe to compose: a raised `23505` would abort this whole transaction
    // and turn a successful connect into a 500.
    await enqueueRevenueBackfill(tx, {
      credentialId: credential.id,
      siteId: input.siteId,
      provider: input.provider,
      // Generation 0 — the row's default. Every later bump (a rotation, an
      // operator re-run) mints a fresh key, so a backfill that reached
      // `failed_terminal` is not a permanent loss of the customer's history.
      generation: credential.backfillGeneration,
    })

    await writeAudit(tx, {
      action: 'site.revenue.connected',
      actorUserId: input.createdByUserId,
      siteId: input.siteId,
      targetType: 'revenue_credential',
      targetId: credential.id,
      // Categorized only: the provider, the display tail and the key version.
      // Never the secret, never the webhook token — the audit trail is read by
      // more people than the credential surface is.
      metadata: {
        provider: input.provider,
        api_key_last4: input.apiKeyLast4,
        key_version: input.keyVersion,
      },
    })

    return { ok: true as const, credential }
  })
}

export interface ReadRevenueCredentialInput {
  readonly siteId: string
  /** Optional: the connection endpoints are singular per site, so the usual
   * read is "whatever this site connected". */
  readonly provider?: string
}

/**
 * The site's revenue connection.
 *
 * A live credential wins; failing that, the most recently connected row of any
 * status is returned, so a site that disconnected reads back as `disabled`
 * rather than as "never connected". The two are different answers and the read
 * surface renders them differently (D7).
 */
export async function readRevenueCredential(
  db: Executor,
  input: ReadRevenueCredentialInput,
): Promise<RevenueCredentialRow | null> {
  const where =
    input.provider === undefined
      ? eq(revenueCredentials.siteId, input.siteId)
      : and(
          eq(revenueCredentials.siteId, input.siteId),
          eq(revenueCredentials.provider, input.provider),
        )

  const [row] = await db
    .select(COLUMNS)
    .from(revenueCredentials)
    .where(where)
    // Live before history, newest before older. `status <> 'disabled'` sorts
    // true-first as DESC on a boolean.
    .orderBy(
      sql`(${revenueCredentials.status} <> 'disabled') DESC`,
      desc(revenueCredentials.connectedAt),
    )
    .limit(1)

  return row ?? null
}

/** The live credential only — what a rotation or a disconnect may act on. */
export async function readLiveRevenueCredential(
  db: Executor,
  input: ReadRevenueCredentialInput,
): Promise<RevenueCredentialRow | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(revenueCredentials)
    .where(
      and(
        eq(revenueCredentials.siteId, input.siteId),
        ne(revenueCredentials.status, 'disabled'),
        ...(input.provider === undefined ? [] : [eq(revenueCredentials.provider, input.provider)]),
      ),
    )
    .orderBy(desc(revenueCredentials.connectedAt))
    .limit(1)

  return row ?? null
}

/**
 * Resolve a credential from its webhook address (D4).
 *
 * Unfiltered by status on purpose: CP2's endpoint has to be able to tell a
 * *disabled* credential from an unknown token, because those get different
 * answers — a disabled one is acked and ledgered `ignored` so a disconnected
 * site does not accumulate provider-side retry storms, while an unknown token
 * is a 404.
 */
export async function readRevenueCredentialByWebhookToken(
  db: Executor,
  webhookToken: string,
): Promise<RevenueCredentialRow | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(revenueCredentials)
    .where(eq(revenueCredentials.webhookToken, webhookToken))
  return row ?? null
}

export interface UpdateRevenueCredentialStateInput {
  readonly credentialId: string
  /**
   * Required, and it is a guard rather than a lookup key.
   *
   * CP2 resolves a credential from an **attacker-supplied webhook token**, and
   * every writer downstream of that resolution carries the site it believes it
   * is acting on. Demanding both means a confusion between the two — a token
   * that resolved to one site driving a write against another — cannot be
   * expressed, instead of being prevented by every caller remembering to check.
   */
  readonly siteId: string
  readonly status?: RevenueCredentialStatus
  /** Explicit null clears a recorded failure — which is how a recovered sync
   * stops reporting an outage that is over. */
  readonly lastError?: string | null
  readonly lastVerifiedAt?: Date
  readonly lastSyncedAt?: Date
  readonly lastWebhookAt?: Date
  readonly now?: Date
}

/**
 * Record what the sync, the probe or the webhook observed.
 *
 * One flexible writer rather than five named ones, in the shape
 * `updateDeletionTarget` already established: the callers touch different
 * subsets and a "set everything" signature would make each of them restate
 * values it has no opinion about. In particular a failure sets `status` and
 * `lastError` and leaves `lastSyncedAt` alone, because a degraded credential has
 * to keep reporting when its data was last actually correct (D4).
 *
 * `disabled` is deliberately not reachable through here: disabling erases
 * ciphertexts, and a status writer that could disable without erasing would be a
 * second path to the state the CHECK constraint forbids.
 *
 * The predicate is `(id, site_id)` and not-already-disabled. All three matter:
 * the site pins which row the caller meant, and the status guard stops a
 * disconnected credential being re-armed with ciphertexts that no longer exist.
 */
export async function updateRevenueCredentialState(
  db: Executor,
  input: UpdateRevenueCredentialStateInput,
): Promise<void> {
  const now = input.now ?? new Date()
  if (input.status === 'disabled') {
    throw new Error('use disconnectRevenueCredential to disable a credential')
  }
  await db
    .update(revenueCredentials)
    .set({
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.lastError === undefined ? {} : { lastError: input.lastError }),
      ...(input.lastVerifiedAt === undefined ? {} : { lastVerifiedAt: input.lastVerifiedAt }),
      ...(input.lastSyncedAt === undefined ? {} : { lastSyncedAt: input.lastSyncedAt }),
      ...(input.lastWebhookAt === undefined ? {} : { lastWebhookAt: input.lastWebhookAt }),
      updatedAt: now,
    })
    .where(
      all(
        eq(revenueCredentials.id, input.credentialId),
        // The site the caller believes it is acting on, not the one a resolved
        // row happens to name.
        eq(revenueCredentials.siteId, input.siteId),
        // Never re-arm a disconnected credential. Its ciphertexts are gone, so a
        // row flipped back to `active` here would be a connection that cannot
        // decrypt anything and would fail on every sync forever.
        ne(revenueCredentials.status, 'disabled'),
      ),
    )
}

export interface RotateRevenueCredentialInput {
  readonly credentialId: string
  readonly siteId: string
  readonly encryptedApiKey: string
  readonly keyVersion: string
  readonly apiKeyLast4: string
  readonly actorUserId: string
  readonly verifiedAt?: Date
  readonly now?: Date
}

/**
 * Swap the API key ciphertext, atomically (D3's `PATCH` path).
 *
 * The ciphertext, its key version and its display tail move in one UPDATE: they
 * describe one secret, and a row carrying a new ciphertext under the old
 * version's label would be undecryptable the moment the old key left the ring.
 *
 * The webhook secret is untouched — rotating the API key in Stripe does not
 * change the endpoint's signing secret, and re-encrypting it here would be a
 * write with no cause. Its ciphertext therefore keeps its ORIGINAL key version,
 * which is why the rotation sweep reads the column rather than assuming both
 * halves of a row moved together.
 *
 * Guarded on the row still being live, so a rotation racing a disconnect loses.
 * Returns null when nothing moved.
 *
 * **A rotation also bumps the backfill generation and enqueues a fresh walk**
 * (ADR-0033, D4). That is not a convenience: the ordinary reason a customer
 * rotates is that the previous key stopped working — revoked, or created with
 * too few permissions to read every resource — and the backfill that failed
 * under it has left the account's history un-walked. Without this the new key
 * would ingest everything from now on and silently never recover the ninety days
 * the connection promised, while the read surface reported a healthy connection.
 *
 * Both writes are in this one transaction, so a crash cannot leave a rotated
 * credential whose history nobody is walking.
 */
export async function rotateRevenueCredential(
  db: Database,
  input: RotateRevenueCredentialInput,
): Promise<RevenueCredentialRow | null> {
  const now = input.now ?? new Date()

  return await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(revenueCredentials)
      .set({
        encryptedApiKey: input.encryptedApiKey,
        keyVersion: input.keyVersion,
        apiKeyLast4: input.apiKeyLast4,
        // A rotation that passed the probe is a working connection again, so it
        // clears whatever category the previous key was failing under. This is
        // the ONE path allowed to clear an `unauthorized` error without a
        // completed walk behind it, because it is the only one that saw a live
        // probe succeed with a *new* secret.
        status: 'active',
        lastError: null,
        // A new generation, so the backfill enqueued below gets a key the
        // previous (possibly terminal) job has not spent.
        backfillGeneration: sql`${revenueCredentials.backfillGeneration} + 1`,
        ...(input.verifiedAt === undefined ? {} : { lastVerifiedAt: input.verifiedAt }),
        updatedAt: now,
      })
      .where(
        and(
          eq(revenueCredentials.id, input.credentialId),
          eq(revenueCredentials.siteId, input.siteId),
          ne(revenueCredentials.status, 'disabled'),
        ),
      )
      .returning(COLUMNS)

    if (!updated) return null

    // The generation the UPDATE just wrote, read back from `RETURNING` rather
    // than computed here — the two must not be able to disagree.
    await enqueueRevenueBackfill(tx, {
      credentialId: updated.id,
      siteId: input.siteId,
      provider: updated.provider,
      generation: updated.backfillGeneration,
    })

    await writeAudit(tx, {
      action: 'site.revenue.rotated',
      actorUserId: input.actorUserId,
      siteId: input.siteId,
      targetType: 'revenue_credential',
      targetId: updated.id,
      metadata: {
        provider: updated.provider,
        api_key_last4: input.apiKeyLast4,
        key_version: input.keyVersion,
      },
    })

    return updated
  })
}

export interface SetRevenueWebhookSecretInput {
  readonly credentialId: string
  readonly siteId: string
  readonly encryptedWebhookSecret: string
  readonly keyVersion: string
  readonly actorUserId: string
  readonly now?: Date
}

/**
 * Store (or replace) the webhook signing secret — the second half of the
 * two-step connect (CP6).
 *
 * Deliberately **not** folded into `rotateRevenueCredential`, even though both
 * are `PATCH` bodies. That function bumps `backfill_generation` and enqueues a
 * fresh ninety-day walk, and it does so for a specific reason: the ordinary
 * cause of an API-key rotation is that the previous key stopped working, so the
 * history it failed to walk has to be re-walked. None of that reasoning survives
 * contact with a webhook secret. Pasting a signing secret says nothing about
 * whether the API key ever worked, and re-walking ninety days of a provider's
 * history every time somebody finishes step two of the connect guide would be a
 * large, pointless bill.
 *
 * It also does not touch `status` or `last_error`. A credential is `active` from
 * the moment its API key passed the probe — backfill and reconcile are fully
 * functional without webhooks, and `last_webhook_at` staying null is the honest
 * way to say no delivery has arrived, rather than a degraded status that would
 * make a working connection look broken for as long as the customer took to
 * finish the second step.
 *
 * `key_version` moves with the ciphertext, because the row's version label is
 * what the rotation sweep reads to decide which key a row is pinned under, and
 * this write is the newest ciphertext on the row.
 *
 * Guarded on the row still being live, so setting a secret on a credential
 * somebody disconnected mid-flow loses rather than resurrecting an erased row.
 */
export async function setRevenueWebhookSecret(
  db: Database,
  input: SetRevenueWebhookSecretInput,
): Promise<RevenueCredentialRow | null> {
  const now = input.now ?? new Date()

  return await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(revenueCredentials)
      .set({
        encryptedWebhookSecret: input.encryptedWebhookSecret,
        keyVersion: input.keyVersion,
        updatedAt: now,
      })
      .where(
        and(
          eq(revenueCredentials.id, input.credentialId),
          eq(revenueCredentials.siteId, input.siteId),
          ne(revenueCredentials.status, 'disabled'),
        ),
      )
      .returning(COLUMNS)

    if (!updated) return null

    // Its own action rather than `site.revenue.rotated`: an operator reading
    // this trail is asking which secret moved, and the two have different blast
    // radii. Never the secret, never a prefix of it — only that it was set.
    await writeAudit(tx, {
      action: 'site.revenue.webhook_secret_set',
      actorUserId: input.actorUserId,
      siteId: input.siteId,
      targetType: 'revenue_credential',
      targetId: updated.id,
      metadata: { provider: updated.provider, key_version: input.keyVersion },
    })

    return updated
  })
}

export interface DisconnectRevenueCredentialInput {
  readonly credentialId: string
  readonly siteId: string
  /** Null for a disconnect nobody asked for — the owner-removal revocation and
   * the deletion-start erasure both run without an acting user of their own. */
  readonly actorUserId: string | null
  readonly reason?: 'requested' | 'owner_removed' | 'site_deleting'
  readonly now?: Date
}

/**
 * Disconnect: disable the row and erase both ciphertexts in the same UPDATE.
 *
 * The facts and the history stay — this is a status change, not a delete — and
 * the row keeps its `webhook_token` so a provider still posting to the old
 * address resolves to a credential the CP2 endpoint can ack and ignore, rather
 * than to a 404 that Stripe would retry.
 *
 * One statement, because the two halves are one promise. The table's
 * `revenue_credentials_disabled_erased_check` is what makes that promise
 * enforced rather than merely intended.
 */
export async function disconnectRevenueCredential(
  db: Database,
  input: DisconnectRevenueCredentialInput,
): Promise<boolean> {
  const now = input.now ?? new Date()

  return await db.transaction(async (tx) => {
    const rows = await eraseRevenueCredentials(tx, {
      where: all(
        eq(revenueCredentials.id, input.credentialId),
        eq(revenueCredentials.siteId, input.siteId),
      ),
      now,
    })
    const disconnected = rows[0]
    if (!disconnected) return false

    await writeAudit(tx, {
      action: 'site.revenue.disconnected',
      actorType: input.actorUserId === null ? 'system' : 'user',
      actorUserId: input.actorUserId,
      siteId: input.siteId,
      targetType: 'revenue_credential',
      targetId: disconnected.id,
      metadata: { provider: disconnected.provider, reason: input.reason ?? 'requested' },
    })

    return true
  })
}

/**
 * The shared erase-and-disable UPDATE.
 *
 * Every path that takes a credential out of service goes through it — the
 * customer's disconnect, the owner-removal revocation, the account teardown and
 * the deletion-start erasure — so there is exactly one statement in the codebase
 * that can leave a row disabled, and it is the one that nulls both ciphertexts.
 *
 * `where` is **required, not `SQL | undefined`**, and that is not a style
 * preference: drizzle's `and()` silently drops `undefined` operands, so a caller
 * that passed one would compose down to `WHERE status <> 'disabled'` and erase
 * every credential in the installation. The type is what makes that unwritable.
 */
async function eraseRevenueCredentials(
  tx: Executor,
  input: { where: SQL; now: Date },
): Promise<{ id: string; provider: string; createdByUserId: string }[]> {
  return await tx
    .update(revenueCredentials)
    .set({
      status: 'disabled',
      encryptedApiKey: null,
      encryptedWebhookSecret: null,
      disabledAt: input.now,
      // Cleared with the secret: a stale failure category on a disconnected
      // credential would render to the customer as an outage they cannot fix.
      lastError: null,
      updatedAt: input.now,
    })
    .where(and(input.where, ne(revenueCredentials.status, 'disabled')))
    .returning({
      id: revenueCredentials.id,
      provider: revenueCredentials.provider,
      createdByUserId: revenueCredentials.createdByUserId,
    })
}

export interface RevokeRevenueCredentialsInput {
  readonly siteId: string
  /** The departing owner. Their credentials go with them. */
  readonly userId: string
  /** Who caused the removal; null for a system-driven path. */
  readonly actorUserId?: string | null
  readonly now?: Date
}

/**
 * Revoke the credentials an owner being removed from the site connected
 * (snapshot 02 §19, ADR-0033 D3).
 *
 * Takes an `Executor` rather than a `Database` on purpose: it runs **inside**
 * the removal's own transaction, beside the membership delete, the private-key
 * revocation and the durable realtime-epoch bump. Split out into its own
 * transaction, a crash between the two would leave a removed owner's provider
 * key live on a site they no longer belong to — which is the exact window the
 * §19 rule exists to close.
 *
 * Returns the credential ids it disabled, so the caller can record the count.
 */
export async function revokeRevenueCredentialsCreatedBy(
  tx: Executor,
  input: RevokeRevenueCredentialsInput,
): Promise<string[]> {
  const now = input.now ?? new Date()
  const rows = await eraseRevenueCredentials(tx, {
    where: all(
      eq(revenueCredentials.siteId, input.siteId),
      eq(revenueCredentials.createdByUserId, input.userId),
    ),
    now,
  })
  if (rows.length === 0) return []

  await writeAudit(tx, {
    action: 'site.revenue.revoked',
    actorType: input.actorUserId ? 'user' : 'system',
    actorUserId: input.actorUserId ?? null,
    siteId: input.siteId,
    targetType: 'site_member',
    targetId: input.userId,
    metadata: {
      reason: 'owner_removed',
      credentials: rows.length,
      providers: rows.map((row) => row.provider),
    },
  })

  return rows.map((row) => row.id)
}

/**
 * Revoke every credential this **account** connected, across every site
 * (ADR-0033, D3/D8 — the `revenue_credentials_revoke` account target).
 *
 * The mirror of `api_keys_revoke`, and it exists for exactly the same reason
 * that one does: the rows are *site*-scoped and the sites are not being deleted,
 * so nothing else in an account teardown reaches them. Left alone, the sync loop
 * would keep decrypting and using a customer's payment-provider key on behalf of
 * an account that no longer exists — a live, decryptable secret whose only owner
 * has been erased.
 *
 * Deliberately **not** scoped by site: `revokeRevenueCredentialsCreatedBy` is
 * the membership-removal path and answers "this person left this site", while
 * this one answers "this person is gone". An account that connected credentials
 * on four sites has four to revoke, and a site loop would need the membership
 * rows the same transaction is about to delete.
 *
 * Disabled with the ciphertexts erased rather than deleted, because the row is
 * the *site's* connection history and the site is still alive — the same
 * distinction that makes `api_keys_revoke` a revocation and the site
 * vocabulary's `api_keys` a delete.
 *
 * Takes an `Executor`: it runs inside the teardown transaction, beside the key
 * revocation and the membership delete.
 */
export async function revokeAccountRevenueCredentials(
  tx: Executor,
  input: { userId: string; now?: Date },
): Promise<string[]> {
  const rows = await eraseRevenueCredentials(tx, {
    where: all(eq(revenueCredentials.createdByUserId, input.userId)),
    now: input.now ?? new Date(),
  })
  return rows.map((row) => row.id)
}

/**
 * Erase every credential ciphertext on a site that is starting deletion
 * (ADR-0033, D8).
 *
 * Runs inside `startSiteDeletion`'s transaction, beside the key revocation, and
 * long before `postgres_purge` removes the rows: a site on its way out must not
 * keep a decryptable provider key even transiently, and the purge phases can
 * take as long as ClickHouse takes to rewrite its parts. No audit row of its
 * own — the deletion's own `site.deletion_requested` entry records the count.
 */
export async function eraseSiteRevenueCredentials(
  tx: Executor,
  input: { siteId: string; now?: Date },
): Promise<number> {
  const rows = await eraseRevenueCredentials(tx, {
    where: eq(revenueCredentials.siteId, input.siteId),
    now: input.now ?? new Date(),
  })
  return rows.length
}
