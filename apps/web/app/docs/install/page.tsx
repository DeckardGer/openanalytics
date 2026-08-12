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
import { DOC_FRAMEWORKS, DOCS_SNIPPET } from "@/lib/docs-frameworks";

const page = docPage("install");
export const metadata = docsMetadata(page);

export default function InstallOverviewPage() {
  return (
    <DocArticle page={page}>
      <DocSection title="The snippet">
        <p>
          Everything starts with one tag in your site&apos;s{" "}
          <Code>&lt;head&gt;</Code>, on every page:
        </p>
        <DocCode caption="<head>">{DOCS_SNIPPET}</DocCode>
        <DocList
          items={[
            <span key="key">
              <Code>data-key</Code> is your site&apos;s tracking key, shown
              in the dashboard when you create the site and any time after
              under Settings, Installation. It is public by design:
              write-only, an ingest identifier, never read access.
            </span>,
            <span key="async">
              <Code>async</Code> is deliberate. The tracker records the
              first pageview immediately and folds in your site&apos;s
              configuration afterwards, so it never costs you a fast bounce.
            </span>,
            <span key="spa">
              Single-page apps need the tag once: the tracker follows
              client-side navigation itself and counts route changes as
              pageviews.
            </span>,
          ]}
        />
      </DocSection>

      <DocSection title="The CLI installer">
        <p>
          <Code>npx getopen init</Code> does the paste for you: it detects
          the framework, asks for the tracking key, writes the snippet into
          the right file and tells you which file it changed. It is
          idempotent; a project that already carries the snippet is left
          alone. See <DocLink slug="cli">the CLI page</DocLink> for
          everything else it can do.
        </p>
      </DocSection>

      <DocSection title="Per-framework guides">
        <DocList
          items={DOC_FRAMEWORKS.map((framework) => (
            <DocLink key={framework.slug} slug={`install/${framework.slug}`}>
              {framework.name}
            </DocLink>
          ))}
        />
      </DocSection>

      <DocSection title="Confirming it works">
        <p>
          The realtime view is the fastest signal: open your site once and
          the visit appears within seconds. Historical charts pass through
          the batch pipeline and typically land in about two seconds. The
          dashboard&apos;s install step also flips to done on its own the
          moment the first event arrives.
        </p>
      </DocSection>

      <DocSection title="The origin allowlist">
        <DocNote>
          If your site has domains configured in Settings, events are
          accepted only from those hosts. An empty domain list means
          unconfigured, which accepts any origin; it never means deny all.
          Adding your first domain silently narrows what is accepted, so if
          you test from a staging host, add it too.
        </DocNote>
      </DocSection>

      <DocSection title="Updates">
        <p>
          The script URL never changes and the file is cached for one hour.
          You never edit the snippet to get a fix; improvements reach your
          visitors within an hour of us shipping them.
        </p>
      </DocSection>
    </DocArticle>
  );
}
