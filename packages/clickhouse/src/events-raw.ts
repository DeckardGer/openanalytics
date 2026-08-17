import type { PersistedEvent } from '@openanalytics/contracts'

/**
 * The `analytics.events_raw` row and the mapping from the server envelope
 * (docs snapshot 02 §8, §15; migration 0001).
 *
 * One row per accepted event. The mapping is pure and total: every envelope
 * field either becomes a column or is folded into `properties`, and nothing is
 * silently dropped. That completeness is the point — an envelope field with no
 * destination is data a customer sent, the collector accepted and answered
 * `202` for, and the worker then threw away.
 */

export const EVENTS_RAW_TABLE = 'events_raw'

/**
 * Prefix for server-owned keys folded into the properties JSON.
 *
 * The M4 contract reserves it: `propertyKeySchema` rejects any client property
 * key starting with `oa_` (case-insensitively). So a folded field can never
 * shadow a value a customer sent, and a customer can never forge one — which is
 * what makes it safe to read these back as though the server had written them,
 * because it did.
 */
export const OA_PROPERTY_PREFIX = 'oa_'

/**
 * Ceiling on the serialized properties JSON, in bytes.
 *
 * Docs snapshot 02 §15 requires properties to be stored "bounded". The M4
 * contract already bounds what a client may send (32 keys, 256-byte values), and
 * the folded server keys are a fixed, small set — so this is a backstop against
 * a future field rather than a limit ordinary traffic approaches. Exceeding it
 * truncates to the folded server keys alone rather than dropping the row: the
 * typed payload is what the analytics schema is built on, and a row is worth
 * more than the client properties attached to it.
 */
export const MAX_PROPERTIES_BYTES = 16_384

export interface EventsRawRow {
  readonly schema_version: number
  readonly site_id: string
  readonly event_id: string
  readonly batch_id: string
  readonly type: string
  readonly name: string
  readonly origin: string
  readonly occurred_at: string
  readonly received_at: string
  readonly accepted_at: string
  readonly clock_skewed: number
  readonly ingest_generation: number
  readonly billing_user_id: string
  readonly billing_assignment_version: number
  readonly usage_window_start: string
  readonly billing_grace: number
  readonly billable: number
  /** The no-code rule that produced this event; empty when none did. */
  readonly rule_id: string
  readonly anonymous_id: string
  readonly session_id: string
  readonly user_id: string
  readonly page_url: string
  readonly page_path: string
  readonly page_title: string
  readonly referrer_domain: string
  readonly referrer_path: string
  readonly utm_source: string
  readonly utm_medium: string
  readonly utm_campaign: string
  readonly utm_content: string
  readonly utm_term: string
  readonly properties: string
  readonly sdk: string
  readonly sdk_version: string
  readonly device_type: string
  readonly browser: string
  readonly os: string
  readonly country: string
  readonly city: string
}

/**
 * ClickHouse `DateTime64(3, 'UTC')` literal.
 *
 * `2026-07-23T10:00:00.000Z` becomes `2026-07-23 10:00:00.000`. The client sends
 * JSONEachRow, where a `Z`-suffixed ISO string is not a value the column parses,
 * and a rejected timestamp would fail the whole insert.
 */
export function toClickHouseDateTime64(instant: string): string {
  const at = new Date(instant)
  if (Number.isNaN(at.getTime())) {
    throw new RangeError(`Invalid instant for a DateTime64 column: ${instant}`)
  }
  return at.toISOString().replace('T', ' ').replace('Z', '')
}

type ScalarProperty = string | number | boolean | null

/**
 * Folds the envelope's typed payloads into the properties object.
 *
 * `web_vital`, `engagement` and `interaction` are separate envelope fields, not
 * properties (contracts `persistedEventSchema`). `events_raw` has one bounded
 * properties column and no per-type columns, so without this fold every heatmap
 * click, every engagement measurement and every web vital the collector accepted
 * would reach ClickHouse as an event with no payload — accepted, billed where
 * applicable, and analytically empty.
 *
 * Server keys are written last and therefore win, but the `oa_` reservation
 * means there is nothing for them to collide with.
 */
export function foldServerPayload(event: PersistedEvent): Record<string, ScalarProperty> {
  const folded: Record<string, ScalarProperty> = { ...event.properties }
  const set = (key: string, value: ScalarProperty): void => {
    folded[`${OA_PROPERTY_PREFIX}${key}`] = value
  }

  if (event.web_vital) {
    set('metric', event.web_vital.metric)
    set('value', event.web_vital.value)
    set('rating', event.web_vital.rating ?? '')
    set('navigation_type', event.web_vital.navigation_type ?? '')
  }

  if (event.engagement) {
    set('active_ms', event.engagement.active_ms)
    set('visible_ms', event.engagement.visible_ms)
  }

  if (event.interaction) {
    set('x_percent', event.interaction.x_percent)
    set('y_percent', event.interaction.y_percent)
    set('viewport_class', event.interaction.viewport_class)
    set('viewport_width', event.interaction.viewport_width)
    set('selector', event.interaction.selector)
    set('text', event.interaction.text ?? '')
  }

  return folded
}

/** Serializes the folded properties, bounded per §15. */
export function serializeProperties(event: PersistedEvent): string {
  const folded = foldServerPayload(event)
  const json = JSON.stringify(folded)
  if (json.length <= MAX_PROPERTIES_BYTES) return json

  // Drop the client half rather than the row. The typed payload is what the
  // analytics schema reads; an oversized client properties bag is the part that
  // can be lost without changing what any metric means.
  const serverOnly = Object.fromEntries(
    Object.entries(folded).filter(([key]) => key.startsWith(OA_PROPERTY_PREFIX)),
  )
  return JSON.stringify(serverOnly)
}

/**
 * Where the event came from (docs snapshot 02 §15's `source origin` column).
 *
 * Every event on this path arrived through the public collector, so it is
 * `live`. Import, server-side SDK and widget traffic reach ClickHouse through
 * their own milestones, and each will name itself rather than inheriting this
 * default — which is why it is a parameter with a default and not a literal in
 * the row.
 */
export const EVENT_SOURCE_ORIGINS = ['live', 'import', 'server', 'widget'] as const
export type EventSourceOrigin = (typeof EVENT_SOURCE_ORIGINS)[number]

export interface ToEventsRawRowOptions {
  readonly batchId: string
  readonly origin?: EventSourceOrigin
}

/**
 * Envelope to row.
 *
 * Nullable envelope fields become empty strings rather than ClickHouse
 * `Nullable` columns: the schema is queried with `!= ''` filters and a Nullable
 * column costs a second mark stream on every read for a distinction the type
 * column already makes (migration 0001).
 */
export function toEventsRawRow(
  event: PersistedEvent,
  options: ToEventsRawRowOptions,
): EventsRawRow {
  return {
    schema_version: event.schema_version,
    site_id: event.site_id,
    event_id: event.event_id,
    batch_id: options.batchId,
    type: event.type,
    name: event.name ?? '',
    origin: options.origin ?? 'live',

    occurred_at: toClickHouseDateTime64(event.occurred_at),
    received_at: toClickHouseDateTime64(event.received_at),
    accepted_at: toClickHouseDateTime64(event.accepted_at),
    clock_skewed: event.clock_skewed ? 1 : 0,

    ingest_generation: event.ingest_generation,
    billing_user_id: event.billing_user_id,
    billing_assignment_version: event.billing_assignment_version,
    usage_window_start: toClickHouseDateTime64(event.usage_window_start),
    billing_grace: event.billing_grace ? 1 : 0,
    billable: event.billable ? 1 : 0,
    // Empty for every event no rule produced, which is the honest value rather
    // than a null: the column exists so "which rule produced this" is a read,
    // not a reconstruction from a name and a timestamp.
    rule_id: event.rule_id ?? '',

    anonymous_id: event.anonymous_id,
    session_id: event.session_id ?? '',
    user_id: event.user_id ?? '',

    page_url: event.page?.url ?? '',
    page_path: event.page?.path ?? '',
    page_title: event.page?.title ?? '',

    referrer_domain: event.source.referrer_domain ?? '',
    referrer_path: event.source.referrer_path ?? '',
    utm_source: event.source.utm_source ?? '',
    utm_medium: event.source.utm_medium ?? '',
    utm_campaign: event.source.utm_campaign ?? '',
    utm_content: event.source.utm_content ?? '',
    utm_term: event.source.utm_term ?? '',

    properties: serializeProperties(event),

    sdk: event.context.sdk,
    sdk_version: event.context.sdk_version,
    device_type: event.context.device_type ?? '',
    browser: event.context.browser ?? '',
    os: event.context.os ?? '',
    country: event.context.country ?? '',
    city: event.context.city ?? '',
  }
}
