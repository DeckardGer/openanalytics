import { z } from 'zod'

/**
 * Embeddable widgets: the vocabulary, the bounds and the request bodies
 * (ADR-0045; docs snapshot 02 §20).
 *
 * A widget is `(surface, range, limit, title)` plus an origin allowlist, and
 * every rule in this module exists so that **a widget that saves is a widget
 * that renders** — the bounds here are the ones the public read enforces, so a
 * configuration cannot be stored that would 400 on every anonymous request from
 * a page the owner has already published.
 *
 * `apps/api` carries no zod dependency of its own (the contract's and the
 * domain's schemas are the API's validators), so the wire-shaped bodies live
 * here in snake_case, exactly as `funnel.ts` keeps the funnel ones.
 */

/**
 * The eight namable surfaces (ADR-0045, D2).
 *
 * Seven public analytics reads plus `realtime`, which is served as a cacheable
 * snapshot poll rather than as a stream. This list is F-301's deliberately wide
 * allowlist written out, and it is wide without being a new data class: every
 * entry is something an anonymous caller can already read behind an owner's
 * share opt-in. `identity` (ADR-0044) is deliberately absent — it is a modifier
 * on a board, and a widget is not a board.
 */
export const WIDGET_SURFACES = [
  'overview',
  'timeseries',
  'sessions',
  'pages',
  'sources',
  'devices',
  'geography',
  'realtime',
] as const
export type WidgetSurface = (typeof WIDGET_SURFACES)[number]

/**
 * The surfaces whose answer is a list of rows, and therefore the only ones a
 * `limit` means anything on (ADR-0045, D10).
 *
 * Sent with any other surface, `limit` is `VALIDATION_FAILED` at the write
 * rather than a silently ignored field: a stored parameter nothing reads is a
 * setting an owner believes they configured.
 */
export const WIDGET_BREAKDOWN_SURFACES = ['pages', 'sources', 'devices', 'geography'] as const
export type WidgetBreakdownSurface = (typeof WIDGET_BREAKDOWN_SURFACES)[number]

export function isWidgetBreakdownSurface(surface: WidgetSurface): boolean {
  return (WIDGET_BREAKDOWN_SURFACES as readonly string[]).includes(surface)
}

/**
 * The nine relative range keys, taken verbatim from the dashboard's own interval
 * vocabulary (ADR-0045, D10) so "Last 7 days" on a widget is the same window as
 * "Last 7 days" in the owner's dashboard.
 *
 * Relative and never absolute: an embed is a living thing on somebody's page,
 * and a frozen window that ages silently is worse than a report that says its
 * date. `realtime` is the one surface with no range at all.
 */
export const WIDGET_RANGES = [
  'today',
  'yesterday',
  '24h',
  '7d',
  '30d',
  '90d',
  '6mo',
  '12mo',
  'all',
] as const
export type WidgetRange = (typeof WIDGET_RANGES)[number]

/**
 * Widgets per site (ADR-0045, D9), flat across every plan.
 *
 * The `MAX_PUBLISHED_RULES_PER_SITE` precedent taken deliberately rather than by
 * habit: a cap that differed by plan would put this milestone into the
 * billed-limits surface for a number that bounds a settings screen and a site's
 * row count rather than pricing anything. Enforced in application code and not
 * as a database CHECK, so raising it is a change to this constant's callers.
 */
export const MAX_WIDGETS_PER_SITE = 50

/** Entries in one widget's origin allowlist; mirrors the contract's `maxItems`. */
export const MAX_WIDGET_ORIGINS = 20

/** Rows a breakdown widget shows. The public reads allow 500; five hundred rows
 * in a sidebar on somebody else's page is bytes nobody asked for. */
export const WIDGET_LIMIT_MIN = 1
export const WIDGET_LIMIT_MAX = 50
export const WIDGET_LIMIT_DEFAULT = 10

/** Longest owner-authored label, mirroring the contract's `maxLength`. */
export const WIDGET_TITLE_MAX_LENGTH = 80

/** The wildcard, which means "render anywhere" and is accepted only alone. */
export const WIDGET_ORIGIN_WILDCARD = '*'

/**
 * The shape an entry must have before it is even considered: an exact serialized
 * origin, lowercased, with no path, query or fragment.
 *
 * A literal mirror of the contract's `WidgetOrigin` pattern. It is the floor
 * under `isWidgetOrigin` below rather than the whole test.
 */
const ORIGIN_PATTERN = /^https?:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?$/u

/**
 * Whether a string is an origin this allowlist can compare.
 *
 * Two conditions, and the second is the one that matters. The pattern refuses
 * the obvious ("no scheme", "has a path", "not lowercased"); the round-trip
 * through `URL` refuses the subtle: `https://shop.example.com:443` looks like an
 * origin and never matches one, because a browser omits the default port when it
 * serializes `Origin`, so an owner who typed it would get a silently dead
 * allowlist entry. Refusing at the write is the only place that is visible.
 *
 * This is `cors.ts`'s argument restated at a second allowlist: entries are
 * compared as whole strings, never by prefix or suffix, so `app.getopen.so` and
 * `evil-app.getopen.so` are two different entries and a list naming one does not
 * admit the other.
 */
export function isWidgetOrigin(value: string): boolean {
  if (!ORIGIN_PATTERN.test(value)) return false
  try {
    return new URL(value).origin === value
  } catch {
    return false
  }
}

const widgetOriginSchema = z
  .string()
  .max(253)
  .refine((value) => value === WIDGET_ORIGIN_WILDCARD || isWidgetOrigin(value), {
    message: `Each entry must be an exact serialized origin (scheme://host[:port]) or "${WIDGET_ORIGIN_WILDCARD}"`,
  })

/**
 * The allowlist as a whole.
 *
 * An empty list is valid and means **nowhere** (ADR-0045, D4): unlike ingest,
 * where a tracker must accept a site's own pages we have never heard of, a
 * widget is created for a page the owner is looking at, so an omission fails
 * closed. `["*"]` is available and is an explicit choice — accepted only alone,
 * because a list containing `*` means `*` while looking like a restriction.
 */
const widgetOriginListSchema = z
  .array(widgetOriginSchema)
  .max(MAX_WIDGET_ORIGINS)
  .refine((list) => new Set(list).size === list.length, {
    message: 'Origins must be unique',
  })
  .refine((list) => !(list.includes(WIDGET_ORIGIN_WILDCARD) && list.length > 1), {
    message: `"${WIDGET_ORIGIN_WILDCARD}" is accepted only as the sole entry`,
  })

const widgetTitleSchema = z.string().trim().max(WIDGET_TITLE_MAX_LENGTH)
const widgetLimitSchema = z.number().int().min(WIDGET_LIMIT_MIN).max(WIDGET_LIMIT_MAX)

/** The `(surface, range, limit)` agreement, checked in one place so the create
 * body and a patch against a stored surface cannot drift apart. */
function checkSurfaceParameters(
  ctx: z.RefinementCtx,
  input: {
    readonly surface: WidgetSurface
    /** Present at all, and its value; absence and `null` differ on `PATCH`. */
    readonly rangeProvided: boolean
    readonly range: WidgetRange | null | undefined
    readonly limitProvided: boolean
    readonly limit: number | null | undefined
  },
): void {
  if (input.surface === 'realtime') {
    if (input.rangeProvided && input.range !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['range'],
        message: 'A realtime widget has no range',
      })
    }
    if (input.limitProvided && input.limit !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['limit'],
        message: 'A realtime widget has no limit',
      })
    }
    return
  }

  if (input.rangeProvided && input.range === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['range'],
      message: `A ${input.surface} widget must name a range`,
    })
  }
  if (!isWidgetBreakdownSurface(input.surface) && input.limitProvided && input.limit !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['limit'],
      message: `limit applies to ${WIDGET_BREAKDOWN_SURFACES.join(', ')} only`,
    })
  }
}

/**
 * The create body.
 *
 * `allowed_origins` is required and has no default, because an embed's allowlist
 * must be a choice rather than an omission. `range` is required for the seven
 * historical surfaces and refused for `realtime`; `limit` is accepted only on
 * the four breakdown surfaces. The flat per-site cap is **not** here — it is a
 * count across other rows, which no single body can see (ADR-0045, D9).
 */
export const createWidgetRequestSchema = z
  .strictObject({
    surface: z.enum(WIDGET_SURFACES),
    title: widgetTitleSchema.nullable().optional(),
    range: z.enum(WIDGET_RANGES).nullable().optional(),
    limit: widgetLimitSchema.optional(),
    allowed_origins: widgetOriginListSchema,
    enabled: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.surface !== 'realtime' && (value.range === undefined || value.range === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['range'],
        message: `A ${value.surface} widget must name a range`,
      })
      return
    }
    checkSurfaceParameters(ctx, {
      surface: value.surface,
      rangeProvided: value.range !== undefined,
      range: value.range,
      limitProvided: value.limit !== undefined,
      limit: value.limit,
    })
  })

export type CreateWidgetRequest = z.infer<typeof createWidgetRequestSchema>

/**
 * A partial update; an empty body is refused rather than treated as a no-op, the
 * same judgement `updateFunnelRequestSchema` makes.
 *
 * **`surface` is absent on purpose** (ADR-0045, D2). It is the one property
 * whose change alters *what is published* rather than how much of it, so a
 * `strictObject` refusing the key is the enforcement: a widget created as
 * `overview` and edited into `pages` would start publishing the site's URL
 * inventory on a page that already carries the old embed, without anyone
 * touching that page.
 *
 * The `(surface, range, limit)` agreement cannot be checked here, because the
 * surface lives on the stored row rather than in the body — `checkWidgetPatch`
 * below is that half, applied by the route once it has loaded the widget.
 */
export const updateWidgetRequestSchema = z
  .strictObject({
    title: widgetTitleSchema.nullable().optional(),
    range: z.enum(WIDGET_RANGES).nullable().optional(),
    limit: widgetLimitSchema.nullable().optional(),
    allowed_origins: widgetOriginListSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one of title, range, limit, allowed_origins or enabled is required',
  })

export type UpdateWidgetRequest = z.infer<typeof updateWidgetRequestSchema>

/**
 * The half of a patch that needs the stored surface: `range` and `limit` must
 * still agree with a surface the patch cannot change.
 *
 * Returns the issues in the same `{path, message}` shape a schema failure
 * produces, so the route reports both halves identically.
 */
export function checkWidgetPatch(
  surface: WidgetSurface,
  patch: UpdateWidgetRequest,
): { readonly path: string; readonly message: string }[] {
  const issues: { path: string; message: string }[] = []
  const ctx = {
    addIssue: (issue: { path?: readonly PropertyKey[]; message?: string }) => {
      issues.push({
        path: (issue.path ?? []).join('.') || '(root)',
        message: issue.message ?? 'Invalid value',
      })
    },
  } as unknown as z.RefinementCtx

  checkSurfaceParameters(ctx, {
    surface,
    rangeProvided: 'range' in patch,
    range: patch.range,
    limitProvided: 'limit' in patch,
    limit: patch.limit,
  })
  return issues
}

/**
 * The stored `limit` for a surface, given what the body asked for.
 *
 * The default lives here rather than as a zod `.default()`, because a schema
 * default would write `10` onto an `overview` widget that has no row cap at all
 * — a stored value nothing reads, which is exactly the silently-ignored field
 * the create body refuses elsewhere.
 */
export function resolveWidgetLimit(
  surface: WidgetSurface,
  requested: number | null | undefined,
): number | null {
  if (!isWidgetBreakdownSurface(surface)) return null
  return requested ?? WIDGET_LIMIT_DEFAULT
}
