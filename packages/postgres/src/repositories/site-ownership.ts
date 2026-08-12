import { and, eq, isNull } from 'drizzle-orm'
import { REALTIME_ACCESS_REVOKED_TOPIC } from '@openanalytics/domain'
import type { RealtimeAccessRevokedPayload } from '@openanalytics/domain'
import { newId } from '../ids.ts'
import { writeAudit } from './audit.ts'
import { revokeRevenueCredentialsCreatedBy } from './revenue-credentials.ts'
import { OwnershipError, SITE_OWNERSHIP_CHANGED_TOPIC, type Executor } from './sites.ts'
import { apiKeys } from '../schema/api-keys.ts'
import { outbox } from '../schema/outbox.ts'
import { siteMembers, sites } from '../schema/sites.ts'

/**
 * Handing a site to another owner.
 *
 * This is the product half of what used to be one function called
 * `applyBillingCutover`. That function did two things at once: it moved the
 * *owner of record* — a column every deployment has, whose meaning is "whose
 * site is this" — and it moved a *bill*, re-deciding the site's state from the
 * successor's plan and capacity. Only one of those is a product act, so only one
 * of them is here.
 *
 * What a hosted deployment adds, it adds through `registerOwnershipTransferExtension`:
 * the funding row moves to the successor's billing account and the site's state
 * follows from whether that account can carry it (D-011). A self-hosted install
 * registers nothing, and a transfer is then exactly what it looks like — the
 * site belongs to someone else now.
 *
 * The two modes differ in one place and it is not the ownership change:
 *
 * - `removal_cutover` (D-010) is a *removal*. The previous owner's link to the
 *   site is fully severed — membership, the private read keys they were shown,
 *   the provider credentials they connected — and their open realtime streams
 *   are closed.
 * - `voluntary_handover` (ADR-0023) is a *gift*. The previous owner keeps their
 *   membership, their keys and their access; they gave the site away, they did
 *   not leave it.
 */

export type SiteOwnerTransferMode = 'removal_cutover' | 'voluntary_handover'

export interface SiteOwnerTransferResult {
  /** The owner of record this replaced, whether or not they were removed. */
  readonly previousUserId: string
  /** Set only by `removal_cutover`; null when the previous owner stays. */
  readonly removedUserId: string | null
}

export interface OwnershipTransferContext {
  readonly siteId: string
  readonly previousUserId: string
  readonly successorUserId: string
  readonly actorUserId: string
  readonly mode: SiteOwnerTransferMode
  readonly now: Date
  /**
   * Whatever the caller handed the transfer for its extensions, carried through
   * untouched and unread by anything here.
   *
   * `unknown` because the product genuinely does not know: the hosted funding
   * duty needs two suspension windows that are billing policy, and typing them
   * here would put a plan's grace period in the module that moves an owner
   * column. The alternative — a module-level slot the caller sets before the
   * transfer — is a shared mutable read across an `await`, which two concurrent
   * transfers would interleave on.
   */
  readonly extra: unknown
}

export interface OwnershipTransferExtension {
  readonly name: string
  /**
   * Runs inside the transfer's transaction, after the owner column has moved and
   * before anything is published. A hosted deployment moves the funding here and
   * may leave the site `suspended`; the outbox row written afterwards reads the
   * site's *final* status, so whatever this decides is what the fan-out carries.
   */
  readonly afterTransfer?: (tx: Executor, context: OwnershipTransferContext) => Promise<void>
}

const transferExtensions: OwnershipTransferExtension[] = []

export function registerOwnershipTransferExtension(extension: OwnershipTransferExtension): void {
  const existing = transferExtensions.findIndex((entry) => entry.name === extension.name)
  if (existing >= 0) transferExtensions.splice(existing, 1, extension)
  else transferExtensions.push(extension)
}

/**
 * Move a site's owner of record, inside a caller-supplied transaction.
 *
 * The site row is locked `FOR UPDATE` so concurrent transfers and membership
 * changes serialize rather than race. In order: verify the successor is an
 * accepted owner, move the column, sever the previous owner if this is a
 * removal, let a hosted deployment move the money, then publish — a cache and
 * access-epoch invalidation for everyone, and a durable realtime revocation for
 * a removed owner.
 *
 * The deferred ownership-invariant triggers (product migration 0006) see the
 * final state at commit: the successor is still an accepted owner and is now the
 * owner of record, so both invariants hold.
 */
export async function transferSiteOwnership(
  tx: Executor,
  input: {
    siteId: string
    successorUserId: string
    /** Who caused it: the taking owner on a removal, the accepting one on a handover. */
    actorUserId: string
    mode: SiteOwnerTransferMode
    now?: Date
    /** Passed to every registered extension; see `OwnershipTransferContext`. */
    extra?: unknown
  },
): Promise<SiteOwnerTransferResult> {
  const now = input.now ?? new Date()

  // Serialize ownership changes for this site.
  const [site] = await tx
    .select({ ownerUserId: sites.ownerUserId })
    .from(sites)
    .where(eq(sites.id, input.siteId))
    .for('update')
  if (!site) throw new OwnershipError('site_not_found', 'no such site')

  const previousUserId = site.ownerUserId
  if (previousUserId === input.successorUserId) {
    throw new OwnershipError('already_billing_owner', 'the successor already owns this site')
  }

  const [successorMember] = await tx
    .select({ role: siteMembers.role })
    .from(siteMembers)
    .where(and(eq(siteMembers.siteId, input.siteId), eq(siteMembers.userId, input.successorUserId)))
  if (!successorMember || successorMember.role !== 'owner') {
    throw new OwnershipError('not_an_owner', 'only an owner can take over a site')
  }

  await tx
    .update(sites)
    .set({ ownerUserId: input.successorUserId, updatedAt: now })
    .where(eq(sites.id, input.siteId))

  const removedUserId = input.mode === 'removal_cutover' ? previousUserId : null

  if (removedUserId !== null) {
    // Fully sever the removed owner: membership, their private read keys, and
    // the provider credentials they connected.
    await tx
      .delete(siteMembers)
      .where(and(eq(siteMembers.siteId, input.siteId), eq(siteMembers.userId, removedUserId)))
    await tx
      .update(apiKeys)
      .set({ revokedAt: now })
      .where(
        and(
          eq(apiKeys.siteId, input.siteId),
          eq(apiKeys.createdByUserId, removedUserId),
          eq(apiKeys.type, 'private_read'),
          isNull(apiKeys.revokedAt),
        ),
      )
    // Snapshot 02 §19, restated by ADR-0033 D3: a removed owner's revenue
    // credential is revoked with them, through the same erase-and-disable
    // statement a customer's disconnect uses. In this transaction, beside the
    // key revocation, so the removal is one commit rather than a sequence with
    // a window in it.
    await revokeRevenueCredentialsCreatedBy(tx, {
      siteId: input.siteId,
      userId: removedUserId,
      actorUserId: input.actorUserId,
      now,
    })
  }

  for (const extension of transferExtensions) {
    await extension.afterTransfer?.(tx, {
      siteId: input.siteId,
      previousUserId,
      successorUserId: input.successorUserId,
      actorUserId: input.actorUserId,
      mode: input.mode,
      now,
      extra: input.extra,
    })
  }

  // The status the extensions left behind, which is what the fan-out is about:
  // a transfer to someone who cannot fund the site closes its read surfaces, and
  // the handler bumps the epoch on exactly that. Re-read rather than assumed —
  // this half of the code does not know what suspends a site.
  const [after] = await tx
    .select({ status: sites.status })
    .from(sites)
    .where(eq(sites.id, input.siteId))

  // Cache / access-epoch invalidation, for both modes: the owner changed either
  // way, and anything caching "whose site is this" has to hear about it. The key
  // names the event — site, successor, instant — rather than being random, so an
  // operator reading the outbox can tell what it was for.
  await tx
    .insert(outbox)
    .values({
      id: newId(),
      topic: SITE_OWNERSHIP_CHANGED_TOPIC,
      payload: {
        siteId: input.siteId,
        mode: input.mode,
        previousUserId,
        removedUserId,
        successorUserId: input.successorUserId,
        status: after?.status ?? 'active',
      },
      idempotencyKey: `site.ownership:${input.siteId}:${input.successorUserId}:${now.toISOString()}`,
    })
    .onConflictDoNothing({ target: outbox.idempotencyKey })

  if (removedUserId !== null) {
    // Durable realtime revocation for the removed owner (D-213), in the same
    // transaction as the transfer. The worker replays the epoch bump until Redis
    // acks, closing any stream the removed owner still holds open.
    //
    // Not written on a handover: the previous owner keeps their membership, so
    // bumping their epoch would tear down a stream they are still entitled to.
    await tx
      .insert(outbox)
      .values({
        id: newId(),
        topic: REALTIME_ACCESS_REVOKED_TOPIC,
        payload: {
          site_id: input.siteId,
          user_id: removedUserId,
          reason: 'owner_removed',
        } satisfies RealtimeAccessRevokedPayload,
        idempotencyKey: `realtime.access_revoked:owner:${input.siteId}:${removedUserId}:${now.toISOString()}`,
      })
      .onConflictDoNothing({ target: outbox.idempotencyKey })
  }

  await writeAudit(tx, {
    action: input.mode === 'removal_cutover' ? 'site.owner.transferred' : 'site.owner.handed_over',
    actorUserId: input.actorUserId,
    siteId: input.siteId,
    targetType: 'site',
    targetId: input.siteId,
    metadata: {
      mode: input.mode,
      previousUserId,
      removedUserId,
      successorUserId: input.successorUserId,
      status: after?.status ?? 'active',
    },
  })

  return { previousUserId, removedUserId }
}
