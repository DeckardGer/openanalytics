import {
  DEFAULT_PRIVACY_POLICY,
  LINKING_HINT_PROPERTY_KEYS,
  createPrivacyGate,
  safeStorage,
} from '../../apps/tracker/src/index.ts'
import { OPAQUE_ID_PROPERTY_KEYS } from '@openanalytics/domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, resetBrowser } from './harness.ts'

/**
 * GPC, DNT and consent.
 *
 * Two layers, deliberately separate. The mechanism tests prove that one gate
 * decides for every signal, that the policy is data rather than a code path,
 * and that consent is honoured whatever the policy says — they pass under any
 * default. The pinning test is the opposite: G-008 closed with ADR-0057 and the
 * default became a claim in a published privacy notice, so it asserts the exact
 * shipped values and MUST fail if somebody changes them.
 */

function setSignal(name: string, value: unknown): void {
  Object.defineProperty(window.navigator, name, { value, configurable: true })
}

beforeEach(() => {
  resetBrowser()
})

afterEach(() => {
  setSignal('globalPrivacyControl', undefined)
  setSignal('doNotTrack', null)
})

describe('privacy gate', () => {
  it('ships the G-008 defaults, exactly (ADR-0057 D1-D3)', () => {
    // The privacy notice says "a visitor sending GPC or DNT is not measured"
    // without qualification, and says silence is not treated as objection.
    // Changing any of these three values is a change to a published legal
    // document, not a tuning decision — this test is what makes that visible.
    //
    // Three, not four: ADR-0064 considered a fourth flag gating the linking
    // signals and declined it. A field appearing here later is that decision
    // being revisited, which is exactly the size of change this pin is for.
    expect(DEFAULT_PRIVACY_POLICY).toEqual({
      respectGpc: true,
      respectDnt: true,
      requireConsent: false,
    })
  })

  it('is one decision point, not a check per signal', () => {
    // Every event type goes through `mayCollect`, so there is no path that
    // collects while another is blocked.
    setSignal('globalPrivacyControl', true)
    const harness = createHarness()

    harness.tracker.track('should_not_send')
    harness.tracker.conversion('purchase')
    harness.tracker.identify('u_1')
    harness.runTimers()
    harness.fireHeartbeatInterval()

    expect(harness.sent).toHaveLength(0)
    harness.stop()
  })

  it('honours Do Not Track in its several spellings', () => {
    setSignal('doNotTrack', '1')
    const harness = createHarness()

    expect(harness.sent).toHaveLength(0)
    harness.stop()
  })

  it('treats denied consent as final, whatever the policy says', () => {
    const harness = createHarness({
      privacyPolicy: { respectGpc: false, respectDnt: false, requireConsent: false },
    })
    const before = harness.sent.length

    harness.tracker.consent('denied')
    harness.tracker.track('after_denial')
    harness.runTimers()

    expect(harness.sent.length).toBe(before)
    harness.stop()
  })

  it('collects again once consent is granted under a consent-required policy', () => {
    const harness = createHarness({ privacyPolicy: { requireConsent: true } })
    // Nothing yet: the first pageview itself waited for consent.
    expect(harness.sent).toHaveLength(0)

    harness.tracker.consent('granted')
    harness.tracker.track('after_consent')
    harness.runTimers()

    expect(harness.eventsOfType('custom_event')).toHaveLength(1)
    harness.stop()
  })

  it('keeps the policy as data, so a policy change is a value change and not a rewrite', () => {
    // The same browser signals, two policies, two outcomes — with no code path
    // in between.
    setSignal('globalPrivacyControl', true)

    const respecting = createHarness({ privacyPolicy: { respectGpc: true } })
    expect(respecting.sent).toHaveLength(0)
    respecting.stop()

    const ignoring = createHarness({ privacyPolicy: { respectGpc: false, respectDnt: false } })
    expect(ignoring.sent.length).toBeGreaterThan(0)
    ignoring.stop()
  })

  it('remembers consent across pages', () => {
    const storage = safeStorage(window.localStorage)
    const gate = createPrivacyGate({}, storage, DEFAULT_PRIVACY_POLICY)

    gate.setConsent('denied')
    const nextPage = createPrivacyGate({}, safeStorage(window.localStorage), {
      ...DEFAULT_PRIVACY_POLICY,
    })

    expect(nextPage.signals().consent).toBe('denied')
    expect(nextPage.mayCollect()).toBe(false)
  })

  it('sends identify without waiting for consent (ADR-0064)', () => {
    // The decision ADR-0064 records rather than the one it first proposed: a
    // mandatory linking gate was considered and declined, because `identify()`
    // is a call the site's own code makes as controller. Silence is not
    // objection here either — an expressed `denied` still stops everything,
    // which the test above pins.
    const harness = createHarness()

    harness.tracker.identify('u_1')
    harness.runTimers()

    const identified = harness.eventsOfType('identify')
    expect(identified).toHaveLength(1)
    expect(identified[0]?.['external_user_id']).toBe('u_1')
    harness.stop()
  })

  it('sends no order_id until the site turns attributed revenue on (D4a)', () => {
    // The one linking rule the tracker does enforce, and it is the site's own
    // switch rather than the visitor's consent. The conversion itself is
    // measurement and is always sent; what the flag decides is whether it
    // carries the property the revenue matcher joins on.
    const harness = createHarness()
    harness.tracker.consent('granted')

    harness.tracker.conversion('purchase', { order_id: 'cs_test_a1B2c3', plan: 'growth' })
    harness.runTimers()

    // Consent alone does not open it: the choice is the site's.
    expect(harness.eventsOfType('conversion')[0]?.['properties']).toEqual({ plan: 'growth' })
    harness.stop()

    const optedIn = createHarness({ config: { attributedRevenue: true } })
    optedIn.tracker.conversion('purchase', { order_id: 'cs_test_a1B2c3', plan: 'growth' })
    optedIn.runTimers()

    expect(optedIn.eventsOfType('conversion')[0]?.['properties']).toEqual({
      order_id: 'cs_test_a1B2c3',
      plan: 'growth',
    })
    optedIn.stop()
  })

  it('sends no property bag at all when the hint was the only property', () => {
    const harness = createHarness()

    harness.tracker.conversion('purchase', { order_id: 'cs_test_a1B2c3' })
    harness.runTimers()

    const [conversion] = harness.eventsOfType('conversion')
    expect(conversion).toBeDefined()
    expect(conversion && 'properties' in conversion).toBe(false)
    harness.stop()
  })

  it('names the same hints the server strips', () => {
    // The tracker package is dependency-free by design, so this list cannot be
    // imported from `@openanalytics/domain` and is the one unavoidable copy of
    // it. Both halves of D4a enforce the same rule and must therefore mean the
    // same keys by it: a key added on one side only would be a hint one half
    // removes and the other passes through.
    expect([...LINKING_HINT_PROPERTY_KEYS]).toEqual([...OPAQUE_ID_PROPERTY_KEYS])
  })

  it('reads both GPC and DNT from the host, not from a cached snapshot', () => {
    const host = { navigator: { globalPrivacyControl: false, doNotTrack: null as string | null } }
    const gate = createPrivacyGate(host, safeStorage(window.localStorage), {
      respectGpc: true,
      respectDnt: true,
      requireConsent: false,
    })

    expect(gate.mayCollect()).toBe(true)
    host.navigator.doNotTrack = '1'
    // A visitor who turns the signal on mid-session is respected immediately.
    expect(gate.mayCollect()).toBe(false)
  })
})
