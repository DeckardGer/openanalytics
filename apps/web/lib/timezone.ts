"use client";

/**
 * One home for "which clock is this dashboard on".
 *
 * The stored preference (`GET/PATCH /v1/me/preferences`) arrives flattened on
 * the Better Auth session as `user.timezone`; `null` means the user has never
 * chosen — it does NOT mean UTC — and the browser's own zone stands in. The
 * resolved value is what every analytics read sends as its `timezone`
 * parameter; the server never applies the preference behind the frontend's
 * back.
 */

export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
}

/** The zone the dashboard runs on: the stored choice, else the browser's. */
export function resolveTimezone(
  preferred: string | null | undefined
): string {
  return preferred ?? browserTimezone();
}

/** `user.timezone` off a Better Auth session object, tolerating absence. */
export function sessionTimezone(user: unknown): string | null {
  if (typeof user !== "object" || user === null) return null;
  const value = (user as { timezone?: unknown }).timezone;
  return typeof value === "string" && value !== "" ? value : null;
}
