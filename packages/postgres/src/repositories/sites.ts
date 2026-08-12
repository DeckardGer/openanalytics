import { and, asc, eq, ne, sql } from 'drizzle-orm'
import {
  REALTIME_ACCESS_REVOKED_TOPIC,
  type RealtimeAccessRevokedPayload,
} from '@openanalytics/domain'
import type { Database } from '../client.ts'
import { newId } from '../ids.ts'
import { writeAudit } from './audit.ts'
import { applyDepartureToApiKeys, insertApiKey } from './api-keys.ts'
import { markRevenueRollupRecompute } from './revenue-attribution.ts'
import { revokeRevenueCredentialsCreatedBy } from './revenue-credentials.ts'
import { resetRevenueProjection } from './revenue-objects.ts'
import { importRuns } from '../schema/imports.ts'
import { outbox } from '../schema/outbox.ts'
import { siteDomains, siteMembers, sites, type SiteRole, type SiteStatus } from '../schema/sites.ts'
import { users } from '../schema/auth.ts'

/**
 * Ownership transaction service.
 *
 * These are the only writes that change site membership or the billing owner.
 * They run in a transaction so the deferred ownership-invariant triggers
 * (migration 0007) see a complete, consistent end state, and a membership-
 * mutating transaction takes a `FOR UPDATE` lock on the site row so concurrent
 * ownership changes serialize rather than race (docs snapshot 02 §6).
 *
 * The invariants themselves are enforced by the database; this service surfaces
 * a violation as a typed `OwnershipError` instead of a raw driver error. The
 * D-010 billing-owner cutover is Milestone 3 — here a site keeps exactly the
 * billing owner it was created with.
 */

/**
 * The outbox topic a billing-owner change is published on: cache and access-epoch
 * invalidation, and whatever else has to follow the cutover.
 */
export const SITE_OWNERSHIP_CHANGED_TOPIC = 'site.ownership_changed'

/** A `Database` or an open transaction — everything here works inside either. */
export type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0]

/**
 * Work a layered surface does inside the site-create transaction.
 *
 * Site creation is one transaction on purpose — a site without its owner
 * membership or without its tracking key is a broken site — so a surface that
 * owns rows keyed to a new site cannot write them afterwards and cannot open a
 * transaction of its own. It registers here instead and runs inside this one.
 *
 * `beforeCreate` is where a refusal belongs: it runs before anything is written,
 * so throwing leaves the database untouched. `afterCreate` runs once the site
 * row exists, which is what a foreign key to it needs.
 *
 * The third hook is the one worth explaining. `afterCreate` runs for **any** site
 * this deployment now has — including one `createSiteWithOwner` made for a fixture
 * or an import — so it is where a fact about the row belongs: who is billed for
 * it, say. `afterGuardedCreate` runs only when a *customer request* created the
 * site, beside the gate that admitted it, and is where a rule about *creating* one
 * belongs. The split exists because the two are not the same claim: a hosted
 * deployment derives a new site's status from its owner's subscription, and
 * applying that to the unguarded primitive would mean a fixture asking for three
 * sites gets one and a unique-index violation.
 */
export interface SiteCreateExtension {
  readonly name: string
  readonly beforeCreate?: (tx: Executor, input: { readonly ownerUserId: string }) => Promise<void>
  readonly afterCreate?: (tx: Executor, input: SiteCreatedInput) => Promise<void>
  readonly afterGuardedCreate?: (tx: Executor, input: SiteCreatedInput) => Promise<void>
}

export interface SiteCreatedInput {
  readonly siteId: string
  readonly ownerUserId: string
  /** The user who asked, when a request rather than a fixture created this. */
  readonly actorUserId?: string
  readonly now: Date
}

const siteCreateExtensions: SiteCreateExtension[] = []

export function registerSiteCreateExtension(extension: SiteCreateExtension): void {
  if (siteCreateExtensions.some((registered) => registered.name === extension.name)) return
  siteCreateExtensions.push(extension)
}

async function beforeSiteCreate(
  tx: Executor,
  input: { readonly ownerUserId: string },
): Promise<void> {
  for (const extension of siteCreateExtensions) {
    await extension.beforeCreate?.(tx, input)
  }
}

async function onSiteCreated(
  tx: Executor,
  input: {
    readonly siteId: string
    readonly ownerUserId: string
    readonly actorUserId?: string
    readonly now?: Date
    /** True on the guarded path only, where `afterGuardedCreate` also runs. */
    readonly guarded?: boolean
  },
): Promise<void> {
  const now = input.now ?? new Date()
  for (const extension of siteCreateExtensions) {
    await extension.afterCreate?.(tx, { ...input, now })
    if (input.guarded === true) await extension.afterGuardedCreate?.(tx, { ...input, now })
  }
}

export type OwnershipViolation =
  | 'last_owner'
  | 'billing_owner'
  | 'not_a_member'
  | 'already_member'
  | 'site_not_found'
  | 'not_an_owner'
  | 'already_billing_owner'
  /** The caller is entitled but already funds their plan's maximum sites. */
  | 'capacity_exceeded'
  /**
   * The caller has no entitlement and already holds their one unfunded site
   * (ADR-0040, D2). This replaced `no_entitlement` on the create path: an
   * unfunded caller may hold a site, but only one.
   */
  | 'unfunded_site_limit'
  /** The requested public slug is already in use by another site. */
  | 'slug_taken'

export class OwnershipError extends Error {
  readonly violation: OwnershipViolation

  constructor(violation: OwnershipViolation, message: string) {
    super(message)
    this.name = 'OwnershipError'
    this.violation = violation
  }
}

/** The SQLSTATE lives on the driver error, but a wrapper may nest it under
 * `cause`; walk the chain so the mapping is robust to that. */
function ownershipSqlState(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const code = (current as Record<string, unknown>)['code']
    if (code === 'OA001' || code === 'OA002' || code === '23505') return code
    current = (current as Record<string, unknown>)['cause']
  }
  return undefined
}

/**
 * The name of the constraint a driver error names, if any.
 *
 * SQLSTATE `23505` alone is not enough to classify a unique violation once more
 * than one unique key is reachable from a single statement: `createSite` inserts
 * a site and a membership in one transaction, and "this slug is taken" and "this
 * user is already a member" are different answers to the caller. Postgres names
 * the offending constraint (or unique index) on the error, so read that. The
 * message is a fallback for a driver or wrapper that drops the field.
 */
function ownershipConstraint(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const constraint = (current as Record<string, unknown>)['constraint']
    if (typeof constraint === 'string' && constraint.length > 0) return constraint
    current = (current as Record<string, unknown>)['cause']
  }
  const message = error instanceof Error ? error.message : String(error)
  return /violates unique constraint "([^"]+)"/.exec(message)?.[1]
}

export function mapOwnershipError(error: unknown): Error {
  if (error instanceof OwnershipError) return error
  const code = ownershipSqlState(error)
  const message = error instanceof Error ? error.message : String(error)

  // Classify by constraint name before falling back to the SQLSTATE, so a slug
  // collision is never reported as a duplicate membership.
  const constraint = ownershipConstraint(error)
  if (constraint === 'sites_slug_key') {
    return new OwnershipError('slug_taken', 'that site slug is already taken')
  }
  if (constraint === 'site_members_site_user_key') {
    return new OwnershipError('already_member', 'the user is already a member of this site')
  }
  // The D2 bound, lost race (ADR-0040): two concurrent creates by one unfunded
  // caller, who has no subscription row for the `FOR UPDATE` to serialize on.
  // Reported as the refusal the counted check would have raised, so the caller
  // cannot tell a race from an ordinary second attempt.
  if (constraint === 'sites_one_unfunded_per_owner_key') {
    return new OwnershipError(
      'unfunded_site_limit',
      'an unfunded caller may hold only one site; subscribe to it before creating another',
    )
  }

  if (code === 'OA001' || /at least one owner/.test(message)) {
    return new OwnershipError('last_owner', 'a site must keep at least one owner')
  }
  if (code === 'OA002' || /accepted owner member/.test(message)) {
    return new OwnershipError(
      'billing_owner',
      'the billing owner cannot be removed; transfer billing ownership first',
    )
  }
  if (code === '23505' || /duplicate key|already a member/.test(message)) {
    return new OwnershipError('already_member', 'the user is already a member of this site')
  }
  return error instanceof Error ? error : new Error(String(error))
}

export interface CreateSiteWithOwnerInput {
  readonly slug: string
  readonly name: string
  /** Becomes the site's first owner and its billing owner, and the audit actor. */
  readonly ownerUserId: string
}

export interface CreateSiteWithOwnerResult {
  readonly siteId: string
  readonly membershipId: string
}

/**
 * Creates a site with its first owner in one transaction. The deferred triggers accept the intermediate state (site before
 * membership) and verify the invariants at commit.
 *
 * This is the unguarded primitive: it runs neither the gate nor
 * `afterGuardedCreate`, and mints no key. It does run `afterCreate`, because that
 * hook states facts about any site that exists rather than rules about creating
 * one. `createSite` below is the path a customer request takes.
 */
export async function createSiteWithOwner(
  db: Database,
  input: CreateSiteWithOwnerInput,
): Promise<CreateSiteWithOwnerResult> {
  return db.transaction(async (tx) => {
    const [site] = await tx
      .insert(sites)
      .values({ slug: input.slug, name: input.name, ownerUserId: input.ownerUserId })
      .returning({ id: sites.id })
    if (!site) throw new Error('site insert returned no row')

    const [member] = await tx
      .insert(siteMembers)
      .values({ siteId: site.id, userId: input.ownerUserId, role: 'owner' })
      .returning({ id: siteMembers.id })
    if (!member) throw new Error('membership insert returned no row')

    // `afterCreate` runs — a fact about any site this deployment has, such as who
    // is billed for it — and neither the gate nor `afterGuardedCreate` does. That
    // is what "unguarded" means here, and it is why a fixture may make three sites
    // for one owner without meeting a commercial rule about creating them.
    await onSiteCreated(tx, { siteId: site.id, ownerUserId: input.ownerUserId })

    await writeAudit(tx, {
      action: 'site.created',
      actorUserId: input.ownerUserId,
      siteId: site.id,
      targetType: 'site',
      targetId: site.id,
      metadata: { slug: input.slug, ownerRole: 'owner' },
    })

    return { siteId: site.id, membershipId: member.id }
  })
}

export interface CreateSiteInput {
  readonly slug: string
  readonly name: string
  /** Becomes the site's first owner and its billing owner, and the audit actor. */
  readonly ownerUserId: string
}

/** The `tracking_write` key minted with the site. Public, never a secret. */
export interface CreatedSiteTrackingKey {
  readonly id: string
  readonly publicToken: string
  readonly keyPrefix: string
}

export interface CreatedSite {
  readonly siteId: string
  readonly slug: string
  readonly name: string
  readonly status: SiteStatus
  readonly role: SiteRole
  readonly isBillingOwner: boolean
  readonly trackingKey: CreatedSiteTrackingKey
  readonly createdAt: Date
}

/**
 * The guarded site-create path: entitlement, capacity and every write in ONE
 * transaction (docs snapshot 05, D-008/D-009; 02 §22).
 *
 * One transaction, so a failure anywhere leaves nothing: no site without its
 * owner membership, and no site without the tracking key onboarding is about to
 * render. The key is minted here through `insertApiKey` rather than
 * `createApiKey` for exactly that reason.
 *
 * A site is born `active`. Whether one may be created at all, and what else has
 * to be written when it is, are questions for whatever surfaces a deployment
 * mounts: `beforeSiteCreate` runs first and may refuse or take a lock, and
 * `onSiteCreated` runs after the row exists and still inside the transaction.
 * Both are no-ops when nothing registered, which is the self-hosted case and the
 * reason this path has no `suspended` branch left to reason about.
 *
 */
export async function createSite(db: Database, input: CreateSiteInput): Promise<CreatedSite> {
  const now = new Date()
  try {
    return await db.transaction(async (tx) => {
      await beforeSiteCreate(tx, { ownerUserId: input.ownerUserId })

      const [site] = await tx
        .insert(sites)
        .values({
          slug: input.slug,
          name: input.name,
          // A site is `active` from the instant it exists. Nothing in this
          // repository ever writes another status on the create path — the
          // column's other values are reached by an operator suspending the
          // site or by a deletion starting, and both are later, separate acts.
          status: 'active',
          ownerUserId: input.ownerUserId,
        })
        .returning({
          id: sites.id,
          slug: sites.slug,
          name: sites.name,
          status: sites.status,
          createdAt: sites.createdAt,
        })
      if (!site) throw new Error('site insert returned no row')

      await tx
        .insert(siteMembers)
        .values({ siteId: site.id, userId: input.ownerUserId, role: 'owner' })

      await onSiteCreated(tx, {
        siteId: site.id,
        ownerUserId: input.ownerUserId,
        actorUserId: input.ownerUserId,
        now,
        // The customer-request path: whatever a registered surface decides about
        // *creating* a site runs here and nowhere else.
        guarded: true,
      })

      /**
       * The status as it stands after the extensions have run, not as this
       * transaction inserted it.
       *
       * `RETURNING` above answers with the row at insert time, and a registered
       * surface may have written another status in `onSiteCreated` — the hosted
       * gate suspends a site whose owner funds nothing. Returning the insert's
       * value would make `POST /v1/sites` answer `active` for a site the very same
       * transaction left `suspended`, and the dashboard would believe it until its
       * next read. One extra `SELECT` inside a transaction that already does five
       * writes is the honest price of the seam.
       */
      const [effective] = await tx
        .select({ status: sites.status })
        .from(sites)
        .where(eq(sites.id, site.id))

      const key = await insertApiKey(tx, {
        siteId: site.id,
        type: 'tracking_write',
        createdByUserId: input.ownerUserId,
      })

      await writeAudit(tx, {
        action: 'site.created',
        actorUserId: input.ownerUserId,
        siteId: site.id,
        targetType: 'site',
        targetId: site.id,
        metadata: { slug: input.slug, ownerRole: 'owner' },
      })

      return {
        siteId: site.id,
        slug: site.slug,
        name: site.name,
        status: effective?.status ?? site.status,
        role: 'owner',
        isBillingOwner: true,
        trackingKey: { id: key.id, publicToken: key.rawToken, keyPrefix: key.keyPrefix },
        createdAt: site.createdAt,
      }
    })
  } catch (error) {
    throw mapOwnershipError(error)
  }
}

export interface UpdateSiteSettingsInput {
  readonly siteId: string
  /** Already trimmed and length-checked by `normalizeSiteName`. */
  readonly name?: string
  /**
   * Replace-set: this becomes the site's exact origin allowlist. Already
   * normalized, de-duplicated and bounded by `normalizeSiteDomainSet`.
   */
  readonly domains?: readonly string[]
  /**
   * The site's dashboard reporting currency (ADR-0033, D2c; CP5 is its first
   * writer). Already validated and uppercased by `normalizeReportingCurrency`.
   *
   * Changing it is not a settings tweak, it is a **re-materialization**: every
   * stored reporting amount and every rolled-up bucket was computed in the
   * previous currency. `updateSiteSettings` therefore performs both halves of
   * D2c inside the same transaction as the write — see the function.
   */
  readonly reportingCurrency?: string
  /**
   * The site's own reporting clock (ADR-0044, D4). `undefined` means the caller
   * did not send it; `null` clears the setting back to "not configured; the
   * viewer's clock applies". Already validated by `isValidTimezone` at the route,
   * which is the only place that can ask the runtime's tz database — the column's
   * CHECK is the shape floor under it, not a second opinion.
   *
   * Unlike a domain change and like `reportingCurrency`, writing it does **not**
   * bump `config_version`: that counter is the tracker/ingest config generation,
   * and the collector has never heard of a reporting timezone.
   */
  readonly reportingTimezone?: string | null
  readonly actorUserId: string
}

export interface UpdatedSiteSettings {
  readonly siteId: string
  readonly slug: string
  readonly name: string
  readonly status: SiteStatus
  readonly domains: string[]
  readonly configVersion: number
  /** True when the domain set changed, which is what bumped the version. */
  readonly configVersionBumped: boolean
  readonly reportingCurrency: string
  readonly reportingTimezone: string | null
  /**
   * True when this update changed the reporting currency and therefore queued a
   * re-materialization (ADR-0033, D2c). The route reports it so a client can say
   * "restating your revenue" rather than leaving the customer to wonder why the
   * numbers move for the next few minutes.
   */
  readonly reportingCurrencyChanged: boolean
  /** Unchanged by the update, but returned so the route can answer with a whole
   * `SiteSummary` instead of re-reading the site for one immutable column. */
  readonly createdAt: Date
  /** Also unchanged by the update, and returned for the same reason: a settings
   * save must not drop the install-verified signal from the response
   * (ADR-0027). Only the worker ever writes it. */
  readonly firstEventAt: Date | null
  /** Also unchanged, and returned for the same reason: the response is a whole
   * `SiteSummary`, and dropping the lifecycle triple (ADR-0030, decision 9)
   * would make a rename look like an unblock to any client that re-renders from
   * the response. Written only by the lifecycle transitions. */
  readonly suspendedAt: Date | null
}

/**
 * Rename a site and/or replace its origin allowlist, in one transaction.
 *
 * **A domain change bumps `sites.config_version`; a name change does not.** The
 * bump is not a nicety: `site_domains` is the allowlist
 * `packages/postgres/src/repositories/ingest-config.ts` reads on every ingest
 * request, and `config_version` is the counter that invalidates the
 * tracker-config ETag, the CDN copy and the collector's short-TTL ingest-config
 * cache together (ADR-0008). Writing the domains without moving the version
 * would leave every browser and the collector enforcing the previous allowlist
 * until some unrelated change happened to move it — a customer would add their
 * domain and watch their traffic keep being refused. This mirrors
 * `upsertSiteIngestSettings` exactly.
 *
 * `reporting_currency` and `reporting_timezone` are excluded from the bump for
 * the same reason, stated once here: both are read-side presentation choices,
 * and the collector has never heard of either.
 *
 * The name is deliberately excluded from the bump because it is not in the
 * cached configuration: `SiteIngestConfig` (ingest-config.ts) and the public
 * `TrackerConfig` (contracts/events.ts, projected by the collector's
 * `toTrackerConfig`) carry the allowlist, the timezone, the redaction keys, the
 * sampling and the feature flags — and no display name. Bumping on a rename
 * would invalidate every cached config and re-fetch every tracker for a value
 * none of them holds.
 *
 * Returns everything the route needs for the `SiteSummary` response except the
 * caller's own `role`/`is_billing_owner`, which its membership middleware
 * already resolved — re-reading them here would be a second query for an answer
 * the caller is holding.
 */
export async function updateSiteSettings(
  db: Database,
  input: UpdateSiteSettingsInput,
): Promise<UpdatedSiteSettings> {
  const now = new Date()
  const domainsChanged = input.domains !== undefined
  const fields: string[] = []
  if (input.name !== undefined) fields.push('name')
  if (domainsChanged) fields.push('domains')
  if (input.reportingCurrency !== undefined) fields.push('reporting_currency')
  if (input.reportingTimezone !== undefined) fields.push('reporting_timezone')

  return db.transaction(async (tx) => {
    // Read the current reporting currency under the same transaction that is
    // about to replace it, so "did it actually change?" is decided against the
    // stored value rather than against whatever the client thought it was. A
    // PATCH that re-sends the currency a site already has must NOT trigger a
    // re-materialization: that is a save button being pressed twice, and the
    // cost of treating it as a change is every fact in ClickHouse rewritten.
    const [before] = await tx
      .select({ reportingCurrency: sites.reportingCurrency })
      .from(sites)
      .where(eq(sites.id, input.siteId))
      .for('update')
    if (!before) throw new OwnershipError('site_not_found', 'no such site')
    const reportingCurrencyChanged =
      input.reportingCurrency !== undefined && input.reportingCurrency !== before.reportingCurrency

    if (input.domains !== undefined) {
      // Replace-set: the rows that are gone from the list are gone from the
      // allowlist. Delete-then-insert rather than a diff, because the set is at
      // most SITE_DOMAIN_MAX_COUNT rows and a diff would be more code guarding
      // the same end state.
      await tx.delete(siteDomains).where(eq(siteDomains.siteId, input.siteId))
      if (input.domains.length > 0) {
        await tx
          .insert(siteDomains)
          .values(input.domains.map((domain) => ({ siteId: input.siteId, domain })))
      }
    }

    const [site] = await tx
      .update(sites)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        // Written whenever it was sent, even when it equals the stored value:
        // the write is a no-op and the *re-materialization* below is what is
        // conditional. `config_version` is deliberately NOT bumped — it is the
        // tracker/ingest config generation, and the reporting currency is a
        // read-side presentation choice the collector has never heard of.
        ...(input.reportingCurrency === undefined
          ? {}
          : { reportingCurrency: input.reportingCurrency }),
        // Same treatment, same reason (ADR-0044, D4): a read-side presentation
        // choice, so it is written whenever it was sent and never touches
        // `config_version`. `null` is a value here, not an absence — it clears
        // the setting — which is why the branch tests against `undefined`.
        ...(input.reportingTimezone === undefined
          ? {}
          : { reportingTimezone: input.reportingTimezone }),
        ...(domainsChanged ? { configVersion: sql`${sites.configVersion} + 1` } : {}),
        updatedAt: now,
      })
      .where(eq(sites.id, input.siteId))
      .returning({
        id: sites.id,
        slug: sites.slug,
        name: sites.name,
        status: sites.status,
        configVersion: sites.configVersion,
        reportingCurrency: sites.reportingCurrency,
        reportingTimezone: sites.reportingTimezone,
        createdAt: sites.createdAt,
        firstEventAt: sites.firstEventAt,
        suspendedAt: sites.suspendedAt,
      })
    if (!site) throw new OwnershipError('site_not_found', 'no such site')

    const domains = (
      await tx
        .select({ domain: siteDomains.domain })
        .from(siteDomains)
        .where(eq(siteDomains.siteId, input.siteId))
        .orderBy(asc(siteDomains.domain))
    ).map((row) => row.domain)

    await writeAudit(tx, {
      action: 'site.settings.updated',
      actorUserId: input.actorUserId,
      siteId: input.siteId,
      targetType: 'site',
      targetId: input.siteId,
      // Which fields moved and how many domains resulted — not the values. Domain
      // names are site-owned configuration rather than PII, but the audit trail
      // records that a change happened, not a copy of the configuration.
      metadata: {
        fields,
        domain_count: domains.length,
        // The currency is site-owned configuration rather than PII, and the one
        // audited field here whose *value* matters: "who restated this site's
        // revenue, when, and into what" is the question this row will be asked.
        ...(input.reportingTimezone === undefined
          ? {}
          : { reporting_timezone: input.reportingTimezone }),
        ...(input.reportingCurrency === undefined
          ? {}
          : {
              reporting_currency: input.reportingCurrency,
              reporting_currency_from: before.reportingCurrency,
              reporting_currency_changed: reportingCurrencyChanged,
            }),
      },
    })

    /**
     * The D2c re-materialization, in the same transaction as the setting it
     * follows from (ADR-0033, D2c/D7; CP5).
     *
     * Both halves or neither. `resetRevenueProjection` bumps every head's
     * `version` — the CP3 `TODO(CP5)`, without which a restated fact TIES with
     * the row it replaces and `argMax`, evaluated per column, can return a EUR
     * label beside a USD amount. `markRevenueRollupRecompute` drops the rollup
     * step's floor to the epoch, because the attribution job's rolling horizon
     * only reaches back a month and every older bucket would otherwise keep its
     * amounts in the previous currency forever, with nothing recording that it
     * had.
     *
     * Committing one without the other leaves a site whose facts and totals
     * disagree in a way no later pass would notice — which is exactly why they
     * are here rather than in the route.
     */
    if (reportingCurrencyChanged) {
      await resetRevenueProjection(tx, { siteId: input.siteId, now })
      await markRevenueRollupRecompute(tx, {
        siteId: input.siteId,
        // The epoch: "all of it". The column is a timestamp rather than a
        // boolean so a bounded re-roll is expressible later without a migration.
        from: new Date(0),
        now,
      })
    }

    return {
      siteId: site.id,
      slug: site.slug,
      name: site.name,
      status: site.status,
      domains,
      configVersion: site.configVersion,
      configVersionBumped: domainsChanged,
      reportingCurrency: site.reportingCurrency,
      reportingTimezone: site.reportingTimezone,
      reportingCurrencyChanged,
      createdAt: site.createdAt,
      firstEventAt: site.firstEventAt,
      suspendedAt: site.suspendedAt,
    }
  })
}

export interface AddMemberInput {
  readonly siteId: string
  readonly userId: string
  readonly role: SiteRole
  /** The owner/admin performing the change, recorded in the audit trail. */
  readonly actorUserId?: string
}

/**
 * Adds a member. Adding an owner does not change the billing owner (D-009);
 * membership additions only raise the owner count, so they need no site lock.
 */
export async function addMember(
  db: Database,
  input: AddMemberInput,
): Promise<{ membershipId: string }> {
  try {
    return await db.transaction(async (tx) => {
      const [member] = await tx
        .insert(siteMembers)
        .values({ siteId: input.siteId, userId: input.userId, role: input.role })
        .returning({ id: siteMembers.id })
      if (!member) throw new Error('membership insert returned no row')

      await writeAudit(tx, {
        action: 'site.member.added',
        actorUserId: input.actorUserId ?? null,
        actorType: input.actorUserId ? 'user' : 'system',
        siteId: input.siteId,
        targetType: 'site_member',
        targetId: input.userId,
        metadata: { role: input.role },
      })

      return { membershipId: member.id }
    })
  } catch (error) {
    throw mapOwnershipError(error)
  }
}

/**
 * Removes a member. The database refuses to remove the last owner
 * (`OwnershipError('last_owner')`) or the billing owner
 * (`OwnershipError('billing_owner')`); a non-billing member is removed cleanly.
 */
export async function removeMember(
  db: Database,
  input: { siteId: string; userId: string; actorUserId?: string },
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      // Serialize ownership changes for this site.
      await tx.execute(sql`SELECT 1 FROM ${sites} WHERE id = ${input.siteId} FOR UPDATE`)

      const deleted = await tx
        .delete(siteMembers)
        .where(and(eq(siteMembers.siteId, input.siteId), eq(siteMembers.userId, input.userId)))
        .returning({ id: siteMembers.id })

      if (deleted.length === 0) {
        throw new OwnershipError('not_a_member', 'the user is not a member of this site')
      }

      // The provider credentials this member connected die with their
      // membership (snapshot 02 §19, ADR-0033 D3). In this transaction rather
      // than after it, for the same reason the realtime revocation below is: a
      // crash between the two would leave a removed member's payment-provider
      // key live on a site they no longer belong to. The call writes its own
      // audit row and no-ops when they connected nothing.
      await revokeRevenueCredentialsCreatedBy(tx, {
        siteId: input.siteId,
        userId: input.userId,
        actorUserId: input.actorUserId ?? null,
      })

      // The private read keys this member was shown (docs snapshot 02 §19,
      // ADR-0043 D8). Third in this transaction and for the same reason as the
      // two either side of it: a crash between them would leave a departed
      // member's live analytics credential on a site they no longer belong to.
      //
      // Not a blanket revocation. A key they *held* dies here; a key they
      // installed into a machine — `held_by = 'site'`, the WordPress plugin's —
      // survives with `rotation_required_at` stamped, because revoking it would
      // take a working installation down over a personnel change. §19 chose
      // between those two outcomes before we did; this call is both halves.
      await applyDepartureToApiKeys(tx, {
        siteId: input.siteId,
        userId: input.userId,
        actorUserId: input.actorUserId ?? null,
        now: new Date(),
      })

      // Durable realtime revocation (D-213): the same transaction that severs the
      // membership enqueues the epoch bump the worker replays until Redis acks, so
      // a removed member's open stream is closed even if the api's immediate
      // best-effort bump is lost. Written exactly once because it shares this
      // transaction; a random idempotency key is right here — a re-added-then-
      // removed member must enqueue a fresh revocation, not collide with an old one.
      await tx.insert(outbox).values({
        id: newId(),
        topic: REALTIME_ACCESS_REVOKED_TOPIC,
        payload: {
          site_id: input.siteId,
          user_id: input.userId,
          reason: 'member_removed',
        } satisfies RealtimeAccessRevokedPayload,
        idempotencyKey: `realtime.access_revoked:member:${newId()}`,
      })

      await writeAudit(tx, {
        action: 'site.member.removed',
        actorUserId: input.actorUserId ?? null,
        actorType: input.actorUserId ? 'user' : 'system',
        siteId: input.siteId,
        targetType: 'site_member',
        targetId: input.userId,
      })
    })
  } catch (error) {
    throw mapOwnershipError(error)
  }
}

export interface UpdateMemberRoleInput {
  readonly siteId: string
  readonly userId: string
  readonly role: SiteRole
  readonly actorUserId?: string
}

export interface UpdatedMemberRole {
  readonly userId: string
  readonly role: SiteRole
  /** The role held before the call; equal to `role` on a no-op. */
  readonly previousRole: SiteRole
  /** False when the member already held this role — nothing was written. */
  readonly changed: boolean
}

/**
 * Changes a member's role.
 *
 * The site row is locked `FOR UPDATE` first, exactly as `removeMember` does, so
 * a role change serializes with removals and with the D-010 cutover. Two
 * concurrent demotions of the last two owners would otherwise each see the other
 * owner still in place.
 *
 * Two invariants are NOT enforced here, and deliberately so: the deferred
 * constraint triggers of migration 0007 fire on `AFTER INSERT OR UPDATE OR
 * DELETE ON site_members`, so an `UPDATE` of `role` is checked at commit just
 * like an insert or a delete. Demoting the last owner raises `OA001`, and
 * demoting the billing owner below `owner` raises `OA002` (the billing owner
 * must be an *accepted owner member*). `mapOwnershipError` turns those into
 * `OwnershipError('last_owner')` and `OwnershipError('billing_owner')`. They are
 * database-enforced rather than advisory, which is what makes them hold under
 * concurrency instead of only in the happy path.
 *
 * Setting the role a member already holds is a success that writes nothing — no
 * update, and no audit row. An audit trail that records changes which did not
 * happen is a trail nobody can read.
 *
 * No realtime epoch bump: realtime authorization is membership-scoped, not
 * role-scoped (`apps/api/src/http/realtime.ts` issues a token from the
 * membership's `siteId` and the user id, and never reads the role), so a role
 * change revokes no realtime access and there is nothing to invalidate.
 */
export async function updateMemberRole(
  db: Database,
  input: UpdateMemberRoleInput,
): Promise<UpdatedMemberRole> {
  try {
    return await db.transaction(async (tx) => {
      // Serialize ownership changes for this site.
      await tx.execute(sql`SELECT 1 FROM ${sites} WHERE id = ${input.siteId} FOR UPDATE`)

      const [member] = await tx
        .select({ role: siteMembers.role })
        .from(siteMembers)
        .where(and(eq(siteMembers.siteId, input.siteId), eq(siteMembers.userId, input.userId)))
      if (!member) {
        throw new OwnershipError('not_a_member', 'the user is not a member of this site')
      }

      if (member.role === input.role) {
        return { userId: input.userId, role: input.role, previousRole: member.role, changed: false }
      }

      await tx
        .update(siteMembers)
        .set({ role: input.role })
        .where(and(eq(siteMembers.siteId, input.siteId), eq(siteMembers.userId, input.userId)))

      await writeAudit(tx, {
        action: 'site.member.role_changed',
        actorUserId: input.actorUserId ?? null,
        actorType: input.actorUserId ? 'user' : 'system',
        siteId: input.siteId,
        targetType: 'site_member',
        targetId: input.userId,
        metadata: { from: member.role, to: input.role },
      })

      return { userId: input.userId, role: input.role, previousRole: member.role, changed: true }
    })
  } catch (error) {
    throw mapOwnershipError(error)
  }
}

export interface SiteMemberSummary {
  readonly userId: string
  readonly role: SiteRole
  readonly email: string
  /** Better Auth requires a name at sign-up, but an empty one is possible. */
  readonly name: string | null
}

/**
 * A site's members, with the identity a team screen has to show.
 *
 * Joined rather than left to the caller: without it the dashboard rendered raw
 * UUIDs beside a pending-invite list that already showed email addresses, so one
 * screen disagreed with itself about who a person is. The email is disclosed
 * only to someone who is already a member of the same site — the route's
 * `siteMembership` gate — and, as with the invite list, it stays out of the
 * audit trail and out of log lines (AGENTS.md).
 */
export async function listMembers(db: Database, siteId: string): Promise<SiteMemberSummary[]> {
  const rows = await db
    .select({
      userId: siteMembers.userId,
      role: siteMembers.role,
      email: users.email,
      name: users.name,
    })
    .from(siteMembers)
    .innerJoin(users, eq(users.id, siteMembers.userId))
    .where(eq(siteMembers.siteId, siteId))

  return rows.map((row) => ({
    userId: row.userId,
    role: row.role,
    email: row.email,
    // The column is NOT NULL, so an account with no name carries an empty
    // string. The contract says "unknown" with null; conflating the two would
    // have the frontend render an empty label instead of a fallback.
    name: row.name.length === 0 ? null : row.name,
  }))
}

export async function countOwners(db: Database, siteId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(siteMembers)
    .where(and(eq(siteMembers.siteId, siteId), eq(siteMembers.role, 'owner')))
  return row?.n ?? 0
}

/** A site as the caller sees it: the caller's own role, whether they are the
 * billing owner (which no site role grants — only identity does), and the origin
 * allowlist the settings screen edits. */
export interface SiteForUser {
  readonly siteId: string
  readonly slug: string
  readonly name: string
  readonly status: SiteStatus
  readonly role: SiteRole
  readonly isBillingOwner: boolean
  /** The origin allowlist, lowercased and sorted. Empty means unconfigured. */
  readonly domains: string[]
  /** When the site was created — the earliest instant it can have data for, and
   * so the anchor the dashboard's "All time" interval starts from. */
  readonly createdAt: Date
  /** When this site's first event reached the ingest pipeline, or null if none
   * ever has (ADR-0027). The onboarding step "tracker installed" is exactly this
   * field being non-null; it never moves once set. */
  readonly firstEventAt: Date | null
  /**
   * The lifecycle triple (ADR-0030, decision 9). All three are null on an active
   * site, and all three are set together when it blocks — the blocked screen and
   * the retention countdown are frontend reads of exactly these plus `status`.
   */
  readonly suspendedAt: Date | null
  /**
   * The dashboard reporting currency (ADR-0033, D2c), uppercase ISO-4217.
   *
   * On the site summary rather than only on the revenue surface, because it is
   * the label every money figure the product shows is denominated in — a client
   * that had to fetch a revenue endpoint before it could render a currency
   * symbol would show the wrong one for the length of that request.
   */
  readonly reportingCurrency: string
  /**
   * The site's own reporting clock (ADR-0044, D4), or null when the owner has
   * never configured one. An *override* on top of ADR-0026's user preference,
   * not a replacement: no private analytics query reads it. It is on the summary
   * because the settings screen renders it and the public share board is served
   * it — one value, one place it is read from.
   */
  readonly reportingTimezone: string | null
}

const siteForUserColumns = {
  siteId: sites.id,
  slug: sites.slug,
  name: sites.name,
  status: sites.status,
  role: siteMembers.role,
  billingOwner: sites.ownerUserId,
  createdAt: sites.createdAt,
  firstEventAt: sites.firstEventAt,
  suspendedAt: sites.suspendedAt,
  reportingCurrency: sites.reportingCurrency,
  reportingTimezone: sites.reportingTimezone,
  // Aggregated in the same statement rather than a query per site: the site list
  // is rendered on every dashboard load, and one round-trip per site would make
  // the list cost grow with the account. `site_domains` carries no ordering
  // column, so the answer is sorted to be stable across reads instead of
  // depending on physical row order.
  domains: sql<string[]>`coalesce((
    SELECT array_agg(lower(d.domain) ORDER BY lower(d.domain))
    FROM site_domains d
    WHERE d.site_id = ${sites.id}
  ), '{}')`,
} as const

function toSiteForUser(
  row: {
    siteId: string
    slug: string
    name: string
    status: SiteStatus
    role: SiteRole
    billingOwner: string
    domains: string[] | null
    createdAt: Date
    firstEventAt: Date | null
    suspendedAt: Date | null
    reportingCurrency: string
    reportingTimezone: string | null
  },
  userId: string,
): SiteForUser {
  return {
    siteId: row.siteId,
    slug: row.slug,
    name: row.name,
    status: row.status,
    role: row.role,
    isBillingOwner: row.billingOwner === userId,
    domains: row.domains ?? [],
    createdAt: row.createdAt,
    firstEventAt: row.firstEventAt,
    suspendedAt: row.suspendedAt,
    reportingCurrency: row.reportingCurrency,
    reportingTimezone: row.reportingTimezone,
  }
}

/**
 * A `deleted` site is a tombstone, not a site (ADR-0030, decision 9; ADR-0027's
 * rule that a deleted site id never returns). It is excluded from every
 * member-facing read: its name is blank, its slug has been rewritten to free the
 * unique index, and every store behind it has been purged and verified. A
 * `deleting` site is *not* excluded — the frontend renders its progress, which
 * is the only place the state is visible at all.
 */
const notDeleted = ne(sites.status, 'deleted')

export async function listSitesForUser(db: Database, userId: string): Promise<SiteForUser[]> {
  const rows = await db
    .select(siteForUserColumns)
    .from(siteMembers)
    .innerJoin(sites, eq(siteMembers.siteId, sites.id))
    .where(and(eq(siteMembers.userId, userId), notDeleted))
  return rows.map((row) => toSiteForUser(row, userId))
}

export async function getSiteForUser(
  db: Database,
  params: { siteId: string; userId: string },
): Promise<SiteForUser | null> {
  const [row] = await db
    .select(siteForUserColumns)
    .from(siteMembers)
    .innerJoin(sites, eq(siteMembers.siteId, sites.id))
    .where(
      and(eq(siteMembers.userId, params.userId), eq(siteMembers.siteId, params.siteId), notDeleted),
    )
  return row ? toSiteForUser(row, params.userId) : null
}

/** The membership check the HTTP middleware runs — role and billing-owner flag,
 * or null if the user is not a member of the site. */
export async function getMembership(
  db: Database,
  params: { siteId: string; userId: string },
): Promise<{ role: SiteRole; isBillingOwner: boolean } | null> {
  const [row] = await db
    .select({ role: siteMembers.role, billingOwner: sites.ownerUserId })
    .from(siteMembers)
    .innerJoin(sites, eq(siteMembers.siteId, sites.id))
    .where(and(eq(siteMembers.siteId, params.siteId), eq(siteMembers.userId, params.userId)))
  return row ? { role: row.role, isBillingOwner: row.billingOwner === params.userId } : null
}

/** Resolves a public slug to an internal id, but only for a site the caller can
 * see (docs snapshot 03 §8). */
export async function resolveSlugForUser(
  db: Database,
  params: { slug: string; userId: string },
): Promise<{ siteId: string; slug: string } | null> {
  const [row] = await db
    .select({ siteId: sites.id, slug: sites.slug })
    .from(sites)
    .innerJoin(siteMembers, eq(siteMembers.siteId, sites.id))
    .where(and(eq(sites.slug, params.slug), eq(siteMembers.userId, params.userId), notDeleted))
  return row ?? null
}

/** One site's candidate first-event instant, as the pipeline observed it. */
export interface SiteFirstEventCandidate {
  readonly siteId: string
  /** The earliest `occurred_at` this batch carried for the site. */
  readonly occurredAt: Date
}

/**
 * Fill `sites.first_event_at` for sites that have never had one — the
 * install-verified signal (ADR-0027).
 *
 * One statement for the whole batch, and idempotent by `first_event_at IS NULL`
 * rather than by anything the caller remembers. That guard is the entire
 * correctness argument: the write is a no-op on every batch after the first,
 * concurrent workers observing the same site serialize on the row lock and the
 * loser's update matches nothing, and a batch retried after a crash cannot move
 * a value that is already set.
 *
 * **Never `LEAST`, deliberately.** An event that occurred earlier but arrives in
 * a later batch — a late flush, an offline tracker's replay — does not pull the
 * instant backwards. The consumer is an onboarding step asking "has data ever
 * flowed", and a stable answer is worth more than a marginally more accurate
 * one that can change under a client that cached it. The doc comment on the
 * column says "as seen by the pipeline" for exactly this reason.
 *
 * Returns the ids actually filled, which is what the caller counts. Note that a
 * site *not* in that list is not an error: it means the site already had a
 * first event, or no longer exists.
 */
export async function markSitesFirstEvent(
  db: Database,
  candidates: readonly SiteFirstEventCandidate[],
): Promise<string[]> {
  if (candidates.length === 0) return []

  const rows = sql.join(
    candidates.map(
      (candidate) =>
        sql`(${candidate.siteId}::uuid, ${candidate.occurredAt.toISOString()}::timestamptz)`,
    ),
    sql`, `,
  )

  const result = await db.execute(sql`
    UPDATE ${sites} AS s
       SET first_event_at = c.occurred_at,
           updated_at = now()
      FROM (VALUES ${rows}) AS c(site_id, occurred_at)
     WHERE s.id = c.site_id
       AND s.first_event_at IS NULL
    RETURNING s.id
  `)

  return (result as unknown as { rows: { id: string }[] }).rows.map((row) => row.id)
}

export interface SiteBasics {
  readonly siteId: string
  readonly slug: string
  readonly name: string
  readonly status: SiteStatus
  /**
   * The counter every cache of this site's configuration keys on. Carried here
   * because the read middleware already loads this row for the billing gate, and
   * the analytics routes pass it to the query gateway as `cache_epoch` so a
   * block, reactivation or deletion-start makes every cached answer for the
   * previous version unreachable (ADR-0030, decision 6).
   */
  readonly configVersion: number
  /**
   * The site's published import and where it stops (ADR-0032, D2b/D4).
   *
   * Carried on this row for the same reason `configVersion` is: the analytics
   * middleware already loads it, the read path needs the pointer on **every**
   * request — the pointer *is* the invalidation mechanism, so it is never cached
   * beyond one request — and a second query per analytics read to fetch two
   * columns would be a round trip bought with nothing.
   *
   * The cutover comes from the run rather than the site, so this is a LEFT JOIN.
   * Both fields are null together: a site with no pointer has no cutover, and a
   * pointer that named a run with no cutover could not have been published (the
   * publish endpoint resolves one before the transition).
   */
  readonly publishedImportRunId: string | null
  readonly importCutoverDate: string | null
  /**
   * The dashboard reporting currency (ADR-0033, D2c), uppercase ISO-4217.
   *
   * Carried here for the same reason `configVersion` and the import pointer are:
   * `requireAnalyticsAccess` already loads this row on every analytics read, and
   * every revenue total the API returns is denominated in this currency. A
   * second query per revenue request to fetch one column would be a round trip
   * bought with nothing.
   */
  readonly reportingCurrency: string
}

/** A site's non-member-scoped basics, for a private-key-authenticated read. */
export async function getSiteBasics(db: Database, siteId: string): Promise<SiteBasics | null> {
  const [row] = await db
    .select({
      siteId: sites.id,
      slug: sites.slug,
      name: sites.name,
      status: sites.status,
      configVersion: sites.configVersion,
      publishedImportRunId: sites.publishedImportRunId,
      importCutoverDate: importRuns.cutoverDate,
      reportingCurrency: sites.reportingCurrency,
    })
    .from(sites)
    .leftJoin(importRuns, eq(importRuns.id, sites.publishedImportRunId))
    .where(eq(sites.id, siteId))
  return row ?? null
}
