import {
  DocArticle,
  DocLink,
  DocList,
  DocNote,
  DocSection,
} from "@/components/docs/doc-prose";
import { docPage, docsMetadata, hasDocPage } from "@/lib/docs";

const page = docPage("funnels");
export const metadata = docsMetadata(page);

export default function FunnelsDocsPage() {
  return (
    <DocArticle page={page}>
      <DocSection title="What a funnel is here">
        <p>
          A funnel is an ordered list of steps (a page visited, an event
          fired) and the question is always the same: of the people who did
          step one, how many made it to the end, and where did the rest
          leave. Funnels live in their own tab on each site.
        </p>
      </DocSection>

      <DocSection title="Building one">
        <DocList
          items={[
            "A step is a page path or a custom event. The editor suggests from what your site actually sends, so you pick real names instead of guessing spellings.",
            "Steps are ordered: a visitor counts for step three only having matched one and two first, within the same session.",
            "Funnels are computed over the range you pick, like every other view; change the range and the funnel recomputes.",
            "Owners and admins edit funnels; viewers see results read-only.",
          ]}
        />
      </DocSection>

      <DocSection title="Deleting">
        <DocNote>
          Deleting a funnel archives it: the definition leaves your list,
          and recreating the same funnel later is harmless. Funnels are
          definitions over your events, so they never change what is
          collected, and building one records nothing new. The events
          themselves are the only thing counted
          {hasDocPage("usage-billing") ? (
            <>
              ; see <DocLink slug="usage-billing">usage and billing</DocLink>
            </>
          ) : null}
          .
        </DocNote>
      </DocSection>
    </DocArticle>
  );
}
