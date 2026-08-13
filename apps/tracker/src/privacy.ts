import type { PropertyValue } from './sanitize.ts'
import type { SafeStorage } from './storage.ts'
import type { TrackerEvent } from './types.ts'

/**
 * GPC, DNT and consent.
 *
 * This file builds the *mechanism* only. The default behaviour was G-008 and is
 * now decided (ADR-0057): the two signals that carry an *expressed* objection —
 * GPC and DNT — are honoured out of the box, and an unset consent state does not
 * block collection, because the identity model stores nothing that identifies
 * the visitor, so silence is not treated as objection. The policy stays a plain
 * data object, read at every decision, and each flag remains overridable per
 * site through init options or script-tag attributes.
 *
 * **There is one gate, and that is a decision rather than an omission
 * (ADR-0064).** A signal that links a visitor to a named person or to an order —
 * `identify()`, and the `order_id` hint the revenue matcher joins on — carries a
 * consent obligation this gate does not enforce, because `identify()` is called
 * by the site's own code and the site is the controller for that call. Making it
 * wait for a consent state we cannot verify would refuse a customer's own
 * instruction on their behalf. We say so in the documentation instead, and the
 * one thing the tracker does enforce is the site's own switch: with
 * `attributed_revenue` off, no linking hint is sent at all.
 *
 * The asymmetry that governed the provisional value still governs the final
 * one: a default that is too tight costs some uncollected traffic; a default
 * that is too loose is a privacy incident that cannot be undone.
 */

export type ConsentState = 'granted' | 'denied' | 'unknown'

export interface PrivacySignals {
  /** Global Privacy Control, `navigator.globalPrivacyControl`. */
  readonly gpc: boolean
  /** Do Not Track, in its several historical spellings. */
  readonly dnt: boolean
  readonly consent: ConsentState
}

export interface PrivacyPolicy {
  readonly respectGpc: boolean
  readonly respectDnt: boolean
  /** When true, `unknown` consent blocks collection until `oa.consent()` runs. */
  readonly requireConsent: boolean
}

/**
 * The shipped product default (G-008, ADR-0057). A test pins these exact values
 * because they are a claim in a published privacy notice, not a tuning knob.
 *
 * A fourth field, `linkingRequiresConsent`, was written and then removed before
 * it shipped (ADR-0064): the mandatory linking gate was considered and declined.
 * The pin stays at three because three is what the notice describes.
 */
export const DEFAULT_PRIVACY_POLICY: PrivacyPolicy = {
  respectGpc: true,
  respectDnt: true,
  requireConsent: false,
}

const CONSENT_KEY = 'oa.consent'

interface PrivacyHost {
  readonly navigator?: {
    globalPrivacyControl?: boolean
    doNotTrack?: string | null
    msDoNotTrack?: string | null
  }
  readonly doNotTrack?: string | null
}

export function readGpc(host: PrivacyHost): boolean {
  return host.navigator?.globalPrivacyControl === true
}

export function readDnt(host: PrivacyHost): boolean {
  const values = [host.navigator?.doNotTrack, host.navigator?.msDoNotTrack, host.doNotTrack]
  return values.some((value) => value === '1' || value === 'yes')
}

export function createPrivacyGate(host: PrivacyHost, storage: SafeStorage, policy: PrivacyPolicy) {
  let current: PrivacyPolicy = policy

  const readConsent = (): ConsentState => {
    const stored = storage.get(CONSENT_KEY)
    return stored === 'granted' || stored === 'denied' ? stored : 'unknown'
  }

  return {
    signals(): PrivacySignals {
      return { gpc: readGpc(host), dnt: readDnt(host), consent: readConsent() }
    },

    /** `oa.consent('granted' | 'denied')`, persisted across pages. */
    setConsent(state: ConsentState): void {
      if (state === 'unknown') storage.remove(CONSENT_KEY)
      else storage.set(CONSENT_KEY, state)
    },

    /** Replace the policy at runtime; used by init options and by tests. */
    setPolicy(next: PrivacyPolicy): void {
      current = next
    },

    policy(): PrivacyPolicy {
      return current
    },

    /**
     * The single decision point. Every signal the tracker sends passes through
     * here, so policy behaviour has one place to change and no code path that
     * quietly bypasses it.
     */
    mayCollect(): boolean {
      const signals = this.signals()

      if (signals.consent === 'denied') return false
      if (current.respectGpc && signals.gpc) return false
      if (current.respectDnt && signals.dnt) return false
      if (current.requireConsent && signals.consent !== 'granted') return false
      return true
    },
  }
}

export type PrivacyGate = ReturnType<typeof createPrivacyGate>

/**
 * Property keys that are a linking hint rather than a measurement (ADR-0064).
 *
 * One key, and it is the same one the server exempts from its opaque-token
 * redaction for the same reason (`packages/domain/src/event-sanitize.ts`):
 * `order_id` is the documented property of the `conversion` event, and the
 * revenue matcher joins a charge to a visitor on exactly this value (ADR-0033
 * D6 signal 1). Matched case-insensitively — wider than the matcher's own
 * lowercase read, deliberately, because the direction to be wrong in is
 * withholding a hint we could have sent.
 *
 * What decides whether it is sent is the **site's** `attributed_revenue`
 * switch, not the visitor's consent state (ADR-0064 D4a): a site that has not
 * turned attribution on should not have browsers sending the hint that would
 * make it work. The visitor's consent obligation is the site's to meet, and the
 * tracker does not attempt to enforce it.
 */
export const LINKING_HINT_PROPERTY_KEYS: readonly string[] = ['order_id']

/**
 * Remove the linking hints from an event's properties unless they are allowed.
 *
 * Returns the input untouched when there is nothing to remove, so the ordinary
 * event — the overwhelming majority — allocates nothing. The conversion event
 * itself is never dropped: it is a measurement signal and stays one. What it
 * loses is the property that would tie the visitor to an order.
 */
export function stripLinkingHints(
  extras: Partial<TrackerEvent>,
  allowed: boolean,
): Partial<TrackerEvent> {
  const properties = extras.properties
  if (allowed || !properties) return extras

  const kept: Record<string, PropertyValue> = {}
  let removed = false
  for (const key of Object.keys(properties)) {
    if (LINKING_HINT_PROPERTY_KEYS.indexOf(key.trim().toLowerCase()) !== -1) {
      removed = true
      continue
    }
    const value = properties[key]
    if (value !== undefined) kept[key] = value
  }
  if (!removed) return extras

  // An event whose only property was the hint sends no property bag at all,
  // rather than an empty object the server would have to interpret.
  const { properties: _hint, ...rest } = extras
  return Object.keys(kept).length === 0 ? rest : { ...rest, properties: kept }
}
