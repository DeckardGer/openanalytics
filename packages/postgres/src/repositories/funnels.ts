import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { Database } from '../client.ts'
import { writeAudit } from './audit.ts'
import { funnels, type FunnelScope } from '../schema/funnels.ts'

/**
 * Stored funnel definitions (migration 0024).
 *
 * A row here is a saved question, never an answer: nothing in this module reads
 * `events_raw` or reaches the query gateway. Computing a stored funnel is still
 * `GET /v1/sites/{site_id}/analytics/funnel` with the steps read from one of
 * these rows (ADR-0012), and that endpoint is untouched by this table.
 *
 * Every function takes `siteId` and puts it in the `WHERE`. A caller authorized
 * on one site must not be able to read or write another site's funnel by holding
 * its id — the same rule `revokeApiKey` and `revokeInvite` enforce, and the
 * reason none of these take an id alone.
 */

export interface FunnelDefinition {
  readonly id: string
  readonly siteId: string
  readonly name: string
  /** Ordered step keys: a page path or a custom event name each. */
  readonly steps: readonly string[]
  readonly scope: FunnelScope
  readonly windowMs: number
  readonly createdByUserId: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
  /** Null for a live definition; set once it has been archived. */
  readonly archivedAt: Date | null
}

/** Explicit projection rather than `select()`, so a column added later does not
 * silently widen every funnel response. */
const definitionColumns = {
  id: funnels.id,
  siteId: funnels.siteId,
  name: funnels.name,
  steps: funnels.steps,
  scope: funnels.scope,
  windowMs: funnels.windowMs,
  createdByUserId: funnels.createdByUserId,
  createdAt: funnels.createdAt,
  updatedAt: funnels.updatedAt,
  archivedAt: funnels.archivedAt,
}

export interface ListFunnelsOptions {
  /** Include archived definitions. Default false — archived is the delete. */
  readonly includeArchived?: boolean
}

/**
 * A site's funnel definitions, newest first.
 *
 * Archived rows are excluded unless asked for: the funnels screen is a list of
 * things you can run, and an archived definition is not one of them. `created_at`
 * descending with `id` as the tie-break, so two funnels saved in the same
 * millisecond do not swap places between two reads of an unchanged list.
 */
export async function listFunnels(
  db: Database,
  siteId: string,
  options: ListFunnelsOptions = {},
): Promise<FunnelDefinition[]> {
  const scoped = options.includeArchived
    ? eq(funnels.siteId, siteId)
    : and(eq(funnels.siteId, siteId), isNull(funnels.archivedAt))

  return db
    .select(definitionColumns)
    .from(funnels)
    .where(scoped)
    .orderBy(desc(funnels.createdAt), desc(funnels.id))
}

/** One definition, or null. Site-scoped, so a funnel id from another site reads
 * as absent rather than as a permission error. */
export async function getFunnel(
  db: Database,
  input: { readonly id: string; readonly siteId: string },
): Promise<FunnelDefinition | null> {
  const [row] = await db
    .select(definitionColumns)
    .from(funnels)
    .where(and(eq(funnels.id, input.id), eq(funnels.siteId, input.siteId)))
    .limit(1)
  return row ?? null
}

export interface CreateFunnelInput {
  readonly siteId: string
  readonly name: string
  readonly steps: readonly string[]
  readonly scope: FunnelScope
  readonly windowMs: number
  readonly createdByUserId?: string
}

export async function createFunnel(
  db: Database,
  input: CreateFunnelInput,
): Promise<FunnelDefinition> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(funnels)
      .values({
        siteId: input.siteId,
        name: input.name,
        steps: [...input.steps],
        scope: input.scope,
        windowMs: input.windowMs,
        ...(input.createdByUserId === undefined ? {} : { createdByUserId: input.createdByUserId }),
      })
      .returning(definitionColumns)
    if (!row) throw new Error('funnel insert returned no row')

    await writeAudit(tx, {
      action: 'funnel.created',
      actorUserId: input.createdByUserId ?? null,
      actorType: input.createdByUserId ? 'user' : 'system',
      siteId: input.siteId,
      targetType: 'funnel',
      targetId: row.id,
      // Step keys are site-owned configuration — a page path or an event name
      // the site's own operator typed — not visitor data, so the shape of the
      // change is recordable. The step *values* are not: they are not needed to
      // answer "who changed this funnel, and when".
      metadata: { scope: input.scope, stepCount: input.steps.length },
    })
    return row
  })
}

export interface UpdateFunnelInput {
  readonly id: string
  readonly siteId: string
  readonly name?: string
  readonly steps?: readonly string[]
  readonly scope?: FunnelScope
  readonly windowMs?: number
  readonly actorUserId?: string
}

/**
 * Applies a partial update and returns the updated definition, or null when no
 * live funnel with this id exists on this site.
 *
 * An archived definition is not updatable: editing something that has been taken
 * out of the list would be a change nobody can see, and it would let an archived
 * funnel be quietly repurposed. Restoring is a separate act this checkpoint does
 * not offer.
 */
export async function updateFunnel(
  db: Database,
  input: UpdateFunnelInput,
): Promise<FunnelDefinition | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(funnels)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.steps === undefined ? {} : { steps: [...input.steps] }),
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(input.windowMs === undefined ? {} : { windowMs: input.windowMs }),
        updatedAt: new Date(),
      })
      .where(
        and(eq(funnels.id, input.id), eq(funnels.siteId, input.siteId), isNull(funnels.archivedAt)),
      )
      .returning(definitionColumns)
    if (!row) return null

    await writeAudit(tx, {
      action: 'funnel.updated',
      actorUserId: input.actorUserId ?? null,
      actorType: input.actorUserId ? 'user' : 'system',
      siteId: input.siteId,
      targetType: 'funnel',
      targetId: input.id,
      metadata: {
        fields: (['name', 'steps', 'scope', 'windowMs'] as const).filter(
          (field) => input[field] !== undefined,
        ),
      },
    })
    return row
  })
}

/**
 * Archives a definition. Returns whether a funnel with this id exists on this
 * site at all.
 *
 * **Idempotent, deliberately unlike `revokeApiKey`/`revokeInvite`.** Those refuse
 * a replay because a credential revocation is a one-shot security act, and
 * answering "revoked" twice would leave the operator unsure whether their revoke
 * was the one that took effect. Archiving a saved chart is not that: the caller's
 * intent is a state ("this funnel is off my list"), not an event, and the honest
 * answer to "archive it again" is that it is archived. So a second call succeeds,
 * and `archived_at` keeps its original value via `COALESCE` — the instant the
 * funnel actually left the list, not the last time someone clicked.
 */
export async function archiveFunnel(
  db: Database,
  input: { readonly id: string; readonly siteId: string; readonly actorUserId?: string },
): Promise<{ archived: boolean }> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(funnels)
      .set({
        archivedAt: sql`COALESCE(${funnels.archivedAt}, now())`,
        updatedAt: new Date(),
      })
      .where(and(eq(funnels.id, input.id), eq(funnels.siteId, input.siteId)))
      .returning({ id: funnels.id })
    if (updated.length === 0) return { archived: false }

    await writeAudit(tx, {
      action: 'funnel.archived',
      actorUserId: input.actorUserId ?? null,
      actorType: input.actorUserId ? 'user' : 'system',
      siteId: input.siteId,
      targetType: 'funnel',
      targetId: input.id,
    })
    return { archived: true }
  })
}
