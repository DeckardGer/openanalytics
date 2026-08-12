import { ApiError } from '@openanalytics/contracts'
import { authorizeCapability, type Auth, type Capability, type SiteRole } from '@openanalytics/auth'
import type { ImportPointer } from '@openanalytics/domain'
import { getMembership, getSiteBasics, type Database } from '@openanalytics/postgres'
import type { RequestContextVariables } from '@openanalytics/observability/hono'
import type { MiddlewareHandler } from 'hono'

/**
 * The server-side authorization chain (docs snapshot 02 §19): resolve the
 * session, resolve the caller's membership of the site in the path, then check
 * the capability the route requires. A frontend route guard is not a boundary;
 * this is.
 */

export interface AuthedUser {
  readonly id: string
  readonly email: string
  readonly emailVerified: boolean
  readonly createdAt: Date
}

export interface Membership {
  readonly siteId: string
  readonly role: SiteRole
  readonly isBillingOwner: boolean
}

export interface AuthedSession {
  /** When the session was authenticated — the recency a sensitive action checks
   * with `isRecentReauth`. */
  readonly createdAt: Date
}

/**
 * The OAuth client behind a grant-authenticated request (ADR-0048 D2), or
 * absent for a session.
 *
 * Set by `principalAuth` on the grant arm and read by nothing that authorizes
 * — authorization is `membership.role`, the same for a grant as for a session.
 * It exists so a token-authored write can name its client in the logs (D5),
 * and so a handler that wants to (the connected-apps surface) can tell the two
 * principals apart.
 */
export interface GrantContext {
  readonly clientId: string
  readonly grantId: string
  readonly scopes: readonly string[]
}

export type ApiVariables = RequestContextVariables & {
  user: AuthedUser
  session: AuthedSession
  /** Present only when the request authenticated with an OAuth grant, not a
   * session (ADR-0048 D2). */
  grant?: GrantContext
  membership: Membership
  /**
   * The site's `config_version`, set by `requireAnalyticsAccess` from the row it
   * already loads for the billing gate. The analytics routes pass it to the
   * query gateway as `cache_epoch`, so every entry cached under a previous
   * version becomes unreachable the moment a lifecycle transition bumps it
   * (ADR-0030, decision 6). Free: no extra read.
   */
  siteCacheEpoch: number
  /**
   * The site's published import and its cutover, or null (ADR-0032, D2b).
   *
   * Set by `requireAnalyticsAccess` from the same row it already loads — the
   * pointer joins the run for its cutover date, so this costs no extra query. It
   * is resolved **per request and never cached**: the pointer is what a publish
   * or a rollback moves, and it reaches the gateway as a bound parameter, so the
   * gateway's existing cache key changes with it. There is nothing else to
   * invalidate.
   */
  siteImportPointer: ImportPointer | null
  /**
   * The site's `reporting_currency` (ADR-0033, D2c), set by
   * `requireAnalyticsAccess` from the row it already loads.
   *
   * Every revenue amount the API returns is denominated in it, and the revenue
   * routes pass it to the service so a total can name its own currency without a
   * second query. Free: no extra read.
   */
  siteReportingCurrency: string
}

type Env = { Variables: ApiVariables }

/** Requires a valid Better Auth session; sets `user`. */
export function sessionAuth(auth: Auth): MiddlewareHandler<Env> {
  return async (c, next) => {
    const result = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!result?.user) {
      throw new ApiError('UNAUTHENTICATED', 'Authentication required')
    }
    c.set('user', {
      id: result.user.id,
      email: result.user.email,
      emailVerified: result.user.emailVerified === true,
      // Better Auth returns createdAt as a Date, but coerce defensively so the
      // trial eligibility cutoff comparison is always against a real Date.
      createdAt: new Date(result.user.createdAt),
    })
    c.set('session', { createdAt: new Date(result.session.createdAt) })
    await next()
  }
}

/**
 * The canonical spelling of a site id: lowercase, hyphenated, no braces.
 *
 * Postgres's `uuid` type accepts a family of spellings — uppercase,
 * brace-wrapped, hyphen-free — and normalizes them on the way in, so
 * `/v1/sites/{UPPERCASE-ID}/...` resolves to the same row as the lowercase one.
 * That is harmless right up until something *derives a string* from the path
 * spelling rather than from the row. ADR-0033's credential AAD does exactly
 * that (`revenue_credential:{credential_id}:{site_id}`), so a credential
 * encrypted through an uppercase URL would be bound to an AAD no later request
 * reproduces, and the ciphertext would be permanently undecryptable.
 *
 * Normalizing here rather than in the one route that noticed: `membership.siteId`
 * is what every site-scoped route reads, and the next derivation to be written
 * should not have to rediscover this.
 */
const UUID_PATTERN =
  /^\{?([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})\}?$/iu

export function canonicalSiteId(raw: string): string | null {
  const match = UUID_PATTERN.exec(raw.trim())
  if (!match) return null
  return match.slice(1).join('-').toLowerCase()
}

/** Requires the `user` to be a member of the `:site_id` in the path; sets
 * `membership` with the id in its canonical spelling. A non-member gets
 * `SITE_NOT_FOUND`, not `FORBIDDEN`, so the API does not reveal that a site it
 * cannot see exists — and so does a path segment that is not a site id at all,
 * for the same reason: "that is not a uuid" and "you cannot see it" are the same
 * answer to a caller holding an id, and a 400 would distinguish them. */
export function siteMembership(db: Database): MiddlewareHandler<Env> {
  return async (c, next) => {
    const user = c.get('user')
    const rawSiteId = c.req.param('site_id')
    if (!rawSiteId) {
      throw new ApiError('VALIDATION_FAILED', 'A site id is required')
    }
    const siteId = canonicalSiteId(rawSiteId)
    if (siteId === null) {
      throw new ApiError('SITE_NOT_FOUND', 'No such site')
    }
    const membership = await getMembership(db, { siteId, userId: user.id })
    if (!membership) {
      throw new ApiError('SITE_NOT_FOUND', 'No such site')
    }
    c.set('membership', {
      siteId,
      role: membership.role,
      isBillingOwner: membership.isBillingOwner,
    })
    await next()
  }
}

/** Requires the resolved membership to grant `capability`. */
export function requireCapability(capability: Capability): MiddlewareHandler<Env> {
  return async (c, next) => {
    const membership = c.get('membership')
    try {
      authorizeCapability({ role: membership.role, capability })
    } catch {
      throw new ApiError('FORBIDDEN', 'Insufficient capability for this operation')
    }
    await next()
  }
}

/**
 * Requires the site to be in a state that permits analytics reads.
 *
 * Analytics read is membership-gated, not capability-gated: a `viewer` suffices
 * (docs snapshot 02 §19 — "viewer: only the permitted analytics read"), so no
 * `requireCapability` sits in front of it. What *does* gate it is the site: a
 * `suspended` site closes analytics read with a typed `SITE_SUSPENDED`
 * (403), never an empty 200 (§19; the site, team and recovery surfaces stay
 * open — this one does not). A `deleting`/`deleted` site is reported as
 * `SITE_NOT_FOUND` so a torn-down site is not distinguishable from one that never
 * existed. Runs after `siteMembership`, so the caller is already a member.
 */
export function requireAnalyticsAccess(db: Database): MiddlewareHandler<Env> {
  return async (c, next) => {
    const { siteId } = c.get('membership')
    const site = await getSiteBasics(db, siteId)
    if (!site || site.status === 'deleting' || site.status === 'deleted') {
      throw new ApiError('SITE_NOT_FOUND', 'No such site')
    }
    if (site.status === 'suspended') {
      throw new ApiError('SITE_SUSPENDED', 'Analytics is unavailable while this site is suspended')
    }
    c.set('siteCacheEpoch', site.configVersion)
    c.set('siteReportingCurrency', site.reportingCurrency)
    // Both or neither: a published run always carries the cutover the publish
    // endpoint resolved before the transition, so a pointer with no cutover is a
    // row that cannot exist — and if it somehow did, reading it as "no import" is
    // the safe direction (live data unrestricted, imported branch empty).
    c.set(
      'siteImportPointer',
      site.publishedImportRunId !== null && site.importCutoverDate !== null
        ? { runId: site.publishedImportRunId, cutoverDate: site.importCutoverDate }
        : null,
    )
    await next()
  }
}

/** Parses a `Bearer <token>` header, or null. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer (.+)$/i.exec(header.trim())
  return match?.[1] ?? null
}
