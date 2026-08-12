import {
  DocArticle,
  DocLink,
  DocList,
  DocNote,
  DocSection,
} from "@/components/docs/doc-prose";
import { docPage, docsMetadata } from "@/lib/docs";

const page = docPage("share");
export const metadata = docsMetadata(page);

export default function ShareDocsPage() {
  return (
    <DocArticle page={page}>
      <DocSection title="What a public dashboard is">
        <p>
          A read-only version of your site&apos;s numbers at a link anyone
          can open, no account needed: totals, the traffic chart,
          engagement, geography, pages, sources and devices, over any range
          the visitor picks. You turn it on under your site&apos;s Settings,
          in the Public dashboard panel, and the link is minted there.
        </p>
      </DocSection>

      <DocSection title="Three decisions">
        <DocList
          items={[
            <span key="master">
              <strong className="font-medium text-foreground/80">
                The dashboard switch
              </strong>{" "}
              opens the whole data board at once; the text under it lists
              exactly what becomes visible. Off, the link answers nothing at
              all.
            </span>,
            <span key="live">
              <strong className="font-medium text-foreground/80">
                Live visitors
              </strong>{" "}
              is separate: the active-visitor count only, no pages or
              countries. Some owners share history but not presence.
            </span>,
            <span key="identity">
              <strong className="font-medium text-foreground/80">
                Site identity
              </strong>{" "}
              is separate too: your site&apos;s name and favicon in the
              header. Off, the page stays anonymous and shows the shape of
              the traffic without saying whose it is.
            </span>,
          ]}
        />
      </DocSection>

      <DocSection title="The viewer's controls">
        <p>
          A visitor to the share page picks their own range and their own
          timezone (searchable by country or city), so a reader in another
          country reads your day on their clock. Their choices touch nothing
          of yours.
        </p>
      </DocSection>

      <DocSection title="Revoking a link">
        <DocNote>
          Rotate link mints a new address and the old one stops working
          immediately, including any open live streams. Turning the
          dashboard off keeps the address but answers nothing. Share pages
          are deliberately not indexed by search engines; public means
          whoever has the link, not findable in Google. For embedding a
          single number instead of a whole board, use{" "}
          <DocLink slug="widgets">widgets</DocLink>.
        </DocNote>
      </DocSection>
    </DocArticle>
  );
}
