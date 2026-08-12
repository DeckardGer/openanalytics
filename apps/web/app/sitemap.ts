import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";
import { SITE_PAGES } from "@/lib/site-pages";

/**
 * The invitation, generated from `lib/site-pages.ts`.
 *
 * A sitemap says "these are worth your crawl budget", `robots.txt` says "you
 * may", and `llms.txt` says "here is what each one holds". All three read the
 * same list, so a page cannot be offered to one and hidden from another by
 * accident.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return SITE_PAGES.map((page) => ({
    url: `${SITE_URL}${page.path}`,
    changeFrequency: page.changeFrequency,
    priority: page.priority,
  }));
}
