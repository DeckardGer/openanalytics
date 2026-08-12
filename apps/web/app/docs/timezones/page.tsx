import {
  DocArticle,
  DocLink,
  DocNote,
  DocSection,
  DocTable,
} from "@/components/docs/doc-prose";
import { docPage, docsMetadata } from "@/lib/docs";

const page = docPage("timezones");
export const metadata = docsMetadata(page);

export default function TimezonesDocsPage() {
  return (
    <DocArticle page={page}>
      <DocSection title="Three clocks, three owners">
        <DocTable
          head={["Clock", "Set where", "Governs"]}
          rows={[
            [
              "Your timezone",
              "Account, Preferences",
              "Your own dashboards: Today means today in this zone, on every site you can see. Browser default follows wherever you sign in from.",
            ],
            [
              "The site's reporting timezone",
              "Site Settings, Widgets tab",
              "Widgets' windows, cut server-side, and the public dashboard's default. Not set, widgets resolve in UTC.",
            ],
            [
              "The share page viewer's pick",
              "On the public page itself",
              "That viewer's reading only; remembered per tab, touches nothing of yours.",
            ],
          ]}
        />
      </DocSection>

      <DocSection title="Why they are separate">
        <p>
          A team is people in different places: each member reads charts on
          their own clock without changing anyone else&apos;s. A widget is
          public and cannot ask its reader anything, so the site declares
          its clock once. A share page can ask, so it does, with a picker
          that searches by country, city or timezone name.
        </p>
      </DocSection>

      <DocSection title="One clock that never moves">
        <DocNote>
          The anonymous visitor identifier rotates at UTC midnight
          everywhere, deliberately: letting a site pick the rotation clock
          would split visitors at local midnight and make sites comparable
          by their timezone choice. Reporting clocks change how numbers are
          bucketed, never how people are counted. Details under{" "}
          <DocLink slug="privacy">Privacy and consent</DocLink>.
        </DocNote>
      </DocSection>
    </DocArticle>
  );
}
