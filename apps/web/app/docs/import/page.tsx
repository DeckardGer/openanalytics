import {
  DocArticle,
  DocLink,
  DocList,
  DocNote,
  DocSection,
} from "@/components/docs/doc-prose";
import { docPage, docsMetadata } from "@/lib/docs";

const page = docPage("import");
export const metadata = docsMetadata(page);

export default function ImportDocsPage() {
  return (
    <DocArticle page={page}>
      <DocSection title="How importing works">
        <p>
          Export your history from your current tool and upload it as a
          single ZIP under your site&apos;s Settings, in the Transfer tab.
          Plausible and Fathom exports are supported, and other tools whose
          exports share the same daily-aggregate shape.
        </p>
        <DocList
          items={[
            "Nothing reaches your dashboard until you have reviewed exactly what the file contains: the date span, the metrics, the row counts.",
            "Imported history lands as daily aggregates in its own store; your live events are never mixed with it and never overwritten by it.",
            "One click rolls an import back, completely.",
            "Imported rows never count against your plan. Only your own live traffic bills.",
          ]}
        />
      </DocSection>

      <DocSection title="What imported history can and cannot answer">
        <DocNote>
          A daily aggregate knows visitors, pageviews, sources and pages per
          day; it does not know sessions, funnels steps or realtime. Views
          built on those simply start from the day your live tracking began.
          Charts spanning both eras label which is which rather than
          blending them silently. Exporting your data out again is always
          available from the dashboard; see{" "}
          <DocLink slug="api">the read API</DocLink> for programmatic
          access.
        </DocNote>
      </DocSection>
    </DocArticle>
  );
}
