import { notFound } from "next/navigation";
import {
  Code,
  DocArticle,
  DocCode,
  DocLink,
  DocNote,
  DocSection,
} from "@/components/docs/doc-prose";
import { docPage, docsMetadata } from "@/lib/docs";
import { DOC_FRAMEWORKS, docFramework } from "@/lib/docs-frameworks";

/**
 * One template, every framework: the guides are data
 * (`lib/docs-frameworks.ts`), so a new framework is a list entry, not a
 * page. Statically generated; an unknown slug is a 404, not a fallback.
 */

export function generateStaticParams() {
  return DOC_FRAMEWORKS.map((framework) => ({ framework: framework.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ framework: string }>;
}) {
  const { framework } = await params;
  const entry = docFramework(framework);
  if (!entry) return {};
  return docsMetadata(docPage(`install/${framework}`));
}

export default async function FrameworkInstallPage({
  params,
}: {
  params: Promise<{ framework: string }>;
}) {
  const { framework } = await params;
  const entry = docFramework(framework);
  if (!entry) notFound();
  const page = docPage(`install/${framework}`);

  return (
    <DocArticle page={page}>
      {entry.cliDetects ? (
        <DocSection title="The short way">
          <p>
            From your project folder, let the CLI detect {entry.name} and
            place the snippet itself:
          </p>
          <DocCode caption="terminal">npx getopen init</DocCode>
          <p>
            It asks for your tracking key (dashboard, your site, Settings,
            Installation), writes the tag, and prints which file it changed.
            Prefer to do it by hand? The steps below are what it does.
          </p>
        </DocSection>
      ) : (
        <DocSection title="Before you start">
          <p>
            You need your site&apos;s tracking key from the dashboard: your
            site, then Settings, then Installation. It looks like{" "}
            <Code>oa_pk_…</Code> and is safe to paste into your pages; it
            can only write events, never read anything.
          </p>
        </DocSection>
      )}

      <DocSection title="Manual steps">
        <div className="flex flex-col gap-4">
          {entry.steps.map((step, index) => (
            <div className="flex flex-col gap-2" key={index}>
              <p>
                {entry.steps.length > 1 ? `${index + 1}. ` : null}
                {step.text}
              </p>
              {step.code ? (
                <DocCode caption={step.caption}>{step.code}</DocCode>
              ) : null}
            </div>
          ))}
        </div>
      </DocSection>

      <DocSection title="Next">
        <DocNote>
          Route changes in a single-page app are tracked automatically, and
          the snippet never needs editing for updates. From here:{" "}
          <DocLink slug="custom-events">custom events</DocLink> for the
          actions you care about, or{" "}
          <DocLink slug="script">script options</DocLink> for test mode and
          the privacy attributes.
        </DocNote>
      </DocSection>
    </DocArticle>
  );
}
