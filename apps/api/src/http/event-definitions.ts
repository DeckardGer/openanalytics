import { ApiError } from '@openanalytics/contracts'
import {
  createEventDefinitionRequestSchema,
  createEventDefinitionVersionRequestSchema,
  publishEventDefinitionRequestSchema,
  MAX_PUBLISHED_RULES_PER_SITE,
} from '@openanalytics/domain'
import {
  archiveEventDefinition,
  createEventDefinition,
  getEventDefinition,
  getEventDefinitionVersion,
  listEventDefinitionVersions,
  listEventDefinitions,
  listPublishedRules,
  publishEventDefinition,
  rollbackEventDefinition,
  saveEventDefinitionVersion,
  type Database,
  type EventDefinitionRecord,
  type EventDefinitionVersionContent,
  type EventDefinitionVersionRecord,
} from '@openanalytics/postgres'
import { Hono } from 'hono'
import { requireCapability, siteMembership, type ApiVariables } from './middleware.ts'

/**
 * Dashboard-defined custom events (migration 0038; ADR-0034).
 *
 * Authorization follows the funnels surface it resembles (`funnels.ts`):
 * **reading is membership-only, including `viewer`** — a viewer already sees the
 * events these definitions name in every chart, so hiding the definition list
 * from them would withhold the labels, not the data. **Writing requires
 * `site:settings`** (owner and admin, never viewer), because a rule set is site
 * configuration of exactly the class that capability was drawn around.
 *
 * Two shapes here are not in the funnels surface, and both come from ADR-0034:
 *
 * - **Publish and rollback carry `expected_published_version`.** They are the
 *   only mutations on this API where two admins acting at once would otherwise
 *   silently overwrite each other, because the thing they contend for is a
 *   single pointer rather than a row each of them owns. A mismatch is a `409`
 *   naming the version that is actually live (D3).
 * - **Rollback creates a version rather than rewinding one.** The route reads
 *   as "publish v1 again" and the storage records it as a new v3 whose
 *   `source_version` is 1, because the tracker-config ETag epoch only ever
 *   increases (D3).
 */

type Env = { Variables: ApiVariables }

export interface EventDefinitionRoutesDeps {
  readonly db: Database
}

function definitionJson(definition: EventDefinitionRecord) {
  return {
    id: definition.id,
    site_id: definition.siteId,
    event_name: definition.eventName,
    status: definition.status,
    // Always present; `null` states "drafted but never published", which a
    // missing key would leave the client to infer.
    published_version: definition.publishedVersion,
    created_by_user_id: definition.createdByUserId,
    created_at: definition.createdAt.toISOString(),
    updated_at: definition.updatedAt.toISOString(),
    archived_at: definition.archivedAt?.toISOString() ?? null,
  }
}

function versionJson(version: EventDefinitionVersionRecord) {
  return {
    id: version.id,
    definition_id: version.definitionId,
    version: version.version,
    display_name: version.displayName,
    description: version.description,
    category: version.category,
    property_schema: version.propertySchema,
    display_template: version.displayTemplate,
    rules: version.rules,
    source_version: version.sourceVersion,
    created_by_user_id: version.createdByUserId,
    created_at: version.createdAt.toISOString(),
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

/** `apps/api` carries no zod dependency; the domain's schemas are its validators. */
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

/**
 * Whether a thrown error, or anything it wraps, names this database constraint.
 *
 * Drizzle raises an error whose message is the failed statement and hangs the
 * driver's error off `cause`, so the constraint name a route wants to branch on
 * is one or more levels down. Bounded rather than recursive-unbounded: a cycle
 * in a `cause` chain would otherwise hang the request.
 */
function hasConstraint(error: unknown, constraint: string): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (typeof current === 'object') {
      const record = current as { constraint?: unknown; message?: unknown; cause?: unknown }
      if (record.constraint === constraint) return true
      if (typeof record.message === 'string' && record.message.includes(constraint)) return true
      current = record.cause
      continue
    }
    return false
  }
  return false
}

/** Wire content (snake_case) to the repository's shape (camelCase). */
function toContent(body: {
  display_name: string
  description: string | null
  category: string | null
  property_schema: readonly { key: string; type: 'string' | 'number' | 'boolean' }[]
  display_template: string | null
  rules: readonly unknown[]
}): EventDefinitionVersionContent {
  return {
    displayName: body.display_name,
    description: body.description,
    category: body.category,
    propertySchema: [...body.property_schema],
    displayTemplate: body.display_template,
    rules: [...body.rules] as NonNullable<EventDefinitionVersionContent['rules']>,
  }
}

/**
 * The site-wide published-rule ceiling (ADR-0034, D2; flat 50 across plans).
 *
 * Checked at publish time rather than at save, and that is the point: a draft is
 * not in anyone's browser, so bounding drafts would refuse work that costs
 * nothing. What must be bounded is the set a visitor actually evaluates, which
 * is the union of every *published* definition's rules — a number no single
 * version row can see, which is why it is here and not a database CHECK.
 */
async function assertSiteRuleBudget(
  db: Database,
  input: { siteId: string; definitionId: string; incoming: number },
): Promise<void> {
  const published = await listPublishedRules(db, input.siteId)
  // The definition being published replaces its own currently-published rules
  // rather than adding to them.
  const others = published.filter((rule) => rule.definitionId !== input.definitionId).length
  const total = others + input.incoming
  if (total > MAX_PUBLISHED_RULES_PER_SITE) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `Publishing this version would put ${total} rules on the site; the limit is ${MAX_PUBLISHED_RULES_PER_SITE}.`,
      { details: { reason: 'rule_budget_exceeded', published: others, incoming: input.incoming } },
    )
  }
}

export function createEventDefinitionRoutes(deps: EventDefinitionRoutesDeps): Hono<Env> {
  const { db } = deps
  const app = new Hono<Env>()

  const base = '/sites/:site_id/event-definitions'

  // Membership guards every route; the mutations add the capability
  // individually, so reads stay open to a viewer.
  app.use(`${base}/*`, siteMembership(db))
  app.use(base, siteMembership(db))

  /** The definitions on a site. Archived excluded unless asked for. */
  app.get(base, async (c) => {
    const { siteId } = c.get('membership')
    const includeArchived = c.req.query('include_archived') === 'true'
    const items = await listEventDefinitions(db, siteId, { includeArchived })
    return c.json({ items: items.map(definitionJson) })
  })

  app.post(base, requireCapability('site:settings'), async (c) => {
    const actor = c.get('user')
    const { siteId } = c.get('membership')
    const body = parsed(
      createEventDefinitionRequestSchema.safeParse(await readJson(c)),
      'Invalid event definition',
    )

    let created
    try {
      created = await createEventDefinition(db, {
        siteId,
        eventName: body.event_name,
        content: toContent(body),
        createdByUserId: actor.id,
      })
    } catch (error) {
      // The unique key is the only way this insert fails on well-formed input,
      // and "that name is taken" is a 409 a dashboard can act on, not a 500.
      //
      // The constraint name is looked for down the `cause` chain, not in
      // `String(error)`: Drizzle wraps the driver error in one whose message is
      // the failed SQL, so the top-level string never contains it. A test asserts
      // the 409 rather than the 500 this used to be.
      if (hasConstraint(error, 'event_definitions_site_event_name_key')) {
        throw new ApiError(
          'EVENT_DEFINITION_NAME_TAKEN',
          'An event definition with this name already exists on this site',
          { details: { event_name: body.event_name } },
        )
      }
      throw error
    }

    return c.json(
      { ...definitionJson(created.definition), version: versionJson(created.version) },
      201,
    )
  })

  app.get(`${base}/:definition_id`, async (c) => {
    const { siteId } = c.get('membership')
    const definition = await getEventDefinition(db, {
      id: c.req.param('definition_id') as string,
      siteId,
    })
    if (!definition) throw new ApiError('NOT_FOUND', 'No such event definition on this site')
    return c.json(definitionJson(definition))
  })

  /** A definition's full version history, oldest first. */
  app.get(`${base}/:definition_id/versions`, async (c) => {
    const { siteId } = c.get('membership')
    const definitionId = c.req.param('definition_id') as string
    const definition = await getEventDefinition(db, { id: definitionId, siteId })
    if (!definition) throw new ApiError('NOT_FOUND', 'No such event definition on this site')

    const versions = await listEventDefinitionVersions(db, { definitionId, siteId })
    return c.json({
      published_version: definition.publishedVersion,
      items: versions.map(versionJson),
    })
  })

  app.get(`${base}/:definition_id/versions/:version`, async (c) => {
    const { siteId } = c.get('membership')
    const version = Number(c.req.param('version'))
    if (!Number.isInteger(version) || version < 1) {
      throw new ApiError('VALIDATION_FAILED', 'version must be a positive integer')
    }
    const found = await getEventDefinitionVersion(db, {
      definitionId: c.req.param('definition_id') as string,
      siteId,
      version,
    })
    if (!found) throw new ApiError('NOT_FOUND', 'No such version of this event definition')
    return c.json(versionJson(found))
  })

  /**
   * Saves a new draft version. The whole content is restated rather than
   * patched: a version is immutable and complete, and a partial update would
   * make "what did v3 contain" a question you answer by replaying v1 and v2.
   */
  app.post(`${base}/:definition_id/versions`, requireCapability('site:settings'), async (c) => {
    const actor = c.get('user')
    const { siteId } = c.get('membership')
    const body = parsed(
      createEventDefinitionVersionRequestSchema.safeParse(await readJson(c)),
      'Invalid event definition version',
    )
    const version = await saveEventDefinitionVersion(db, {
      id: c.req.param('definition_id') as string,
      siteId,
      content: toContent(body),
      actorUserId: actor.id,
    })
    if (!version) {
      throw new ApiError('NOT_FOUND', 'No live event definition with this id on this site')
    }
    return c.json(versionJson(version), 201)
  })

  app.post(`${base}/:definition_id/publish`, requireCapability('site:settings'), async (c) => {
    const actor = c.get('user')
    const { siteId } = c.get('membership')
    const definitionId = c.req.param('definition_id') as string
    const body = parsed(
      publishEventDefinitionRequestSchema.safeParse(await readJson(c)),
      'Invalid publish request',
    )

    const target = await getEventDefinitionVersion(db, {
      definitionId,
      siteId,
      version: body.version,
    })
    if (!target) throw new ApiError('NOT_FOUND', 'No such version of this event definition')
    await assertSiteRuleBudget(db, {
      siteId,
      definitionId,
      incoming: target.rules.length,
    })

    const outcome = await publishEventDefinition(db, {
      id: definitionId,
      siteId,
      version: body.version,
      expectedPublishedVersion: body.expected_published_version,
      actorUserId: actor.id,
    })

    if (!outcome.ok) {
      if (outcome.reason === 'not_found') {
        throw new ApiError('NOT_FOUND', 'No live event definition with this id on this site')
      }
      if (outcome.reason === 'unknown_version') {
        throw new ApiError('NOT_FOUND', 'No such version of this event definition')
      }
      throw new ApiError(
        'EVENT_DEFINITION_VERSION_CONFLICT',
        'Another change was published first',
        { details: { published_version: outcome.publishedVersion } },
      )
    }

    return c.json({
      published_version: outcome.publishedVersion,
      config_version: outcome.configVersion,
    })
  })

  /**
   * Rollback: publish an older version's content as a new one.
   *
   * `POST .../rollback` rather than a `PUT` of the pointer, because it is not
   * idempotent in the way a pointer write would be — calling it twice produces
   * two versions, and the response says which one is now live.
   */
  app.post(`${base}/:definition_id/rollback`, requireCapability('site:settings'), async (c) => {
    const actor = c.get('user')
    const { siteId } = c.get('membership')
    const definitionId = c.req.param('definition_id') as string
    const body = parsed(
      publishEventDefinitionRequestSchema.safeParse(await readJson(c)),
      'Invalid rollback request',
    )

    const source = await getEventDefinitionVersion(db, {
      definitionId,
      siteId,
      version: body.version,
    })
    if (!source) throw new ApiError('NOT_FOUND', 'No such version of this event definition')
    await assertSiteRuleBudget(db, { siteId, definitionId, incoming: source.rules.length })

    const outcome = await rollbackEventDefinition(db, {
      id: definitionId,
      siteId,
      toVersion: body.version,
      expectedPublishedVersion: body.expected_published_version,
      actorUserId: actor.id,
    })

    if (!outcome.ok) {
      if (outcome.reason === 'not_found') {
        throw new ApiError('NOT_FOUND', 'No live event definition with this id on this site')
      }
      if (outcome.reason === 'unknown_version') {
        throw new ApiError('NOT_FOUND', 'No such version of this event definition')
      }
      throw new ApiError(
        'EVENT_DEFINITION_VERSION_CONFLICT',
        'Another change was published first',
        { details: { published_version: outcome.publishedVersion } },
      )
    }

    return c.json({
      published_version: outcome.version.version,
      source_version: outcome.version.sourceVersion,
      config_version: outcome.configVersion,
      version: versionJson(outcome.version),
    })
  })

  /**
   * Archive — the delete, kept soft, and the same replay semantics as a funnel:
   * a second `DELETE` answers 204 because archiving states an intent about the
   * definition's place in the list rather than performing a one-shot act.
   *
   * Archiving also unpublishes, so the rules stop being served.
   */
  app.delete(`${base}/:definition_id`, requireCapability('site:settings'), async (c) => {
    const actor = c.get('user')
    const { siteId } = c.get('membership')
    const { archived } = await archiveEventDefinition(db, {
      id: c.req.param('definition_id') as string,
      siteId,
      actorUserId: actor.id,
    })
    if (!archived) throw new ApiError('NOT_FOUND', 'No such event definition on this site')
    return c.body(null, 204)
  })

  return app
}
