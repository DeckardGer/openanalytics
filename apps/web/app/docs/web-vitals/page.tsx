import {
  DocArticle,
  DocLink,
  DocNote,
  DocSection,
  DocTable,
} from "@/components/docs/doc-prose";
import { docPage, docsMetadata } from "@/lib/docs";

const page = docPage("web-vitals");
export const metadata = docsMetadata(page);

export default function WebVitalsPage() {
  return (
    <DocArticle page={page}>
      <DocSection title="What is measured">
        <p>
          The same script that counts pageviews also reports Google&apos;s
          Core Web Vitals, so you see how the site feels, not only how many
          people felt it. No extra tag, no extra cost: vitals never count
          against your plan.
        </p>
        <DocTable
          head={["Metric", "What it captures"]}
          rows={[
            ["LCP", "Largest Contentful Paint: when the main content became visible."],
            ["CLS", "Cumulative Layout Shift: how much the page jumped around."],
            ["INP", "Interaction to Next Paint: how quickly the page reacted to input."],
            ["FCP", "First Contentful Paint: when anything first rendered."],
            ["TTFB", "Time To First Byte: how fast the server answered."],
          ]}
        />
      </DocSection>

      <DocSection title="How it reports">
        <p>
          Each metric is measured the way Google defines it (CLS as the
          session-window maximum) and reported once per pageview, when the
          tab first goes to the background, with Google&apos;s own
          good/needs-improvement/poor thresholds attached. The dashboard
          shows the distribution per page, so a slow route stands out
          instead of drowning in a site-wide average.
        </p>
      </DocSection>

      <DocSection title="Reading it">
        <DocNote>
          Vitals arrive with normal traffic; a page needs real visits before
          its numbers stabilize. If a route looks slow, the{" "}
          <DocLink slug="dashboard">dashboard page</DocLink> explains how to
          cut the range and compare periods to see whether a deploy moved
          it.
        </DocNote>
      </DocSection>
    </DocArticle>
  );
}
