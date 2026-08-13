import {
  MAX_HEARTBEAT_INTERVAL_SECONDS,
  MIN_HEARTBEAT_INTERVAL_SECONDS,
  PRESENCE_WINDOW_HEARTBEAT_RATIO,
} from '@openanalytics/contracts'

/**
 * Defaults for a site's tracker configuration (docs snapshot 02 §11).
 *
 * `site_ingest_settings` (migration 0014) is an optional row: a site acquires
 * one when a dashboard change writes it, and until then the collector serves
 * these. That is what made the migration a pure expand with no backfill — but it
 * also means these values are what most sites actually run on, so they live here
 * rather than as literals in the repository that happens to read the row.
 *
 * The tracker carries its own copy of these defaults for the first page load,
 * before any config request has completed (`apps/tracker/src/core.ts`). The two
 * must agree, or a visitor's first pageview would be tracked under different
 * rules from their second; `tests/tracker/config.test.ts` and the contract tests
 * hold that line.
 */

/**
 * Whether a heartbeat interval is one a site may be configured with
 * (ADR-0035, D8).
 *
 * The rule is the presence window, not a taste: three intervals must fit inside
 * it, so a visitor survives two consecutive lost heartbeats. Enforced at write
 * time as well as by the column's `CHECK` (migration 0039) and the published
 * contract, because a value outside it does not fail loudly — it produces a
 * board that flickers, which reads as a bug in everything except the setting
 * that caused it.
 */
export function isValidHeartbeatIntervalSeconds(seconds: number): boolean {
  return (
    Number.isInteger(seconds) &&
    seconds >= MIN_HEARTBEAT_INTERVAL_SECONDS &&
    seconds <= MAX_HEARTBEAT_INTERVAL_SECONDS
  )
}

/**
 * Thrown by a settings write given a value the presence window forbids.
 *
 * **An HTTP writer must map this to `400 VALIDATION_FAILED`.** There is none
 * today — `heartbeat_interval_seconds` appears in `trackerConfigSchema`, which
 * is parsed on the way *out* (`apps/collector/src/tracker-config.ts:120`), and
 * no endpoint accepts it as input. Whoever adds the site-settings PATCH has to
 * catch this: an uncaught throw out of a route handler is a 500, and a customer
 * typing 200 into a form deserves to be told the bound, not shown a server
 * error.
 */
export class InvalidHeartbeatIntervalError extends Error {
  readonly seconds: number

  constructor(seconds: number) {
    super(
      `heartbeat_interval_seconds must be an integer in ` +
        `[${MIN_HEARTBEAT_INTERVAL_SECONDS}, ${MAX_HEARTBEAT_INTERVAL_SECONDS}] — the presence ` +
        `window must hold ${PRESENCE_WINDOW_HEARTBEAT_RATIO} intervals so a visitor survives two ` +
        `consecutive lost heartbeats (ADR-0035); got ${seconds}`,
    )
    this.name = 'InvalidHeartbeatIntervalError'
    this.seconds = seconds
  }
}

export interface TrackerFeatureFlags {
  readonly web_vitals: boolean
  readonly engagement: boolean
  readonly interactions: boolean
  readonly heartbeat: boolean
}

export interface SiteTrackerSettings {
  readonly timezone: string
  readonly redactQueryKeys: readonly string[]
  readonly interactionSampling: number
  readonly heartbeatIntervalSeconds: number
  readonly features: TrackerFeatureFlags
  /**
   * Whether this site's browsers may send the revenue-linking hint (ADR-0064
   * D4a, migration 0043).
   *
   * Deliberately not inside `features`: those are measurement signals and
   * default on, this is a linking signal and defaults off. It is also not the
   * same question as consent — the visitor's consent decides whether a hint
   * *may* be sent, and this decides whether the site wants one at all. The
   * choice is enforced at the signal, in the browser: with the flag off the
   * tracker sends no hint even from a visitor who granted consent, so a site
   * that has not opted in cannot be attributing revenue by accident.
   */
  readonly attributedRevenue: boolean
}

/**
 * `UTC` for the timezone, because a wrong guess is worse than a neutral one: a
 * dashboard grouped in a timezone the customer did not choose looks like missing
 * traffic at the day boundary. It affects grouping only — the anonymous
 * identity's rotation day is always the UTC calendar date (D-102).
 *
 * Sampling reports every click. ADR-0008 rejected default sampling as an
 * invented product decision: it silently distorts a heatmap, and the tracker's
 * throttle plus its per-pageview ceiling already bound the volume.
 *
 * The heartbeat interval matches the tracker's own `HEARTBEAT_INTERVAL_SECONDS`.
 *
 * `attributedRevenue` is the one value here that is off by default, and the
 * reason is the one ADR-0064 turns on: everything else is measurement, and this
 * is the flag that lets a browser send a hint tying a visitor to an order.
 */
export const DEFAULT_TRACKER_SETTINGS: SiteTrackerSettings = {
  timezone: 'UTC',
  redactQueryKeys: [],
  interactionSampling: 1,
  heartbeatIntervalSeconds: 15,
  features: {
    web_vitals: true,
    engagement: true,
    interactions: true,
    heartbeat: true,
  },
  attributedRevenue: false,
}
