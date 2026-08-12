import type { MiddlewareHandler } from 'hono'

/**
 * Public, credential-less CORS for the ingest surface.
 *
 * The collector is addressed by *customer* pages, on origins we cannot know in
 * advance — a customer installs the snippet on whatever hostname they own, and
 * they may add another tomorrow. There is no allowlist to be had here, so the
 * answer is `Access-Control-Allow-Origin: *`.
 *
 * **Why `*` is correct and legal here, and not a shortcut.** A wildcard is only
 * dangerous when it is paired with credentials, because then any page on the web
 * can read a response computed with the visitor's ambient authority. Nothing of
 * the sort exists on this surface: the tracker sends `credentials: 'omit'` on
 * every request (transport.ts, config.ts), no cookie is set or read, and no
 * bearer token is accepted. `Access-Control-Allow-Credentials` is therefore
 * **never** sent — not "sent as false", not sent at all. That absence is what
 * keeps the wildcard legal: a browser rejects the `*` + `Allow-Credentials`
 * pair outright, so a future change that added credentials to this service would
 * break loudly rather than quietly widen a hole.
 *
 * **Why a wide-open origin policy grants nothing.** The only credential involved
 * is the public tracking key, and it is write-only (docs snapshot 01 §3.2): it
 * is an ingest identifier, never read authorization, never a subscription
 * credential. What a page can do with it cross-origin — POST events, read a
 * site's public tracker configuration — is exactly what it can already do from
 * `curl`, and neither returns another party's analytics data. Restricting the
 * origin here would protect nothing while breaking every legitimate customer
 * site; admission control is `site_domains`/`isOriginAllowed` inside the ingest
 * gate, which is a *product* rule about which sites may send, enforced on the
 * server, and is deliberately untouched by this file. CORS is not that boundary.
 *
 * This is deliberately *not* `apps/api/src/http/cors.ts` (ADR-0019 decision 11),
 * which is exact-origin, fail-closed and credentialed because it answers one
 * known first-party origin holding a session cookie. Inheriting that policy here
 * would refuse every customer page; inheriting this one there would be a
 * security defect. Two services, two situations, two files.
 *
 * Two details a naive fix gets wrong, both read out of the tracker source:
 *
 * - **`Access-Control-Expose-Headers: ETag`.** `apps/tracker/src/config.ts`
 *   stores `response.headers.get('etag')` to drive its `If-None-Match` cache. A
 *   cross-origin response exposes only the CORS-safelisted response headers by
 *   default, and `ETag` is not one of them — so without this the tracker reads
 *   `null`, stores no tag, and the 304 path can never fire. Not cosmetic: it is
 *   the difference between a full config body per visitor and a bodyless 304.
 * - **The preflight.** The event POST is a CORS *simple* request by
 *   construction and never preflights, which is why the batch was being received
 *   all along. But `config.ts` sends `If-None-Match` as soon as it has a cached
 *   config, and that header is not on the safelist — so the *second* config
 *   fetch of every visitor's browser preflights. An `OPTIONS` that nothing
 *   answers is a config fetch that never happens.
 *
 * No `Vary: Origin`: unlike the api, this response's CORS headers are the same
 * constant for every origin, so there is nothing for a cache to mix up. Adding
 * `Vary` would only fragment the CDN cache of a public, cacheable endpoint.
 */

/** The methods this service actually serves. Advertising more would be a lie. */
const ALLOW_METHODS = 'GET, POST, OPTIONS'

/**
 * The request headers a customer page may set on an ingest call.
 *
 * A fixed, narrow list rather than an echo of `Access-Control-Request-Headers`.
 * `content-type` covers the `text/plain;charset=UTF-8` the batch POST declares —
 * safelisted, so it never actually preflights, but a browser that does preflight
 * (a proxy-injected header, a fetch with a different mode) must still be
 * answered. `if-none-match` is the one that genuinely matters: it is what the
 * tracker's config cache sends, and the reason a preflight fires at all.
 */
const ALLOW_HEADERS = 'content-type, if-none-match'

/**
 * The response headers a customer page may read.
 *
 * `ETag` only. The tracker needs it; nothing else on this surface is meant to be
 * read by a page.
 */
const EXPOSE_HEADERS = 'ETag'

/**
 * How long a browser may cache a preflight, in seconds.
 *
 * An engineering value for a cache lifetime — not one of the
 * `docs/snapshot/05-aciq-qerarlar.md` GATE ceilings (abuse limits, rate limits,
 * prices), which must never appear as invented defaults. Ten minutes, the same
 * number and the same reasoning as the api (ADR-0019 decision 7): long enough
 * that a returning visitor is not re-preflighting, short enough that a method or
 * header change is not shadowed by stale preflights.
 */
const MAX_AGE_SECONDS = '600'

/**
 * Answers public CORS for the ingest surface.
 *
 * Registered with `app.use('*', …)` *before* the `/v1` routes, so it runs ahead
 * of them and a preflight is answered without any route handler being reached.
 * It is registered after `createServiceApp` has mounted `/health`, which means
 * `/health` keeps behaving exactly as it did — no CORS headers, no change — and
 * that is intentional: `/health` is an operator endpoint, not a browser one.
 *
 * Response headers are added *after* the inner handler has produced its
 * response, so this middleware only annotates; it never stages headers a route
 * then has to merge. The preflight is the one case that answers with no inner
 * handler at all.
 */
export function publicIngestCors(): MiddlewareHandler {
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
          'Access-Control-Expose-Headers': EXPOSE_HEADERS,
          'Access-Control-Max-Age': MAX_AGE_SECONDS,
        },
      })
    }

    await next()

    const headers = c.res.headers
    headers.set('Access-Control-Allow-Origin', '*')
    headers.set('Access-Control-Expose-Headers', EXPOSE_HEADERS)
    return undefined
  }
}
