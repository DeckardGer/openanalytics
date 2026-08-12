import type { MiddlewareHandler } from 'hono'

/**
 * Credentialed CORS for the api's own browser callers.
 *
 * The frontend is served from `https://app.getopen.so` and the api from
 * `https://api.getopen.so`. Those are different origins, so every dashboard
 * call is a cross-origin request carrying the session cookie, and a browser
 * discards such a response unless the api names that exact origin back. Without
 * this middleware the api answers with no CORS header at all and a preflight
 * `OPTIONS` reaches the session middleware and 401s — so the browser blocks the
 * real request before it is ever sent. Docs snapshot 03 §7 already decided the
 * rule: with a separate frontend origin, credentialed CORS answers only the
 * exact app origin.
 *
 * Why it lives in `apps/api` and not in `@openanalytics/observability`: the
 * collector and the realtime gateway have different cross-origin situations.
 * The collector is addressed by *customer* pages on origins we do not know in
 * advance and its tracker deliberately sends unauthenticated, credential-less
 * "simple" requests; inheriting an allowlist built for one first-party origin
 * would be wrong for it. A shared middleware would have made that inheritance
 * the default.
 *
 * The rules, and why each one is what it is:
 *
 * - **Exact string match, never a prefix or a suffix.** `app.getopen.so` and
 *   `evil-app.getopen.so` are different origins and a suffix test would accept
 *   both. `Origin` is a full serialized origin (`scheme://host[:port]`), so an
 *   exact comparison against the configured list is the whole check.
 * - **Never `*`.** A wildcard is invalid with `Access-Control-Allow-Credentials`
 *   anyway — a browser rejects the pair — so reaching for it would silently
 *   break the cookie flow it was meant to enable.
 * - **Fail closed.** An unknown origin, or an empty allowlist, gets no CORS
 *   header at all. A deployment that has not configured its frontend origin
 *   refuses browsers rather than defaulting to accepting one.
 * - **`Vary: Origin` on every response**, matched or not. The response body is
 *   identical for every origin but the *headers* are not, so a shared cache that
 *   did not vary on `Origin` could serve one origin's `Access-Control-Allow-Origin`
 *   to another — turning a correct allowlist into an incorrect one at the cache.
 * - **A preflight is answered here and never reaches the session middleware.**
 *   `OPTIONS` carries no cookie by design, so a session guard can only ever 401
 *   it, which is exactly the failure observed in production.
 *
 * The allowlist is the api's existing `AUTH_TRUSTED_ORIGINS`, parsed once by
 * `parseTrustedOrigins` and shared with Better Auth's own trusted-origin list
 * (`apps/api/src/auth.ts`). One variable, one parse: a second split of the same
 * string is a second definition that can drift.
 */

/**
 * Split `AUTH_TRUSTED_ORIGINS` into its origins.
 *
 * The one definition of how that variable is read. Empty and whitespace-only
 * entries are dropped rather than becoming an origin that matches nothing (or,
 * worse, an empty string that a naive comparison could match).
 */
export function parseTrustedOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
}

/** The methods this api actually serves. Advertising more would be a lie. */
const ALLOW_METHODS = 'GET, POST, PATCH, PUT, DELETE, OPTIONS'

/**
 * The request headers a browser caller may set.
 *
 * A fixed, narrow list rather than an echo of `Access-Control-Request-Headers`:
 * echoing turns the allowlist into whatever the caller asks for, and nothing
 * here needs that. `authorization` is deliberately absent — bearer keys on this
 * api are `private_read` secrets for server-to-server calls, and a browser has
 * no business holding one; the dashboard authenticates with its session cookie.
 */
const ALLOW_HEADERS = 'content-type, idempotency-key, x-request-id'

/**
 * How long a browser may cache a preflight, in seconds.
 *
 * An engineering value for a cache lifetime — not one of the `05-aciq-qerarlar.md`
 * GATE ceilings (abuse limits, rate limits, prices), which must never appear as
 * invented defaults. Ten minutes keeps a route or method change from being
 * shadowed by stale preflights for long.
 */
const MAX_AGE_SECONDS = '600'

/** Adds `Origin` to an existing `Vary` rather than replacing it, so a route that
 * already varies on something else keeps that. */
function varyOnOrigin(headers: Headers): void {
  const current = headers.get('vary')
  if (current === null) {
    headers.set('Vary', 'Origin')
    return
  }
  if (!/(^|,)\s*origin\s*(,|$)/i.test(current)) headers.append('Vary', 'Origin')
}

/**
 * Answers credentialed CORS for the exact configured app origins.
 *
 * Mounted as the outermost layer in `createApp`, so it covers `/api/auth/*` (the
 * sign-in calls that set the session cookie), `/health` and `/v1/*` alike.
 *
 * Response headers are added *after* the inner handler has produced its
 * response, not staged before it: staging would make every response go through
 * Hono's header-merge path, and this middleware has no reason to touch a
 * response it is only annotating. The preflight is the one case that answers
 * without an inner handler at all.
 */
export function credentialedCors(origins: readonly string[]): MiddlewareHandler {
  const allowlist = new Set(origins)

  return async (c, next) => {
    const origin = c.req.header('origin')
    const allowed = origin !== undefined && allowlist.has(origin)

    // A preflight is an OPTIONS that names the method it is asking about. A bare
    // OPTIONS is not one and is left to the router.
    const isPreflight =
      c.req.method === 'OPTIONS' && c.req.header('access-control-request-method') !== undefined

    if (isPreflight) {
      const headers = new Headers({ Vary: 'Origin' })
      if (allowed) {
        // The echoed origin, never `*`: a wildcard is invalid with credentials.
        headers.set('Access-Control-Allow-Origin', origin)
        headers.set('Access-Control-Allow-Credentials', 'true')
        headers.set('Access-Control-Allow-Methods', ALLOW_METHODS)
        headers.set('Access-Control-Allow-Headers', ALLOW_HEADERS)
        headers.set('Access-Control-Max-Age', MAX_AGE_SECONDS)
      }
      // Answered here either way, so it never reaches the session middleware. A
      // disallowed origin gets a bodiless 204 with no CORS headers, which the
      // browser refuses — the same fail-closed outcome, without a 401 that
      // suggests the caller could fix it by authenticating.
      return new Response(null, { status: 204, headers })
    }

    await next()

    // Set on every response, including the ones that get no CORS headers: what
    // keeps a cache from mixing two origins' answers is the presence of `Vary`,
    // not the presence of the allow header.
    const headers = c.res.headers
    varyOnOrigin(headers)
    if (allowed) {
      headers.set('Access-Control-Allow-Origin', origin)
      headers.set('Access-Control-Allow-Credentials', 'true')
    }
    return undefined
  }
}
