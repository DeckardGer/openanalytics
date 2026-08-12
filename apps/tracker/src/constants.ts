/**
 * Tracker constants.
 *
 * These mirror `EVENT_LIMITS` and `EVENT_SCHEMA_VERSION` in
 * `@openanalytics/contracts`. They are copied rather than imported on purpose:
 * this bundle ships to third-party sites and must stay dependency-free, and
 * importing the contract package would pull a schema validator into every
 * visitor's browser.
 *
 * The copy is not left to trust — `tests/tracker/contract-alignment.test.ts`
 * fails if any value here drifts from the contract, and the tracker's own
 * payloads are validated against the real schemas there.
 */

export const TRACKER_SCHEMA_VERSION = 1
export const TRACKER_SDK = 'web'
export const TRACKER_VERSION = '2.0.0'

/** Mirrors `EVENT_LIMITS`. Enforced client-side so a bad call fails locally. */
export const LIMITS = {
  eventNameMaxLength: 64,
  propertyKeyMaxLength: 40,
  propertyValueMaxLength: 256,
  maxPropertiesPerEvent: 32,
  urlMaxLength: 1024,
  referrerMaxLength: 1024,
  pageTitleMaxLength: 256,
  selectorMaxLength: 256,
  elementTextMaxLength: 128,
  externalUserIdMaxLength: 128,
  clientSessionIdMaxLength: 64,
  actionIdMaxLength: 64,
  maxEventsPerBatch: 100,
  maxBatchBytes: 262_144,
} as const

/**
 * Retry horizon. Docs snapshot 02 §7.3: the offline queue is bounded and TTL'd,
 * and it never outlives the server's 24h acceptance boundary — an event the
 * collector would reject is dropped here rather than retried forever.
 */
export const RETRY_TTL_MS = 24 * 60 * 60 * 1000

/** Hard cap on stored events, so a long offline period cannot fill storage. */
export const RETRY_MAX_EVENTS = 200

/** Analytics session inactivity window (docs snapshot 02 §10). */
export const SESSION_INACTIVITY_MS = 30 * 60 * 1000

/** How long non-critical events wait to be batched with their neighbours. */
export const BATCH_DELAY_MS = 1_000

/** Minimum gap between two reported heatmap clicks. */
export const INTERACTION_THROTTLE_MS = 250

/** Per-pageview ceiling on heatmap clicks, before sampling. */
export const INTERACTION_MAX_PER_PAGE = 100

/** Default realtime presence interval; tracker config may override it. */
export const HEARTBEAT_INTERVAL_SECONDS = 15

/**
 * Engagement heuristic: a visitor counts as active for this long after an
 * interaction, while the page is visible (docs snapshot 02 §10 — "visible and
 * active time", not wall-clock time on page).
 */
export const ACTIVITY_WINDOW_MS = 5_000

/** Viewport class breakpoints, in CSS pixels. */
export const VIEWPORT_BREAKPOINTS = { mobile: 640, tablet: 1024, desktop: 1600 } as const
