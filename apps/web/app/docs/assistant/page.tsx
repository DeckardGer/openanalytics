import {
  DocArticle,
  DocLink,
  DocList,
  DocNote,
  DocSection,
} from "@/components/docs/doc-prose";
import { docPage, docsMetadata } from "@/lib/docs";

const page = docPage("assistant");
export const metadata = docsMetadata(page);

export default function AssistantDocsPage() {
  return (
    <DocArticle page={page}>
      <DocSection title="What it is">
        <p>
          A chat in the dashboard that answers questions about your sites in
          plain language: what changed this week, which pages grew, where a
          spike came from. It reads the same aggregates your dashboard
          reads, reasons over them, and answers with the numbers inline.
        </p>
      </DocSection>

      <DocSection title="What it can see, precisely">
        <DocList
          items={[
            "Totals, time buckets and top-N lists: pages, referrers, countries, cities, devices, browsers, and revenue summaries. The same read surface as everything else.",
            "Never a per-visitor row, never an email, never a transaction. The surfaces it queries do not carry them, so there is nothing to filter and nothing to forget.",
            "Your question is scrubbed for anything secret-shaped before it leaves; a pasted API key never reaches the model provider.",
            "It answers only about your sites and their analytics; recipes and world news are politely declined.",
          ]}
        />
      </DocSection>

      <DocSection title="Limits and storage">
        <DocNote>
          Conversations are not stored on our servers; the transcript lives
          in your browser session. A daily fair-use quota applies, and
          hitting it says so plainly. For programmatic access or a different
          agent, use <DocLink slug="mcp">MCP</DocLink>; for your own code,{" "}
          <DocLink slug="api">the read API</DocLink>.
        </DocNote>
      </DocSection>
    </DocArticle>
  );
}
