import type { MetadataRoute } from "next";
import { marketingSitePages } from "@seam/slots";
import { DOCS_PAGES, docHref } from "@/lib/docs";

/**
 * The public surface, in one list.
 *
 * `sitemap.xml` is generated from it, and so is `llms.txt` where that file
 * exists. A page is listed once — here, by way of a registry — or it is in
 * neither: Sleek hand-wrote its `llms.txt` beside a generated sitemap and the
 * two had already drifted apart by the time we read them, which turns the file
 * from a map into a misdirection.
 *
 * What is public depends on the deployment. Documentation is product and is
 * always here; the landing, the comparisons and the legal pages arrive from
 * `@seam/slots` because they only exist where the marketing site does. A
 * self-hosted install therefore publishes a sitemap of its documentation and
 * offers nothing it does not serve.
 */

export type SitePage = {
  path: string;
  /** Human title, as the page's own `metadata.title` states it. */
  title: string;
  /** One line for `llms.txt` — what a reader would find here. */
  summary: string;
  changeFrequency: NonNullable<
    MetadataRoute.Sitemap[number]["changeFrequency"]
  >;
  priority: number;
};

/**
 * The documentation, derived from its own registry (`lib/docs.ts`): a doc page
 * exists in the sidebar, the sitemap and `llms.txt` from one entry, or in none
 * of them.
 */
const DOC_SITE_PAGES: readonly SitePage[] = DOCS_PAGES.map((doc) => ({
  path: docHref(doc.slug),
  title: doc.title,
  summary: doc.summary,
  changeFrequency: "monthly",
  priority: doc.slug === "" ? 0.8 : 0.6,
}));

export const SITE_PAGES: readonly SitePage[] = [
  ...marketingSitePages,
  ...DOC_SITE_PAGES,
];
