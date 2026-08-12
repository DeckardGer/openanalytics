/**
 * The documentation's one map: sections, pages, titles, summaries.
 *
 * Everything reads from here — the sidebar, each page's metadata, the
 * sitemap and `llms.txt` entries — so a page cannot exist without being
 * navigable and indexable, and cannot be listed anywhere it does not exist.
 * Framework install guides are the one dynamic branch; they live in
 * `lib/docs-frameworks.ts` and are folded into `DOCS_PAGES` from there.
 */

import type { Metadata } from "next";
import { docsPages as extensionDocsPages } from "@seam/slots";
import { DOC_FRAMEWORKS } from "@/lib/docs-frameworks";

export type DocPage = {
  /** Path under /docs; "" is the index. */
  slug: string;
  /** The page's H1 and metadata title. */
  title: string;
  /** The shorter sidebar label. */
  nav: string;
  /** One line for metadata descriptions and llms.txt. */
  summary: string;
};

export type DocSection = { label: string; items: DocPage[] };

export const DOC_SECTIONS: DocSection[] = [
  {
    label: "Getting started",
    items: [
      {
        slug: "",
        title: "Open Analytics documentation",
        nav: "Introduction",
        summary:
          "What Open Analytics is, how the pieces fit together, and where to start.",
      },
      {
        slug: "quick-start",
        title: "Quick start",
        nav: "Quick start",
        summary:
          "From zero to live numbers in a few minutes: create a site, install the tracker, watch the first pageview arrive.",
      },
    ],
  },
  {
    label: "Installation",
    items: [
      {
        slug: "install",
        title: "Installing the tracker",
        nav: "Overview",
        summary:
          "The snippet, the CLI installer, where the tag goes, and how to confirm it works.",
      },
      ...DOC_FRAMEWORKS.map((framework) => ({
        slug: `install/${framework.slug}`,
        title: `Install on ${framework.name}`,
        nav: framework.name,
        summary: `Add Open Analytics to a ${framework.name} site: where the snippet goes and how to verify it.`,
      })),
    ],
  },
  {
    label: "Tracking",
    items: [
      {
        slug: "script",
        title: "Script options",
        nav: "Script options",
        summary:
          "Every attribute the snippet accepts: test mode, debug logging, and the privacy signals.",
      },
      {
        slug: "custom-events",
        title: "Custom events",
        nav: "Custom events",
        summary:
          "Three ways to track events: data attributes, no-code rules in the dashboard, and the JavaScript API.",
      },
      {
        slug: "identify",
        title: "Identifying your users",
        nav: "Identify",
        summary:
          "Attach your own pseudonymous user ID to events with oa.identify, and what that changes.",
      },
      {
        slug: "privacy",
        title: "Privacy and consent",
        nav: "Privacy & consent",
        summary:
          "What is collected and what never is, GPC and DNT handling, the consent API, and cookie banners.",
      },
      {
        slug: "web-vitals",
        title: "Web Vitals",
        nav: "Web Vitals",
        summary:
          "Core Web Vitals (LCP, CLS, INP, FCP, TTFB) collected by the same script, at no extra cost.",
      },
    ],
  },
  {
    label: "Features",
    items: [
      {
        slug: "dashboard",
        title: "The dashboard",
        nav: "Dashboard",
        summary:
          "Reading your numbers: intervals, comparisons, timezones, and every breakdown explained.",
      },
      {
        slug: "realtime",
        title: "Realtime",
        nav: "Realtime",
        summary:
          "Who is on your site right now: the live counter, the visitor feed, and how presence works.",
      },
      {
        slug: "funnels",
        title: "Funnels",
        nav: "Funnels",
        summary:
          "Define a sequence of pages and events and see where people drop off.",
      },
      {
        slug: "share",
        title: "Public dashboards",
        nav: "Public dashboards",
        summary:
          "Share your numbers with a link: what the three switches publish, and how to revoke a link.",
      },
      {
        slug: "widgets",
        title: "Widgets",
        nav: "Widgets",
        summary:
          "Publish one number as a live iframe you can embed anywhere, no account needed to view.",
      },
      {
        slug: "revenue",
        title: "Revenue attribution",
        nav: "Revenue",
        summary:
          "Connect Stripe and see which pages, channels and campaigns actually earn.",
      },
      {
        slug: "import",
        title: "Importing history",
        nav: "Import",
        summary:
          "Bring your history from Plausible, Fathom and other tools, review it before it lands, roll it back with one click.",
      },
      {
        slug: "team",
        title: "Team and roles",
        nav: "Team",
        summary:
          "Invite people to a site, what owner, admin and viewer can each do, and how billing transfers work.",
      },
      {
        slug: "timezones",
        title: "Timezones",
        nav: "Timezones",
        summary:
          "The three clocks: your dashboard timezone, a site's reporting timezone, and the share page's viewer picker.",
      },
    ],
  },
  {
    label: "Developers",
    items: [
      {
        slug: "api",
        title: "The read API",
        nav: "Read API",
        summary:
          "Query your analytics from your own code: authentication, endpoints, and the range parameters.",
      },
      {
        slug: "api-keys",
        title: "API keys",
        nav: "API keys",
        summary:
          "Tracking keys and read keys: what each one can do and how to handle them.",
      },
      {
        slug: "cli",
        title: "The CLI",
        nav: "CLI",
        summary:
          "getopen on npm: install the tracker with oa init, sign in with oa login, read stats from the terminal.",
      },
      {
        slug: "mcp",
        title: "MCP: connect an AI agent",
        nav: "MCP",
        summary:
          "Give Claude, ChatGPT or any MCP client scoped access to your analytics, and revoke it any time.",
      },
      {
        slug: "assistant",
        title: "The AI assistant",
        nav: "AI assistant",
        summary:
          "Ask questions about your traffic in plain language, and what the assistant can and cannot see.",
      },
    ],
  },
  {
    label: "Help",
    items: [
      {
        slug: "troubleshooting",
        title: "Troubleshooting",
        nav: "Troubleshooting",
        summary:
          "No data arriving, numbers lower than other tools, events counted twice: the checklist for each.",
      },
    ],
  },
];

/**
 * Pages an optional surface documents, folded into the section it names
 * before anything reads the map. The hosted deployment adds "Usage & billing":
 * plans, quotas and lapsed subscriptions are things only it has, and a
 * self-hosted install linking that page from its sidebar would be pointing at
 * a route its own build does not contain.
 */
for (const page of extensionDocsPages) {
  const section = DOC_SECTIONS.find(
    (candidate) => candidate.label === page.section
  );
  if (!section) {
    throw new Error(`No documentation section named ${page.section}`);
  }
  section.items.push({
    slug: page.slug,
    title: page.title,
    nav: page.nav,
    summary: page.summary,
  });
}

export const DOCS_PAGES: DocPage[] = DOC_SECTIONS.flatMap(
  (section) => section.items
);

export function docHref(slug: string): string {
  return slug === "" ? "/docs" : `/docs/${slug}`;
}

/**
 * Whether this deployment documents `slug`.
 *
 * `DocLink` throws on an unknown slug on purpose — a documentation set that
 * links to a page it does not contain is worse than one that says less — so a
 * page whose *neighbour* is optional asks first and writes the sentence
 * without the link when the answer is no.
 */
export function hasDocPage(slug: string): boolean {
  return DOCS_PAGES.some((candidate) => candidate.slug === slug);
}

export function docPage(slug: string): DocPage {
  const page = DOCS_PAGES.find((candidate) => candidate.slug === slug);
  if (!page) throw new Error(`Unknown doc page: ${slug}`);
  return page;
}

/** Every doc page's metadata, from the same registry entry the sidebar reads. */
export function docsMetadata(page: DocPage): Metadata {
  return {
    title:
      page.slug === ""
        ? { absolute: "Documentation | Open Analytics" }
        : page.title,
    description: page.summary,
    alternates: { canonical: docHref(page.slug) },
  };
}
