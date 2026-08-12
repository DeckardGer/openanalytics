import {
  Code,
  DocArticle,
  DocCode,
  DocLink,
  DocNote,
  DocSection,
} from "@/components/docs/doc-prose";
import { COLLECTOR_BASE_URL } from "@/lib/api";
import { docPage, docsMetadata } from "@/lib/docs";

const page = docPage("quick-start");
export const metadata = docsMetadata(page);

export default function QuickStartPage() {
  return (
    <DocArticle page={page}>
      <DocSection title="1. Create a site">
        <p>
          Sign in and add your site: a name and its domain.
          The dashboard hands you a tracking key (it looks like{" "}
          <Code>oa_pk_…</Code>) and the exact snippet to paste. The tracking
          key is public by design; it can only write events, never read
          anything.
        </p>
      </DocSection>

      <DocSection title="2. Install the tracker">
        <p>The fastest path is the CLI, from your project folder:</p>
        <DocCode caption="terminal">npx getopen init</DocCode>
        <p>
          It detects your framework, asks for the tracking key, and writes
          the snippet into the right file itself. Prefer doing it by hand,
          or on a hosted platform? Paste the snippet into your site&apos;s{" "}
          <Code>&lt;head&gt;</Code>:
        </p>
        <DocCode caption="<head>">{`<script
  async
  src="${COLLECTOR_BASE_URL}/oa.js"
  data-key="YOUR_TRACKING_KEY"
  data-collector="${COLLECTOR_BASE_URL}"
></script>`}</DocCode>
        <p>
          Per-framework file locations are in the{" "}
          <DocLink slug="install">installation guides</DocLink>.
        </p>
      </DocSection>

      <DocSection title="3. Watch the first visit arrive">
        <p>
          Open your site once, then look at the dashboard: the install step
          flips to done on its own, and the realtime view shows your visit
          within seconds. Historical charts follow moments later; the
          pipeline typically lands an event in about two seconds.
        </p>
        <DocNote>
          Nothing showing up? The{" "}
          <DocLink slug="troubleshooting">troubleshooting page</DocLink>{" "}
          walks the three usual causes: a wrong key, a caching layer serving
          old HTML, and an origin allowlist that does not include the host
          you are testing from.
        </DocNote>
      </DocSection>

      <DocSection title="4. From here">
        <p>
          Name the actions you care about with{" "}
          <DocLink slug="custom-events">custom events</DocLink> (one HTML
          attribute is enough), connect{" "}
          <DocLink slug="revenue">Stripe revenue</DocLink>, or share a{" "}
          <DocLink slug="share">public dashboard</DocLink> with your team or
          your audience.
        </p>
      </DocSection>
    </DocArticle>
  );
}
