/**
 * Authorization vocabulary and the role → capability matrix.
 *
 * This lives in `domain` with the other policy data: it is pure rules, not
 * enforcement. `packages/auth` re-exports it and adds the enforcement helpers
 * that combine a session and a membership with this matrix.
 *
 * The distinction that must not blur (docs snapshot 02 §19): `owner` is a
 * *membership role* held by possibly several users, while `sites.owner_user_id`
 * names the single user answerable for the site. Every owner administers the
 * site; what the responsible user additionally holds is decided by whatever
 * surfaces a deployment mounts, not by this matrix.
 */

export const SITE_ROLES = ['owner', 'admin', 'viewer'] as const
export type SiteRole = (typeof SITE_ROLES)[number]

/**
 * Capabilities checked independently of the coarse role.
 *
 * Legacy scattered authorization across routes, so a site admin could reach
 * customer revenue data (docs snapshot 01 §10.3). These are explicit because
 * "can administer the site" and "can read customer revenue PII" are not the same
 * permission.
 */
export const CAPABILITIES = [
  'team:manage',
  'credentials:manage',
  'site:settings',
  'revenue:read',
  'export:raw',
  'site:delete',
] as const
export type Capability = (typeof CAPABILITIES)[number]

/**
 * Which capabilities each site role grants.
 *
 * The sensitive and destructive capabilities — reading customer revenue PII,
 * raw export and deleting the site — stay owner-only. Admin manages the team and
 * site credentials but not those; broader per-capability grants are a later,
 * gated feature (F-305). Viewer is read-only and grants no management capability.
 *
 * `site:settings` — renaming a site and replacing its origin allowlist — is
 * granted to owner and admin. It is the same class of administrative act as
 * `credentials:manage`, which admin already holds: both configure how the site
 * ingests, neither exposes customer PII and neither is destructive. It is
 * deliberately not in the owner-only set, because that set is defined by
 * irreversibility and by personal data, and a settings change is neither. Viewer
 * stays read-only.
 */
const ROLE_CAPABILITIES: Readonly<Record<SiteRole, readonly Capability[]>> = {
  owner: [
    'team:manage',
    'credentials:manage',
    'site:settings',
    'revenue:read',
    'export:raw',
    'site:delete',
  ],
  admin: ['team:manage', 'credentials:manage', 'site:settings'],
  viewer: [],
}

export function capabilitiesForRole(role: SiteRole): readonly Capability[] {
  return ROLE_CAPABILITIES[role]
}

/** Whether a site role grants a capability. */
export function roleHasCapability(role: SiteRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability)
}

/** The states a site itself can be in. */
export const SITE_STATES = ['active', 'suspended', 'deleting', 'deleted'] as const
export type SiteState = (typeof SITE_STATES)[number]

export function isSiteRole(value: unknown): value is SiteRole {
  return typeof value === 'string' && (SITE_ROLES as readonly string[]).includes(value)
}

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value)
}
