import type { IngestAdmission, Policy, SiteIngestConfig } from '@openanalytics/domain'
import type { Metrics } from '@openanalytics/observability'
import type { Database } from '@openanalytics/postgres'
import type { RealtimeCache } from '@openanalytics/redis'
import type { CachedIngestConfig } from './ingest-config-store.ts'

/**
 * The seam the hosted quota and suspension gates mount through.
 *
 * The registration shape the rest of the split uses, applied to ingest. Three
 * gates were inline in `events.ts` and `ingest-gate.ts` until the open-core
 * split, and all three are about money: whether a `suspended` site is inside its
 * paid grace window, whether the plan's window limit is spent, and the near-
 * realtime counter that decides both. A self-hosted collector has no plan and no
 * window, and — this is the part worth stating — **it must not have a quota gate
 * that fails open**. Absent an extension there is no gate at all rather than one
 * that always says yes: the difference matters the day somebody reads this code
 * to find out what limits their install has.
 *
 * `apps/collector/src/main.cloud.ts` is the entry point that registers one; the
 * product's `main.ts` reads the registry and names no cloud module, which is what
 * `scripts/check-boundaries.mjs` enforces.
 */

/**
 * What the hosted gates know about a site that the product config does not.
 *
 * Resolved by `decorateConfig` on a config-cache miss and cached in the same
 * entry, so it costs one extra Postgres read per key per TTL rather than one per
 * event — the product read stays the single query it says it is.
 */
export interface CloudIngestFacts {
  /** D-014's anchor. Null means nothing has ever been paid, so there is no
   * window and no limit to exceed. */
  readonly quotaAnchorAt: Date | null
  /** The plan in force, or null for a site with no entitlement. `null` is "no
   * limit", which is only ever reached by a site that is also unbilled. */
  readonly planTier: string | null
  /** D-012: set when a previously entitled site was suspended. */
  readonly ingestGraceUntil: Date | null
  /** D-012/D-013: the marker separating a site that once paid from one that
   * never has. Null means no grace has ever been earned. */
  readonly firstEntitledAt: Date | null
}

/** The window a batch billed into, handed from the pre-enqueue check to the
 * post-enqueue increment so the two cannot disagree about which window they
 * mean. Opaque to the product path, which only passes it back. */
export interface CloudUsageWindow {
  readonly startsAt: Date
  readonly endsAt: Date
}

export interface CollectorCloudExtension {
  readonly name: string
  /**
   * Resolves the hosted facts for a freshly read config, and may correct its
   * billing attribution — `billingUserId` and `billingAssignmentVersion` are the
   * usage ledger's grouping key, and the product read fills them from the site's
   * owner of record because it has no assignment table to consult.
   *
   * Called on a cache miss only. Its result is what gets cached, so a failure
   * here is a failure to resolve the config at all rather than a config cached
   * without its facts.
   */
  readonly decorateConfig: (resolved: CachedIngestConfig) => Promise<CachedIngestConfig>
  /**
   * The verdict for a site the product gate found `suspended` (D-012/D-013):
   * inside its grace window the batch is admitted as `grace`, outside it the
   * refusal names why. Pure, given the facts the decorator already resolved.
   */
  readonly admitSuspended: (input: {
    readonly config: SiteIngestConfig
    readonly facts: CloudIngestFacts
    readonly now: Date
  }) => IngestAdmission
  /**
   * The quota gate (D-103), before anything is enqueued. Throws
   * `QUOTA_EXCEEDED` when the window and its buffer are spent; otherwise returns
   * the window this batch bills into, or `null` for a site that has none.
   */
  readonly checkUsage: (input: {
    readonly config: SiteIngestConfig
    readonly facts: CloudIngestFacts
    readonly acceptedAt: Date
    /** Billable events in the batch, as classified. */
    readonly billable: number
  }) => Promise<CloudUsageWindow | null>
  /**
   * The counter increment, after the durable write succeeded and only for events
   * that were *newly* enqueued — a duplicate billed twice is the double charge
   * D-209 exists to prevent. Never throws: the worker reconciles this counter,
   * so losing an increment costs a limit check, not an event.
   */
  readonly recordUsage: (input: {
    readonly config: SiteIngestConfig
    readonly window: CloudUsageWindow
    readonly newlyBillable: number
    readonly acceptedAt: Date
  }) => Promise<void>
}

/**
 * What the extension is built from: the same four objects the ingest routes hold.
 *
 * Nothing new is opened for it — the database is the pool the config read already
 * uses, and the counter is the very `RealtimeCache` instance in `CollectorDeps`,
 * so the quota gate and the presence writes share one connection and one budget.
 */
export interface CollectorCloudContext {
  readonly db: Database
  readonly realtime: RealtimeCache
  readonly metrics: Metrics
  readonly policy: Policy
}

/** Registered at import time; built once `main.ts` has the four objects above. */
export interface CollectorCloudFactory {
  readonly name: string
  readonly create: (ctx: CollectorCloudContext) => CollectorCloudExtension
}

let registered: CollectorCloudFactory | undefined

/** Idempotent by name. A second, different extension is refused: two quota gates
 * on one path would make which one refused a batch depend on import order. */
export function registerCollectorCloudExtension(factory: CollectorCloudFactory): void {
  if (registered?.name === factory.name) return
  if (registered) {
    throw new Error(
      `a collector cloud extension is already registered ("${registered.name}"); ` +
        `"${factory.name}" would make the gate order depend on import order`,
    )
  }
  registered = factory
}

export function collectorCloudExtension(): CollectorCloudFactory | undefined {
  return registered
}
