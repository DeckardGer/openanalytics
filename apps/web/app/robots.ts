import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/**
 * Static-rendered robots.txt, in three sections because three kinds of
 * crawler want three different answers:
 *
 * - **Search engines** (the `*` rule) get the marketing surface and nothing
 *   that belongs to a customer — the app, auth flows, and public share
 *   dashboards. A share link is public by its owner's choice; being
 *   *findable in Google* is a bigger choice a privacy-first product does
 *   not make for them.
 * - **AI crawlers** are explicitly welcomed on the same paths. Being cited
 *   by ChatGPT, Claude and Perplexity is real referral traffic for an
 *   analytics product; the section exists so the welcome is stated, not
 *   inherited.
 * - **Social-share crawlers** additionally get `/share/` — they fetch pages
 *   to unfurl link previews, not to index them, and an owner pasting their
 *   own dashboard into Slack deserves a card instead of a blank. Some
 *   (notably Twitterbot) interpret rule precedence loosely, so the carve-out
 *   is its own section rather than an Allow they might miss.
 */

const BLOCKED_PATHS = [
  "/dashboard",
  "/api/",
  "/login",
  "/onboarding",
  "/invites/",
  "/share/",
  "/playground",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: BLOCKED_PATHS,
      },
      // AI training and answer engines — same path policy as everyone,
      // called out so it is clear they are welcome.
      {
        userAgent: [
          "GPTBot",
          "ChatGPT-User",
          "ClaudeBot",
          "anthropic-ai",
          "PerplexityBot",
          "Google-Extended",
          "CCBot",
          "cohere-ai",
        ],
        allow: "/",
        disallow: BLOCKED_PATHS,
      },
      // Link-preview crawlers: everything search engines get, plus the
      // public share dashboards so pasted links unfurl.
      {
        userAgent: [
          "Twitterbot",
          "facebookexternalhit",
          "facebookcatalog",
          "LinkedInBot",
          "Slackbot",
          "Slackbot-LinkExpanding",
          "Discordbot",
          "TelegramBot",
          "WhatsApp",
          "Applebot",
        ],
        allow: ["/", "/share/"],
        disallow: BLOCKED_PATHS.filter((path) => path !== "/share/"),
      },
    ],
    // Both are absolute-URL fields; a deployment that has not been told its
    // own address offers neither rather than a path a crawler cannot resolve.
    ...(SITE_URL
      ? { sitemap: `${SITE_URL}/sitemap.xml`, host: SITE_URL }
      : {}),
  };
}
