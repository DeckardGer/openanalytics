/**
 * Event time boundaries (docs snapshot 05, D-015/D-016; 02 §7.1 item 7).
 *
 * Two clocks, never conflated: usage is billed at the server's `accepted_at`,
 * analytics is bucketed at the validated `occurred_at`. This module owns the
 * validation of the second one.
 *
 * Both rules are deterministic functions of `(occurred_at, accepted_at)` — no
 * `Date.now()`, no configuration — because the same event must be decided the
 * same way by the collector, by a worker replaying a manifest and by a test.
 */

/** Older than this and the event is rejected outright: it creates no usage, no queue row. */
export const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000

/** Beyond this into the future the client clock is wrong, so the time is clamped. */
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000

export type EventTimeRejection = 'too_old' | 'invalid_timestamp'

export type EventTimeDecision =
  | { readonly accepted: false; readonly reason: EventTimeRejection }
  | {
      readonly accepted: true
      /** The value analytics buckets on: the client's, or `accepted_at` if clamped. */
      readonly occurredAt: Date
      /** True when the client's clock was more than five minutes ahead. */
      readonly clockSkewed: boolean
    }

function toTime(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value)
}

/**
 * Decide an event's analytics timestamp.
 *
 * - Strictly older than `accepted_at - 24h` → rejected. The tracker's retry
 *   queue expires at the same boundary (02 §7.3), and the server's boundary is
 *   the final authority. Exactly 24h old is still accepted: the rule is `<`, and
 *   an off-by-one here would drop events a compliant tracker just sent.
 * - Strictly more than five minutes ahead of `accepted_at` → clamped to
 *   `accepted_at` with `clock_skewed = true`. A machine with a wrong clock must
 *   not be able to write events into the future of a dashboard.
 * - Anything between passes through untouched.
 */
export function resolveEventTime(input: {
  occurredAt: Date | string
  acceptedAt: Date | string
}): EventTimeDecision {
  const occurredAt = toTime(input.occurredAt)
  const acceptedAt = toTime(input.acceptedAt)

  if (!Number.isFinite(occurredAt) || !Number.isFinite(acceptedAt)) {
    return { accepted: false, reason: 'invalid_timestamp' }
  }

  if (occurredAt < acceptedAt - MAX_EVENT_AGE_MS) {
    return { accepted: false, reason: 'too_old' }
  }

  if (occurredAt > acceptedAt + MAX_FUTURE_SKEW_MS) {
    return { accepted: true, occurredAt: new Date(acceptedAt), clockSkewed: true }
  }

  return { accepted: true, occurredAt: new Date(occurredAt), clockSkewed: false }
}

/** The UTC calendar date an accepted event belongs to, as `YYYY-MM-DD`. */
export function utcCalendarDate(instant: Date | string): string {
  const time = toTime(instant)
  const date = new Date(time)
  const parts = date.toISOString()
  return parts.slice(0, 10)
}
