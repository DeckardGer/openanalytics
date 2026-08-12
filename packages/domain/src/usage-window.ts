/**
 * Usage window generation and quota-anchor lifecycle.
 *
 * A usage window is a user-owned, half-open [startsAt, endsAt) UTC interval that
 * resets monthly for both billing intervals (docs snapshot 05, D-014; 02 §9).
 * The generator is a pure function of the anchor and an instant, so the worker
 * can compute-or-create the window an event's `accepted_at` falls into
 * idempotently; the `(user_id, starts_at)` unique constraint (migration 0011)
 * then collapses a concurrent race to a single row. Nothing here writes to the
 * database — this is the rule the repository and the worker call.
 *
 * All arithmetic is UTC. Monthly boundaries are calendar-clamped anniversaries of
 * the anchor: an anchor on the 31st falls back to the last day of a shorter
 * month, and Feb clamps to the 28th or 29th by leap year — the boundary carries
 * the anchor's time-of-day throughout.
 */

export interface UsageWindowInterval {
  readonly startsAt: Date
  readonly endsAt: Date
}

function daysInUtcMonth(year: number, month0: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate()
}

/**
 * The k-th monthly anniversary of the anchor (k may be negative), calendar-
 * clamped and carrying the anchor's time-of-day.
 */
function anniversary(anchor: Date, k: number): Date {
  const totalMonths = anchor.getUTCMonth() + k
  const year = anchor.getUTCFullYear() + Math.floor(totalMonths / 12)
  const month0 = ((totalMonths % 12) + 12) % 12
  const day = Math.min(anchor.getUTCDate(), daysInUtcMonth(year, month0))
  return new Date(
    Date.UTC(
      year,
      month0,
      day,
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  )
}

/**
 * The monthly usage window an instant falls into, anchored at `anchorAt`.
 *
 * Returns the half-open [startsAt, endsAt) such that startsAt <= at < endsAt,
 * where both bounds are calendar-clamped monthly anniversaries of the anchor.
 * `at` before the anchor yields the (negative-k) window containing it, which the
 * callers never hit in practice — an event's accepted_at is always at or after
 * the anchor — but the function stays total.
 */
export function usageWindowFor(anchorAt: Date, at: Date): UsageWindowInterval {
  // Estimate the month offset, then correct by at most one step in each
  // direction so the clamped, time-of-day-carrying bounds are exact.
  let k =
    (at.getUTCFullYear() - anchorAt.getUTCFullYear()) * 12 +
    (at.getUTCMonth() - anchorAt.getUTCMonth())

  while (anniversary(anchorAt, k).getTime() > at.getTime()) k -= 1
  while (anniversary(anchorAt, k + 1).getTime() <= at.getTime()) k += 1

  return { startsAt: anniversary(anchorAt, k), endsAt: anniversary(anchorAt, k + 1) }
}
