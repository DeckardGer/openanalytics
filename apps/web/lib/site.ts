/**
 * The site's public identity, in one place.
 *
 * Five files describe this deployment to machines — the metadata in the root
 * layout, `robots.txt`, `sitemap.xml`, `llms.txt` and the JSON-LD graph — and
 * every one of them needs the same three facts. Held separately they drift,
 * and a structured-data graph that disagrees with the OG card is worse than
 * no graph at all: it tells an answer engine two things and lets it pick.
 *
 * All of it is configuration, because this build is not only ours. A fork
 * that inherited our address would publish canonical URLs pointing at a site
 * it does not run, and an OG card that sends every share to a competitor.
 *
 * `NEXT_PUBLIC_*` values are inlined at build time, so these are set for the
 * build, not for the running container.
 */

/**
 * The origin this deployment is served from — canonical URLs, the sitemap and
 * `metadataBase` all hang off it. Empty means "no absolute URLs": the app
 * still works, it just stops making claims about where it lives.
 */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "";

export const SITE_NAME = process.env.NEXT_PUBLIC_SITE_NAME ?? "Open Analytics";

export const SITE_DESCRIPTION =
  process.env.NEXT_PUBLIC_SITE_DESCRIPTION ??
  "Open Analytics is an open-source, privacy-first alternative to Google Analytics: realtime visitors, funnels and revenue attribution from one lightweight, cookieless script. GDPR-friendly with no consent banner, and self-hostable.";

/**
 * Where a human reaches whoever runs this — printed on the brand entity, not
 * just a link. Empty is the honest default: an install that has not named an
 * address must not offer one, and the surfaces that would print it check.
 */
export const SITE_EMAIL = process.env.NEXT_PUBLIC_SITE_EMAIL ?? "";

/**
 * The source, for every surface that offers it: the hero's badge, the footer's
 * resources column, and the brand entity's `sameAs`.
 *
 * The one fact on this page that is deliberately *not* configuration. The
 * others describe where a deployment lives, and a fork inheriting them would
 * publish claims about an address it does not run. This one describes where
 * the code lives, which is the same answer for every deployment — a
 * self-hosted install pointing at the upstream repository is pointing at the
 * truth, and the alternative is a fork whose "Proudly Open Source" badge leads
 * nowhere.
 */
export const GITHUB_URL = "https://github.com/OpenLabs-so/openanalytics";
