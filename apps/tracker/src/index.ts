/**
 * Open Analytics browser tracker (v2).
 *
 * Dependency-free by construction: nothing under `apps/tracker/src` imports a
 * workspace package or a bare specifier, and `pnpm run boundaries` fails the
 * build if that changes. The legacy `public/v1.js` is not a starting point — it
 * is audited as a source of defects to avoid (docs snapshot 01 §5), and
 * backwards compatibility is explicitly not required (docs snapshot 05, D-004).
 *
 * The invariants the implementation keeps:
 *
 * - Every historical event carries a client-generated UUIDv7 `event_id`, minted
 *   *before* the first send attempt. A server-generated id cannot deduplicate a
 *   retry whose response was lost (docs snapshot 02 §7.1).
 * - `window.oa` is never overwritten when it belongs to someone else.
 * - The raw URL is never sent: fragments and sensitive query keys are stripped
 *   in the browser, and again on the server.
 * - The retry queue is bounded and expires at 24h; the server's time boundary is
 *   always the final authority.
 * - Heartbeats go to the realtime endpoint only, never into the historical batch.
 * - An input's value is never read, at any layer.
 *
 * This module is the typed entry point for tests and for an embedder that wants
 * the runtime without the auto-boot; `browser.ts` is the bundle entry that boots
 * itself from a script tag.
 */

export {
  DEFAULT_RUNTIME_CONFIG,
  createTracker,
  type Tracker,
  type TrackerConfigPatch,
  type TrackerOptions,
  type TrackerRuntimeConfig,
} from './core.ts'

export {
  CONFIG_CACHE_TTL_MS,
  loadTrackerConfig,
  toRuntimeConfig,
  type ConfigLoaderDeps,
} from './config.ts'

export {
  installTracker,
  optionsFromScript,
  type InstallOutcome,
  type InstallResult,
} from './install.ts'

export {
  DEFAULT_PRIVACY_POLICY,
  createPrivacyGate,
  readDnt,
  readGpc,
  type ConsentState,
  type PrivacyPolicy,
  type PrivacySignals,
} from './privacy.ts'

export {
  DEFAULT_REDACT_QUERY_KEYS,
  REDACTED,
  isValidEventName,
  redactText,
  sanitizeProperties,
  sanitizeReferrer,
  sanitizeUrl,
  truncate,
} from './sanitize.ts'

export { IGNORE_KEY, resolveIgnore, showIgnoreNotice, type IgnoreDecision } from './ignore.ts'
export { createRetryQueue, createSessionTracker, safeStorage } from './storage.ts'
export { INGEST_CONTENT_TYPE, createTransport } from './transport.ts'
export { createUuidV7, uuidV7 } from './uuid.ts'
export { createEngagement } from './engagement.ts'
export { createWebVitals } from './vitals.ts'
export { bearsUserInput, createInteractions, selectorFor, viewportClass } from './interaction.ts'
export {
  RULE_BUDGET_MS,
  createRules,
  matchesPattern,
  type NoCodeRule,
  type RuleMatch,
  type RuleTrigger,
  type Rules,
} from './rules.ts'
export { createHeartbeat } from './heartbeat.ts'

export {
  ACTIVITY_WINDOW_MS,
  HEARTBEAT_INTERVAL_SECONDS,
  INTERACTION_MAX_PER_PAGE,
  INTERACTION_THROTTLE_MS,
  LIMITS,
  RETRY_MAX_EVENTS,
  RETRY_TTL_MS,
  SESSION_INACTIVITY_MS,
  TRACKER_SCHEMA_VERSION,
  TRACKER_SDK,
  TRACKER_VERSION,
  VIEWPORT_BREAKPOINTS,
} from './constants.ts'

export type {
  EngagementPayload,
  EventBatchBody,
  HeartbeatBody,
  InteractionPayload,
  TrackerContext,
  TrackerEvent,
  TrackerEventType,
  TrackerPage,
  ViewportClass,
  WebVitalPayload,
} from './types.ts'
