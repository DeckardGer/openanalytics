import { z } from 'zod'
import { MAX_HEARTBEAT_INTERVAL_SECONDS, MIN_HEARTBEAT_INTERVAL_SECONDS } from './realtime.ts'
import { utcInstantSchema } from './time.ts'

/**
 * Canonical event contract.
 *
 * Docs snapshot 02 §7.3, §8 and §11; 04 Milestone 4. Three shapes live here and
 * they are deliberately not interchangeable:
 *
 * - `eventBatchSchema` — what a tracker/SDK may send to `POST /v1/events`. It is
 *   historical, durable and billable-eligible.
 * - `heartbeatRequestSchema` — what a tracker sends to
 *   `POST /v1/realtime/heartbeat`. It never reaches the queue, ClickHouse or
 *   usage, so it carries no `event_id` and cannot appear in a historical batch.
 * - `persistedEventSchema` — the server envelope (02 §8). Everything a client is
 *   structurally unable to state — site, geo, billing user, assignment version,
 *   usage window, `billable`, `accepted_at`, generation — appears only here.
 *
 * The separation is the acceptance criterion, not a convenience: a client that
 * could name its own `billing_user_id` or set `billable` would be choosing who
 * pays for its traffic. Every request object is strict, so an unknown or
 * server-owned key is a `VALIDATION_FAILED`, never a silently ignored field.
 *
 * Limits in this file are contract limits — how big a legitimate request may be.
 * Abuse ceilings and per-IP/site/device rate limits are a different question and
 * belong to G-005, which closes before Milestone 5.
 */

/** Wire schema version. A new event type or field shape needs a new version. */
export const EVENT_SCHEMA_VERSION = 1
export const SUPPORTED_EVENT_SCHEMA_VERSIONS = [1] as const

/** Types accepted in the historical batch. `heartbeat` is intentionally absent. */
export const HISTORICAL_EVENT_TYPES = [
  'page_view',
  'custom_event',
  'conversion',
  'identify',
  'engagement',
  'web_vital',
  'interaction',
] as const

/** Realtime-only types: presence signals that never become historical rows. */
export const REALTIME_EVENT_TYPES = ['heartbeat'] as const

export const EVENT_TYPES = [...HISTORICAL_EVENT_TYPES, ...REALTIME_EVENT_TYPES] as const

export type HistoricalEventType = (typeof HISTORICAL_EVENT_TYPES)[number]
export type EventType = (typeof EVENT_TYPES)[number]

export const eventTypeSchema = z.enum(EVENT_TYPES)
export const historicalEventTypeSchema = z.enum(HISTORICAL_EVENT_TYPES)

export function isHistoricalEventType(value: unknown): value is HistoricalEventType {
  return typeof value === 'string' && (HISTORICAL_EVENT_TYPES as readonly string[]).includes(value)
}

/**
 * Contract limits.
 *
 * Sized so an ordinary page's worth of tracking fits in one request while a
 * hostile or buggy client cannot make the collector do unbounded work before
 * validation fails. Byte limits are checked on the decoded body, because a
 * compressed payload's cost is what it expands to.
 */
export const EVENT_LIMITS = {
  /** Event name (`custom_event`, `conversion`). */
  eventNameMaxLength: 64,
  propertyKeyMaxLength: 40,
  propertyValueMaxLength: 256,
  maxPropertiesPerEvent: 32,
  urlMaxLength: 1024,
  referrerMaxLength: 1024,
  pageTitleMaxLength: 256,
  /** CSS-ish selector path for a heatmap click. */
  selectorMaxLength: 256,
  /** Element text for a heatmap click, after tracker-side redaction. */
  elementTextMaxLength: 128,
  externalUserIdMaxLength: 128,
  clientSessionIdMaxLength: 64,
  actionIdMaxLength: 64,
  trackingKeyMaxLength: 64,
  sdkVersionMaxLength: 32,
  maxEventsPerBatch: 100,
  /** Decoded request body. */
  maxBatchBytes: 262_144,
  /** Bytes on the wire; a compressed body is rejected before it is inflated. */
  maxCompressedBytes: 65_536,
} as const

/** Request encodings the ingest endpoints accept. */
export const SUPPORTED_CONTENT_ENCODINGS = ['identity', 'gzip', 'deflate'] as const
export type ContentEncoding = (typeof SUPPORTED_CONTENT_ENCODINGS)[number]

/**
 * Client-generated `event_id`, lowercase UUIDv7.
 *
 * Docs snapshot 02 §7.1: the ID is minted before the first send attempt, so a
 * retry whose response was lost still deduplicates. A server-generated ID cannot
 * do that. v7 specifically, because its time prefix keeps queue and ClickHouse
 * keys roughly ordered.
 */
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export const eventIdSchema = z
  .string()
  .regex(UUID_V7_PATTERN, 'event_id must be a lowercase UUIDv7')

export function isUuidV7(value: string): boolean {
  return UUID_V7_PATTERN.test(value)
}

/** Public tracking key. Write-only: never read auth (docs snapshot 01 §3.2). */
export const trackingKeySchema = z.string().min(8).max(EVENT_LIMITS.trackingKeyMaxLength)

export const eventNameSchema = z
  .string()
  .min(1)
  .max(EVENT_LIMITS.eventNameMaxLength)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/, 'event name must be alphanumeric with _ . : -')

/**
 * Property keys are flattened into analytics storage later, so `oa_` is reserved
 * for fields the server owns. Values are scalars only: a nested object has no
 * stable column, and accepting one now would make the first rollup a migration.
 */
export const propertyKeySchema = z
  .string()
  .min(1)
  .max(EVENT_LIMITS.propertyKeyMaxLength)
  .regex(/^[a-zA-Z_][a-zA-Z0-9_.-]*$/, 'property key must start with a letter or underscore')
  .refine((key) => !key.toLowerCase().startsWith('oa_'), 'property keys may not use the oa_ prefix')

export const propertyValueSchema = z.union([
  z.string().max(EVENT_LIMITS.propertyValueMaxLength),
  z.number().finite(),
  z.boolean(),
  z.null(),
])

export const eventPropertiesSchema = z
  .record(propertyKeySchema, propertyValueSchema)
  .refine(
    (properties) => Object.keys(properties).length <= EVENT_LIMITS.maxPropertiesPerEvent,
    `at most ${EVENT_LIMITS.maxPropertiesPerEvent} properties per event`,
  )

export type EventProperties = z.infer<typeof eventPropertiesSchema>

/**
 * Page context a client may state.
 *
 * The tracker sanitizes before sending: no fragment, no sensitive query keys
 * (docs snapshot 02 §11). The server sanitizes again and derives `path`, the
 * referrer split and UTM fields itself — a client never states them, so a
 * malformed or forged `source` block cannot enter attribution.
 */
export const eventPageSchema = z.strictObject({
  url: z.url().max(EVENT_LIMITS.urlMaxLength),
  title: z.string().max(EVENT_LIMITS.pageTitleMaxLength).optional(),
})

/** SDK identity. Device, browser, OS and geo are server-derived, never client-stated. */
export const clientContextSchema = z.strictObject({
  sdk: z.enum(['web', 'node', 'wordpress', 'mobile']),
  sdk_version: z.string().min(1).max(EVENT_LIMITS.sdkVersionMaxLength),
  /**
   * Deprecated and ignored (ADR-0068). Old snippets still send it, so the field
   * stays accepted — `strictObject` would 400 them off the air — but the server
   * treats the traffic as ordinary: visible and billable.
   */
  test_mode: z.boolean().optional(),
})

export type ClientContext = z.infer<typeof clientContextSchema>

const commonEventFields = {
  event_id: eventIdSchema,
  occurred_at: utcInstantSchema,
  /**
   * Client session hint only. The server HMACs it site-scoped and the canonical
   * session is rebuilt by the sessionizer (docs snapshot 02 §10) — a client
   * cannot pin two visitors into one session by reusing a value.
   */
  client_session_id: z.string().min(1).max(EVENT_LIMITS.clientSessionIdMaxLength).optional(),
  /**
   * Correlates events produced by one browser action.
   *
   * It carries no billing meaning and is not a batch-wide discount: the server
   * uses it for exactly the one case D-101 documents — a raw `custom_event` and
   * a no-code rule describing the same click bill once. A `page_view` or
   * `conversion` sharing the id is charged normally.
   */
  action_id: z.string().min(1).max(EVENT_LIMITS.actionIdMaxLength).optional(),
  page: eventPageSchema.optional(),
  referrer: z.string().max(EVENT_LIMITS.referrerMaxLength).optional(),
  properties: eventPropertiesSchema.optional(),
}

export const VIEWPORT_CLASSES = ['mobile', 'tablet', 'desktop', 'wide'] as const
export type ViewportClass = (typeof VIEWPORT_CLASSES)[number]

export const WEB_VITAL_METRICS = ['LCP', 'CLS', 'INP', 'FCP', 'TTFB'] as const
export type WebVitalMetric = (typeof WEB_VITAL_METRICS)[number]

/**
 * Heatmap click signal (F-314, D-101).
 *
 * Passive, high-volume and never billable. Coordinates are viewport percentages
 * rather than pixels so a heatmap can be rendered at any width. Element text is
 * redacted and truncated by the tracker and re-redacted by the collector
 * (ADR-0057 D6), so the stored value does not depend on trusting the client;
 * the value of an input is never captured at all, at any layer.
 */
export const interactionPayloadSchema = z.strictObject({
  x_percent: z.number().min(0).max(100),
  y_percent: z.number().min(0).max(100),
  viewport_class: z.enum(VIEWPORT_CLASSES),
  viewport_width: z.number().int().min(0).max(20_000),
  selector: z.string().min(1).max(EVENT_LIMITS.selectorMaxLength),
  text: z.string().max(EVENT_LIMITS.elementTextMaxLength).optional(),
})

export const engagementPayloadSchema = z.strictObject({
  /** Time the page was visible and the visitor was actually active. */
  active_ms: z.number().int().min(0).max(86_400_000),
  visible_ms: z.number().int().min(0).max(86_400_000),
})

export const webVitalPayloadSchema = z.strictObject({
  metric: z.enum(WEB_VITAL_METRICS),
  value: z.number().min(0),
  rating: z.enum(['good', 'needs-improvement', 'poor']).optional(),
  navigation_type: z
    .enum(['navigate', 'reload', 'back-forward', 'prerender', 'restore'])
    .optional(),
})

const pageViewEventSchema = z.strictObject({
  ...commonEventFields,
  type: z.literal('page_view'),
  page: eventPageSchema,
})

const customEventSchema = z.strictObject({
  ...commonEventFields,
  type: z.literal('custom_event'),
  name: eventNameSchema,
  /**
   * The no-code rule that produced this event (ADR-0034, D5).
   *
   * A *claim*, never a grant. The server accepts `origin: 'no_code_rule'` only
   * when this id resolves to a published, active rule on the same site AND the
   * event's `name` equals that rule's configured name — so the origin is
   * established from the site's own published configuration rather than
   * believed from the wire. An id that resolves to nothing is not an error: the
   * event is classified `client_sdk` and billed normally, because a rule
   * published seconds ago against a 30-second-stale ingest-config cache must not
   * reject a customer's traffic (G-005).
   */
  rule_id: z.string().min(1).max(64).optional(),
})

const conversionEventSchema = z.strictObject({
  ...commonEventFields,
  type: z.literal('conversion'),
  name: eventNameSchema,
})

const identifyEventSchema = z.strictObject({
  ...commonEventFields,
  type: z.literal('identify'),
  /**
   * The customer's own user id. It must not be raw PII; the server HMACs it
   * site-scoped before storage (docs snapshot 02 §10).
   */
  external_user_id: z.string().min(1).max(EVENT_LIMITS.externalUserIdMaxLength),
})

const engagementEventSchema = z.strictObject({
  ...commonEventFields,
  type: z.literal('engagement'),
  engagement: engagementPayloadSchema,
})

const webVitalEventSchema = z.strictObject({
  ...commonEventFields,
  type: z.literal('web_vital'),
  web_vital: webVitalPayloadSchema,
})

const interactionEventSchema = z.strictObject({
  ...commonEventFields,
  type: z.literal('interaction'),
  interaction: interactionPayloadSchema,
})

/** One event as a client may send it. Server-owned fields are absent by design. */
export const clientEventSchema = z.discriminatedUnion('type', [
  pageViewEventSchema,
  customEventSchema,
  conversionEventSchema,
  identifyEventSchema,
  engagementEventSchema,
  webVitalEventSchema,
  interactionEventSchema,
])

export type ClientEvent = z.infer<typeof clientEventSchema>

/**
 * Historical batch body for `POST /v1/events`.
 *
 * The tracking key travels in the body rather than a header because
 * `navigator.sendBeacon` cannot set one, and a key in a query string would land
 * in every access log on the path.
 */
export const eventBatchSchema = z
  .strictObject({
    schema_version: z.literal(EVENT_SCHEMA_VERSION),
    tracking_key: trackingKeySchema,
    /** The client's clock at send time. Diagnostic only; never a billing input. */
    sent_at: utcInstantSchema,
    context: clientContextSchema,
    events: z.array(clientEventSchema).min(1).max(EVENT_LIMITS.maxEventsPerBatch),
  })
  .superRefine((batch, ctx) => {
    // Docs snapshot 02 §7.1: uniqueness is checked inside the batch too. A batch
    // repeating an id is a client bug, and accepting it would make the
    // all-or-nothing enqueue ambiguous about what "already accepted" means.
    const seen = new Set<string>()
    batch.events.forEach((event, index) => {
      if (seen.has(event.event_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['events', index, 'event_id'],
          message: 'event_id must be unique within a batch',
        })
      }
      seen.add(event.event_id)
    })
  })

export type EventBatch = z.infer<typeof eventBatchSchema>

/**
 * `202 Accepted` body.
 *
 * First acceptance and a duplicate retry share one semantic (docs snapshot 02
 * §7.3, D-209); the counts tell a client what happened without changing status.
 */
export const eventBatchAcceptedSchema = z.strictObject({
  accepted: z.number().int().min(0),
  duplicate: z.number().int().min(0),
})

export type EventBatchAccepted = z.infer<typeof eventBatchAcceptedSchema>

/**
 * `POST /v1/realtime/heartbeat` body.
 *
 * Realtime presence only: it never reaches the durable queue, ClickHouse or
 * usage (docs snapshot 02 §7.2, D-101). It therefore has no `event_id` — nothing
 * deduplicates it — which is also why it cannot be smuggled into a historical
 * batch: the batch requires an `event_id` and does not know the type.
 */
export const heartbeatRequestSchema = z.strictObject({
  schema_version: z.literal(EVENT_SCHEMA_VERSION),
  tracking_key: trackingKeySchema,
  sent_at: utcInstantSchema,
  context: clientContextSchema,
  client_session_id: z.string().min(1).max(EVENT_LIMITS.clientSessionIdMaxLength).optional(),
  page: eventPageSchema.optional(),
})

export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>

/**
 * Fields only the server may state, listed so the guarantee is testable rather
 * than merely intended. Docs snapshot 02 §8 and 04/M4: a client cannot name the
 * billing user, plan, usage window, geo or the billable flag.
 */
export const SERVER_ASSIGNED_EVENT_FIELDS = [
  'site_id',
  'ingest_generation',
  'billing_user_id',
  'billing_assignment_version',
  'usage_window_id',
  'billable',
  'plan',
  'anonymous_id',
  'session_id',
  'received_at',
  'accepted_at',
  'clock_skewed',
  'source',
  'geo',
  'country',
  'city',
  'ip',
] as const

/** Context fields the server derives from the request, never from the payload. */
export const SERVER_ASSIGNED_CONTEXT_FIELDS = [
  'device_type',
  'browser',
  'os',
  'country',
  'city',
  'ip',
] as const

/**
 * The persisted/server envelope (docs snapshot 02 §8).
 *
 * Written by the worker, read by analytics. Present here so the shape the
 * pipeline agrees on has one definition, and so the difference between what a
 * client may say and what the server records is visible in one file.
 */
export const persistedEventSchema = z.strictObject({
  schema_version: z.literal(EVENT_SCHEMA_VERSION),
  event_id: eventIdSchema,
  site_id: z.string().min(1),
  type: eventTypeSchema,
  name: eventNameSchema.nullable(),

  occurred_at: utcInstantSchema,
  received_at: utcInstantSchema,
  accepted_at: utcInstantSchema,
  clock_skewed: z.boolean(),

  ingest_generation: z.number().int().min(0),
  billing_user_id: z.string().min(1),
  billing_assignment_version: z.number().int().min(0),
  /**
   * The usage window's `starts_at`, snapshotted by the collector.
   *
   * The collector cannot mint `usage_window_id`: the row is created by the
   * worker's idempotent compute-or-create (plan M6 item 12), and minting it
   * would be a Postgres write on the ingest path. It carries the deterministic
   * half instead — the same `(user_id, starts_at)` key the unique constraint
   * uses — so the worker can resolve the row and correct a stale assignment
   * snapshot against version history (02 §7.1 item 10).
   */
  usage_window_start: utcInstantSchema,
  usage_window_id: z.string().min(1).nullable(),
  /**
   * Accepted under the D-012 24-hour ingest grace of a `suspended` site.
   *
   * Marked because such usage belongs to the blocked billing user and is only
   * reconciled into their first active window if *that same user* restores
   * entitlement — it is never carried over to a later owner.
   */
  billing_grace: z.boolean(),
  /** Server-computed usage class (D-101). Never echoed from the request. */
  billable: z.boolean(),
  /**
   * The no-code rule that produced this event, or `null` (ADR-0034, D5).
   *
   * Server-established: present only when the collector resolved the client's
   * claimed `rule_id` against the site's published rule set and the event name
   * matched. It is stored so "which rule produced this event" is answerable
   * from the row rather than reconstructed from a name and a timestamp.
   */
  rule_id: z.string().min(1).max(64).nullable(),
  /** The definition version the rule came from, or `null`. */
  rule_version: z.number().int().min(1).nullable(),

  anonymous_id: z.string().min(1),
  session_id: z.string().min(1).nullable(),
  user_id: z.string().min(1).nullable(),

  page: z
    .strictObject({
      url: z.string().max(EVENT_LIMITS.urlMaxLength),
      path: z.string().max(EVENT_LIMITS.urlMaxLength),
      title: z.string().max(EVENT_LIMITS.pageTitleMaxLength).nullable(),
    })
    .nullable(),

  source: z.strictObject({
    referrer_domain: z.string().nullable(),
    referrer_path: z.string().nullable(),
    utm_source: z.string().nullable(),
    utm_medium: z.string().nullable(),
    utm_campaign: z.string().nullable(),
    utm_content: z.string().nullable(),
    utm_term: z.string().nullable(),
  }),

  properties: eventPropertiesSchema,

  context: z.strictObject({
    sdk: z.string(),
    sdk_version: z.string(),
    device_type: z.string().nullable(),
    browser: z.string().nullable(),
    os: z.string().nullable(),
    country: z.string().length(2).nullable(),
    city: z.string().nullable(),
  }),

  interaction: interactionPayloadSchema.nullable().optional(),
  engagement: engagementPayloadSchema.nullable().optional(),
  web_vital: webVitalPayloadSchema.nullable().optional(),
})

export type PersistedEvent = z.infer<typeof persistedEventSchema>

/**
 * Tracker configuration served to the browser (docs snapshot 02 §11).
 *
 * Cached by `ETag`; `config_version` comes from the site row and is bumped by a
 * dashboard change. The response never contains the tracking key or anything a
 * reader could use as authorization.
 */
export const trackerConfigSchema = z.strictObject({
  config_version: z.number().int().min(1),
  site_timezone: z.string().min(1),
  allowed_domains: z.array(z.string().min(1)).max(100),
  /** Query keys stripped from URLs before they leave the browser. */
  redact_query_keys: z.array(z.string().min(1).max(64)).max(200),
  /** Fraction of clicks reported as heatmap `interaction` signals, 0…1. */
  interaction_sampling: z.number().min(0).max(1),
  /**
   * Realtime presence interval the tracker should use, in seconds.
   *
   * The ceiling is **derived from the presence window, not chosen** (ADR-0035,
   * D8): three intervals must fit inside it, so a visitor survives two
   * consecutive lost heartbeats. It was 300 — the whole window — which left the
   * pair configurable into permanent flicker.
   */
  heartbeat_interval_seconds: z
    .number()
    .int()
    .min(MIN_HEARTBEAT_INTERVAL_SECONDS)
    .max(MAX_HEARTBEAT_INTERVAL_SECONDS),
  features: z.strictObject({
    web_vitals: z.boolean(),
    engagement: z.boolean(),
    interactions: z.boolean(),
    heartbeat: z.boolean(),
  }),
  /**
   * Whether this site's browsers may send the revenue-linking hint — the
   * `order_id` property of a `conversion` event (ADR-0033 D6 signal 1).
   *
   * Outside `features` on purpose: those are measurement signals and default
   * on, and this one defaults **off** (ADR-0064 D4a). It is not consent and
   * does not stand in for it — the hint needs both this flag and a granted
   * consent, and the tracker checks them in that order.
   */
  attributed_revenue: z.boolean(),
  /**
   * Dashboard-defined no-code rules the tracker runtime evaluates (ADR-0034).
   *
   * **This shape changed in M13, deliberately.** M4 guessed it against no
   * implementation: `{rule_id, name, selector, event: click|submit|view}`, max
   * 200. `view` was never a browser primitive anyone had designed, the property
   * mapping the feature needs had nowhere to live, and 200 rules was a number
   * with no measurement behind it. Narrowing a published contract is only free
   * while every site is served an empty list, which was true until this
   * milestone and will never be true again — so it happened here.
   *
   * The maximum is 50, from the worst case per click ADR-0034 D2 states:
   * 50 rules x one `closest()` each, over an ancestor chain, with a selector of
   * at most 12 simple parts.
   */
  no_code_rules: z
    .array(
      z.strictObject({
        rule_id: z.string().min(1),
        /** The canonical event name a match produces. */
        name: eventNameSchema,
        /**
         * The definition version this rule came from.
         *
         * Sent so a preview and a published rule set are distinguishable in the
         * events they produce, and so a support question about "which rules was
         * this browser running" has an answer that does not depend on guessing
         * from the config epoch.
         */
        version: z.number().int().min(1),
        trigger: z.enum(['click', 'submit', 'url_pattern']),
        /** Present for `click` and `submit`. A restricted grammar, not full CSS. */
        selector: z.string().min(1).max(EVENT_LIMITS.selectorMaxLength).optional(),
        /** Present for `url_pattern`. A path glob, never a regular expression. */
        url_pattern: z.string().min(1).max(512).optional(),
        properties: z
          .array(
            z.strictObject({
              key: propertyKeySchema,
              source: z.enum([
                'text',
                'element_tag',
                'page_path',
                'page_url',
                'page_title',
                'attribute',
                'url_param',
                'constant',
              ]),
              argument: z.string().max(256).optional(),
            }),
          )
          .max(8)
          .optional(),
      }),
    )
    .max(50),
})

export type TrackerConfig = z.infer<typeof trackerConfigSchema>
