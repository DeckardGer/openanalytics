import {
  Code,
  DocArticle,
  DocCode,
  DocLink,
  DocList,
  DocNote,
  DocSection,
} from "@/components/docs/doc-prose";
import { docPage, docsMetadata } from "@/lib/docs";

const page = docPage("revenue");
export const metadata = docsMetadata(page);

export default function RevenueDocsPage() {
  return (
    <DocArticle page={page}>
      <DocSection title="Connecting Stripe">
        <p>
          Under your site&apos;s Settings, Integrations, connect Stripe with
          a restricted, read-only key: a couple of minutes, no code changes.
          From then on payments, refunds, disputes and fees flow into the
          Revenue tab, joined to the visits that produced them where a
          signal exists. Disconnecting stops the flow immediately.
        </p>
      </DocSection>

      <DocSection title="Recipe 1: the order_id conversion (the strong one)">
        <p>Fire a conversion on your success page carrying the order:</p>
        <DocCode caption="success page">{`oa.conversion("purchase", { order_id: "cs_live_a1B2c3" });`}</DocCode>
        <DocList
          items={[
            <span key="ids">
              <Code>order_id</Code> is the Stripe Checkout Session (
              <Code>cs_…</Code>), PaymentIntent (<Code>pi_…</Code>) or
              charge id (<Code>ch_…</Code>), whichever your page has.
            </span>,
            "The join is exact: the transaction and its journey get confidence “exact”, the strongest the system issues.",
            "A conversion is a billable custom event, one unit; nothing about the recipe bills twice.",
          ]}
        />
      </DocSection>

      <DocSection title="Recipe 2: identify plus client_reference_id">
        <p>
          When your success page cannot know the order, pass the same stable
          user reference to both sides:
        </p>
        <DocCode caption="browser">{`oa.identify("user_8f21c4");`}</DocCode>
        <DocCode caption="server, creating the checkout">{`stripe.checkout.sessions.create({
  client_reference_id: "user_8f21c4",
  // ...
});`}</DocCode>
        <p>
          Both sides are hashed with the same site-scoped derivation and
          joined without either value ever being stored raw. This yields
          confidence &quot;linked&quot;: it identifies the person rather
          than the order, which is exactly what makes it the fallback. See{" "}
          <DocLink slug="identify">identify</DocLink> for the rules.
        </p>
      </DocSection>

      <DocSection title="What the reports show">
        <DocList
          items={[
            "Net revenue with its parts printed: gross, refunds, disputes, fees. A flat month of quiet trading and a flat month of heavy refunds look different here, on purpose.",
            "Gross and net share one chart; the gap between the lines is the cost of doing business.",
            "Payments the join could not attribute still count in every total; they simply have no journey. There is no IP matching and no time-proximity guessing, by policy.",
            "Currencies that could not be converted are listed beside the totals rather than silently dropped.",
          ]}
        />
      </DocSection>

      <DocSection title="Privacy">
        <DocNote>
          Card numbers never touch our servers, provider payloads are never
          persisted, and the customer reference is stored only as a
          non-joinable pseudonym. Revenue aggregates are readable over the
          API by the site owner; individual transactions never leave the
          dashboard.
        </DocNote>
      </DocSection>
    </DocArticle>
  );
}
