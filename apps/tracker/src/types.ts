import type { PropertyValue } from './sanitize.ts'

/**
 * The wire shapes the tracker produces.
 *
 * Structurally identical to `ClientEvent` / `EventBatch` / `HeartbeatRequest` in
 * `@openanalytics/contracts`, restated here so the bundle carries no dependency.
 * `tests/tracker/contract-alignment.test.ts` parses real tracker output with the
 * real schemas, so this restatement cannot drift unnoticed.
 *
 * Note what is absent and stays absent: `site_id`, geo, `billing_user_id`,
 * `usage_window_id`, `billable`, `accepted_at`. The tracker has no field to put
 * them in, which is the client half of the Milestone 4 acceptance criterion.
 */

export type TrackerEventType =
  | 'page_view'
  | 'custom_event'
  | 'conversion'
  | 'identify'
  | 'engagement'
  | 'web_vital'
  | 'interaction'

export interface TrackerPage {
  readonly url: string
  readonly title?: string
}

export interface EngagementPayload {
  readonly active_ms: number
  readonly visible_ms: number
}

export type WebVitalMetric = 'LCP' | 'CLS' | 'INP' | 'FCP' | 'TTFB'

export interface WebVitalPayload {
  readonly metric: WebVitalMetric
  readonly value: number
  readonly rating?: 'good' | 'needs-improvement' | 'poor'
}

export type ViewportClass = 'mobile' | 'tablet' | 'desktop' | 'wide'

export interface InteractionPayload {
  readonly x_percent: number
  readonly y_percent: number
  readonly viewport_class: ViewportClass
  readonly viewport_width: number
  readonly selector: string
  /** Element text, already redacted and truncated. Never an input's value. */
  readonly text?: string
}

export interface TrackerEvent {
  readonly event_id: string
  readonly type: TrackerEventType
  readonly occurred_at: string
  readonly client_session_id?: string
  readonly action_id?: string
  readonly page?: TrackerPage
  readonly referrer?: string
  readonly properties?: Record<string, PropertyValue>
  readonly name?: string
  /** The no-code rule that produced this event (ADR-0034, D5). A claim the
   * server checks against the site's published rules, never a grant. */
  readonly rule_id?: string
  readonly external_user_id?: string
  readonly engagement?: EngagementPayload
  readonly web_vital?: WebVitalPayload
  readonly interaction?: InteractionPayload
}

export interface TrackerContext {
  readonly sdk: 'web'
  readonly sdk_version: string
}

export interface EventBatchBody {
  readonly schema_version: number
  readonly tracking_key: string
  readonly sent_at: string
  readonly context: TrackerContext
  readonly events: readonly TrackerEvent[]
}

export interface HeartbeatBody {
  readonly schema_version: number
  readonly tracking_key: string
  readonly sent_at: string
  readonly context: TrackerContext
  readonly client_session_id?: string
  readonly page?: TrackerPage
}
