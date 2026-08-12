import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { createdAt, idColumn, instant, primaryId, updatedAt } from './_shared.ts'
import { users } from './auth.ts'

/**
 * Sites, domains, membership and invitations (mirror of migrations 0002, 0008
 * and 0019).
 *
 * The ownership-invariant constraints (the owner is an accepted owner member;
 * at least one owner per site) are not here — they are cross-row predicates
 * added with their tests in a later migration (docs snapshot 02 §6).
 *
 * The lifecycle/ingest columns (migration 0008) drive the ingest fencing
 * (D-210) and config-cache invalidation. `suspended` is a state nothing in the
 * product sets on its own; every surface refuses a suspended site.
 *
 * The columns the cloud stream adds to this table are declared beside their
 * readers, in `src/cloud/schema/sites.ts`: they exist only on a database whose
 * cloud stream has been applied, and a product query that could name one would
 * be a query that fails on every self-hosted install.
 */

export type SiteRole = 'owner' | 'admin' | 'viewer'
export type SiteStatus = 'active' | 'suspended' | 'deleting' | 'deleted'
export type InviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired'

export const sites = pgTable(
  'sites',
  {
    id: primaryId(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    status: text('status').$type<SiteStatus>().notNull().default('active'),
    ownerUserId: idColumn('owner_user_id')
      .notNull()
      .references(() => users.id),
    // Lifecycle / ingest fields (migration 0008).
    ingestGeneration: integer('ingest_generation').notNull().default(1),
    configVersion: integer('config_version').notNull().default(1),
    suspendedAt: instant('suspended_at'),
    // The install-verified signal (migration 0019, ADR-0027): when this site's
    // first event reached the pipeline. NULL until one has, written once by the
    // batch worker and never moved afterwards.
    firstEventAt: instant('first_event_at'),
    // **The import pointer** (migration 0023, ADR-0032 D3): which import run's
    // staged rows this site's analytics reads union in. NULL means none is
    // published, which the read path binds as the nil UUID so the imported
    // branch of every query is simply empty. Declared as a plain column rather
    // than with a `.references()` because the FK is a cycle — `import_runs`
    // references `sites` — and Drizzle cannot express both directions without
    // a circular module import. The migration owns the constraint (ON DELETE
    // SET NULL), which is where the DDL truth lives anyway (ADR-0006).
    publishedImportRunId: idColumn('published_import_run_id'),
    // The dashboard currency (migration 0026, ADR-0033 D2c). Every revenue fact
    // keeps its original currency and amounts untouched; this chooses what the
    // reporting amounts beside them are materialized into. Changing it is a
    // re-materialization of the facts, never a re-ingest.
    reportingCurrency: text('reporting_currency').notNull().default('USD'),
    // The site's own reporting clock (migration 0039, ADR-0044 D4) — an
    // *override* layered on the user preference ADR-0026 chose, never a
    // replacement for it. Nullable with no default: NULL means "not configured;
    // the viewer's clock applies", and a stored 'UTC' would be
    // indistinguishable from an owner who genuinely chose UTC. Read by the
    // public site-identity surface; no private query reads it.
    reportingTimezone: text('reporting_timezone'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('sites_slug_key').on(t.slug),
    index('sites_owner_idx').on(t.ownerUserId),
    // The one-unfunded-site-per-owner partial unique index is a CLOUD invariant
    // (cloud migration 0007) and is not mirrored here — the cloud SQL owns it.
    // ISO-4217 shape only. Whether ECB publishes a rate for the code is decided
    // per transaction (`conversion_source = 'unavailable'` is visible, never a
    // silent zero), not by this constraint.
    check('sites_reporting_currency_format', sql`${t.reportingCurrency} ~ '^[A-Z]{3}$'`),
    // A literal mirror of `users_timezone_format` (migration 0017): shape and
    // length only, so a direct SQL write cannot plant an offset zone such as
    // `+05:00` — which `Intl` accepts and this product does not (ADR-0026). The
    // IANA question is answered on write by `isValidTimezone`.
    check(
      'sites_reporting_timezone_format',
      sql`${t.reportingTimezone} IS NULL OR (char_length(${t.reportingTimezone}) BETWEEN 1 AND 64 AND ${t.reportingTimezone} ~ '^[A-Za-z][A-Za-z0-9._+-]*(/[A-Za-z0-9._+-]+)*$')`,
    ),
  ],
)

export const siteDomains = pgTable(
  'site_domains',
  {
    id: primaryId(),
    siteId: idColumn('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('site_domains_site_domain_key').on(t.siteId, sql`lower(${t.domain})`)],
)

export const siteMembers = pgTable(
  'site_members',
  {
    id: primaryId(),
    siteId: idColumn('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    userId: idColumn('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<SiteRole>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique('site_members_site_user_key').on(t.siteId, t.userId)],
)

export const siteInvites = pgTable(
  'site_invites',
  {
    id: primaryId(),
    siteId: idColumn('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').$type<SiteRole>().notNull(),
    tokenHash: text('token_hash').notNull(),
    invitedByUserId: idColumn('invited_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    status: text('status').$type<InviteStatus>().notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    acceptedAt: instant('accepted_at'),
  },
  (t) => [
    uniqueIndex('site_invites_token_hash_key').on(t.tokenHash),
    uniqueIndex('site_invites_pending_key')
      .on(t.siteId, sql`lower(${t.email})`)
      .where(sql`status = 'pending'`),
  ],
)
