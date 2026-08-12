import type { PersistedEvent } from '@openanalytics/contracts'
import type { AppliedUsage, UsageDelta } from '@openanalytics/postgres'
import type { IngestDeps } from './deps.ts'

/**
 * Who a batch's billable events are counted against, and what happens once the
 * ledger has taken them.
 *
 * The ledger itself (`usage_batches`, `usage_batch_deltas`) is every deployment's:
 * a self-hosted install that wants to know how many events its sites produced
 * reads exactly those two tables. What is *not* every deployment's is the notion
 * of a billing **window** — a monthly interval anchored at a paid invoice, with a
 * plan's event limit on it — and everything that follows from one: the near-
 * realtime counter the collector's quota gate reads, its reconciliation against
 * the ledger, and the rapid-burn notice about a limit.
 *
 * So the product resolves attribution the honest way for a build with no
 * subscriptions — the payer stamped on the event, no window — and a registered
 * surface replaces that with the windowed answer and adds the two after-effects.
 */

/**
 * One (billing user, window) pair a batch touched, with the window's limit.
 *
 * Meaningless to the product path, which produces none and only hands the map
 * back to whatever produced it: reconciliation and the rapid-burn check reason
 * about a window as a whole, while the ledger's own grain carries the site.
 */
export interface UsageWindowFacts {
  readonly billingUserId: string
  readonly startsAt: Date
  readonly endsAt: Date
  readonly eventLimit: number
}

export interface UsageAttribution {
  readonly deltas: readonly UsageDelta[]
  /** Keyed `${billingUserId}:${usageWindowId}`. Empty without a surface that
   * keeps windows. */
  readonly windows: ReadonlyMap<string, UsageWindowFacts>
}

export interface UsageAttributionExtension {
  readonly name: string
  /** Replaces the product's window-less attribution below. */
  readonly computeDeltas: (
    deps: IngestDeps,
    events: readonly PersistedEvent[],
  ) => Promise<UsageAttribution>
  /**
   * Runs after `applyBatchUsage` has committed, with what it applied. Two
   * effects live here: correcting the losable counter against the authoritative
   * ledger, and the rapid-burn notice. Best-effort by contract — the batch's rows
   * are already durable, so nothing in here may fail it.
   */
  readonly afterApply: (
    deps: IngestDeps,
    input: {
      readonly applied: readonly AppliedUsage[]
      readonly attribution: UsageAttribution
      readonly events: readonly PersistedEvent[]
    },
  ) => Promise<void>
}

let registered: UsageAttributionExtension | undefined

/** Idempotent by name. A second, different extension is refused: two answers to
 * "who is billed for this event" is how a ledger ends up double-counting. */
export function registerUsageAttributionExtension(extension: UsageAttributionExtension): void {
  if (registered?.name === extension.name) return
  if (registered) {
    throw new Error(
      `a usage attribution extension is already registered ("${registered.name}"); ` +
        `"${extension.name}" would make the ledger's grain depend on import order`,
    )
  }
  registered = extension
}

/**
 * Total a batch's billable events per (payer, site), with no window.
 *
 * `billing_user_id` is read off the event rather than resolved, and that is the
 * product's honest answer rather than a shortcut: the collector stamped the site's
 * owner of record at acceptance (02 §7.1 item 10), and with no assignment history
 * to consult there is nothing later that could correct it. `usageWindowId` is
 * `null` — the column is nullable for exactly this case, and `applyBatchUsage`'s
 * idempotency rests on the batch row rather than on the delta tuple because of it.
 */
export async function computeUsageAttribution(
  deps: IngestDeps,
  events: readonly PersistedEvent[],
): Promise<UsageAttribution> {
  if (registered) return await registered.computeDeltas(deps, events)

  const totals = new Map<string, UsageDelta>()
  for (const event of events) {
    if (!event.billable) continue
    const key = `${event.billing_user_id}:${event.site_id}`
    const existing = totals.get(key)
    totals.set(key, {
      billingUserId: event.billing_user_id,
      usageWindowId: null,
      siteId: event.site_id,
      delta: (existing?.delta ?? 0) + 1,
    })
  }
  return { deltas: [...totals.values()], windows: new Map() }
}

/** The registered surface's after-effects, or nothing. */
export async function afterUsageApplied(
  deps: IngestDeps,
  input: {
    readonly applied: readonly AppliedUsage[]
    readonly attribution: UsageAttribution
    readonly events: readonly PersistedEvent[]
  },
): Promise<void> {
  if (!registered) return
  await registered.afterApply(deps, input)
}
