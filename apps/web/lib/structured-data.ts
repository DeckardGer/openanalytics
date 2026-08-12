import {
  GITHUB_URL,
  SITE_DESCRIPTION,
  SITE_EMAIL,
  SITE_NAME,
  SITE_URL,
} from "@/lib/site";

/**
 * The JSON-LD graph — what this site tells machines it *is*.
 *
 * Metadata says how a page should look when shared; structured data says what
 * the page means. Answer engines lean on the second: an AI asked what Open
 * Analytics costs will read an `Offer` before it will parse a price out of a
 * receipt-styled card, and one asked a question we already answer on the
 * landing page will lift an `Answer` verbatim.
 *
 * **Every builder takes the rendered content as its argument.** Nothing here
 * restates a price or an answer — the pricing table hands over the array it
 * draws from, the FAQ hands over its own questions. Structured data that is
 * maintained *beside* the content it describes drifts from it, and drifted
 * markup is a wrong answer with a schema.org URL attached to it.
 *
 * The nodes are joined by `@id` rather than nested, so the organization is
 * described once and referenced by the site and the product. That is what
 * lets a crawler resolve all three into a single entity instead of three
 * unrelated things that happen to share a name.
 *
 * Deliberately absent: `aggregateRating`. It is the field that most improves
 * how a software listing renders, and we have no reviews — inventing one is
 * both a policy violation and a lie told in a machine-readable format.
 */

/** Plain JSON — a JSON-LD document is data, never code. */
export type JsonLdValue =
  | string
  | number
  | boolean
  | null
  | JsonLdValue[]
  | { [key: string]: JsonLdValue };

export type JsonLdDocument = {
  "@context": "https://schema.org";
} & Record<string, JsonLdValue>;

/** Stable node names, so the graph refers to itself rather than repeating. */
const ORGANIZATION_ID = `${SITE_URL}/#organization`;
const WEBSITE_ID = `${SITE_URL}/#website`;

/**
 * The brand entity: who publishes all of this.
 *
 * `sameAs` is the strongest signal in this node: it ties this name to the same
 * name elsewhere. It held nothing while the only candidate was a GitHub
 * organisation that did not yet hold the code — an unowned link asserts an
 * identity we cannot back. The repository is public now, so it carries exactly
 * one entry. Social accounts join it when they exist, not before.
 */
export function organizationSchema(): JsonLdDocument {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": ORGANIZATION_ID,
    name: SITE_NAME,
    url: SITE_URL,
    description: SITE_DESCRIPTION,
    logo: {
      "@type": "ImageObject",
      url: `${SITE_URL}/web-app-manifest-512x512.png`,
      width: 512,
      height: 512,
    },
    sameAs: [GITHUB_URL],
    email: SITE_EMAIL,
  };
}

/** The site itself, published by the organization above. */
export function webSiteSchema(): JsonLdDocument {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": WEBSITE_ID,
    url: SITE_URL,
    name: SITE_NAME,
    description: SITE_DESCRIPTION,
    inLanguage: "en",
    publisher: { "@id": ORGANIZATION_ID },
  };
}

/**
 * What the pricing section hands over. A superset is fine — this is the
 * subset the graph needs, so the receipt stays the single source of the
 * numbers.
 */
export type PlanOffer = {
  name: string;
  /** Monthly list price, USD. */
  monthly: number;
  /** Yearly list price, USD. */
  yearly: number;
  events: number;
  /** `null` is unlimited. */
  sites: number | null;
};

/** 50_000 → "50K", so an offer name carries the limit a reader compares. */
function compactEvents(events: number): string {
  return events >= 1_000_000
    ? `${events / 1_000_000}M`
    : `${events / 1_000}K`;
}

/**
 * One offer per plan per billing period.
 *
 * Both periods are listed because both are really purchasable, and "is there
 * an annual discount" is a question a pricing answer should be able to settle
 * without a human opening the page. `referenceQuantity` is what makes the
 * figure a *rate* rather than a one-off charge — without it, $90 a year reads
 * as $90, once.
 */
function planOffers(plans: readonly PlanOffer[]): JsonLdValue[] {
  const periods = [
    { label: "monthly", price: (plan: PlanOffer) => plan.monthly, unitCode: "MON" },
    { label: "yearly", price: (plan: PlanOffer) => plan.yearly, unitCode: "ANN" },
  ] as const;

  return plans.flatMap((plan) =>
    periods.map((period) => ({
      "@type": "Offer",
      name: `${plan.name} (${period.label})`,
      description: `${compactEvents(plan.events)} events a month, ${
        plan.sites === null ? "unlimited sites" : `${plan.sites} sites`
      }. Every feature is on every plan.`,
      price: period.price(plan),
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
      url: `${SITE_URL}/#pricing`,
      priceSpecification: {
        "@type": "UnitPriceSpecification",
        price: period.price(plan),
        priceCurrency: "USD",
        referenceQuantity: {
          "@type": "QuantitativeValue",
          value: 1,
          unitCode: period.unitCode,
        },
      },
    }))
  );
}

/**
 * The product, priced.
 *
 * `offers` is the reason this node exists: it is how a pricing question gets
 * answered with our numbers instead of a competitor's summary of them.
 */
export function softwareApplicationSchema(
  plans: readonly PlanOffer[]
): JsonLdDocument {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "@id": `${SITE_URL}/#software`,
    name: SITE_NAME,
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    applicationCategory: "BusinessApplication",
    applicationSubCategory: "Web analytics",
    operatingSystem: "Web browser",
    publisher: { "@id": ORGANIZATION_ID },
    isPartOf: { "@id": WEBSITE_ID },
    offers: planOffers(plans),
  };
}

/** What the FAQ section hands over — a superset is fine. */
export type FaqEntry = {
  title: string;
  description: string;
};

/**
 * The questions we already answer, in the shape an answer engine extracts.
 *
 * This is the cheapest AEO win on the site: the copy is written, reviewed and
 * rendered — the markup only tells a machine which half of each row is the
 * question.
 */
export function faqPageSchema(faqs: readonly FaqEntry[]): JsonLdDocument {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.title,
      acceptedAnswer: {
        "@type": "Answer",
        text: faq.description,
      },
    })),
  };
}
