import { NextResponse, type NextRequest } from "next/server";

/**
 * Host routing, and only host routing: one deployment can serve two domains,
 * and which page a URL means depends on the host.
 *
 * Both domains are configuration, and with neither set this file does
 * nothing at all — which is the right answer for an install with one host,
 * where `/` is the app's own front door and there is no marketing site to
 * route to. Our own values live with our deployment, not in this build.
 *
 * - a **marketing host** at `/` → the marketing homepage, served by an
 *   internal rewrite to `/home`. A rewrite, not a redirect: the visitor's
 *   address bar keeps the apex root, which is the page's canonical URL.
 * - a marketing host on an app path (`/login`, `/dashboard`, …) → `308` to
 *   the same path on the **app origin**. The pages would render on the apex,
 *   but every API call from that origin dies in CORS (only the app origin is
 *   trusted), so serving them there is a working-looking page that cannot
 *   work. This is also what makes the landing's relative `/login` links
 *   correct on both hosts: on one host they stay local, on the apex they hop.
 * - every other host (the app host, localhost, previews) → untouched: `/`
 *   stays the app's fork in `app/page.tsx` (signed in → dashboard, else
 *   login).
 * - `/home` visited directly on a configured host → `308` to `/`, so the
 *   rewrite target never exists as a second public URL. On localhost and
 *   previews it stays reachable as the landing's review route.
 *
 * The matcher is the safety guarantee: nothing but these paths ever enters
 * this file, so every other route — marketing subpages, share links, the
 * whole dashboard on the app host — behaves exactly as before. `/share`
 * stays deliberately unlisted: a share link is public on any host.
 */

/** Comma-separated, e.g. `example.com,www.example.com`. Host only, no scheme. */
const MARKETING_HOSTS = new Set(
  (process.env.MARKETING_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
);

/** The full origin of the app host, e.g. `https://app.example.com`. */
const APP_ORIGIN = process.env.APP_ORIGIN ?? "";

const APP_HOSTS = new Set(
  APP_ORIGIN ? [new URL(APP_ORIGIN).hostname.toLowerCase()] : []
);

export function middleware(request: NextRequest) {
  const host = (request.headers.get("host") ?? "")
    .toLowerCase()
    .split(":")[0]!;
  const { pathname, search } = request.nextUrl;
  const marketing = MARKETING_HOSTS.has(host);

  if (pathname === "/") {
    if (marketing) {
      const url = request.nextUrl.clone();
      url.pathname = "/home";
      return NextResponse.rewrite(url);
    }
    return NextResponse.next();
  }

  if (pathname === "/home") {
    if (marketing || APP_HOSTS.has(host)) {
      const url = request.nextUrl.clone();
      url.pathname = "/";
      return NextResponse.redirect(url, 308);
    }
    return NextResponse.next();
  }

  // Every other matched path is an app path; the query string rides along
  // untouched because invite tokens and OAuth error params live there. With
  // no app origin configured there is nowhere to send them, and the page is
  // served where it was asked for.
  if (marketing && APP_ORIGIN) {
    return NextResponse.redirect(
      new URL(`${pathname}${search}`, APP_ORIGIN),
      308
    );
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/",
    "/home",
    "/login",
    "/dashboard/:path*",
    "/onboarding",
    "/invites/:path*",
    "/playground/:path*",
    "/billing/:path*",
  ],
};
