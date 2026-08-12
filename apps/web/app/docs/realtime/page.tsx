import {
  DocArticle,
  DocLink,
  DocList,
  DocNote,
  DocSection,
} from "@/components/docs/doc-prose";
import { docPage, docsMetadata } from "@/lib/docs";

const page = docPage("realtime");
export const metadata = docsMetadata(page);

export default function RealtimeDocsPage() {
  return (
    <DocArticle page={page}>
      <DocSection title="What you see">
        <p>
          The realtime view answers right now: how many people are on the
          site this moment, which pages they are reading, where they are
          from, on what devices, and a rolling feed of pageviews as they
          happen. It updates over a live stream, no refreshing.
        </p>
      </DocSection>

      <DocSection title="How presence works">
        <DocList
          items={[
            "The tracker sends a small heartbeat every few seconds while a tab is visible. Presence is built from heartbeats, so someone reading quietly still counts as online.",
            "A hidden tab stops heartbeating and the visitor ages out of the view within minutes; realtime state lives about five minutes and is never stored historically.",
            "A visitor can be present without a feed entry: the feed lists pageviews, and someone who arrived before your window opened has heartbeats but no fresh pageview. The Online count includes them; that is the ordinary case, not a bug.",
          ]}
        />
      </DocSection>

      <DocSection title="Sharing it">
        <DocNote>
          The live visitor count can ride a{" "}
          <DocLink slug="share">public dashboard</DocLink> (its own switch,
          count only) and the{" "}
          <DocLink slug="widgets">widgets</DocLink> can embed it anywhere.
          Realtime is also on the read API for your own code, via
          short-lived stream tokens; see{" "}
          <DocLink slug="api">the read API</DocLink>.
        </DocNote>
      </DocSection>
    </DocArticle>
  );
}
