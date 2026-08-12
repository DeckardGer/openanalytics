import { z } from 'zod'

/**
 * Payload schemas for the outbox topics the worker's dispatcher fans out
 * (ADR-0030, decision 1).
 *
 * They live here for the same reason `realtimeAccessRevokedPayloadSchema` does:
 * the producer is `@openanalytics/postgres` and the consumer is the worker, and
 * a schema owned by neither is a schema the two cannot drift apart on. It also
 * keeps zod out of the worker's dependency list, which carries no validator of
 * its own.
 *
 * Every one of these is deliberately **non-strict** about extra keys and narrow
 * about the keys it names. An outbox row was written by an earlier deploy of the
 * producer, so a payload may carry fields this build has never heard of, and
 * refusing it would dead-letter a side effect that is perfectly deliverable.
 * What each schema pins is the identifier the handler acts on.
 */

/**
 * `site.ownership_changed` — a billing-owner cutover landed.
 *
 * `status` is the site state the cutover decided. When it is `suspended`
 * the handler bumps the site epoch, because a handover to someone who cannot
 * fund the site closes its read surfaces and its open streams have to go with
 * them (ADR-0023 + ADR-0030 D1). Any other status is a settled no-op.
 */
export const siteOwnershipChangedPayloadSchema = z.object({
  siteId: z.string().min(1),
  status: z.string().min(1),
})

export type SiteOwnershipChangedPayload = z.infer<typeof siteOwnershipChangedPayloadSchema>

export function parseSiteOwnershipChangedPayload(value: unknown): SiteOwnershipChangedPayload {
  return siteOwnershipChangedPayloadSchema.parse(value)
}
