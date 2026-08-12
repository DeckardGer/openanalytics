/**
 * Favicon proxy.
 *
 * Google's `faviconV2` cannot be used directly from an `<img>` if you want
 * your own fallback: when a domain has no favicon it answers **404 with a
 * 16×16 generic globe as the body**, and browsers render the body of a 404
 * image response, so `onerror` never fires and every unknown site shows
 * Google's grey globe. gstatic sends no CORS headers either, so the status
 * cannot be read in the browser.
 *
 * This route reads it server-side and turns the upstream status into a real
 * one: an actual image, or a bodyless 404 that `onerror` can act on. It is
 * also the seam for swapping providers later — callers only know
 * `/api/favicon?domain=`.
 */

/** Bare hostname, lowercase, at least one dot. Nothing else is fetched. */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** A miss is cached too — a site without a favicon does not grow one hourly. */
const HIT_CACHE = "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400";
const MISS_CACHE = "public, max-age=3600, s-maxage=86400";

export async function GET(request: Request): Promise<Response> {
  const domain = (
    new URL(request.url).searchParams.get("domain") ?? ""
  ).toLowerCase();

  // The only value that ever reaches an outbound fetch, and it is a bare
  // hostname or nothing — no scheme, port, path, credentials or IP literal.
  if (domain.length > 253 || !HOSTNAME.test(domain)) {
    return new Response(null, { status: 400 });
  }

  const upstream = `https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${encodeURIComponent(`https://${domain}`)}&size=64`;

  let response: Response;
  try {
    response = await fetch(upstream, { cache: "no-store" });
  } catch {
    // Upstream unreachable is a miss, not a 500: the caller draws its own
    // mark either way, and a broken favicon is never worth an error page.
    return new Response(null, {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  }

  if (!response.ok) {
    return new Response(null, {
      status: 404,
      headers: { "cache-control": MISS_CACHE },
    });
  }

  const type = response.headers.get("content-type") ?? "";
  // Only ever hand back an image, whatever the upstream decides to send.
  if (!type.startsWith("image/")) {
    return new Response(null, {
      status: 404,
      headers: { "cache-control": MISS_CACHE },
    });
  }

  return new Response(await response.arrayBuffer(), {
    status: 200,
    headers: {
      "cache-control": HIT_CACHE,
      "content-type": type,
      "x-content-type-options": "nosniff",
    },
  });
}
