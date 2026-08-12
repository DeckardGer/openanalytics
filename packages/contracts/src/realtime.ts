import { z } from 'zod'
import { utcInstantSchema } from './time.ts'

/**
 * Realtime surface contract (docs snapshot 02 §17, 05 D-213).
 *
 * Three request/response shapes and the SSE payloads the stream carries live
 * here, and the separation between the private and the public shape is the point
 * rather than a convenience:
 *
 * - A short-lived scoped token is issued by the api and verified by the realtime
 *   gateway; the response tells the client when it expires and how often the
 *   gateway re-checks the access epoch.
 * - The private snapshot carries the full active-visitor breakdown. The public
 *   snapshot is a deliberately separate, narrower schema — D-213 forbids the
 *   public payload from reusing the private shape, so it cannot drift into
 *   exposing more than its allowlist by a shared edit.
 * - Control messages carry disconnects and degraded/recovered transitions.
 *
 * City appears in the **private** snapshot only (ADR-0024). It is the coarse
 * GeoLite2 label the collector already resolves for the persisted event, and the
 * private surface is an authenticated member of the site looking at their own
 * traffic. The public snapshot is a separate schema with `active_visitors` alone,
 * so no city can reach it; G-008 coarsening stays a historical-read concern.
 */

/** Bounded lists in a snapshot (docs snapshot 02 §17). */
export const REALTIME_SNAPSHOT_TOP_N = 10

/**
 * How many heartbeat intervals must fit inside the presence window (ADR-0035, D8).
 *
 * Three, so a visitor survives **two consecutive lost heartbeats**: the third
 * beat after the last successful one still lands inside the window. Two would
 * mean one dropped ping drops a present visitor off the board, which is the
 * flicker this rule exists to make unconfigurable.
 */
export const PRESENCE_WINDOW_HEARTBEAT_RATIO = 3

/** Floor on the tracker's presence interval — a ping every few seconds is a
 * battery cost with no presence benefit at any window. */
export const MIN_HEARTBEAT_INTERVAL_SECONDS = 5

/**
 * Ceiling on the tracker's presence interval, in seconds.
 *
 * Derived rather than chosen: `VISITOR_PRESENCE_WINDOW_MS / 1000 /
 * PRESENCE_WINDOW_HEARTBEAT_RATIO` = 300 / 3. It was **300** — equal to the
 * whole window — which meant the pair was configurable into permanent flicker,
 * every visitor's presence expiring exactly as their next beat arrived. The two
 * packages share no import, so a unit test pins this against the window itself.
 *
 * Narrowing a published maximum is only free while nothing is served a value it
 * excludes, which is checked rather than assumed: production has **zero rows** in
 * `site_ingest_settings` and no API surface writes the column, so every site runs
 * the 15-second default from the repository fallback. The same reason M13's rule
 * cap went 200 → 50.
 */
export const MAX_HEARTBEAT_INTERVAL_SECONDS = 100

/** Page views the snapshot's rolling feed carries at most (ADR-0024). */
export const REALTIME_FEED_MAX_EVENTS = 50

/**
 * How old a snapshot may be before a client must stop believing it (ADR-0035).
 *
 * The gateway recomputes on a timer while anyone is connected
 * (`REALTIME_SNAPSHOT_REFRESH_SECONDS`, 10 s by default), so a snapshot that has
 * not been replaced in this long means the **stream is dead**, not that the site
 * is quiet. Before the timer existed the hub only recomputed on traffic, so a
 * client could not tell the two apart at all and the board guessed with a
 * hand-tuned 90 s.
 *
 * **The value is the budget for one bad tick, and that is why it is 40 and not
 * 30.** The gateway suppresses an unchanged snapshot for half this value, which
 * at a 10 s cadence makes the steady gap 20 s. A single *failed or slow*
 * recompute costs one whole tick, taking the worst gap to 30 s — so a 30-second
 * threshold left exactly **zero** margin and would show a "live paused" flicker
 * the first time one Redis read was slow. At 40 the same event lands 10 s inside
 * the threshold. Widening it costs 10 s of detection latency on a genuinely dead
 * stream, which the ≤15 s keepalive and the `degraded` control both notice
 * sooner anyway.
 *
 * Raising it does **not** make the stream chattier or quieter: the floor is
 * derived from this (`maxAge / 2`), and 15 s and 20 s both round up to the same
 * 20-second gap at a 10-second cadence. Server behaviour is unchanged; only the
 * client's patience moves.
 *
 * It is stated on the wire side, in seconds, because the consumer is a browser
 * that cannot read policy: the client compares it against `generated_at` and
 * shows its connection state instead of a stale crowd. Mirrored against the
 * gateway's cadence the way `REALTIME_FEED_MAX_EVENTS` mirrors
 * `PRESENCE_FEED_MAX` — the two packages share no import, and a test pins the
 * relation including the missed-tick allowance.
 */
export const REALTIME_SNAPSHOT_MAX_AGE_SECONDS = 40

/** Device buckets a snapshot may report; `unknown` is a first-class bucket. */
export const REALTIME_DEVICE_TYPES = ['desktop', 'mobile', 'tablet', 'unknown'] as const
export type RealtimeDeviceType = (typeof REALTIME_DEVICE_TYPES)[number]

/** Disconnect/degraded/recovered transitions a control message announces. */
export const REALTIME_CONTROL_ACTIONS = ['disconnect', 'degraded', 'recovered'] as const
export type RealtimeControlAction = (typeof REALTIME_CONTROL_ACTIONS)[number]

/**
 * Stable, minimal reason enum. The disconnect reasons cover the two ways a
 * private stream is closed against the client's wishes — a revoked member
 * (`access_revoked`) and the fail-closed path when auth/Redis state cannot be
 * read (`auth_unreachable`) — plus the ordinary "your token is old, reconnect"
 * (`token_expired_reconnect`). `snapshot_unavailable`/`ok` carry the degraded and
 * recovered transitions.
 */
export const REALTIME_CONTROL_REASONS = [
  'access_revoked',
  'auth_unreachable',
  'token_expired_reconnect',
  'snapshot_unavailable',
  'ok',
] as const
export type RealtimeControlReason = (typeof REALTIME_CONTROL_REASONS)[number]

/**
 * Response of both token endpoints (docs snapshot 02 §17).
 *
 * `epoch_check_seconds` is the cadence the gateway re-checks the access epoch,
 * capped at 15 by `REALTIME_EPOCH_CHECK_SECONDS`; the client uses it only to know
 * how quickly a revocation takes effect. The token is opaque to the client.
 */
export const realtimeTokenResponseSchema = z.strictObject({
  token: z.string().min(1),
  expires_at: utcInstantSchema,
  epoch_check_seconds: z.number().int().min(1).max(15),
})

export type RealtimeTokenResponse = z.infer<typeof realtimeTokenResponseSchema>

/**
 * Country label in a snapshot: a two-letter code, or the literal `unknown`.
 */
export const realtimeCountrySchema = z.union([z.string().length(2), z.literal('unknown')])

/**
 * One page view on the private stream's rolling feed (ADR-0024).
 *
 * `visitor` is the D-102 anonymous identity: a site-scoped HMAC that **rotates
 * at UTC midnight**. A visitor whose session crosses midnight therefore appears
 * under two different values, and the two cannot be linked — that is the privacy
 * decision D-102 makes, not a defect to work around in a client.
 *
 * Every field is the same sanitized value the persisted event carries: a path
 * with no query or fragment, a referrer domain, coarse geo and UA labels. There
 * is no raw URL, IP or user-agent string on the feed.
 */
export const realtimeFeedEventSchema = z.strictObject({
  event_id: z.string().min(1),
  occurred_at: utcInstantSchema,
  visitor: z.string().min(1),
  path: z.string(),
  country: realtimeCountrySchema.nullable(),
  device_type: z.enum(REALTIME_DEVICE_TYPES).nullable(),
  browser: z.string().nullable(),
  os: z.string().nullable(),
  referrer: z.string().nullable(),
})

export type RealtimeFeedEvent = z.infer<typeof realtimeFeedEventSchema>

/** Visitors the snapshot names individually (ADR-0035, D3). Mirrors
 * `PRESENCE_PRESENT_MAX` in @openanalytics/redis, the way
 * `REALTIME_FEED_MAX_EVENTS` mirrors `PRESENCE_FEED_MAX`. */
export const REALTIME_PRESENT_MAX_VISITORS = 50

/**
 * One visitor who is here right now (ADR-0035, D3).
 *
 * `active_visitors` says how many; this says **who**, which is what lets a board
 * draw a named row for a visitor reading one page for ten minutes instead of an
 * anonymous `+1`. It is the presence store's own state, not the page-view feed's:
 * a visitor kept alive by heartbeats alone appears here with no feed entry to
 * their name, which is precisely the case that used to be unrenderable.
 *
 * `visitor` is the D-102 anonymous identity, the same value `RealtimeFeedEvent`
 * carries, and it **rotates at UTC midnight** — a visitor whose session crosses
 * midnight appears under two unlinkable values. That is the privacy decision
 * D-102 makes, not a defect to work around in a client. Join a `present` row to a
 * feed event by this field to recover the page history and referrer; the feed is
 * where those live, and this is deliberately not a second copy of them.
 *
 * Every label is nullable because presence stores what it was told: a heartbeat
 * with no page leaves `path` null, and a GeoLite2 or UA miss leaves the rest
 * null. `null` means *not recorded*, which is a different statement from the
 * `unknown` bucket.
 *
 * **There is no city on this row, deliberately** (ADR-0035, D3). ADR-0024 admits
 * a city to the private snapshot as an *aggregate* — a histogram over the active
 * set, which names nobody. A per-row city joined to that row's own path, browser
 * and OS is a different disclosure, and it is not one this surface makes.
 */
export const realtimePresentVisitorSchema = z.strictObject({
  visitor: z.string().min(1),
  last_seen_at: utcInstantSchema,
  path: z.string().nullable(),
  country: realtimeCountrySchema.nullable(),
  device_type: z.enum(REALTIME_DEVICE_TYPES).nullable(),
  browser: z.string().nullable(),
  os: z.string().nullable(),
})

export type RealtimePresentVisitor = z.infer<typeof realtimePresentVisitorSchema>

/**
 * Private snapshot (docs snapshot 02 §17, ADR-0024).
 *
 * `browsers`, `operating_systems` and `cities` join the original three
 * breakdowns under the same bounded top-N rule. Labels are passed through as the
 * classifier and GeoLite2 produced them — presentation (title-casing a browser
 * family, say) is the client's job, so the wire value stays the one the
 * historical reports group by.
 */
export const realtimeSnapshotSchema = z.strictObject({
  type: z.literal('snapshot'),
  generated_at: utcInstantSchema,
  active_visitors: z.number().int().min(0),
  pages: z
    .array(z.strictObject({ path: z.string(), visitors: z.number().int().min(0) }))
    .max(REALTIME_SNAPSHOT_TOP_N),
  countries: z
    .array(z.strictObject({ country: realtimeCountrySchema, visitors: z.number().int().min(0) }))
    .max(REALTIME_SNAPSHOT_TOP_N),
  devices: z.array(
    z.strictObject({
      device_type: z.enum(REALTIME_DEVICE_TYPES),
      visitors: z.number().int().min(0),
    }),
  ),
  browsers: z
    .array(z.strictObject({ browser: z.string(), visitors: z.number().int().min(0) }))
    .max(REALTIME_SNAPSHOT_TOP_N),
  operating_systems: z
    .array(z.strictObject({ os: z.string(), visitors: z.number().int().min(0) }))
    .max(REALTIME_SNAPSHOT_TOP_N),
  /** Private surface only (ADR-0024) — absent from `publicRealtimeSnapshotSchema`. */
  cities: z
    .array(z.strictObject({ city: z.string(), visitors: z.number().int().min(0) }))
    .max(REALTIME_SNAPSHOT_TOP_N),
  /**
   * The site's most recent page views, newest first, private surface only.
   *
   * Carried *on the snapshot* rather than pushed as its own event type: the
   * stream's whole replay model is "a snapshot supersedes every missed delta"
   * (ADR-0016), and a separate event-push protocol would reintroduce exactly the
   * delta a reconnecting client could double-apply. A client renders this list as
   * it arrives and never appends to its own copy.
   *
   * It is a *live* feed, not a history: entries expire with the traffic that
   * produced them. The hours-deep "earlier" list is the recent-visitors read API,
   * which is served from ClickHouse.
   */
  events: z.array(realtimeFeedEventSchema).max(REALTIME_FEED_MAX_EVENTS),
  /**
   * Who is here right now, newest last-seen first, private surface only
   * (ADR-0035, D3).
   *
   * `active_visitors` remains the authoritative count — it is a `ZCOUNT` over
   * the whole presence set, while this list is bounded at
   * `REALTIME_PRESENT_MAX_VISITORS`. On a site with more visitors than that,
   * `present.length < active_visitors` and the difference is real: name the ones
   * you were given and state the rest as a count.
   *
   * Like `events`, it rides the snapshot and is **replaced, never accumulated**.
   */
  present: z.array(realtimePresentVisitorSchema).max(REALTIME_PRESENT_MAX_VISITORS),
})

export type RealtimeSnapshot = z.infer<typeof realtimeSnapshotSchema>

/**
 * Public snapshot — the narrow allowlist (D-213). Deliberately a separate schema
 * from `realtimeSnapshotSchema`; the public payload never reuses the private one.
 */
export const publicRealtimeSnapshotSchema = z.strictObject({
  type: z.literal('snapshot'),
  generated_at: utcInstantSchema,
  active_visitors: z.number().int().min(0),
})

export type PublicRealtimeSnapshot = z.infer<typeof publicRealtimeSnapshotSchema>

/** Control message (docs snapshot 02 §17): disconnects and degraded transitions. */
export const realtimeControlSchema = z.strictObject({
  type: z.literal('control'),
  action: z.enum(REALTIME_CONTROL_ACTIONS),
  reason: z.enum(REALTIME_CONTROL_REASONS),
})

export type RealtimeControl = z.infer<typeof realtimeControlSchema>

/**
 * One event on the private stream: a snapshot or a control message. Discriminated
 * on `type`, so a client narrows without guessing. The public snapshot stands
 * apart — it is not a member of this union, by D-213's separation.
 */
export const realtimeStreamEventSchema = z.discriminatedUnion('type', [
  realtimeSnapshotSchema,
  realtimeControlSchema,
])

export type RealtimeStreamEvent = z.infer<typeof realtimeStreamEventSchema>
