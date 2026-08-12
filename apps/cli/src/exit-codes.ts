/**
 * The CLI's exit codes (docs snapshot 02 §20: "stabil exit code-lar olur").
 *
 * **These are contract, so they are tested as contract** rather than described
 * in a README. A script that branches on `$?` is a consumer exactly like a client
 * that branches on `error.code`, and the whole point of a stable table is that a
 * later refactor cannot renumber it without a test going red.
 *
 * The mapping is deliberately *coarse*: one code per action a caller can take.
 * A separate number for every HTTP status would push the API's taxonomy into
 * shell scripts, and the question a script asks is "should I retry, re-login,
 * narrow the query, or give up" — which is four questions, not fourteen.
 */
export const EXIT_CODES = {
  /** The command did what was asked. */
  ok: 0,
  /**
   * Something went wrong that the caller cannot act on: a network failure, a
   * malformed response, an unhandled error. The catch-all, and deliberately `1`
   * so a script that only checks `!= 0` behaves sensibly.
   */
  failure: 1,
  /** The command line itself was wrong — unknown command, missing argument. */
  usage: 2,
  /** No stored credential, or the server refused it. Run `oa login`. */
  unauthenticated: 3,
  /** Authenticated, but not permitted: a missing scope, or a role that is not
   * enough (revenue is owner-only). Re-logging in with the same account will
   * not help, which is why this is not `unauthenticated`. */
  forbidden: 4,
  /** The named site does not exist, or the caller is not a member of it. The
   * two are the same answer by design — there is no oracle. */
  notFound: 5,
  /** Rate limited, or over the daily query budget. Retryable after a wait, and
   * the CLI prints how long. */
  rateLimited: 6,
  /** The requested range is wider than the server will serve. Not retryable:
   * ask for less. */
  rangeTooLarge: 7,
  /** The server is up but the feature is not available on this deployment
   * (no query gateway, no realtime). Retryable, but not by the caller. */
  unavailable: 8,
} as const

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES]

/**
 * Which exit code an API error envelope becomes.
 *
 * Keyed on `error.code`, not on the HTTP status, because the status is
 * deliberately shared — `VALIDATION_FAILED`, `RESOLUTION_NOT_AVAILABLE` and
 * `RANGE_TOO_LARGE` are all `400`, and only the last of those means "ask for a
 * narrower window".
 */
export function exitCodeForApiError(code: string): ExitCode {
  switch (code) {
    case 'UNAUTHENTICATED':
      return EXIT_CODES.unauthenticated
    case 'FORBIDDEN':
      return EXIT_CODES.forbidden
    case 'SITE_NOT_FOUND':
    case 'NOT_FOUND':
      return EXIT_CODES.notFound
    case 'RATE_LIMITED':
      return EXIT_CODES.rateLimited
    case 'RANGE_TOO_LARGE':
      return EXIT_CODES.rangeTooLarge
    case 'SERVICE_UNAVAILABLE':
    case 'SITE_SUSPENDED':
    case 'DATA_NOT_READY':
      return EXIT_CODES.unavailable
    default:
      return EXIT_CODES.failure
  }
}
