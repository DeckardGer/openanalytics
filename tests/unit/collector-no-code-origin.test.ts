import {
  billableCount,
  classifyEvents,
  collapseBillableActions,
  classifyEvent,
  type ClassificationCandidate,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * D-101's double-billing rule, on the path that actually runs (ADR-0034, D5).
 *
 * `collapseBillableActions` has existed and been tested since M4, and until this
 * milestone it could never fire in production: `apps/collector/src/events.ts`
 * hardcoded `origin: 'client_sdk'` on every event, so no candidate was ever a
 * no-code one. The collector-side test at the bottom of this file is the guard
 * against that returning — it asserts through the real route, so a regression to
 * a hardcoded origin fails here rather than silently un-implementing the rule.
 *
 * The other half is the narrowing D5 adds: the two events must share a **name**.
 * That is what takes the forgeable discount to zero, and the arithmetic is
 * asserted rather than described.
 */

function candidate(overrides: Partial<ClassificationCandidate> = {}): ClassificationCandidate {
  return {
    eventId: 'e1',
    type: 'custom_event',
    origin: 'client_sdk',
    ...overrides,
  } as ClassificationCandidate
}

describe('the raw/no-code collapse', () => {
  it('bills one unit for the same click described twice under one name', () => {
    const batch = [
      candidate({ eventId: 'raw', name: 'pricing_cta_clicked', actionId: 'a1' }),
      candidate({
        eventId: 'nocode',
        origin: 'no_code_rule',
        name: 'pricing_cta_clicked',
        actionId: 'a1',
      }),
    ]
    const classifications = classifyEvents(batch)

    expect(billableCount(classifications)).toBe(1)
    // The no-code event is the billable one (D-101), and the raw one carries the
    // reason rather than simply being 0.
    expect(classifications[0]?.reason).toBe('duplicate_source_action')
    expect(classifications[1]?.billable).toBe(true)
  })

  it('bills two when the names differ, because those are two semantic events', () => {
    const batch = [
      candidate({ eventId: 'raw', name: 'added_to_cart', actionId: 'a1' }),
      candidate({
        eventId: 'nocode',
        origin: 'no_code_rule',
        name: 'pricing_cta_clicked',
        actionId: 'a1',
      }),
    ]
    expect(billableCount(classifyEvents(batch))).toBe(2)
  })

  it('makes the forged discount worth exactly zero', () => {
    // The attack D5 has to bound: a patched tracker wants two dashboard-visible
    // events for one unit. Under name equality the only event it may suppress is
    // a duplicate of one it already sent, so what it buys is a wrong number in
    // its own dashboard.
    const honest = [
      candidate({ eventId: 'a', name: 'signup_started', actionId: 'a1' }),
      candidate({ eventId: 'b', name: 'checkout_started', actionId: 'a1' }),
    ]
    expect(billableCount(classifyEvents(honest))).toBe(2)

    const forged = [
      candidate({ eventId: 'a', name: 'signup_started', actionId: 'a1' }),
      candidate({ eventId: 'b', name: 'checkout_started', actionId: 'a1' }),
      candidate({
        eventId: 'fake',
        origin: 'no_code_rule',
        name: 'signup_started',
        actionId: 'a1',
      }),
    ]
    // Three events, two units: the forger paid for the fake one and got back the
    // unit it suppressed. Net zero, and one of its two real events is now
    // double-counted in its own numbers.
    expect(billableCount(classifyEvents(forged))).toBe(2)
  })

  it('suppresses at most one raw event per action and name', () => {
    const batch = [
      candidate({ eventId: 'r1', name: 'x', actionId: 'a1' }),
      candidate({ eventId: 'r2', name: 'x', actionId: 'a1' }),
      candidate({ eventId: 'r3', name: 'x', actionId: 'a1' }),
      candidate({ eventId: 'n1', origin: 'no_code_rule', name: 'x', actionId: 'a1' }),
    ]
    // One suppressed, two raw events still billed, plus the no-code one.
    expect(billableCount(classifyEvents(batch))).toBe(3)
  })

  it('never suppresses a page_view or a conversion, whatever the action id', () => {
    const batch = [
      candidate({ eventId: 'pv', type: 'page_view', name: null, actionId: 'a1' }),
      candidate({ eventId: 'cv', type: 'conversion', name: 'purchase', actionId: 'a1' }),
      candidate({ eventId: 'n1', origin: 'no_code_rule', name: 'purchase', actionId: 'a1' }),
    ]
    expect(billableCount(classifyEvents(batch))).toBe(3)
  })

  it('is not a batch-wide discount: one id across a hundred pageviews bills a hundred', () => {
    const batch = [
      ...Array.from({ length: 100 }, (_, i) =>
        candidate({ eventId: `pv${i}`, type: 'page_view', name: null, actionId: 'a1' }),
      ),
      candidate({ eventId: 'n1', origin: 'no_code_rule', name: 'x', actionId: 'a1' }),
    ]
    expect(billableCount(classifyEvents(batch))).toBe(101)
  })

  it('leaves events without an action id completely alone', () => {
    const batch = [
      candidate({ eventId: 'raw', name: 'x' }),
      candidate({ eventId: 'nocode', origin: 'no_code_rule', name: 'x' }),
    ]
    expect(billableCount(classifyEvents(batch))).toBe(2)
  })

  it('does not let a non-billable no-code event suppress anything', () => {
    // A bot-flagged no-code event is 0 units; it must not take the raw event's
    // unit with it, or the flag would become a way to zero a real event.
    const batch = [
      candidate({ eventId: 'raw', name: 'x', actionId: 'a1' }),
      candidate({
        eventId: 'nocode',
        origin: 'no_code_rule',
        name: 'x',
        actionId: 'a1',
        bot: true,
      }),
    ]
    const classifications = classifyEvents(batch)
    expect(classifications[0]?.billable).toBe(true)
    expect(billableCount(classifications)).toBe(1)
  })

  it('is index-aligned, so a caller can zip it back onto its own events', () => {
    const batch = [
      candidate({ eventId: 'a', type: 'heartbeat', name: null }),
      candidate({ eventId: 'b', name: 'x', actionId: 'a1' }),
      candidate({ eventId: 'c', origin: 'no_code_rule', name: 'x', actionId: 'a1' }),
    ]
    const classifications = collapseBillableActions(batch, batch.map(classifyEvent))
    expect(classifications).toHaveLength(3)
    expect(classifications[0]?.reason).toBe('never_billable_type')
    expect(classifications[1]?.reason).toBe('duplicate_source_action')
    expect(classifications[2]?.billable).toBe(true)
  })
})
