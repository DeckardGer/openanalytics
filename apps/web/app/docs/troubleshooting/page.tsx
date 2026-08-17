import {
  Code,
  DocArticle,
  DocLink,
  DocList,
  DocNote,
  DocSection,
} from "@/components/docs/doc-prose";
import { docPage, docsMetadata } from "@/lib/docs";
import { SITE_EMAIL } from "@/lib/site";

const page = docPage("troubleshooting");
export const metadata = docsMetadata(page);

export default function TroubleshootingPage() {
  return (
    <DocArticle page={page}>
      <DocSection title="No data is arriving">
        <DocList
          items={[
            <span key="key">
              Check the key: the <Code>data-key</Code> in your page must be
              the tracking key from this site&apos;s Settings, Installation.
              A key from another site writes to that other site.
            </span>,
            "Check the HTML actually served: a caching layer or CDN can serve pages from before you added the tag. View source in the browser and search for oa.js; purge caches if it is missing.",
            "Check the origin allowlist: if your site has domains configured in Settings, events are accepted only from those hosts. Testing from staging or localhost? Add that host, or use an empty list while installing.",
            <span key="verify">
              Verify on the realtime view, not the charts: it shows a visit
              within seconds. Add <Code>data-debug=&quot;true&quot;</Code>{" "}
              temporarily and the browser console reports any transport
              failure.
            </span>,
          ]}
        />
      </DocSection>

      <DocSection title="Numbers are lower than my other tool">
        <DocList
          items={[
            "Privacy-signal visitors are absent by design: someone sending GPC or DNT is not measured at all, while cookie-based tools count them. Respecting the opt-out is the product working.",
            "Bots are filtered before billing and before charts.",
            "Visitors here means people, counted with a daily identifier: a tool that counts cookie lifetimes or device installs will read higher on the same traffic.",
          ]}
        />
      </DocSection>

      <DocSection title="An event is counted twice">
        <p>
          The one way to double-bill a click is describing it twice yourself
          under the same name with two mechanisms: a{" "}
          <Code>data-oa-event</Code> attribute plus an{" "}
          <Code>oa.track()</Code> call of the same name on the same element.
          Pick one. A dashboard rule with the same name is safe; the rule
          wins and exactly one event fires. Details on{" "}
          <DocLink slug="custom-events">the custom events page</DocLink>.
        </p>
      </DocSection>

      <DocSection title="Keeping your own visits out">
        <p>
          Create a separate site for staging and local environments and point
          those snippets at its own tracking key: their traffic then lands in
          its own dashboard instead of production&apos;s. There is no
          per-person exclusion cookie, because the product does not recognise
          people; separating environments is the honest version. (The old{" "}
          <Code>data-test-mode</Code> attribute is retired and ignored —
          traffic from snippets still carrying it is ordinary and visible.)
        </p>
      </DocSection>

      <DocSection title="Still stuck">
        <DocNote>
          {SITE_EMAIL ? (
            <>
              Write to{" "}
              <a
                className="text-foreground underline underline-offset-2 hover:no-underline"
                href={`mailto:${SITE_EMAIL}`}
              >
                {SITE_EMAIL}
              </a>{" "}
              with your site&apos;s slug and what you tried; we answer quickly.
            </>
          ) : (
            <>
              Open an issue on the project&apos;s repository with your
              site&apos;s slug and what you tried.
            </>
          )}
        </DocNote>
      </DocSection>
    </DocArticle>
  );
}
