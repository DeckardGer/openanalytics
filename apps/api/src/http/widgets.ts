import { ApiError } from '@openanalytics/contracts'
import {
  checkWidgetPatch,
  createWidgetRequestSchema,
  resolveWidgetLimit,
  updateWidgetRequestSchema,
  MAX_WIDGETS_PER_SITE,
} from '@openanalytics/domain'
import {
  countWidgets,
  createWidget,
  deleteWidget,
  getWidget,
  listWidgets,
  updateWidget,
  type Database,
  type WidgetRecord,
} from '@openanalytics/postgres'
import { Hono } from 'hono'
import { requireCapability, siteMembership, type ApiVariables } from './middleware.ts'

/**
 * Embeddable widget configuration (ADR-0045, D13; migration 0048).
 *
 * Five operations in the funnels CRUD's shape, and the same authorization split:
 * **reads are membership-only, including `viewer`** — seeing which widgets exist
 * is part of knowing what a site publishes, and a viewer who could not see the
 * list could not tell that one of the site's numbers is on a public page —
 * while **every mutation requires `site:settings`**, the capability that already
 * governs the public share, the site's domain allowlist and its clock.
 *
 * Nothing here computes. What a widget publishes is read anonymously at
 * `GET /v1/widget/{widget_id}` (CP2) through the existing public read pipeline,
 * so no route in this file reaches the query gateway or reads an event.
 *
 * Two places this deliberately differs from the funnels surface it otherwise
 * mirrors, both from ADR-0045:
 *
 * - **`surface` cannot be patched** (D2). It is the one property whose change
 *   alters *what is published* rather than how much of it, on a page that
 *   already carries the old embed.
 * - **`DELETE` is not idempotent** (D13). A widget delete is the revocation of a
 *   public credential, and a `204` for an id that no longer exists tells an
 *   operator checking whether they revoked the right thing nothing at all.
 */

type Env = { Variables: ApiVariables }

export interface WidgetRoutesDeps {
  readonly db: Database
  /**
   * The api's own public origin, e.g. `https://api.getopen.so`, with no trailing
   * slash.
   *
   * `embed_url` is built from this and **never from `c.req.url`** (ADR-0045,
   * D13): behind Caddy the request URL carries the internal `http://` scheme and
   * the internal host, and a snippet a customer pastes into their HTML is the
   * worst possible place to discover that — it is the `b54c03d` lesson from the
   * M16 deploy, arriving in someone else's page instead of in our logs.
   *
   * The embed document is the api's own (`GET /embed/{widget_id}`, CP3) rather
   * than a page on the dashboard, because the document has to answer
   * `Content-Security-Policy: frame-ancestors` from the widget's `allowed_origins`
   * — a list that lives only on the widget row and is deliberately absent from
   * the public read.
   */
  readonly apiBaseUrl: string
}

/** Escapes a string for an HTML *attribute* value.
 *
 * The title is owner-authored and lands inside `title="…"` of the snippet we
 * hand back for pasting, so the quote and the angle brackets have to go. Written
 * out rather than imported: this is the only HTML this module produces, and a
 * shared escaper would invite the next caller to use it for element content,
 * where the rules differ. */
function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * The `<iframe>` we recommend, returned beside `embed_url` rather than left to
 * the client to assemble (ADR-0045, D13).
 *
 * Both fields, so the copy button in the dashboard is not a second place where
 * the attributes of a supported embed are decided. `loading="lazy"` because an
 * embed is usually below the fold on somebody else's page and must not cost them
 * a render-blocking request; `border:0` because a default iframe border is the
 * first thing every integrator removes; `color-scheme:normal` because a host
 * page that declares its own scheme would otherwise mismatch the embedded
 * document's, and the browser answers a mismatch by painting an opaque canvas
 * behind the iframe — the white box our rounded border was leaking over.
 */
function embedSnippet(url: string, title: string | null): string {
  const label = escapeAttribute(title ?? 'Analytics widget')
  return `<iframe src="${url}" title="${label}" width="100%" height="320" loading="lazy" style="border:0;color-scheme:normal"></iframe>`
}

function widgetJson(widget: WidgetRecord, apiBaseUrl: string) {
  const embedUrl = `${apiBaseUrl}/embed/${widget.id}`
  return {
    id: widget.id,
    surface: widget.surface,
    // Always present, `null` included: a missing key would leave the client to
    // infer "no title" from an absence, and the same is true of the two
    // parameters below, which are structurally null on some surfaces.
    title: widget.title,
    range: widget.range,
    limit: widget.limit,
    allowed_origins: widget.allowedOrigins,
    enabled: widget.enabled,
    embed_url: embedUrl,
    embed_snippet: embedSnippet(embedUrl, widget.title),
    created_by_user_id: widget.createdByUserId,
    created_at: widget.createdAt.toISOString(),
    updated_at: widget.updatedAt.toISOString(),
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
 * domain's schemas are the API's validators — so this is typed against the shape
 * of a result rather than against zod's own types, exactly as `funnels.ts` does.
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
 * The flat per-site ceiling (ADR-0045, D9), in the rule budget's own shape
 * (`assertSiteRuleBudget`, `apps/api/src/http/event-definitions.ts`).
 *
 * A count rather than a database CHECK, because a CHECK cannot see sibling rows
 * — and deliberately so, because fifty bounds a settings screen rather than
 * pricing anything, which means raising it must not be a migration.
 */
async function assertWidgetBudget(db: Database, siteId: string): Promise<void> {
  const existing = await countWidgets(db, siteId)
  if (existing >= MAX_WIDGETS_PER_SITE) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `This site already has ${existing} widgets; the limit is ${MAX_WIDGETS_PER_SITE}.`,
      { details: { reason: 'widget_budget_exceeded', existing, limit: MAX_WIDGETS_PER_SITE } },
    )
  }
}

export function createWidgetRoutes(deps: WidgetRoutesDeps): Hono<Env> {
  const { db } = deps
  const apiBaseUrl = deps.apiBaseUrl.replace(/\/$/u, '')
  const app = new Hono<Env>()

  const base = '/sites/:site_id/widgets'

  // Membership guards every widget route; the mutations add the capability
  // individually, so the reads stay open to a viewer.
  app.use(`${base}/*`, siteMembership(db))
  app.use(base, siteMembership(db))

  app.get(base, async (c) => {
    const { siteId } = c.get('membership')
    const items = await listWidgets(db, siteId)
    return c.json({ items: items.map((widget) => widgetJson(widget, apiBaseUrl)) })
  })

  app.get(`${base}/:widget_id`, async (c) => {
    const { siteId } = c.get('membership')
    const widget = await getWidget(db, { id: c.req.param('widget_id') as string, siteId })
    if (!widget) throw new ApiError('NOT_FOUND', 'No such widget on this site')
    return c.json(widgetJson(widget, apiBaseUrl))
  })

  app.post(base, requireCapability('site:settings'), async (c) => {
    const actor = c.get('user')
    const { siteId } = c.get('membership')
    const body = parsed(
      createWidgetRequestSchema.safeParse(await readJson(c)),
      'Invalid widget configuration',
    )
    // Counted after the body is known to be valid and before anything is
    // written, so a refusal over the cap is never confused with a refusal over
    // the payload and neither leaves a row behind.
    await assertWidgetBudget(db, siteId)

    const created = await createWidget(db, {
      siteId,
      surface: body.surface,
      title: body.title ?? null,
      range: body.range ?? null,
      limit: resolveWidgetLimit(body.surface, body.limit),
      allowedOrigins: body.allowed_origins,
      ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      createdByUserId: actor.id,
    })
    return c.json(widgetJson(created, apiBaseUrl), 201)
  })

  app.patch(`${base}/:widget_id`, requireCapability('site:settings'), async (c) => {
    const actor = c.get('user')
    const { siteId } = c.get('membership')
    const widgetId = c.req.param('widget_id') as string
    // `surface` is not a property of this schema, so a body carrying it fails
    // here as an unrecognized key — the strict-object refusal *is* the
    // immutability rule (ADR-0045, D2), and it lands before the row is read.
    const body = parsed(
      updateWidgetRequestSchema.safeParse(await readJson(c)),
      'Invalid widget configuration',
    )

    // The rest of the validation needs the stored surface, which the patch
    // cannot change and therefore cannot supply: `range` and `limit` still have
    // to agree with it, or a `realtime` widget acquires a window that no read
    // would ever use.
    const existing = await getWidget(db, { id: widgetId, siteId })
    if (!existing) throw new ApiError('NOT_FOUND', 'No such widget on this site')

    const issues = checkWidgetPatch(existing.surface, body)
    if (issues.length > 0) {
      throw new ApiError('VALIDATION_FAILED', 'Invalid widget configuration', {
        details: { issues },
      })
    }

    const updated = await updateWidget(db, {
      id: widgetId,
      siteId,
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.range === undefined ? {} : { range: body.range }),
      ...(body.limit === undefined ? {} : { limit: body.limit }),
      ...(body.allowed_origins === undefined ? {} : { allowedOrigins: body.allowed_origins }),
      ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      actorUserId: actor.id,
    })
    if (!updated) throw new ApiError('NOT_FOUND', 'No such widget on this site')
    return c.json(widgetJson(updated, apiBaseUrl))
  })

  /**
   * The permanent revoke, and it is a hard delete.
   *
   * **Not idempotent**, unlike the funnel archive beside it: a repeat is 404.
   * That endpoint's own reasoning drew the line — archiving is soft and a linked
   * chart must not dangle, "unlike an API-key or invite revocation". This *is* a
   * revocation of a public credential, and an operator checking whether they
   * revoked the right widget learns nothing from a 204 for an id that is gone.
   */
  app.delete(`${base}/:widget_id`, requireCapability('site:settings'), async (c) => {
    const actor = c.get('user')
    const { siteId } = c.get('membership')
    const { deleted } = await deleteWidget(db, {
      id: c.req.param('widget_id') as string,
      siteId,
      actorUserId: actor.id,
    })
    if (!deleted) throw new ApiError('NOT_FOUND', 'No such widget on this site')
    return c.body(null, 204)
  })

  return app
}
