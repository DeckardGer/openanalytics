import { z } from 'zod'

/**
 * Durable realtime access-revocation, the worker-drained half of D-213.
 *
 * Revocation is two-layered (docs snapshot 02 §17, 05 D-213). The api bumps the
 * access epoch and publishes a disconnect immediately after a membership change
 * commits — the "immediate" control message — but that best-effort bump is lost if
 * Redis is unreachable at that instant. So the same transaction that removes the
 * member also writes an outbox row on this topic, and the worker drains it,
 * bumping the epoch until Redis acknowledges. A double bump only over-revokes,
 * which is safe: it invalidates already-invalid tokens a second time.
 *
 * The topic constant and its payload schema live here, in a redis-free package
 * both the Postgres outbox producer and the worker drainer already depend on —
 * mirroring how `EMAIL_OUTBOX_TOPIC` sits beside its payload in
 * `@openanalytics/integrations`, and keeping any ioredis import out of
 * `@openanalytics/postgres`.
 */

/** Outbox topic for a durable realtime access revocation. */
export const REALTIME_ACCESS_REVOKED_TOPIC = 'realtime.access_revoked'

/**
 * Why access was revoked; a stable, minimal enum for correlation.
 *
 * `site_deleted` is the deletion-start transaction's (ADR-0030, D4). It differs
 * from the other two in *scope* rather than in mechanism: the subject it carries
 * is the reserved site-level one below, so the drain's bump cuts every stream on
 * the site instead of one member's.
 */
export const REALTIME_REVOCATION_REASONS = [
  'member_removed',
  'owner_removed',
  'site_deleted',
] as const

export type RealtimeRevocationReason = (typeof REALTIME_REVOCATION_REASONS)[number]

/**
 * The reserved site-level realtime subject (ADR-0030, decision 5).
 *
 * Mirrors `REALTIME_SITE_EPOCH_SUBJECT` in `@openanalytics/redis`, which is the
 * package that builds the epoch key — the two are pinned to each other by a unit
 * test rather than by an import, for the same reason this whole module lives
 * here: `@openanalytics/postgres` writes this payload and must not gain an
 * ioredis dependency to name one string.
 */
export const REALTIME_SITE_SUBJECT = 'site'

/**
 * The stored payload. `user_id` is the realtime subject whose epoch the worker
 * bumps (the epoch key is `rt_epoch:{siteId}:{subject}`, subject = the user id
 * for a private member, the literal `public` for a share link, or
 * `REALTIME_SITE_SUBJECT` for the whole site). The drain passes the field
 * straight through as `subject`, so the field name is narrower than what it
 * carries — kept as it is because renaming a stored payload's key would strand
 * every row already written. A malformed row is marked failed with a clear
 * reason rather than crashing the drain, exactly as the email outbox does.
 */
export const realtimeAccessRevokedPayloadSchema = z.strictObject({
  site_id: z.string().min(1),
  user_id: z.string().min(1),
  reason: z.enum(REALTIME_REVOCATION_REASONS),
})

export type RealtimeAccessRevokedPayload = z.infer<typeof realtimeAccessRevokedPayloadSchema>

/** Validates a stored payload before the worker acts on it. Throws a typed error
 * on a malformed row, which the drain turns into `markFailed`, never a crash. */
export function parseRealtimeAccessRevokedPayload(value: unknown): RealtimeAccessRevokedPayload {
  const parsed = realtimeAccessRevokedPayloadSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(
      `realtime access-revoked payload is malformed: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    )
  }
  return parsed.data
}
