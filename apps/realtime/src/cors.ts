import type { MiddlewareHandler } from 'hono'

/**
 * Public, credential-less CORS for the SSE stream surface.
 *
 * The stream is consumed by a browser on a *different* origin — the dashboard
 * at `app.getopen.so`, a local `next dev`, tomorrow perhaps an embedded share
 * widget — and it authenticates with a short-lived scoped bearer token in an
 * `Authorization` header (D-213; `apps/web/lib/realtime.ts` deliberately uses
 * `fetch` streaming because `EventSource` cannot set that header). An
 * `Authorization` header is not CORS-safelisted, so **every** browser
 * connection preflights. Without this middleware the preflight hit the router,
 * got a CORS-header-less 404, and the browser refused to open the stream at
 * all — from any origin, including production. Nothing server-side could see
 * that; the tokens minted fine and the stream answered `curl` perfectly.
 *
 * **Why `*` is correct and legal here.** A wildcard is dangerous only when it
 * is paired with credentials, because then any page can read a response
 * computed from the visitor's *ambient* authority. This surface has none: no
 * cookie is set or read, and the bearer token is explicit script-held state a
 * page can only present if the api already minted it one — which is where the
 * actual authorization lives (scoped claims, ≤60 s TTL, epoch re-check). The
 * fetch runs with the default credentials mode, so nothing ambient rides
 * along. `Access-Control-Allow-Credentials` is therefore **never** sent — not
 * "sent as false", not sent at all — and that absence is what keeps the
 * wildcard legal: a browser rejects the `*` + credentials pair outright, so a
 * future change that added cookies to this service would break loudly rather
 * than quietly widen a hole.
 *
 * An origin allowlist here would also be a second, drifting copy of a boundary
 * the token already draws better: the api mints tokens only to authenticated,
 * authorized callers, and the gateway re-verifies every claim on connect. CORS
 * is not that boundary (same reasoning as the collector's `cors.ts`).
 *
 * This is deliberately *not* `apps/api/src/http/cors.ts` (exact-origin,
 * fail-closed, credentialed — right for a cookie-holding surface, wrong here)
 * and not a copy imported from the collector: ADR-0019 decision 11 keeps one
 * CORS file per service because their situations differ and a shared default
 * is how the wrong policy spreads.
 *
 * No `Access-Control-Expose-Headers`: the SSE protocol is body-only and
 * `use-realtime.ts` reads no response header. No `Vary: Origin`: these headers
 * are the same constant for every origin, so there is nothing for a cache to
 * mix up.
 */

/** The methods this service actually serves. Advertising more would be a lie. */
const ALLOW_METHODS = 'GET, OPTIONS'

/**
 * The request headers a stream consumer may set.
 *
 * A fixed, narrow list rather than an echo of `Access-Control-Request-Headers`.
 * `authorization` carries the scoped token and is what forces the preflight in
 * the first place; `last-event-id` is sent on every reconnect to resume from
 * the last snapshot (`use-realtime.ts`); `accept` is safelisted but a proxy or
 * a stricter client may still name it, and refusing it would fail a legitimate
 * preflight over a header this route requires anyway.
 */
const ALLOW_HEADERS = 'accept, authorization, last-event-id'

/**
 * How long a browser may cache a preflight, in seconds.
 *
 * An engineering value for a cache lifetime — not one of the
 * `docs/snapshot/05-aciq-qerarlar.md` GATE ceilings, which must never appear as
 * invented defaults. Ten minutes, the same number and the same reasoning as the
 * api and the collector (ADR-0019 decision 7): reconnecting readers are not
 * re-preflighting every retry, but a method or header change is not shadowed
 * by stale preflights for long.
 */
const MAX_AGE_SECONDS = '600'

/**
 * Answers public CORS for the stream surface.
 *
 * Registered with `app.use('*', …)` *before* the `/v1` routes and *after*
 * `createServiceApp` has mounted `/health`, so `/health` keeps behaving exactly
 * as it did — an operator endpoint, not a browser one. It is registered even
 * when the stream itself did not mount: an unmounted gateway then answers a
 * readable 404 instead of an opaque network error, and `use-realtime.ts` can
 * tell "access lost" from "the network ate it".
 *
 * Response headers are added *after* the inner handler has produced its
 * response, so this middleware only annotates. The preflight is the one case
 * that answers with no inner handler at all.
 */
export function publicStreamCors(): MiddlewareHandler {
  return async (c, next) => {
    // A preflight is an OPTIONS that names the method it is asking about. A bare
    // OPTIONS is not one and is left to the router.
    const isPreflight =
      c.req.method === 'OPTIONS' && c.req.header('access-control-request-method') !== undefined

    if (isPreflight) {
      // No `Access-Control-Allow-Credentials`, here or below. See the file
      // comment: its absence is what makes `*` a legal answer.
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': ALLOW_METHODS,
          'Access-Control-Allow-Headers': ALLOW_HEADERS,
          'Access-Control-Max-Age': MAX_AGE_SECONDS,
        },
      })
    }

    await next()

    c.res.headers.set('Access-Control-Allow-Origin', '*')
    return undefined
  }
}
