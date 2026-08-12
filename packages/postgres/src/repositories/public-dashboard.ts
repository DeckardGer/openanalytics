import { randomBytes } from 'node:crypto'
import { asc, eq, sql } from 'drizzle-orm'
import type { Database } from '../client.ts'
import { writeAudit } from './audit.ts'
import { importRuns } from '../schema/imports.ts'
import { sitePublicDashboardSettings } from '../schema/public-dashboard.ts'
import { siteDomains, sites, type SiteStatus } from '../schema/sites.ts'

/**
 * Public-dashboard settings repository (docs snapshot 02 §20; plan Milestone 7
 * item 8).
 *
 * Three reads and one write:
 *
 * - `getPublicDashboardSettings` — the owner-facing settings for a site id.
 * - `resolvePublicShare` — the public read path's slug → site resolution. It
 *   returns the internal site id, the site's live billing status and the
 *   per-surface flags in one query, so the route can apply the §20 rules (share
 *   is closed while `suspended`; a surface must be individually opted in)
 *   without a second round trip, and a slug never leaks the internal id to a
 *   caller who only holds the slug.
 * - `readPublicSiteIdentity` — the site's display name, favicon domain,
 *   reporting timezone and first-event instant, for the ADR-0044 public
 *   site-identity read. Authorization is `isSharePublishing` plus, for the two
 *   identity fields, `isSurfaceShared(share, 'identity')`; this read makes no
 *   decision of its own.
 * - `updatePublicDashboardSettings` — the owner opt-in/opt-out and slug rotation.
 */

/**
 * Every surface a share can opt into, in the order the settings screen lists
 * them (docs snapshot 02 §20; realtime is M9; the five breakdown reads are
 * ADR-0039; `identity` is ADR-0044).
 *
 * **`identity` is a surface for authorization and not a board card.** It has one
 * flag, one column and one audit key like the other eight, and it gates two
 * fields of `GET /v1/public/{slug}/site` rather than a route of its own — which
 * is why `PUBLISHING_SURFACES` below excludes it when deciding whether a slug
 * publishes anything at all.
 *
 * This array is the single place a surface is declared. `PublicSurfaceFlags`
 * derives its field names from it, `SURFACE_FLAG` maps each entry to one, and
 * `isSurfaceShared` reads through that map — so a surface added to this list
 * without a column and a flag is a type error rather than a silently
 * unauthorized route.
 */
export const PUBLIC_SURFACES = [
  'overview',
  'geography',
  'realtime',
  'timeseries',
  'sessions',
  'pages',
  'sources',
  'devices',
  'identity',
] as const

/** A public surface a share can opt into. */
export type PublicSurface = (typeof PUBLIC_SURFACES)[number]

/** The per-surface opt-in booleans, one per `PublicSurface`, off by default. */
export type PublicSurfaceFlags = {
  readonly [S in PublicSurface as `share${Capitalize<S>}`]: boolean
}

/**
 * Surface → column, written out rather than derived from the string, so the
 * mapping is greppable and a missing entry fails the build.
 */
const SURFACE_FLAG: { readonly [S in PublicSurface]: keyof PublicSurfaceFlags } = {
  overview: 'shareOverview',
  geography: 'shareGeography',
  realtime: 'shareRealtime',
  timeseries: 'shareTimeseries',
  sessions: 'shareSessions',
  pages: 'sharePages',
  sources: 'shareSources',
  devices: 'shareDevices',
  identity: 'shareIdentity',
}

/**
 * The flag columns as a reusable `select` projection. `satisfies` pins it to
 * exactly the `PublicSurfaceFlags` key set, so a surface added above without a
 * column here fails to compile instead of resolving to `undefined` at read time
 * — which `isSurfaceShared` would have read as "not shared", closing a share the
 * owner had opened.
 */
const FLAG_COLUMNS = {
  shareOverview: sitePublicDashboardSettings.shareOverview,
  shareGeography: sitePublicDashboardSettings.shareGeography,
  shareRealtime: sitePublicDashboardSettings.shareRealtime,
  shareTimeseries: sitePublicDashboardSettings.shareTimeseries,
  shareSessions: sitePublicDashboardSettings.shareSessions,
  sharePages: sitePublicDashboardSettings.sharePages,
  shareSources: sitePublicDashboardSettings.shareSources,
  shareDevices: sitePublicDashboardSettings.shareDevices,
  shareIdentity: sitePublicDashboardSettings.shareIdentity,
} as const satisfies Record<keyof PublicSurfaceFlags, unknown>

const ALL_SURFACES_OFF: PublicSurfaceFlags = {
  shareOverview: false,
  shareGeography: false,
  shareRealtime: false,
  shareTimeseries: false,
  shareSessions: false,
  sharePages: false,
  shareSources: false,
  shareDevices: false,
  shareIdentity: false,
}

export interface PublicDashboardSettings extends PublicSurfaceFlags {
  readonly enabled: boolean
  readonly shareSlug: string | null
}

const DEFAULT_SETTINGS: PublicDashboardSettings = {
  enabled: false,
  shareSlug: null,
  ...ALL_SURFACES_OFF,
}

/**
 * A URL-safe, unguessable public slug. Two random words plus a number would be
 * friendlier, but this is opaque by design (it must not encode the site id) and
 * a base36 token of 96 random bits is both collision-safe and matches the slug
 * format constraint (`^[a-z0-9]…`).
 */
export function generateShareSlug(random: () => Buffer = () => randomBytes(12)): string {
  const token = BigInt(`0x${random().toString('hex')}`).toString(36)
  // Guarantee the format constraint's first-char rule even if base36 starts with
  // a value that is already alphanumeric (it always is), and a stable length.
  return `s${token}`.slice(0, 32)
}

export async function getPublicDashboardSettings(
  db: Database,
  siteId: string,
): Promise<PublicDashboardSettings> {
  const [row] = await db
    .select({
      enabled: sitePublicDashboardSettings.enabled,
      shareSlug: sitePublicDashboardSettings.shareSlug,
      ...FLAG_COLUMNS,
    })
    .from(sitePublicDashboardSettings)
    .where(eq(sitePublicDashboardSettings.siteId, siteId))
  return row ?? DEFAULT_SETTINGS
}

export interface ResolvedPublicShare extends PublicSurfaceFlags {
  readonly siteId: string
  readonly siteStatus: SiteStatus
  /** The site's cache epoch, passed to the query gateway as `cache_epoch` so a
   * lifecycle change makes every cached public answer unreachable (ADR-0030,
   * decision 6). Selected here because the public read path has no other site
   * row to take it from. */
  readonly configVersion: number
  /** The published import and its cutover (ADR-0032, D2b). A shared dashboard of
   * a migrated site shows the same history the owner sees, and it costs no extra
   * read: this query already joins `sites`. */
  readonly publishedImportRunId: string | null
  readonly importCutoverDate: string | null
  readonly enabled: boolean
}

/** Resolves a public slug to its site and sharing state. Null if no such slug. */
export async function resolvePublicShare(
  db: Database,
  slug: string,
): Promise<ResolvedPublicShare | null> {
  const [row] = await db
    .select({
      siteId: sitePublicDashboardSettings.siteId,
      siteStatus: sites.status,
      configVersion: sites.configVersion,
      publishedImportRunId: sites.publishedImportRunId,
      importCutoverDate: importRuns.cutoverDate,
      enabled: sitePublicDashboardSettings.enabled,
      ...FLAG_COLUMNS,
    })
    .from(sitePublicDashboardSettings)
    .innerJoin(sites, eq(sites.id, sitePublicDashboardSettings.siteId))
    .leftJoin(importRuns, eq(importRuns.id, sites.publishedImportRunId))
    .where(eq(sitePublicDashboardSettings.shareSlug, slug))
  return row ?? null
}

export interface UpdatePublicDashboardInput extends PublicSurfaceFlags {
  readonly siteId: string
  readonly actorUserId: string
  readonly enabled: boolean
  /** Mint a fresh slug, revoking the previous public address. */
  readonly rotateSlug: boolean
}

/** The nine opt-in booleans of an input or a settings row, on their own. */
function surfaceFlagsOf(source: PublicSurfaceFlags): PublicSurfaceFlags {
  return {
    shareOverview: source.shareOverview,
    shareGeography: source.shareGeography,
    shareRealtime: source.shareRealtime,
    shareTimeseries: source.shareTimeseries,
    shareSessions: source.shareSessions,
    sharePages: source.sharePages,
    shareSources: source.shareSources,
    shareDevices: source.shareDevices,
    shareIdentity: source.shareIdentity,
  }
}

/**
 * Upserts a site's public-dashboard settings.
 *
 * A slug is minted the first time sharing is enabled, and re-minted when
 * `rotateSlug` is set (revoking the old address). Disabling keeps the row but
 * turns the master switch off; the slug is retained so re-enabling does not
 * change the shared URL unless rotation is asked for.
 */
export async function updatePublicDashboardSettings(
  db: Database,
  input: UpdatePublicDashboardInput,
): Promise<PublicDashboardSettings> {
  const now = new Date()
  return db.transaction(async (tx) => {
    const existing = await getPublicDashboardSettings(tx as unknown as Database, input.siteId)

    let shareSlug = existing.shareSlug
    if (input.rotateSlug || (input.enabled && shareSlug === null)) {
      shareSlug = generateShareSlug()
    }

    const flags = surfaceFlagsOf(input)
    const values = {
      siteId: input.siteId,
      enabled: input.enabled,
      shareSlug,
      ...flags,
      updatedAt: now,
    }

    await tx
      .insert(sitePublicDashboardSettings)
      .values(values)
      .onConflictDoUpdate({
        target: sitePublicDashboardSettings.siteId,
        set: {
          enabled: values.enabled,
          shareSlug: values.shareSlug,
          ...flags,
          updatedAt: now,
        },
      })

    // Bump config_version so any cached view of a site's public exposure is
    // invalidated on the same counter tracker/ingest config uses.
    await tx
      .update(sites)
      .set({ configVersion: sql`${sites.configVersion} + 1`, updatedAt: now })
      .where(eq(sites.id, input.siteId))

    await writeAudit(tx, {
      action: 'site.public_dashboard.updated',
      actorUserId: input.actorUserId,
      siteId: input.siteId,
      targetType: 'site',
      targetId: input.siteId,
      metadata: {
        enabled: input.enabled,
        // Every surface by name, so the audit row records the whole exposure a
        // change produced rather than the subset that existed when it was
        // written. A trail that silently stops covering new surfaces is worse
        // than one that never covered them.
        ...auditFlags(flags),
        rotated: input.rotateSlug,
      },
    })

    return {
      enabled: values.enabled,
      shareSlug: values.shareSlug,
      ...flags,
    }
  })
}

/** The flags under their wire names (`share_pages`), for the audit metadata. */
function auditFlags(flags: PublicSurfaceFlags): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const surface of PUBLIC_SURFACES) out[`share_${surface}`] = flags[SURFACE_FLAG[surface]]
  return out
}

/**
 * Guard used by the public read routes (docs snapshot 02 §20).
 *
 * Every surface shares on the same three rules — master switch on, site active,
 * per-surface flag set — and the flag is reached through `SURFACE_FLAG` rather
 * than an `if`-chain. The chain this replaced ended in an unguarded
 * `return share.shareRealtime`, so a surface added to the union without its own
 * branch would have inherited realtime's answer instead of failing to compile
 * (ADR-0039).
 */
export function isSurfaceShared(share: ResolvedPublicShare, surface: PublicSurface): boolean {
  if (!share.enabled) return false
  // A `suspended`/`deleting`/`deleted` site's public share is closed.
  if (share.siteStatus !== 'active') return false
  return share[SURFACE_FLAG[surface]]
}

/**
 * The surfaces whose being open means the share actually publishes something.
 *
 * `identity` is excluded, and the exclusion is the decision (ADR-0044 D2). It
 * describes a board rather than being one, so counting it would make
 * `isSharePublishing` circular: a share whose only open flag is `share_identity`
 * would be "live" purely because identity is on, and the site-identity route
 * would then confirm a slug whose board renders not one number. `realtime` is
 * counted — a share publishing only the live-visitor stream is publishing.
 */
const PUBLISHING_SURFACES: readonly PublicSurface[] = PUBLIC_SURFACES.filter(
  (surface) => surface !== 'identity',
)

/**
 * Does this slug publish anything at all? (ADR-0044, D2.)
 *
 * The gate for `GET /v1/public/{slug}/site`, which is not itself a board card
 * and therefore cannot gate on its own flag. Composed from `isSurfaceShared`
 * rather than restating its three conditions, so the master switch and the
 * `suspended` close are inherited and cannot drift: a share with every
 * surface off — or one on a blocked site — is not confirmable through this
 * route, exactly as it is not through the other seven.
 */
export function isSharePublishing(share: ResolvedPublicShare): boolean {
  return PUBLISHING_SURFACES.some((surface) => isSurfaceShared(share, surface))
}

/**
 * What a shared board needs to name and draw itself (ADR-0044).
 *
 * Read after `isSharePublishing` has already decided the slug answers, so this
 * function makes no authorization decision of its own — the route picks which
 * of these fields reach the wire from `share_identity`.
 *
 * `faviconDomain` is **derived, not stored** (D5): the first entry of the site's
 * own origin allowlist, which is the owner's declaration of which hosts are this
 * site. The allowlist is a set with no stored order, so "first" is the
 * lexicographic first — the same order the settings screen lists and
 * `updateSiteSettings` returns, so the value a viewer sees is one the owner has
 * seen. `null` when the site has no allowlist configured.
 */
export interface PublicSiteIdentity {
  /** `sites.name` — the name the owner typed, not a separate public alias. */
  readonly displayName: string
  readonly faviconDomain: string | null
  /** NULL means "not configured; the viewer's clock applies" (ADR-0044, D4). */
  readonly reportingTimezone: string | null
  /** ADR-0027's install-verified instant, served unchanged. */
  readonly firstEventAt: Date | null
}

export async function readPublicSiteIdentity(
  db: Database,
  siteId: string,
): Promise<PublicSiteIdentity | null> {
  const [site] = await db
    .select({
      name: sites.name,
      reportingTimezone: sites.reportingTimezone,
      firstEventAt: sites.firstEventAt,
    })
    .from(sites)
    .where(eq(sites.id, siteId))
  if (!site) return null

  const [domain] = await db
    .select({ domain: siteDomains.domain })
    .from(siteDomains)
    .where(eq(siteDomains.siteId, siteId))
    .orderBy(asc(siteDomains.domain))
    .limit(1)

  return {
    displayName: site.name,
    faviconDomain: domain?.domain ?? null,
    reportingTimezone: site.reportingTimezone,
    firstEventAt: site.firstEventAt,
  }
}
