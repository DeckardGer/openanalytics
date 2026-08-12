"use client";

import * as React from "react";

/**
 * This deployment's own tracker, on its own marketing site
 * (frontend_tasks.md §39, launch day).
 *
 * One Next.js app serves two hosts, and only one of them is the site being
 * measured: the landing pages are the property, the product host is not.
 * A static tag in the root layout would count every dashboard session and
 * every localhost dev visit as landing traffic under the same key — so the
 * tag is injected on the client, where the hostname is known, and only on
 * the marketing hosts. Reading the host server-side instead (via `headers()`)
 * would make every marketing page dynamic, which is the wrong trade for a
 * script that is `async` anyway.
 *
 * Injecting once is enough: the tracker follows client-side navigation
 * itself (tracker_snippet.md), so route transitions after this mount are
 * counted without any router wiring here.
 *
 * All three values are deployment configuration, so a fork measures its own
 * site and never ours. With any of them unset the component renders nothing —
 * self-measurement is opt-in, and a half-configured tag would POST to the
 * wrong origin rather than fail visibly.
 */

/** Comma-separated hostnames to measure, e.g. `example.com,www.example.com`. */
const TRACKED_HOSTS = new Set(
  (process.env.NEXT_PUBLIC_OA_TRACKED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean),
);

/**
 * The `tracking_write` key of the site being measured — public by design,
 * write-only, an ingest identifier and never read authorization
 * (tracker_snippet.md).
 */
const TRACKING_KEY = process.env.NEXT_PUBLIC_OA_TRACKING_KEY ?? "";

/**
 * NOT optional, whatever §39 says: the tracker falls back to
 * `location.origin` when `data-collector` is absent — it never infers the
 * collector from its own `src`. Without this attribute every event POSTs
 * to the marketing host's own `/v1/events` and 404s in this very app
 * (verified live, 2026-08-10, headless-browser trace).
 */
const COLLECTOR_URL = process.env.NEXT_PUBLIC_OA_COLLECTOR_URL ?? "";

const TRACKER_SRC = COLLECTOR_URL ? `${COLLECTOR_URL}/oa.js` : "";

export function OaTracker() {
  React.useEffect(() => {
    if (!TRACKING_KEY || !TRACKER_SRC) return;
    if (!TRACKED_HOSTS.has(window.location.hostname)) return;
    // StrictMode runs effects twice in dev; two tags would be two trackers.
    if (document.querySelector(`script[src="${TRACKER_SRC}"]`)) return;

    const script = document.createElement("script");
    script.async = true;
    script.src = TRACKER_SRC;
    script.dataset.key = TRACKING_KEY;
    script.dataset.collector = COLLECTOR_URL;
    document.head.appendChild(script);
    // No cleanup: the tracker is a page-lifetime install, not a React
    // resource. Removing the tag would not uninstall it anyway.
  }, []);

  return null;
}
