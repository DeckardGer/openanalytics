import { roleHasCapability, type Capability, type SiteRole } from '@openanalytics/domain'

/**
 * Server-side capability enforcement.
 *
 * The capability matrix is domain policy (`@openanalytics/domain`); this is the
 * enforcement primitive an endpoint calls to turn a membership role into an
 * allow/deny decision. Every endpoint authorizes on the server — a frontend
 * route guard is not a security boundary (docs snapshot 02 §19). An owner-only
 * operation attempted by an admin or viewer raises here.
 */

export class AuthorizationError extends Error {
  readonly role: SiteRole
  readonly capability: Capability

  constructor(role: SiteRole, capability: Capability) {
    super(`role "${role}" lacks capability "${capability}"`)
    this.name = 'AuthorizationError'
    this.role = role
    this.capability = capability
  }
}

/** True if the role grants the capability. `billing:self_manage` is never
 * granted by a role — use `canManageBilling` from the domain package. */
export function canAct(role: SiteRole, capability: Capability): boolean {
  return roleHasCapability(role, capability)
}

/** Throws `AuthorizationError` when the role does not grant the capability. */
export function authorizeCapability(input: { role: SiteRole; capability: Capability }): void {
  if (!roleHasCapability(input.role, input.capability)) {
    throw new AuthorizationError(input.role, input.capability)
  }
}
