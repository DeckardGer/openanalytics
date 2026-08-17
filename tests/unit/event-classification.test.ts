import { HISTORICAL_EVENT_TYPES, type EventType } from '@openanalytics/contracts'
import {
  billableCount,
  classifyEvent,
  classifyEvents,
  type ClassificationCandidate,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * Docs snapshot 05, D-101. The matrix is the invoice: an event classified
 * billable is money, and a client has no vote. Every row is asserted, including
 * the zero rows, because a future event type silently defaulting to billable is
 * exactly the failure this table exists to prevent.
 */
describe('D-101 billable matrix', () => {
  const expected: Record<EventType, 0 | 1> = {
    page_view: 1,
    custom_event: 1,
    conversion: 1,
    identify: 0,
    engagement: 0,
    web_vital: 0,
    interaction: 0,
    heartbeat: 0,
  }

  it.each(Object.entries(expected))('charges %s exactly %s unit(s)', (type, units) => {
    const classification = classifyEvent({ type: type as EventType, origin: 'client_sdk' })
    expect(classification.usageUnits).toBe(units)
    expect(classification.billable).toBe(units === 1)
  })

  it('covers every canonical type', () => {
    // If a type is added to the contract without a decision here, this fails
    // rather than quietly inheriting a default.
    for (const type of HISTORICAL_EVENT_TYPES) {
      expect(Object.keys(expected)).toContain(type)
    }
  })

  it('charges nothing for the heatmap signal even though a click may also bill', () => {
    // D-101: the passive `interaction` signal and a semantic no-code event can
    // come from the same click; only the semantic one is usage.
    expect(classifyEvent({ type: 'interaction', origin: 'client_sdk' }).usageUnits).toBe(0)
    expect(classifyEvent({ type: 'custom_event', origin: 'no_code_rule' }).usageUnits).toBe(1)
  })

  it('charges nothing for imported history or synced revenue', () => {
    expect(classifyEvent({ type: 'page_view', origin: 'import' }).reason).toBe(
      'not_customer_traffic',
    )
    expect(classifyEvent({ type: 'conversion', origin: 'revenue_sync' }).usageUnits).toBe(0)
    expect(classifyEvent({ type: 'custom_event', origin: 'internal' }).usageUnits).toBe(0)
  })

  it('charges nothing for bot, invalid or duplicate traffic', () => {
    const base = { type: 'page_view', origin: 'client_sdk' } as const

    expect(classifyEvent({ ...base, bot: true }).reason).toBe('bot')
    expect(classifyEvent({ ...base, invalid: true }).reason).toBe('invalid')
    expect(classifyEvent({ ...base, duplicate: true }).reason).toBe('duplicate')

    for (const flag of ['bot', 'invalid', 'duplicate'] as const) {
      expect(classifyEvent({ ...base, [flag]: true }).usageUnits).toBe(0)
    }
  })
})

/**
 * Milestone 4 acceptance: "the same source action is not counted as two billable
 * events because of no-code plus custom". Docs snapshot 02 §9 and D-101.
 *
 * D-101 names exactly one pair — a raw `track` call and a no-code rule
 * describing the same click — and the suppression is scoped to it. Nothing else
 * inside an `action_id` group loses its charge.
 *
 * ADR-0034 D5 narrowed it further: the two events must also share a **name**.
 * That is what makes the discount unforgeable rather than merely gated — the
 * only raw event a forger can suppress is a duplicate of one they already sent,
 * so the trade costs them a wrong number in their own dashboard and buys them
 * nothing. `tests/unit/collector-no-code-origin.test.ts` asserts that arithmetic
 * and the route-level origin establishment that feeds it.
 */
describe('raw custom event and no-code rule bill once', () => {
  const candidate = (over: Partial<ClassificationCandidate>): ClassificationCandidate => ({
    eventId: 'e_1',
    type: 'custom_event',
    origin: 'client_sdk',
    // Every custom event has a name in reality, and since ADR-0034 D5 the name
    // is load-bearing: the collapse only fires when the raw event and the
    // no-code event call the click the same thing. A shared default keeps these
    // cases describing one action; the cases that need two names say so.
    name: 'cta_clicked',
    ...over,
  })

  it('bills once when a click produces both a custom event and a no-code event', () => {
    const classifications = classifyEvents([
      candidate({ eventId: 'e_raw', actionId: 'a_1', origin: 'client_sdk' }),
      candidate({ eventId: 'e_rule', actionId: 'a_1', origin: 'no_code_rule' }),
    ])

    expect(billableCount(classifications)).toBe(1)
    // D-101 keeps the dashboard-defined semantic event as the canonical one.
    expect(classifications[0]?.reason).toBe('duplicate_source_action')
    expect(classifications[1]?.billable).toBe(true)
  })

  it('bills once regardless of the order the two arrive in', () => {
    const reversed = classifyEvents([
      candidate({ eventId: 'e_rule', actionId: 'a_1', origin: 'no_code_rule' }),
      candidate({ eventId: 'e_raw', actionId: 'a_1', origin: 'client_sdk' }),
    ])

    expect(billableCount(reversed)).toBe(1)
    expect(reversed[0]?.billable).toBe(true)
  })

  it('suppresses at most one raw custom event per action', () => {
    // One no-code rule restates one click. The other `track` calls the page made
    // under the same id are events the customer caused, and they are charged.
    const classifications = classifyEvents([
      candidate({ eventId: 'e_rule', actionId: 'a_2', origin: 'no_code_rule' }),
      candidate({ eventId: 'e_raw_1', actionId: 'a_2' }),
      candidate({ eventId: 'e_raw_2', actionId: 'a_2' }),
      candidate({ eventId: 'e_raw_3', actionId: 'a_2' }),
    ])

    expect(billableCount(classifications)).toBe(3)
    expect(classifications[1]?.reason).toBe('duplicate_source_action')
    expect(classifications[2]?.billable).toBe(true)
    expect(classifications[3]?.billable).toBe(true)
  })

  it('never suppresses a page_view or a conversion', () => {
    // The matrix gives each its own unit: a navigation and a purchase are not
    // restatements of a click, whatever `action_id` they carry.
    const classifications = classifyEvents([
      candidate({ eventId: 'e_rule', actionId: 'a_3', origin: 'no_code_rule' }),
      candidate({ eventId: 'e_view', actionId: 'a_3', type: 'page_view' }),
      candidate({ eventId: 'e_conv', actionId: 'a_3', type: 'conversion' }),
    ])

    expect(billableCount(classifications)).toBe(3)
    expect(classifications.every((entry) => entry.billable)).toBe(true)
  })

  it('never lets events of the same class suppress each other', () => {
    const noCodeOnly = classifyEvents([
      candidate({ eventId: 'e_rule_1', actionId: 'a_4', origin: 'no_code_rule' }),
      candidate({ eventId: 'e_rule_2', actionId: 'a_4', origin: 'no_code_rule' }),
    ])
    const rawOnly = classifyEvents([
      candidate({ eventId: 'e_raw_1', actionId: 'a_5' }),
      candidate({ eventId: 'e_raw_2', actionId: 'a_5' }),
    ])

    expect(billableCount(noCodeOnly)).toBe(2)
    expect(billableCount(rawOnly)).toBe(2)
  })

  it('leaves the heatmap signal alone: it was never billable to begin with', () => {
    const classifications = classifyEvents([
      candidate({ eventId: 'e_click', actionId: 'a_6', type: 'interaction' }),
      candidate({ eventId: 'e_rule', actionId: 'a_6', origin: 'no_code_rule' }),
    ])

    expect(billableCount(classifications)).toBe(1)
    expect(classifications[0]?.reason).toBe('never_billable_type')
  })

  it('does not touch events that share no action', () => {
    const classifications = classifyEvents([
      candidate({ eventId: 'e_a', type: 'page_view' }),
      candidate({ eventId: 'e_b', type: 'custom_event' }),
      candidate({ eventId: 'e_c', actionId: 'a_7', type: 'custom_event' }),
    ])

    expect(billableCount(classifications)).toBe(3)
  })

  it('never resurrects an event a disqualifier already zeroed', () => {
    const classifications = classifyEvents([
      candidate({ eventId: 'e_bot', actionId: 'a_8', bot: true }),
      candidate({ eventId: 'e_bot2', actionId: 'a_8', bot: true }),
    ])

    expect(billableCount(classifications)).toBe(0)
    expect(classifications.every((entry) => entry.reason === 'bot')).toBe(true)
  })
})

/**
 * `action_id` arrives from the browser, so it is attacker-controlled. A patched
 * tracker that stamps one id onto a whole batch must not buy a discount: the
 * dashboard would still show every event while usage counted one.
 */
describe('action_id cannot be used to evade quota', () => {
  const candidate = (over: Partial<ClassificationCandidate>): ClassificationCandidate => ({
    eventId: 'e_1',
    type: 'custom_event',
    origin: 'client_sdk',
    // Every custom event has a name in reality, and since ADR-0034 D5 the name
    // is load-bearing: the collapse only fires when the raw event and the
    // no-code event call the click the same thing. A shared default keeps these
    // cases describing one action; the cases that need two names say so.
    name: 'cta_clicked',
    ...over,
  })

  it('charges all 100 pageviews stamped with one action_id', () => {
    const classifications = classifyEvents(
      Array.from({ length: 100 }, (_, index) =>
        candidate({ eventId: `e_${index}`, actionId: 'a_evade', type: 'page_view' }),
      ),
    )

    expect(billableCount(classifications)).toBe(100)
  })

  it('charges all 100 custom events stamped with one action_id', () => {
    const classifications = classifyEvents(
      Array.from({ length: 100 }, (_, index) =>
        candidate({ eventId: `e_${index}`, actionId: 'a_evade' }),
      ),
    )

    expect(billableCount(classifications)).toBe(100)
  })

  it('charges all 100 conversions stamped with one action_id', () => {
    const classifications = classifyEvents(
      Array.from({ length: 100 }, (_, index) =>
        candidate({ eventId: `e_${index}`, actionId: 'a_evade', type: 'conversion' }),
      ),
    )

    expect(billableCount(classifications)).toBe(100)
  })

  it('gives up exactly one unit even with a no-code event in the batch', () => {
    // The worst a forged `action_id` can achieve is the one suppression D-101
    // documents — not a batch-wide discount.
    const classifications = classifyEvents([
      candidate({ eventId: 'e_rule', actionId: 'a_evade', origin: 'no_code_rule' }),
      ...Array.from({ length: 99 }, (_, index) =>
        candidate({ eventId: `e_${index}`, actionId: 'a_evade' }),
      ),
    ])

    expect(billableCount(classifications)).toBe(99)
  })

  it('charges a mixed batch under one action_id in full but for that one pair', () => {
    const classifications = classifyEvents([
      candidate({ eventId: 'e_rule', actionId: 'a_evade', origin: 'no_code_rule' }),
      candidate({ eventId: 'e_raw', actionId: 'a_evade' }),
      ...Array.from({ length: 50 }, (_, index) =>
        candidate({ eventId: `e_view_${index}`, actionId: 'a_evade', type: 'page_view' }),
      ),
      ...Array.from({ length: 48 }, (_, index) =>
        candidate({ eventId: `e_conv_${index}`, actionId: 'a_evade', type: 'conversion' }),
      ),
    ])

    expect(classifications).toHaveLength(100)
    expect(billableCount(classifications)).toBe(99)
  })
})
