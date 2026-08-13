import {
  Code,
  DocArticle,
  DocCode,
  DocLink,
  DocNote,
  DocSection,
  DocTable,
} from "@/components/docs/doc-prose";
import { COLLECTOR_BASE_URL } from "@/lib/api";
import { docPage, docsMetadata } from "@/lib/docs";

const page = docPage("script");
export const metadata = docsMetadata(page);

export default function ScriptOptionsPage() {
  return (
    <DocArticle page={page}>
      <DocSection title="Attributes">
        <p>
          Every option rides on the script tag itself. A missing attribute
          means the server decides; <Code>false</Code> and <Code>0</Code> are
          the only falsey values.
        </p>
        <DocTable
          head={["Attribute", "Effect"]}
          rows={[
            [
              <Code key="a">data-test-mode</Code>,
              "Marks the traffic non-production. It never bills, and it stays out of every chart, rollup and realtime view. Use it on staging and local environments.",
            ],
            [
              <Code key="b">data-debug</Code>,
              "Logs transport failures to the browser console. Useful while installing, off in production.",
            ],
            [
              <Code key="c">data-respect-gpc</Code>,
              "Honour Global Privacy Control. On by default.",
            ],
            [
              <Code key="d">data-respect-dnt</Code>,
              "Honour Do Not Track, in any of its spellings. On by default.",
            ],
            [
              <Code key="e">data-require-consent</Code>,
              "Collect nothing until your consent banner calls oa.consent('granted'). Off by default, because measurement here is aggregate and first-party.",
            ],
            [
              <Code key="f">data-storage=&quot;none&quot;</Code>,
              "Strict mode: the script neither writes to nor reads from localStorage and sessionStorage. The per-tab session hint, the offline queue and the consent state then last one page load, and #oa-ignore does not work.",
            ],
          ]}
        />
        <DocNote>
          One attribute is weaker than it looks, on purpose:{" "}
          <Code>data-respect-gpc=&quot;false&quot;</Code> cannot make GPC
          visitors countable. Our servers discard any request carrying the
          Sec-GPC header regardless of the snippet, so the attribute only
          controls whether the browser bothers sending. The DNT attribute
          works as written; GPC is the signal with legal force, and it is
          enforced on both ends.
        </DocNote>
      </DocSection>

      <DocSection title="Example: staging install">
        <DocCode caption="<head> on staging">{`<script
  async
  src="${COLLECTOR_BASE_URL}/oa.js"
  data-key="YOUR_TRACKING_KEY"
  data-collector="${COLLECTOR_BASE_URL}"
  data-test-mode="true"
  data-debug="true"
></script>`}</DocCode>
      </DocSection>

      <DocSection title="What the script does on its own">
        <p>
          With no options at all, the tracker records pageviews (including
          client-side route changes), engagement time (visible time, and
          active time near a real interaction),{" "}
          <DocLink slug="web-vitals">Core Web Vitals</DocLink>, and the
          events you mark up. Pageviews send immediately; everything else
          batches for about a second and leaves via sendBeacon when a tab
          closes, so nothing is lost to navigation.
        </p>
        <p>
          Site-level behaviour (heartbeat cadence, redacted query keys,
          no-code rules, sampling) comes from your site&apos;s configuration
          and updates without touching the snippet.
        </p>
      </DocSection>

      <DocSection title="What it never does">
        <p>
          No cookies, no identifier stored on the device, no fingerprinting,
          no keystrokes, no form values, no session replay. The full list,
          with the reasons, is on the{" "}
          <DocLink slug="privacy">privacy and consent</DocLink> page.
        </p>
      </DocSection>
    </DocArticle>
  );
}
