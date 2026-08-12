import {
  Code,
  DocArticle,
  DocCode,
  DocLink,
  DocList,
  DocNote,
  DocSection,
} from "@/components/docs/doc-prose";
import { COLLECTOR_BASE_URL } from "@/lib/api";
import { docPage, docsMetadata } from "@/lib/docs";

const page = docPage("privacy");
export const metadata = docsMetadata(page);

export default function PrivacyDocsPage() {
  return (
    <DocArticle page={page}>
      <DocSection title="The short version">
        <p>
          The tracker sets no cookies, stores nothing on the visitor&apos;s
          device, never keeps a raw IP address, and counts visitors with a
          keyed hash that expires at UTC midnight and differs on every site.
          These are design properties of the software, not policies; the
          full construction, with every exception named, is in the{" "}
          <DocLink href="/privacy">Privacy Policy</DocLink>.
        </p>
      </DocSection>

      <DocSection title="Opt-out signals">
        <DocList
          items={[
            "Global Privacy Control: a visitor sending GPC is not measured. Honoured in the browser and again at our servers, so no snippet configuration can override it.",
            "Do Not Track: honoured by default; a per-site setting on the snippet.",
            "One consequence worth knowing: privacy-signal visitors are simply absent from your numbers, which is one reason totals can sit below cookie-based tools.",
          ]}
        />
      </DocSection>

      <DocSection title="The consent API">
        <p>
          Most sites need no banner for this tracker, because nothing is
          stored on the device and nothing personal is collected. If your
          legal position wants explicit consent anyway, two pieces:
        </p>
        <DocCode caption="gate collection until consent">{`<script
  async
  src="${COLLECTOR_BASE_URL}/oa.js"
  data-key="YOUR_TRACKING_KEY"
  data-collector="${COLLECTOR_BASE_URL}"
  data-require-consent="true"
></script>`}</DocCode>
        <DocCode caption="wire your banner to it">{`// when the visitor decides:
oa.consent("granted"); // or
oa.consent("denied");`}</DocCode>
        <DocList
          items={[
            "With data-require-consent, nothing is collected until granted.",
            "Denied is final for that visitor regardless of any other setting, and the choice persists in localStorage on their device.",
            "Every signal the script could send passes through one decision point; there is no path around it.",
          ]}
        />
      </DocSection>

      <DocSection title="What your own privacy policy can say">
        <DocNote>
          We publish a{" "}
          <DocLink href="/privacy/template">privacy notice template</DocLink>{" "}
          written for sites that run Open Analytics: copy it, change the
          name, delete the sections that do not apply (
          <Code>identify</Code>, click positions). For contracts, the{" "}
          <DocLink href="/dpa">Data Processing Agreement</DocLink> applies to
          every customer automatically, no signature round-trip.
        </DocNote>
      </DocSection>

      <DocSection title="Where data lives">
        <p>
          All analytics data is stored and processed in the European Union
          (Helsinki, Finland) and does not leave that infrastructure. Country
          and city come from a database file on our own servers; no IP
          address is ever sent to a geolocation service. The full
          subprocessor list is in the Privacy Policy.
        </p>
      </DocSection>
    </DocArticle>
  );
}
