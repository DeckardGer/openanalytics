import type { ErrorCode, ExtensionErrorCode } from '@openanalytics/contracts'
import type { SiteState } from './authz.ts'

/**
 * Whether a resolved site may ingest, as a pure verdict.
 *
 * Docs snapshot 02 §7.1 item 11 and 05 D-012/D-013/D-210. This is asked on every
 * batch and every heartbeat, and both of its wrong answers are expensive: a
 * false accept stores and eventually bills traffic nobody is paying for, and a
 * false refuse silently deletes a paying customer's analytics with no error
 * anyone will notice.
 *
 * Keeping it pure means the collector, its tests and (later) the deletion drain
 * all read the same rule, and that the 24-hour boundary is provable without a
 * clock.
 */

/**
 * The versioned site ingest config a tracking key resolves to (02 §7.1 item 3).
 *
 * `ingestGeneration` and `configVersion` are carried rather than used here: the
 * first fences an accepted event against a concurrent deletion (D-210) and the
 * second keys the short-TTL config cache, so both belong to the resolved value
 * even though admission does not branch on them.
 */
export interface SiteIngestConfig {
  readonly siteId: string
  readonly status: SiteState
  /** Snapshotted onto every accepted event; deletion bumps it (D-210). */
  readonly ingestGeneration: number
  /** Bumped by a dashboard change; invalidates the config cache and the ETag. */
  readonly configVersion: number

  /**
   * The user answerable for this site, stamped onto every accepted event so the
   * usage ledger can group by it (02 §7.1 item 10). The `billing_` spelling is
   * the ledger column's, kept in step with it deliberately.
   */
  readonly billingUserId: string
  readonly billingAssignmentVersion: number

  /** Expiry of the tracking key this config was resolved from, if it has one. */
  readonly keyExpiresAt: Date | null

  /** Customer-configured origin allowlist. Empty means unconfigured, not deny. */
  readonly allowedDomains: readonly string[]
}

/**
 * Why a resolved site was refused.
 *
 * A string rather than a closed union of *this* module's three reasons, because
 * a deployment that mounts more gates than these has more reasons — and the
 * value is a metric label and an error detail, never something branched on.
 */
export type IngestRefusalReason = string

export type IngestAdmission =
  | {
      readonly admitted: true
      /**
       * `grace` marks a window a layered surface admitted the batch under. The
       * distinction is carried forward onto the event because such usage is
       * attributed differently by whatever opened the window; nothing in this
       * package produces it.
       */
      readonly mode: 'entitled' | 'grace'
    }
  | {
      readonly admitted: false
      /** A product code, or one a layered surface registered. */
      readonly code: ErrorCode | ExtensionErrorCode
      readonly reason: IngestRefusalReason
      /** Carried only by a refusal this module does not own the wording of. */
      readonly message?: string
    }

export const ADMIT_ENTITLED: IngestAdmission = { admitted: true, mode: 'entitled' }

/**
 * Decide whether this site may ingest right now.
 *
 * Order matters. The key is checked first so an expired credential never reports
 * the site's state — that would tell an unauthenticated caller something about a
 * site they can no longer address. Deletion is checked next, for the same
 * reason: a `deleting` site answers as if it did not exist rather than as a
 * condition the caller could act on.
 *
 * A `suspended` site answers the same way by default, and `onSuspended` is the
 * one hook: a deployment that has its own account of *why* a site is suspended —
 * and its own grace window for it — supplies the verdict there rather than
 * having this function re-derive it from fields it does not carry. Nothing in
 * this package sets `suspended`; the state, the gate and this hook exist so that
 * a site an operator closes stops ingesting, which is the guarantee the status
 * column makes.
 */
export function decideIngestAdmission(input: {
  readonly config: SiteIngestConfig
  readonly now: Date
  readonly onSuspended?: (input: { config: SiteIngestConfig; now: Date }) => IngestAdmission
}): IngestAdmission {
  const { config, now } = input

  if (config.keyExpiresAt !== null && config.keyExpiresAt.getTime() <= now.getTime()) {
    return { admitted: false, code: 'SITE_NOT_FOUND', reason: 'key_expired' }
  }

  if (config.status === 'deleting' || config.status === 'deleted') {
    return { admitted: false, code: 'SITE_NOT_FOUND', reason: 'site_deleting' }
  }

  if (config.status === 'active') return ADMIT_ENTITLED

  // `suspended` from here. The site row is the authority on whether it happened,
  // so neither this function nor its hook re-derives the answer from anything
  // else: two sources of truth for one question is how a site ends up accepting
  // events its status says it may not.
  if (input.onSuspended) return input.onSuspended({ config, now })

  return { admitted: false, code: 'SITE_NOT_FOUND', reason: 'site_suspended' }
}

/**
 * Site domain/origin allowlist (02 §7.1 item 4).
 *
 * An empty list means the customer has not configured one, which is not a deny —
 * a site that has never opened the setting still expects its traffic. A
 * configured list is a deny for everything outside it, including a request that
 * sends no `Origin` header at all, which is the shape a script posting straight
 * at the endpoint has.
 *
 * Matching is on the host: exact, or a subdomain under a dot boundary. Plain
 * suffix matching would let anyone ingest into `example.com`'s site by
 * registering `notexample.com`.
 */
export function isOriginAllowed(
  origin: string | null | undefined,
  allowedDomains: readonly string[],
): boolean {
  if (allowedDomains.length === 0) return true
  if (origin === null || origin === undefined || origin === '' || origin === 'null') return false

  let host: string
  try {
    host = new URL(origin).hostname.toLowerCase()
  } catch {
    return false
  }
  if (host === '') return false

  return allowedDomains.some((configured) => {
    const domain = configured.trim().toLowerCase().replace(/^\*\./, '')
    if (domain === '') return false
    return host === domain || host.endsWith(`.${domain}`)
  })
}
