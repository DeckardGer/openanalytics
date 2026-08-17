import type { EventType } from '@openanalytics/contracts'

/**
 * Server event classifier and the D-101 billable matrix.
 *
 * Docs snapshot 02 §9 and 05 D-101. `billable` is never a client field: usage
 * counts meaningful analytics events a customer caused, and letting the sender
 * decide would make the invoice a client-side setting. Everything here is pure,
 * so the collector, the worker and their tests share one answer.
 *
 * The subtle rule is the last one: one browser action must not bill twice
 * because it produced both a hand-written `custom_event` and a dashboard no-code
 * rule. That is `collapseBillableActions`.
 */

/** Where an event came from. Only customer browser/SDK traffic can be billable. */
export const EVENT_ORIGINS = [
  'client_sdk',
  'no_code_rule',
  'import',
  'revenue_sync',
  'internal',
] as const

export type EventOrigin = (typeof EVENT_ORIGINS)[number]

/** Types that count as usage when nothing else disqualifies them (D-101). */
const BILLABLE_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'page_view',
  'custom_event',
  'conversion',
])

/** Origins that are never customer-caused analytics traffic (D-101). */
const NON_CUSTOMER_ORIGINS: ReadonlySet<EventOrigin> = new Set<EventOrigin>([
  'import',
  'revenue_sync',
  'internal',
])

export type NonBillableReason =
  | 'never_billable_type'
  | 'not_customer_traffic'
  | 'bot'
  | 'invalid'
  | 'duplicate'
  | 'duplicate_source_action'

export interface ClassificationInput {
  readonly type: EventType
  readonly origin: EventOrigin
  /** Matched the versioned bot ruleset (docs snapshot 02 §10). */
  readonly bot?: boolean
  /** Failed validation; kept only as a counter, never as usage. */
  readonly invalid?: boolean
  /** Already accepted inside the `(site_id,event_id)` dedup window (D-209). */
  readonly duplicate?: boolean
}

export interface EventClassification {
  readonly type: EventType
  readonly billable: boolean
  /** Usage units, 1 or 0. The matrix has no other value. */
  readonly usageUnits: 0 | 1
  /** Why it is not billable. `billable_type` when it is. */
  readonly reason: NonBillableReason | 'billable_type'
}

const BILLABLE: EventClassification['reason'] = 'billable_type'

function nonBillable(type: EventType, reason: NonBillableReason): EventClassification {
  return { type, billable: false, usageUnits: 0, reason }
}

/**
 * Classify one event.
 *
 * The type decides first: a `heartbeat`, `engagement`, `web_vital`, `identify`
 * or `interaction` is 0 no matter who sent it or how (D-101). Then origin —
 * imported history and synced revenue transactions are not the customer's
 * tracked traffic. Only then the per-event disqualifiers.
 */
export function classifyEvent(input: ClassificationInput): EventClassification {
  const { type } = input

  if (!BILLABLE_TYPES.has(type)) return nonBillable(type, 'never_billable_type')
  if (NON_CUSTOMER_ORIGINS.has(input.origin)) return nonBillable(type, 'not_customer_traffic')
  if (input.invalid === true) return nonBillable(type, 'invalid')
  if (input.bot === true) return nonBillable(type, 'bot')
  if (input.duplicate === true) return nonBillable(type, 'duplicate')

  return { type, billable: true, usageUnits: 1, reason: BILLABLE }
}

export interface ClassificationCandidate extends ClassificationInput {
  readonly eventId: string
  /**
   * Correlates events produced by one browser action. Client-set, but not a
   * billing field and not a discount: it identifies exactly one documented
   * situation — the same click described twice, once by the customer's own
   * `track` call and once by a dashboard no-code rule.
   */
  readonly actionId?: string | null
  /**
   * The event name, for `custom_event` and `conversion`.
   *
   * Load-bearing for the collapse below (ADR-0034, D5): two events only
   * describe *the same* input if they call it the same thing.
   */
  readonly name?: string | null
}

function isRawCustomEvent(candidate: ClassificationCandidate): boolean {
  return candidate.type === 'custom_event' && candidate.origin !== 'no_code_rule'
}

function isNoCodeCustomEvent(candidate: ClassificationCandidate): boolean {
  return candidate.type === 'custom_event' && candidate.origin === 'no_code_rule'
}

/** The collapse key: one browser action, described under one name. */
function collapseKey(actionId: string, name: string): string {
  return `${actionId}\0${name}`
}

/**
 * Suppresses the one double charge D-101 documents, and nothing else.
 *
 * D-101 names a single pair: "the same browser input is not billed twice as a
 * raw custom event and as a no-code derived event". So within one `action_id`
 * **and one event name**, if a billable no-code `custom_event` exists, **at most
 * one** raw `custom_event` loses its charge — the first by position, so a batch
 * always classifies the same way.
 *
 * Everything else is deliberately left alone:
 *
 * - `page_view` and `conversion` are never suppressed. The matrix gives each its
 *   own unit, and a navigation or a purchase is not a restatement of a click.
 * - Events of the same class never suppress each other. Two no-code events, or
 *   two raw `track` calls, are two events the customer caused.
 *
 * **Name equality is what makes the discount unforgeable** (ADR-0034, D5).
 * Server-side origin establishment stops a client *claiming* `no_code_rule`
 * without a real published rule, but it does not bound the discount on its own:
 * rules are free to create, so an attacker could publish one and forge against
 * it. Requiring the two events to share a name removes the incentive instead of
 * the capability — the only thing a forger can suppress is a duplicate of an
 * event they already sent, under the same name, so they trade one unit for a
 * doubled count in their own dashboard and gain no information at all.
 *
 * The narrowness is the point in the other direction too. `action_id` arrives
 * from the browser, so an unbounded "one action bills once" rule would be a
 * quota bypass: a patched tracker could stamp one id onto a hundred pageviews,
 * pay for one, and still see all hundred in its dashboard. Under this rule that
 * batch bills a hundred.
 *
 * Returns classifications index-aligned with the input; events without an
 * `action_id` are untouched.
 */
export function collapseBillableActions(
  candidates: readonly ClassificationCandidate[],
  classifications: readonly EventClassification[],
): EventClassification[] {
  const noCodeActionNames = new Set<string>()

  candidates.forEach((candidate, index) => {
    if (!candidate.actionId) return
    if (!candidate.name) return
    if (!classifications[index]?.billable) return
    if (isNoCodeCustomEvent(candidate)) {
      noCodeActionNames.add(collapseKey(candidate.actionId, candidate.name))
    }
  })

  const suppressed = new Set<number>()
  const alreadySuppressed = new Set<string>()

  candidates.forEach((candidate, index) => {
    const actionId = candidate.actionId
    if (!actionId) return
    if (!candidate.name) return
    if (!classifications[index]?.billable) return
    if (!isRawCustomEvent(candidate)) return

    const key = collapseKey(actionId, candidate.name)
    if (!noCodeActionNames.has(key)) return
    // At most one raw custom event per action *and name*: the no-code rule
    // restates one click, not every event the page happened to send under that
    // id.
    if (alreadySuppressed.has(key)) return

    alreadySuppressed.add(key)
    suppressed.add(index)
  })

  return classifications.map((classification, index) =>
    suppressed.has(index)
      ? nonBillable(classification.type, 'duplicate_source_action')
      : classification,
  )
}

/**
 * Classify a batch: the per-event matrix, then the raw/no-code suppression.
 * This is the entry point the collector uses; calling `classifyEvent`
 * alone on a batch would miss the double-billing rule.
 */
export function classifyEvents(
  candidates: readonly ClassificationCandidate[],
): EventClassification[] {
  return collapseBillableActions(candidates, candidates.map(classifyEvent))
}

export function billableCount(classifications: readonly EventClassification[]): number {
  return classifications.reduce((total, classification) => total + classification.usageUnits, 0)
}
