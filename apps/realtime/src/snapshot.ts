import type {
  PublicRealtimeSnapshot,
  RealtimeControl,
  RealtimeControlAction,
  RealtimeControlReason,
  RealtimeDeviceType,
  RealtimeFeedEvent,
  RealtimePresentVisitor,
  RealtimeSnapshot,
} from '@openanalytics/contracts'
import { REALTIME_DEVICE_TYPES } from '@openanalytics/contracts'
import type { PresenceFeedEntry, PresenceSnapshot, PresenceVisitor } from '@openanalytics/redis'

/**
 * Wire formatters for the SSE payloads (docs snapshot 02 §17, 05 D-213).
 *
 * One presence recompute (`readPresenceSnapshot`) feeds every subscribed client;
 * these turn that single result into the per-scope payload each client is owed —
 * cheap pure functions, so the "one compute, N sends" fan-out never re-scans.
 *
 * The private and public shapes are deliberately built by separate functions
 * over separate types: D-213 forbids the public payload from reusing the private
 * one, and keeping them apart here means a future field added to the private
 * breakdown cannot leak into the public allowlist by a shared edit.
 */

const KNOWN_DEVICE_TYPES: ReadonlySet<string> = new Set(REALTIME_DEVICE_TYPES)

/** Coerces an out-of-vocabulary device label to `unknown` (a first-class bucket),
 * so a presence row can never push a value the snapshot contract forbids. */
function toDeviceType(value: string): RealtimeDeviceType {
  return KNOWN_DEVICE_TYPES.has(value) ? (value as RealtimeDeviceType) : 'unknown'
}

export function toPrivateSnapshot(presence: PresenceSnapshot, generatedAt: Date): RealtimeSnapshot {
  return {
    type: 'snapshot',
    generated_at: generatedAt.toISOString(),
    active_visitors: presence.activeVisitors,
    pages: presence.pages.map((page) => ({ path: page.path, visitors: page.visitors })),
    countries: presence.countries.map((country) => ({
      country: country.country,
      visitors: country.visitors,
    })),
    devices: presence.devices.map((device) => ({
      device_type: toDeviceType(device.deviceType),
      visitors: device.visitors,
    })),
    browsers: presence.browsers.map((browser) => ({
      browser: browser.browser,
      visitors: browser.visitors,
    })),
    operating_systems: presence.operatingSystems.map((entry) => ({
      os: entry.os,
      visitors: entry.visitors,
    })),
    // Private only (ADR-0024). `toPublicSnapshot` below is a separate function
    // over a separate type, so these lines have no public counterpart to drift
    // into.
    cities: presence.cities.map((city) => ({ city: city.city, visitors: city.visitors })),
    events: presence.events.map(toFeedEvent),
    present: presence.present.map(toPresentVisitor),
  }
}

/**
 * One present visitor as the wire row (ADR-0035, D3).
 *
 * The device label takes the same coercion the breakdown and the feed take, so
 * an out-of-vocabulary value cannot push a row the contract's enum forbids. Note
 * what is *not* copied across: the presence metadata holds a city and this row
 * does not carry one, which is the D3 decision expressed where it is enforced.
 */
function toPresentVisitor(entry: PresenceVisitor): RealtimePresentVisitor {
  return {
    visitor: entry.visitorId,
    last_seen_at: new Date(entry.lastSeenMs).toISOString(),
    path: entry.path,
    country: entry.country,
    device_type: entry.deviceType === null ? null : toDeviceType(entry.deviceType),
    browser: entry.browser,
    os: entry.os,
  }
}

/**
 * One stored feed entry as the wire event.
 *
 * The device label goes through the same coercion the breakdown uses, so an
 * out-of-vocabulary value cannot push a row the contract's enum forbids; the
 * absent case stays `null`, which is a different statement from `unknown` — one
 * says "not recorded", the other "recorded as unrecognised".
 */
function toFeedEvent(entry: PresenceFeedEntry): RealtimeFeedEvent {
  return {
    event_id: entry.eventId,
    occurred_at: new Date(entry.occurredAtMs).toISOString(),
    visitor: entry.visitorId,
    path: entry.path,
    country: entry.country,
    device_type: entry.deviceType === null ? null : toDeviceType(entry.deviceType),
    browser: entry.browser,
    os: entry.os,
    referrer: entry.referrer,
  }
}

export function toPublicSnapshot(
  presence: PresenceSnapshot,
  generatedAt: Date,
): PublicRealtimeSnapshot {
  return {
    type: 'snapshot',
    generated_at: generatedAt.toISOString(),
    active_visitors: presence.activeVisitors,
  }
}

export function controlMessage(
  action: RealtimeControlAction,
  reason: RealtimeControlReason,
): RealtimeControl {
  return { type: 'control', action, reason }
}
