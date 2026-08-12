import {
  Code,
  DocArticle,
  DocLink,
  DocList,
  DocNote,
  DocSection,
  DocTable,
} from "@/components/docs/doc-prose";
import { docPage, docsMetadata } from "@/lib/docs";

const page = docPage("api-keys");
export const metadata = docsMetadata(page);

export default function ApiKeysDocsPage() {
  return (
    <DocArticle page={page}>
      <DocSection title="Two kinds of key">
        <DocTable
          head={["Key", "Looks like", "Can"]}
          rows={[
            [
              "Tracking key",
              <Code key="a">oa_pk_…</Code>,
              "Write events from a browser. Public by design: it goes into your HTML, and it can never read anything.",
            ],
            [
              "Read key",
              "Shown once at creation",
              "Read the site and its analytics over the read API. A secret: server-side code and scripts only, never a web page.",
            ],
          ]}
        />
        <p>
          Both live under your site&apos;s Settings, API tab. Keys are
          stored hashed; a read key&apos;s value exists in your clipboard
          once and nowhere else afterwards.
        </p>
      </DocSection>

      <DocSection title="Handling read keys">
        <DocList
          items={[
            "Create one key per consumer (one for the cron job, one for the internal dashboard), so revoking one thing never breaks another.",
            "Revoking is immediate. Rotating is create-new, move, revoke-old, with both alive during the move.",
            "Every key's credential events (created, first used, first used from a new source, revoked) are journalled and visible to the account owner.",
          ]}
        />
      </DocSection>

      <DocSection title="When not to use a key">
        <DocNote>
          Anything interactive or agent-shaped should use OAuth instead: the{" "}
          <DocLink slug="cli">CLI</DocLink> signs in with a device flow and{" "}
          <DocLink slug="mcp">MCP clients</DocLink> get scoped, revocable
          grants. Keys are for headless code you run yourself.
        </DocNote>
      </DocSection>
    </DocArticle>
  );
}
