import { randomBytes } from 'node:crypto'
import { and, count, desc, eq } from 'drizzle-orm'
import type { Database } from '../client.ts'
import { writeAudit } from './audit.ts'
import { importRuns } from '../schema/imports.ts'
import { sites, type SiteStatus } from '../schema/sites.ts'
import { widgets, type WidgetRangeColumn, type WidgetSurfaceColumn } from '../schema/widgets.ts'

/**
 * Embeddable widget configuration (migration 0048; ADR-0045).
 *
 * A row here is configuration and never an answer: nothing in this module reads
 * `events_raw` or reaches the query gateway. What a widget publishes is computed
 * on the anonymous read through the existing public read pipeline (ADR-0043
 * D10), with the parameters taken from one of these rows.
 *
 * Every function takes `siteId` and puts it in the `WHERE`, including the ones
 * that already hold a globally unique widget id. That is the rule `getFunnel`,
 * `revokeApiKey` and `revokeInvite` follow, and it matters more here than
 * anywhere: the widget id is a *public* string that sits in the HTML of a page
 * anyone can view, so a management route that resolved it without the site would
 * let any member of any site read and revoke a widget they found on the web.
 */

/** One widget's stored configuration. */
export interface WidgetRecord {
  readonly id: string
  readonly siteId: string
  readonly surface: WidgetSurfaceColumn
  readonly title: string | null
  /** Null exactly on a `realtime` widget, which has no window. */
  readonly range: WidgetRangeColumn | null
  /** Null on every surface that is not a breakdown. */
  readonly limit: number | null
  readonly allowedOrigins: readonly string[]
  readonly enabled: boolean
  readonly createdByUserId: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** Explicit projection rather than `select()`, so a column added later does not
 * silently widen every widget response. `row_limit` is aliased back to the
 * wire's `limit` here, which is the one place the column name's reserved-word
 * detour is visible. */
const widgetColumns = {
  id: widgets.id,
  siteId: widgets.siteId,
  surface: widgets.surface,
  title: widgets.title,
  range: widgets.range,
  limit: widgets.rowLimit,
  allowedOrigins: widgets.allowedOrigins,
  enabled: widgets.enabled,
  createdByUserId: widgets.createdByUserId,
  createdAt: widgets.createdAt,
  updatedAt: widgets.updatedAt,
}

/**
 * A widget's opaque public id (ADR-0045, D1).
 *
 * `generateShareSlug`'s idiom with a `w` in front of it, and the same stated
 * property: 96 random bits in base36, **opaque by design — it must not encode
 * the site id**. It is the widget's whole credential, so it is minted from
 * `randomBytes` and never from anything derivable (a counter, a hash of the
 * site, a timestamp), and it is the management handle as well, so nothing has to
 * be translated between the dashboard's list and the embed snippet.
 *
 * There is no rotation. Rotating a widget id invalidates a snippet already
 * pasted into somebody's HTML, which is a delete and a create with extra steps.
 */
export function generateWidgetId(random: () => Buffer = () => randomBytes(12)): string {
  const token = BigInt(`0x${random().toString('hex')}`).toString(36)
  // Sliced to the contract's 32-character ceiling, exactly as the share slug is.
  return `w${token}`.slice(0, 32)
}

/**
 * A site's widgets, newest first.
 *
 * `created_at` descending with `id` as the tie-break, so two widgets created in
 * the same millisecond do not swap places between two reads of an unchanged
 * list. There is no archived state to exclude: a widget delete is hard
 * (ADR-0045, D13), because it is the revocation of a public credential.
 */
export async function listWidgets(db: Database, siteId: string): Promise<WidgetRecord[]> {
  return db
    .select(widgetColumns)
    .from(widgets)
    .where(eq(widgets.siteId, siteId))
    .orderBy(desc(widgets.createdAt), desc(widgets.id))
}

/** One widget, or null. Site-scoped, so a widget id belonging to another site
 * reads as absent rather than as a permission error. */
export async function getWidget(
  db: Database,
  input: { readonly id: string; readonly siteId: string },
): Promise<WidgetRecord | null> {
  const [row] = await db
    .select(widgetColumns)
    .from(widgets)
    .where(and(eq(widgets.id, input.id), eq(widgets.siteId, input.siteId)))
    .limit(1)
  return row ?? null
}

/**
 * How many widgets a site has, for the flat cap of fifty (ADR-0045, D9).
 *
 * A `count` rather than `listWidgets(...).length`: the cap is checked on every
 * create and the rows themselves are not wanted, so fetching up to fifty
 * configurations to measure one integer would be work done for nothing.
 */
export async function countWidgets(db: Database, siteId: string): Promise<number> {
  const [row] = await db.select({ total: count() }).from(widgets).where(eq(widgets.siteId, siteId))
  return row?.total ?? 0
}

/**
 * A widget and everything the anonymous read needs from its site, in one row
 * (ADR-0045, CP2).
 *
 * The site half is exactly `ResolvedPublicShare`'s, plus the two ADR-0044
 * columns a server-side range needs. Each field is here because the public read
 * path already requires it and has nowhere else to get it:
 *
 * - `siteStatus` is §20's billing gate — the share is closed while
 *   `suspended`, and so is a widget;
 * - `configVersion` is the gateway's `cache_epoch` (ADR-0030 D6), so a lifecycle
 *   change makes every cached answer unreachable;
 * - `publishedImportRunId` / `importCutoverDate` are the published import
 *   (ADR-0032 D2b) — an embed of a migrated site shows the same history its
 *   owner sees rather than a chart starting the day the tracker was installed;
 * - `reportingTimezone` and `firstEventAt` are the range resolver's two inputs
 *   (ADR-0045 D10): a widget has no viewer whose clock could be asked, and
 *   `all` anchors at the first event rather than at a creation date ADR-0044 D7
 *   keeps off the public surface.
 */
export interface ResolvedPublicWidget {
  readonly id: string
  readonly siteId: string
  readonly surface: WidgetSurfaceColumn
  readonly title: string | null
  readonly range: WidgetRangeColumn | null
  readonly limit: number | null
  readonly allowedOrigins: readonly string[]
  readonly enabled: boolean
  readonly siteStatus: SiteStatus
  readonly configVersion: number
  readonly publishedImportRunId: string | null
  readonly importCutoverDate: string | null
  readonly reportingTimezone: string | null
  readonly firstEventAt: Date | null
}

/**
 * Resolves a public widget id to its configuration and its site's read facts.
 * Null when no such widget exists.
 *
 * **Deliberately not site-scoped, and it is the one function here that is not.**
 * Every other read in this module puts `siteId` in the `WHERE` because a widget
 * id found on the web must not let a member of another site act on it; this one
 * *is* the anonymous door, addressed by the id alone, and the site is what it
 * resolves rather than what it is given. It returns configuration only — no
 * counts, no slug, no name — and the route decides what reaches the wire.
 *
 * It makes **no authorization decision**. `enabled` and `siteStatus` come back
 * as facts and the route collapses them into one indistinguishable `404`
 * (ADR-0045 D7), exactly as `resolvePublicShare` leaves the three-condition
 * predicate to `isSurfaceShared`. Answering `null` for a disabled widget here
 * would put half the gate in a repository and half in a route, which is how the
 * two drift apart.
 *
 * One query, one round trip: `sites` is inner-joined (a widget row cannot
 * outlive its site — the FK cascades), and `import_runs` is left-joined for the
 * cutover date exactly as the share resolution does it.
 */
export async function resolvePublicWidget(
  db: Database,
  widgetId: string,
): Promise<ResolvedPublicWidget | null> {
  const [row] = await db
    .select({
      // Written out rather than spreading `widgetColumns`: this is the anonymous
      // path, and `created_by_user_id` — a real user id — has no business being
      // fetched on it at all, let alone being one route bug from the wire.
      id: widgets.id,
      siteId: widgets.siteId,
      surface: widgets.surface,
      title: widgets.title,
      range: widgets.range,
      limit: widgets.rowLimit,
      allowedOrigins: widgets.allowedOrigins,
      enabled: widgets.enabled,
      siteStatus: sites.status,
      configVersion: sites.configVersion,
      publishedImportRunId: sites.publishedImportRunId,
      importCutoverDate: importRuns.cutoverDate,
      reportingTimezone: sites.reportingTimezone,
      firstEventAt: sites.firstEventAt,
    })
    .from(widgets)
    .innerJoin(sites, eq(sites.id, widgets.siteId))
    .leftJoin(importRuns, eq(importRuns.id, sites.publishedImportRunId))
    .where(eq(widgets.id, widgetId))
    .limit(1)
  return row ?? null
}

export interface CreateWidgetInput {
  readonly siteId: string
  readonly surface: WidgetSurfaceColumn
  readonly title?: string | null
  readonly range: WidgetRangeColumn | null
  readonly limit: number | null
  readonly allowedOrigins: readonly string[]
  readonly enabled?: boolean
  readonly createdByUserId?: string
  /** Injectable so a test can pin an id; production always mints one. */
  readonly id?: string
}

export async function createWidget(db: Database, input: CreateWidgetInput): Promise<WidgetRecord> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(widgets)
      .values({
        id: input.id ?? generateWidgetId(),
        siteId: input.siteId,
        surface: input.surface,
        title: input.title ?? null,
        range: input.range,
        rowLimit: input.limit,
        allowedOrigins: [...input.allowedOrigins],
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.createdByUserId === undefined ? {} : { createdByUserId: input.createdByUserId }),
      })
      .returning(widgetColumns)
    if (!row) throw new Error('widget insert returned no row')

    await writeAudit(tx, {
      action: 'site.widget.created',
      actorUserId: input.createdByUserId ?? null,
      actorType: input.createdByUserId ? 'user' : 'system',
      siteId: input.siteId,
      targetType: 'widget',
      targetId: row.id,
      // The surface and the origin list, by ADR-0045 D13: the trail records what
      // a change *published* rather than only that a change happened. Both are
      // site-owned configuration the operator typed — a public surface name and
      // the operator's own page origins — and neither is visitor data.
      metadata: {
        surface: input.surface,
        allowed_origins: [...input.allowedOrigins],
        range: input.range,
        limit: input.limit,
      },
    })
    return row
  })
}

export interface UpdateWidgetInput {
  readonly id: string
  readonly siteId: string
  readonly title?: string | null
  readonly range?: WidgetRangeColumn | null
  readonly limit?: number | null
  readonly allowedOrigins?: readonly string[]
  readonly enabled?: boolean
  readonly actorUserId?: string
}

/**
 * Applies a partial update and returns the updated widget, or null when no
 * widget with this id exists on this site.
 *
 * `surface` is deliberately not an input (ADR-0045, D2). It is the one property
 * whose change alters what is published rather than how much of it, and this
 * signature is the last line of that defence: a route bug that let the field
 * through would have nowhere to put it.
 */
export async function updateWidget(
  db: Database,
  input: UpdateWidgetInput,
): Promise<WidgetRecord | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(widgets)
      .set({
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.range === undefined ? {} : { range: input.range }),
        ...(input.limit === undefined ? {} : { rowLimit: input.limit }),
        ...(input.allowedOrigins === undefined
          ? {}
          : { allowedOrigins: [...input.allowedOrigins] }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        updatedAt: new Date(),
      })
      .where(and(eq(widgets.id, input.id), eq(widgets.siteId, input.siteId)))
      .returning(widgetColumns)
    if (!row) return null

    await writeAudit(tx, {
      action: 'site.widget.updated',
      actorUserId: input.actorUserId ?? null,
      actorType: input.actorUserId ? 'user' : 'system',
      siteId: input.siteId,
      targetType: 'widget',
      targetId: input.id,
      metadata: {
        // The surface is unchanged by definition, and it is recorded anyway: an
        // operator reading the trail needs to know what was published without
        // joining back to a row that may since have been deleted.
        surface: row.surface,
        allowed_origins: [...row.allowedOrigins],
        fields: (['title', 'range', 'limit', 'allowedOrigins', 'enabled'] as const).filter(
          (field) => input[field] !== undefined,
        ),
      },
    })
    return row
  })
}

/**
 * Deletes a widget. Returns whether one existed on this site to delete.
 *
 * **Hard, and not idempotent** — deliberately unlike `archiveFunnel`. That one
 * chose a soft archive and a replayable `204` because a saved chart may be
 * linked and must not dangle, and it said in the same breath that this was
 * unlike "an API-key or invite revocation". A widget delete *is* a revocation of
 * a public credential: the id is gone from the HTML of nobody's page, and a
 * `204` for an id that no longer exists tells an operator checking whether they
 * revoked the right thing precisely nothing.
 *
 * The audit row is written before the transaction ends, from the row that was
 * removed, so the trail still records the surface and origins a deleted widget
 * was publishing.
 */
export async function deleteWidget(
  db: Database,
  input: { readonly id: string; readonly siteId: string; readonly actorUserId?: string },
): Promise<{ deleted: boolean }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .delete(widgets)
      .where(and(eq(widgets.id, input.id), eq(widgets.siteId, input.siteId)))
      .returning({ surface: widgets.surface, allowedOrigins: widgets.allowedOrigins })
    if (!row) return { deleted: false }

    await writeAudit(tx, {
      action: 'site.widget.deleted',
      actorUserId: input.actorUserId ?? null,
      actorType: input.actorUserId ? 'user' : 'system',
      siteId: input.siteId,
      targetType: 'widget',
      targetId: input.id,
      metadata: { surface: row.surface, allowed_origins: [...row.allowedOrigins] },
    })
    return { deleted: true }
  })
}
