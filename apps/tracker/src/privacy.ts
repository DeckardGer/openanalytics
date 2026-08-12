import type { SafeStorage } from './storage.ts'

/**
 * GPC, DNT and consent.
 *
 * This file builds the *mechanism* only. The default behaviour was G-008 and is
 * now decided (ADR-0057): the two signals that carry an *expressed* objection —
 * GPC and DNT — are honoured out of the box, and an unset consent state does not
 * block collection, because the identity model stores nothing on the visitor's
 * device and nothing that identifies them, so silence is not treated as
 * objection. The policy stays a plain data object, read at every decision, and
 * each flag remains overridable per site through init options or script-tag
 * attributes.
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
