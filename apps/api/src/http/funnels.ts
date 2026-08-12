import { ApiError } from '@openanalytics/contracts'
import { createFunnelRequestSchema, updateFunnelRequestSchema } from '@openanalytics/domain'
import {
  archiveFunnel,
  createFunnel,
  listFunnels,
  updateFunnel,
  type Database,
  type FunnelDefinition,
} from '@openanalytics/postgres'
import { Hono } from 'hono'
import { requireCapability, siteMembership, type ApiVariables } from './middleware.ts'

/**
 * Stored funnel definitions: the saved half of the funnel feature (migration
 * 0024).
 *
 * This surface persists definitions and nothing else. Running a funnel is still
 * `GET /v1/sites/{site_id}/analytics/funnel` with these steps — the ad-hoc
 * compute endpoint from M8 (ADR-0012), which is untouched here — so no route in
 * this file reaches the query gateway or reads an event.
 *
 * Authorization follows the surface it resembles. **Reading is membership-only**,
 * including `viewer`: a viewer may already compute an ad-hoc funnel, so hiding
 * the saved list from them would withhold the names, not the data. **Writing
 * requires `site:settings`** (owner and admin, never viewer). A saved funnel is
 * site configuration of exactly the class that capability was drawn around
 * (`packages/domain/src/authz.ts`): it is not destructive and it exposes no
 * personal data, which is what keeps it out of the owner-only set.
 */

type Env = { Variables: ApiVariables }

function funnelJson(funnel: FunnelDefinition) {
  return {
    id: funnel.id,
    name: funnel.name,
    steps: funnel.steps,
    scope: funnel.scope,
    window_ms: funnel.windowMs,
    created_by_user_id: funnel.createdByUserId,
    created_at: funnel.createdAt.toISOString(),
    updated_at: funnel.updatedAt.toISOString(),
    // Always present; `null` is the statement "this definition is live", which a
    // missing key would leave the client to infer.
    archived_at: funnel.archivedAt?.toISOString() ?? null,
  }
}

async function readJson(c: {
  req: { json: () => Promise<unknown> }
}): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json()
    if (typeof body !== 'object' || body === null) throw new Error('not an object')
    return body as Record<string, unknown>
  } catch {
    throw new ApiError('VALIDATION_FAILED', 'A JSON request body is required')
  }
}

/**
 * A `safeParse` outcome, described structurally.
 *
 * `apps/api` deliberately carries no zod dependency — the contract's and the
 * domain's schemas are the API's validators (the rule `analytics.ts` states) —
 * so the helper below is typed against the shape of a result rather than against
 * zod's own types.
 */
type ParseResult<T> =
  | { readonly success: true; readonly data: T }
  | {
      readonly success: false
      readonly error: {
        readonly issues: readonly {
          readonly path: readonly PropertyKey[]
          readonly message: string
        }[]
      }
    }

/**
 * Turns a schema failure into the `details.issues` shape, matching the analytics
 * surface's `parseFunnel` — these bodies are validated by the same domain
 * module, so they report failures the same way.
 */
function parsed<T>(result: ParseResult<T>, message: string): T {
  if (!result.success) {
    throw new ApiError('VALIDATION_FAILED', message, {
      details: {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.') || '(root)',
          message: issue.message,
        })),
      },
    })
  }
  return result.data
}

export function createFunnelRoutes(deps: { db: Database }): Hono<Env> {
  const { db } = deps
  const app = new Hono<Env>()

  const base = '/sites/:site_id/funnels'

  // Membership guards every funnel route; the mutations add the capability
  // individually, so the read stays open to a viewer.
  app.use(`${base}/*`, siteMembership(db))
  app.use(base, siteMembership(db))

  /**
   * The saved definitions on a site.
   *
   * Archived definitions are excluded unless `include_archived=true`, because
   * archiving is how a funnel is deleted and the default list is the list of
   * funnels you can run.
   */
  app.get(base, async (c) => {
    const { siteId } = c.get('membership')
    const includeArchived = c.req.query('include_archived') === 'true'
    const items = await listFunnels(db, siteId, { includeArchived })
    return c.json({ items: items.map(funnelJson) })
  })

  app.post(base, requireCapability('site:settings'), async (c) => {
    const actor = c.get('user')
    const { siteId } = c.get('membership')
    const body = parsed(
      createFunnelRequestSchema.safeParse(await readJson(c)),
      'Invalid funnel definition',
    )
    const created = await createFunnel(db, {
      siteId,
      name: body.name,
      steps: body.steps,
      scope: body.scope,
      windowMs: body.window_ms,
      createdByUserId: actor.id,
    })
    return c.json(funnelJson(created), 201)
  })

  app.patch(`${base}/:funnel_id`, requireCapability('site:settings'), async (c) => {
    const actor = c.get('user')
    const { siteId } = c.get('membership')
    const body = parsed(
      updateFunnelRequestSchema.safeParse(await readJson(c)),
      'Invalid funnel definition',
    )
    const updated = await updateFunnel(db, {
      id: c.req.param('funnel_id') as string,
      siteId,
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.steps === undefined ? {} : { steps: body.steps }),
      ...(body.scope === undefined ? {} : { scope: body.scope }),
      ...(body.window_ms === undefined ? {} : { windowMs: body.window_ms }),
      actorUserId: actor.id,
    })
    if (!updated) throw new ApiError('NOT_FOUND', 'No live funnel with this id on this site')
    return c.json(funnelJson(updated))
  })

  /**
   * Archive — the delete, kept soft.
   *
   * `DELETE` on the resource with a bodiless 204 is the shape every other
   * removal on this API uses (api keys, invites, members), so a saved funnel is
   * not the one resource that needs a verb sub-path. What differs is the replay:
   * a second `DELETE` answers 204 rather than 404, because archiving states an
   * intent about the funnel's place in the list rather than performing a
   * one-shot security act. See `archiveFunnel` for the full reasoning. 404 is
   * still the answer when no funnel with this id exists on this site.
   */
  app.delete(`${base}/:funnel_id`, requireCapability('site:settings'), async (c) => {
    const actor = c.get('user')
    const { siteId } = c.get('membership')
    const { archived } = await archiveFunnel(db, {
      id: c.req.param('funnel_id') as string,
      siteId,
      actorUserId: actor.id,
    })
    if (!archived) throw new ApiError('NOT_FOUND', 'No such funnel on this site')
    return c.body(null, 204)
  })

  return app
}
