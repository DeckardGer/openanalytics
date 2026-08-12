import { z } from 'zod'

/**
 * The canonical funnel definition and its pure reference matcher (docs snapshot
 * 02 §15 "dynamic funnels are computed over the session/event facts"; 04
 * Milestone 8 item 7 and acceptance criterion 4).
 *
 * Like `sessionize`, this is the reference implementation: a pure, deterministic
 * function of an event set, and the ClickHouse `windowFunnel` operation in the
 * gateway is written to mirror it. The pure function is what the deterministic
 * tie-break is proven against (acceptance criterion 4 is a unit test), and the
 * migration test asserts the ClickHouse operation agrees with it on seeded data.
 *
 * ## Semantics
 *
 * A funnel is an ordered list of **steps**, each a string key an event matches.
 * Events are grouped into **units** (the aggregation scope), each unit's events
 * are ordered by `(occurred_at, event_id)` — the same total order the sessionizer
 * uses, so an exact-millisecond tie is broken deterministically by `event_id` —
 * and a unit's **level** is the longest ordered prefix of steps it completes such
 * that the whole chain, from the first step to the last, fits inside `windowMs`.
 * This is exactly ClickHouse `windowFunnel(window)(t, cond1, …, condN)` in its
 * default mode: steps must occur in order, and the window is measured from the
 * chain's first matched event.
 *
 * The funnel result is, per step `k` (1-based), the number of units that reached
 * at least level `k`; step 1 is the funnel entry and conversion to step `k` is
 * `count_k / count_1`. Counts are non-increasing down the funnel, which is a
 * structural property the matcher guarantees (a unit at level `k` is at every
 * lower level too).
 *
 * ## Scope (unit) — same-session vs same-visitor
 *
 * The D-102 anonymous id is the visitor (ADR-0036 D3: unit-counting reads key
 * on the anonymous id; the funnel population — page_view/custom_event/
 * conversion — never carries a `user_id`, so this is what the old
 * resolved-identity expression always evaluated to here). Two scopes are
 * offered, both computable from `events_raw` without a join:
 *
 *   - **`visitor`** — the unit is the anonymous id. The whole funnel is one
 *     person's journey across visits, bounded only by `windowMs`.
 *   - **`session`** — the unit is `(anonymous id, client session hint)`. The
 *     hint (`events_raw.session_id`, the site-scoped HMAC of the tracker's
 *     `client_session_id`) approximates a browser session; pairing it with the
 *     identity stops two visitors who reused a hint value from being merged.
 *
 * The `session` scope is the client-hint session, **not** the canonical 30-minute
 * sessionizer session: `session_facts_versions` stores per-session aggregates, not
 * the ordered event sequence a step funnel needs, so a canonical-session funnel
 * would need a different fact shape. The hint plus the `windowMs` bound is a sound
 * bounded approximation; a canonical-session funnel is a documented follow-up
 * (ADR-0012). The `windowMs` default matches the session inactivity for `session`
 * scope and is caller-set for `visitor` scope.
 */

/** The most steps a single funnel may declare; the gateway operation is fixed-width. */
export const MAX_FUNNEL_STEPS = 8
/** The fewest steps a funnel needs to be a funnel. */
export const MIN_FUNNEL_STEPS = 2

/** How events are grouped into funnel units. */
export const FUNNEL_SCOPES = ['visitor', 'session'] as const
export type FunnelScope = (typeof FUNNEL_SCOPES)[number]

/** Longest conversion window a funnel may span, in ms (30 days). Bounds the read. */
export const MAX_FUNNEL_WINDOW_MS = 30 * 86_400_000

/**
 * Longest `[from, to)` a funnel may scan synchronously, in ms (92 days). A funnel
 * reads `events_raw` rather than a rollup, so its range is capped tighter than the
 * rollup reads; §15 allows an async job for a larger range, which is a documented
 * follow-up (ADR-0012). The gateway operation and the API resolver both enforce
 * this so a caller gets a typed refusal, not a slow scan.
 */
export const MAX_FUNNEL_RANGE_MS = 92 * 86_400_000

/** Longest a single step key may be. A page path or a custom event name. */
export const FUNNEL_STEP_KEY_MAX_LENGTH = 512

/**
 * The ordered step keys, bounded.
 *
 * Extracted so the ad-hoc compute schema below and the stored-definition schemas
 * further down cannot drift apart: a definition that passes validation on save
 * must be one the compute endpoint will accept when it is run, and two copies of
 * these bounds is exactly how that stops being true.
 */
export const funnelStepsSchema = z
  .array(z.string().min(1).max(FUNNEL_STEP_KEY_MAX_LENGTH))
  .min(MIN_FUNNEL_STEPS)
  .max(MAX_FUNNEL_STEPS)

export const funnelConfigSchema = z
  .object({
    scope: z.enum(FUNNEL_SCOPES).default('visitor'),
    steps: funnelStepsSchema,
    windowMs: z.coerce.number().int().min(1).max(MAX_FUNNEL_WINDOW_MS),
  })
  .strict()

export type FunnelConfig = z.infer<typeof funnelConfigSchema>

/**
 * Longest accepted funnel display name, in characters, after trimming. The same
 * bound a site name carries (`SITE_NAME_MAX_LENGTH`): both are display names
 * typed into the same dashboard, and a different limit on each would be an
 * arbitrary distinction a user would discover only by hitting it.
 */
export const FUNNEL_NAME_MAX_LENGTH = 200

const funnelNameSchema = z.string().trim().min(1).max(FUNNEL_NAME_MAX_LENGTH)

const funnelWindowMsSchema = z.number().int().min(1).max(MAX_FUNNEL_WINDOW_MS)

/**
 * The request bodies for stored funnel definitions.
 *
 * Written in the wire's snake_case rather than the domain's camelCase, because
 * they parse an HTTP body directly — `funnelConfigSchema` remaps by hand in the
 * compute endpoint precisely because it is fed query parameters instead. `apps/api`
 * carries no zod dependency of its own (docs snapshot: the contract's schemas are
 * the API's validators), so these live here with the bounds they enforce.
 *
 * Saving a definition does not compute it. These schemas therefore say nothing
 * about `from`/`to`: a stored funnel carries no range, and the 92-day synchronous
 * scan cap (`MAX_FUNNEL_RANGE_MS`) is still decided per computation by the
 * analytics endpoint.
 */
export const createFunnelRequestSchema = z.strictObject({
  name: funnelNameSchema,
  steps: funnelStepsSchema,
  scope: z.enum(FUNNEL_SCOPES).default('visitor'),
  window_ms: funnelWindowMsSchema,
})

export type CreateFunnelRequest = z.infer<typeof createFunnelRequestSchema>

/**
 * A partial update. At least one field must be present: an empty patch is
 * refused rather than treated as a no-op, the same judgement
 * `PATCH /v1/sites/{site_id}` makes — a save that changed nothing is far more
 * likely a client bug than an intention.
 */
export const updateFunnelRequestSchema = z
  .strictObject({
    name: funnelNameSchema.optional(),
    steps: funnelStepsSchema.optional(),
    scope: z.enum(FUNNEL_SCOPES).optional(),
    window_ms: funnelWindowMsSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one of name, steps, scope or window_ms is required',
  })

export type UpdateFunnelRequest = z.infer<typeof updateFunnelRequestSchema>

/** A single event the funnel matcher consumes. `stepKey` is the matched key. */
export interface FunnelEvent {
  /** The aggregation unit this event belongs to (visitor or session identity). */
  readonly unitKey: string
  readonly occurredMs: number
  readonly eventId: string
  /** The event's funnel key: page_path for a pageview, event name otherwise. */
  readonly stepKey: string
}

/** One row of a funnel result. */
export interface FunnelStepResult {
  /** 1-based step index. */
  readonly step: number
  readonly key: string
  /** Units that reached at least this step. */
  readonly count: number
  /** count / step-1 count, in `[0, 1]`; 1 for step 1 (0 if the funnel is empty). */
  readonly conversionRate: number
}

/**
 * Computes a unit's funnel level under default `windowFunnel` semantics.
 *
 * `eventTs[i]` holds the chain-start timestamp of the best chain that has reached
 * stage `i`; advancing to stage `i` requires the current event to match step `i`
 * and to fall within `windowMs` of that chain start. The inner loop runs stages
 * high-to-low so a single event never advances two stages at once — the same
 * guard ClickHouse's implementation uses.
 */
function unitLevel(
  sortedEvents: readonly FunnelEvent[],
  steps: readonly string[],
  windowMs: number,
): number {
  const eventTs: number[] = new Array(steps.length).fill(Number.NaN)
  for (const event of sortedEvents) {
    for (let stage = steps.length - 1; stage >= 0; stage -= 1) {
      if (event.stepKey !== steps[stage]) continue
      if (stage === 0) {
        eventTs[0] = event.occurredMs
      } else if (
        !Number.isNaN(eventTs[stage - 1]!) &&
        event.occurredMs - eventTs[stage - 1]! <= windowMs
      ) {
        eventTs[stage] = eventTs[stage - 1]!
      }
    }
  }
  let level = 0
  for (let i = 0; i < steps.length; i += 1) {
    if (!Number.isNaN(eventTs[i]!)) level = i + 1
  }
  return level
}

/** Deterministic total order: occurred time, then event id (§10 tie-break). */
function compareFunnelEvents(a: FunnelEvent, b: FunnelEvent): number {
  if (a.occurredMs !== b.occurredMs) return a.occurredMs - b.occurredMs
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0
}

/**
 * The pure funnel matcher. Groups events into units, orders each unit
 * deterministically, computes each unit's level, and returns per-step unit
 * counts and conversion rates.
 *
 * Pure and total: it never throws and never reads a clock. The same event set, in
 * any arrival order, yields identical results.
 */
export function computeFunnel(
  events: readonly FunnelEvent[],
  config: Pick<FunnelConfig, 'steps' | 'windowMs'>,
): FunnelStepResult[] {
  const byUnit = new Map<string, FunnelEvent[]>()
  for (const event of events) {
    const unit = byUnit.get(event.unitKey)
    if (unit === undefined) byUnit.set(event.unitKey, [event])
    else unit.push(event)
  }

  const counts = new Array(config.steps.length).fill(0)
  for (const unitEvents of byUnit.values()) {
    const sorted = [...unitEvents].sort(compareFunnelEvents)
    const level = unitLevel(sorted, config.steps, config.windowMs)
    for (let i = 0; i < level; i += 1) counts[i] += 1
  }

  const entry = counts[0] ?? 0
  return config.steps.map((key, index) => ({
    step: index + 1,
    key,
    count: counts[index] as number,
    conversionRate: entry > 0 ? (counts[index] as number) / entry : 0,
  }))
}
