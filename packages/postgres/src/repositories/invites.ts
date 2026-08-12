import { createHash, randomBytes } from 'node:crypto'
import { and, asc, eq, lte, or, sql } from 'drizzle-orm'
import type { Database } from '../client.ts'
import { writeAudit } from './audit.ts'
import { users } from '../schema/auth.ts'
import { siteInvites, siteMembers, type SiteRole } from '../schema/sites.ts'

/**
 * Site invitations.
 *
 * An invite carries only the SHA-256 hash of its token; the raw token goes in
 * the emailed link and is never stored (ADR-0006). Acceptance is a single
 * transaction that verifies the token, that it is still pending and unexpired,
 * and that the accepting user's email matches the invite, then adds the
 * membership and marks the invite accepted. The invited email is PII and is
 * never written to the audit trail.
 *
 * Expiry is *lazy* (`expireStaleInvites`). `site_invites_pending_key` is a
 * partial unique index on `WHERE status = 'pending'`, and a partial index
 * predicate cannot call `now()`, so a lapsed invite that stays `pending` keeps
 * occupying the one-live-invite slot for its (site, email) while every read that
 * filters on the clock hides it — an invisible, permanent block on re-inviting
 * that address. Sweeping inside the transactions that care is what makes the
 * stored status and the clock agree, exactly as
 * `expireStaleBillingTransferOffers` does for the offer index.
 */

export type InviteViolation =
  'invalid_or_expired' | 'email_mismatch' | 'already_invited' | 'already_member'

export class InviteError extends Error {
  readonly violation: InviteViolation

  constructor(violation: InviteViolation, message: string) {
    super(message)
    this.name = 'InviteError'
    this.violation = violation
  }
}

type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0]

/** Seven days. The default life of an acceptance link. */
export const INVITE_TTL_HOURS = 168

/**
 * How long an expired invitation stays on the team screen.
 *
 * Long enough that "I never got it" arrives while the row is still there to
 * resend, short enough that the screen is a work queue rather than an archive.
 * Past this the row is history like `accepted` and `revoked`, and re-inviting
 * the address is an ordinary new invite.
 */
export const EXPIRED_INVITE_VISIBLE_DAYS = 30

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function pgCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const code = (current as Record<string, unknown>)['code']
    if (typeof code === 'string') return code
    current = (current as Record<string, unknown>)['cause']
  }
  return undefined
}

/**
 * Mark every lapsed `pending` invitation `expired`.
 *
 * Run inside the transactions that care rather than from a periodic job, for the
 * same reason `expireStaleBillingTransferOffers` is: the only thing a lapsed
 * `pending` row does is occupy the "one live invite per (site, email)" partial
 * index, so flipping it exactly when a new invite is made, an invite is resent
 * or the list is read is both sufficient and free of a job that could stop
 * running.
 *
 * No audit row, again matching the offer sweep: nobody performed this — it is
 * the clock catching up with a status the row already had, and an audit trail of
 * accounts acting (AGENTS.md) is not improved by rows nobody caused.
 *
 * The boundary is `expires_at <= now`, the same instant `acceptInvite` already
 * refuses at, so a row can never be expired here yet acceptable there.
 */
export async function expireStaleInvites(
  db: Executor,
  input: { siteId?: string; now?: Date } = {},
): Promise<number> {
  const now = input.now ?? new Date()
  const rows = await db
    .update(siteInvites)
    .set({ status: 'expired' })
    .where(
      and(
        eq(siteInvites.status, 'pending'),
        lte(siteInvites.expiresAt, now),
        ...(input.siteId === undefined ? [] : [eq(siteInvites.siteId, input.siteId)]),
      ),
    )
    .returning({ id: siteInvites.id })

  return rows.length
}

/**
 * Whether the invited address already belongs to a member of this site.
 *
 * Matched case-insensitively on the address, the way the pending index and
 * `acceptInvite` both compare emails.
 */
async function emailIsAlreadyMember(
  tx: Executor,
  input: { siteId: string; email: string },
): Promise<boolean> {
  const [existing] = await tx
    .select({ userId: siteMembers.userId })
    .from(siteMembers)
    .innerJoin(users, eq(users.id, siteMembers.userId))
    .where(
      and(eq(siteMembers.siteId, input.siteId), sql`lower(${users.email}) = lower(${input.email})`),
    )
  return existing !== undefined
}

export interface CreateInviteInput {
  readonly siteId: string
  readonly email: string
  readonly role: SiteRole
  readonly invitedByUserId?: string
  /** Time to live in hours; defaults to seven days. */
  readonly ttlHours?: number
  readonly now?: Date
}

export interface CreatedInvite {
  readonly inviteId: string
  /** The raw token for the emailed acceptance link; never stored. */
  readonly rawToken: string
}

export async function createInvite(db: Database, input: CreateInviteInput): Promise<CreatedInvite> {
  const rawToken = `oa_inv_${randomBytes(24).toString('base64url')}`
  const tokenHash = sha256Hex(rawToken)
  const now = input.now ?? new Date()
  const expiresAt = new Date(now.getTime() + (input.ttlHours ?? INVITE_TTL_HOURS) * 60 * 60 * 1000)

  try {
    return await db.transaction(async (tx) => {
      // Refused up front rather than at acceptance. Without this the invite is
      // created, the email is sent, and the failure only surfaces when the
      // recipient clicks — at which point the row also occupies the pending slot
      // for an address that can never use it.
      if (await emailIsAlreadyMember(tx, { siteId: input.siteId, email: input.email })) {
        throw new InviteError('already_member', 'that address already belongs to a member')
      }

      // A lapsed invite must not hold the pending slot against a fresh one.
      await expireStaleInvites(tx, { siteId: input.siteId, now })

      const [row] = await tx
        .insert(siteInvites)
        .values({
          siteId: input.siteId,
          email: input.email,
          role: input.role,
          tokenHash,
          expiresAt,
          ...(input.invitedByUserId === undefined
            ? {}
            : { invitedByUserId: input.invitedByUserId }),
        })
        .returning({ id: siteInvites.id })
      if (!row) throw new Error('invite insert returned no row')

      await writeAudit(tx, {
        action: 'site.invite.created',
        actorUserId: input.invitedByUserId ?? null,
        actorType: input.invitedByUserId ? 'user' : 'system',
        siteId: input.siteId,
        targetType: 'site_invite',
        targetId: row.id,
        // Role only — the invited email is PII and stays out of the audit trail.
        metadata: { role: input.role },
      })

      return { inviteId: row.id, rawToken }
    })
  } catch (error) {
    if (error instanceof InviteError) throw error
    // The partial unique index forbids a second pending invite per (site, email).
    // Still the authority after the sweep above: two managers inviting the same
    // address at once is exactly the case a read-then-insert would get wrong.
    if (pgCode(error) === '23505') {
      throw new InviteError('already_invited', 'a pending invite already exists for this email')
    }
    throw error
  }
}

/** The two states a listed invitation can be in; see `listSiteInvites`. */
export type ListedInviteStatus = 'pending' | 'expired'

export interface SiteInviteSummary {
  readonly inviteId: string
  /** The invited address. Returned to a team manager, never audited or logged. */
  readonly email: string
  readonly role: SiteRole
  /** Null when the inviting account has since been deleted (ON DELETE SET NULL). */
  readonly invitedByUserId: string | null
  readonly createdAt: Date
  readonly expiresAt: Date
  /**
   * `pending` means the link still works; `expired` means it lapsed and the only
   * thing left to do with the row is resend or revoke it. The sweep runs first,
   * so a stored `pending` the clock has overtaken can only surface in the
   * one-statement window between the sweep and the read; `expiresAt` is the
   * authority if the two ever disagree.
   */
  readonly status: ListedInviteStatus
}

/**
 * A site's actionable invitations, oldest first.
 *
 * `pending` rows *and* rows that expired within the last
 * `EXPIRED_INVITE_VISIBLE_DAYS` days. Hiding the expired ones is what made the
 * dead-end: the row went on holding the pending slot for its address, so a fresh
 * invite was refused with a 409 pointing at an invitation nobody could see, and
 * the manager had no row to revoke or resend. Both actions this screen offers —
 * revoke, resend — mean something on an expired row, so it belongs on the
 * screen.
 *
 * Accepted and revoked invitations stay hidden: those are settled history, and
 * neither action means anything on them.
 *
 * `token_hash` is deliberately not in the projection. The acceptance token is
 * mailed and never stored raw (ADR-0006); its hash is a credential-equivalent
 * and has no reason to leave the database, exactly as `listApiKeys` omits
 * `key_hash`.
 */
export async function listSiteInvites(
  db: Database,
  siteId: string,
  options: { now?: Date } = {},
): Promise<SiteInviteSummary[]> {
  const now = options.now ?? new Date()
  // First, so no row can be reported `pending` after its expiry has passed.
  await expireStaleInvites(db, { siteId, now })

  const visibleFrom = new Date(now.getTime() - EXPIRED_INVITE_VISIBLE_DAYS * 24 * 60 * 60 * 1000)
  const rows = await db
    .select({
      inviteId: siteInvites.id,
      email: siteInvites.email,
      role: siteInvites.role,
      invitedByUserId: siteInvites.invitedByUserId,
      createdAt: siteInvites.createdAt,
      expiresAt: siteInvites.expiresAt,
      status: siteInvites.status,
    })
    .from(siteInvites)
    .where(
      and(
        eq(siteInvites.siteId, siteId),
        or(
          eq(siteInvites.status, 'pending'),
          and(eq(siteInvites.status, 'expired'), sql`${siteInvites.expiresAt} > ${visibleFrom}`),
        ),
      ),
    )
    .orderBy(asc(siteInvites.createdAt))

  return rows.map((row) => ({ ...row, status: row.status as ListedInviteStatus }))
}

export interface RevokeInviteInput {
  readonly siteId: string
  readonly inviteId: string
  readonly actorUserId?: string
}

/**
 * Revokes a pending invitation, so its emailed token can no longer be redeemed.
 *
 * Scoped by BOTH `id` and `site_id`, the way `revokeApiKey` is: an invite id is
 * an opaque identifier a caller may come to hold, and authorization was granted
 * on one site. Without the site predicate a team manager could revoke another
 * site's invitation by id.
 *
 * A `pending` or `expired` row is revocable; `accepted` and `revoked` ones are
 * settled, so a second call reports `revoked: false` and the route answers 404
 * rather than claiming a revocation that did not happen. `expired` is included
 * because `resendInvite` can revive such a row: it is listed, it is revivable,
 * and revoking it is how a manager ends it for good. Restricting this to
 * `pending` would put a button on the team screen that always 404s — the same
 * shape of dead end the lazy sweep exists to remove.
 *
 * Returns whether a live invite was revoked; the audit row carries the role
 * only. The invited email is PII and never enters the audit trail.
 */
export async function revokeInvite(
  db: Database,
  input: RevokeInviteInput,
): Promise<{ revoked: boolean }> {
  return db.transaction(async (tx) => {
    const [revoked] = await tx
      .update(siteInvites)
      .set({ status: 'revoked' })
      .where(
        and(
          eq(siteInvites.id, input.inviteId),
          eq(siteInvites.siteId, input.siteId),
          or(eq(siteInvites.status, 'pending'), eq(siteInvites.status, 'expired')),
        ),
      )
      .returning({ id: siteInvites.id, role: siteInvites.role })
    if (!revoked) return { revoked: false }

    await writeAudit(tx, {
      action: 'site.invite.revoked',
      actorUserId: input.actorUserId ?? null,
      actorType: input.actorUserId ? 'user' : 'system',
      siteId: input.siteId,
      targetType: 'site_invite',
      targetId: revoked.id,
      // Role only — the invited email is PII and stays out of the audit trail.
      metadata: { role: revoked.role },
    })

    return { revoked: true }
  })
}

export interface ResendInviteInput {
  readonly siteId: string
  readonly inviteId: string
  readonly actorUserId?: string
  /** Time to live in hours for the new link; defaults to seven days. */
  readonly ttlHours?: number
  readonly now?: Date
}

export interface ResentInvite {
  readonly inviteId: string
  /** The invited address, so the caller can address the email without re-reading. */
  readonly email: string
  readonly role: SiteRole
  readonly expiresAt: Date
  /** The raw token for the new acceptance link; never stored. */
  readonly rawToken: string
  /**
   * First 16 hex characters of the new token's SHA-256, for the notification's
   * idempotency key. New per resend, so it identifies *this* resend; a hash
   * prefix reveals nothing the outbox row does not already hold — the payload
   * carries the raw token in the acceptance URL.
   */
  readonly tokenHashPrefix: string
}

/**
 * Send the invitation again: a new token, a new expiry, one live link.
 *
 * Works on a `pending` invitation (the manager suspects the mail was lost) and
 * on an `expired` one, which it revives — that is the point. All of it in one
 * transaction under `FOR UPDATE` on the invite row, so the sweep, the status
 * check and the write cannot interleave with a concurrent resend or revoke.
 *
 * The old token stops working the instant this commits, because `token_hash` is
 * replaced: there is exactly one live link per invitation, which is what makes
 * "resend" honest rather than "issue a second key to the same door".
 *
 * `accepted` and `revoked` rows, and rows belonging to another site, report
 * `invalid_or_expired` — the route answers 404. Reviving a settled invitation
 * would undo a decision somebody made.
 */
export async function resendInvite(db: Database, input: ResendInviteInput): Promise<ResentInvite> {
  const rawToken = `oa_inv_${randomBytes(24).toString('base64url')}`
  const tokenHash = sha256Hex(rawToken)
  const now = input.now ?? new Date()
  const expiresAt = new Date(now.getTime() + (input.ttlHours ?? INVITE_TTL_HOURS) * 60 * 60 * 1000)

  try {
    return await db.transaction(async (tx) => {
      // Before the read, so a lapsed row is already `expired` when its status is
      // judged, and so any *other* lapsed invite to this address stops holding
      // the pending slot this revival is about to claim.
      await expireStaleInvites(tx, { siteId: input.siteId, now })

      const [invite] = await tx
        .select({
          id: siteInvites.id,
          email: siteInvites.email,
          role: siteInvites.role,
          status: siteInvites.status,
        })
        .from(siteInvites)
        // Scoped by both id and site id, as `revokeInvite` is: authorization was
        // granted on one site, and an invite id is an opaque identifier a caller
        // may come to hold.
        .where(and(eq(siteInvites.id, input.inviteId), eq(siteInvites.siteId, input.siteId)))
        .for('update')

      if (!invite || (invite.status !== 'pending' && invite.status !== 'expired')) {
        throw new InviteError('invalid_or_expired', 'no resendable invite with this id')
      }
      if (await emailIsAlreadyMember(tx, { siteId: input.siteId, email: invite.email })) {
        throw new InviteError('already_member', 'that address already belongs to a member')
      }

      await tx
        .update(siteInvites)
        .set({ tokenHash, expiresAt, status: 'pending' })
        .where(eq(siteInvites.id, invite.id))

      await writeAudit(tx, {
        action: 'site.invite.resent',
        actorUserId: input.actorUserId ?? null,
        actorType: input.actorUserId ? 'user' : 'system',
        siteId: input.siteId,
        targetType: 'site_invite',
        targetId: invite.id,
        // Role and the state it was resent from — never the invited email (PII).
        metadata: { role: invite.role, from_status: invite.status },
      })

      return {
        inviteId: invite.id,
        email: invite.email,
        role: invite.role,
        expiresAt,
        rawToken,
        tokenHashPrefix: tokenHash.slice(0, 16),
      }
    })
  } catch (error) {
    if (error instanceof InviteError) throw error
    // Reviving an expired row can collide with a newer pending invite to the
    // same address; the partial index is the authority on that, not a pre-read.
    if (pgCode(error) === '23505') {
      throw new InviteError('already_invited', 'a pending invite already exists for this email')
    }
    throw error
  }
}

export interface AcceptInviteInput {
  readonly rawToken: string
  readonly userId: string
}

export interface AcceptedInvite {
  readonly siteId: string
  readonly role: SiteRole
}

export async function acceptInvite(
  db: Database,
  input: AcceptInviteInput,
): Promise<AcceptedInvite> {
  const tokenHash = sha256Hex(input.rawToken)

  try {
    return await db.transaction(async (tx) => {
      const [invite] = await tx
        .select({
          id: siteInvites.id,
          siteId: siteInvites.siteId,
          email: siteInvites.email,
          role: siteInvites.role,
          status: siteInvites.status,
          expiresAt: siteInvites.expiresAt,
        })
        .from(siteInvites)
        .where(eq(siteInvites.tokenHash, tokenHash))
        .for('update')

      if (!invite || invite.status !== 'pending' || invite.expiresAt.getTime() <= Date.now()) {
        throw new InviteError('invalid_or_expired', 'the invite is invalid, used or expired')
      }

      const [user] = await tx
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, input.userId))
      if (!user) {
        throw new InviteError('invalid_or_expired', 'the accepting user does not exist')
      }
      if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
        throw new InviteError('email_mismatch', 'the invite was issued to a different email')
      }

      await tx
        .insert(siteMembers)
        .values({ siteId: invite.siteId, userId: input.userId, role: invite.role })

      await tx
        .update(siteInvites)
        .set({ status: 'accepted', acceptedAt: new Date() })
        .where(eq(siteInvites.id, invite.id))

      await writeAudit(tx, {
        action: 'site.invite.accepted',
        actorUserId: input.userId,
        siteId: invite.siteId,
        targetType: 'site_member',
        targetId: input.userId,
        metadata: { role: invite.role },
      })

      return { siteId: invite.siteId, role: invite.role }
    })
  } catch (error) {
    if (error instanceof InviteError) throw error
    if (pgCode(error) === '23505') {
      throw new InviteError('already_member', 'the user is already a member of this site')
    }
    throw error
  }
}
