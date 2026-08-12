import {
  DocArticle,
  DocCode,
  DocLink,
  DocList,
  DocNote,
  DocSection,
} from "@/components/docs/doc-prose";
import { API_BASE_URL } from "@/lib/api";
import { docPage, docsMetadata } from "@/lib/docs";

const page = docPage("widgets");
export const metadata = docsMetadata(page);

export default function WidgetsDocsPage() {
  return (
    <DocArticle page={page}>
      <DocSection title="What a widget is">
        <p>
          One of your site&apos;s numbers (live visitors, or a stat over a
          window like Today or Last 7 days) published as a small live
          document you can put in an iframe anywhere: a README rendered as
          HTML, a status page, your own marketing site. Viewers need no
          account; the widget has its own public token.
        </p>
      </DocSection>

      <DocSection title="Creating and embedding">
        <p>
          Widgets live under your site&apos;s Settings, in the Widgets tab:
          pick the metric and the window, and copy the snippet. It is a
          plain iframe:
        </p>
        <DocCode caption="anywhere that renders HTML">{`<iframe
  src="${API_BASE_URL}/embed/WIDGET_ID"
  title="Analytics widget"
  width="100%"
  height="320"
  loading="lazy"
  style="border:0;color-scheme:normal"
></iframe>`}</DocCode>
        <DocList
          items={[
            "The document draws its own card and adapts to light and dark; the transparent corners show your page, not a white box.",
            "Disabling a widget makes its document answer 404 for every reader; re-enabling brings it back at the same address.",
            "The preview dialog in the dashboard shows the exact live document before you embed it.",
          ]}
        />
      </DocSection>

      <DocSection title="Whose clock a widget reads">
        <DocNote>
          A widget&apos;s window (Today, Last 7 days) is cut server-side in
          the site&apos;s reporting timezone, set on the same Widgets tab.
          Not set, windows resolve in UTC. This is deliberate: a public
          widget cannot ask each reader for a timezone, so the site declares
          one. The whole clock story is on{" "}
          <DocLink slug="timezones">the timezones page</DocLink>.
        </DocNote>
      </DocSection>
    </DocArticle>
  );
}
