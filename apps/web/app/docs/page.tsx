import {
  DocArticle,
  DocLink,
  DocList,
  DocSection,
} from "@/components/docs/doc-prose";
import { docPage, docsMetadata } from "@/lib/docs";

const page = docPage("");
export const metadata = docsMetadata(page);

export default function DocsIndexPage() {
  return (
    <DocArticle page={page}>
      <DocSection title="What Open Analytics is">
        <p>
          Open Analytics is privacy-first web analytics: one small script on
          your site, a dashboard to read it in, and no cookies, no
          fingerprinting and no personal data anywhere in between. Visitors
          are counted with an identifier that expires every day and differs
          on every site, so nobody can be followed, including by us. The
          full construction is written out under{" "}
          <DocLink slug="privacy">Privacy and consent</DocLink>; the short
          version is that privacy here is a design property, not a setting.
        </p>
        <p>
          Beyond pageviews you get realtime presence, custom events, funnels,
          Core Web Vitals, revenue attribution from Stripe, public share
          pages and embeddable widgets, all from the same script, plus a
          read API, a CLI and an MCP server for everything programmatic.
        </p>
      </DocSection>

      <DocSection title="How the pieces fit">
        <DocList
          items={[
            <span key="tracker">
              <strong className="font-medium text-foreground/80">
                The tracker
              </strong>{" "}
              is a single async script tag, around 2 KB compressed. It
              records pageviews (including client-side route changes),
              engagement time, Web Vitals and the events you define, and
              sends them to our EU collector.
            </span>,
            <span key="dashboard">
              <strong className="font-medium text-foreground/80">
                The dashboard
              </strong>{" "}
              is where everything is read: traffic, sources, pages,
              geography, devices, sessions, funnels, realtime and revenue,
              each over any time range.
            </span>,
            <span key="surfaces">
              <strong className="font-medium text-foreground/80">
                The programmatic surfaces
              </strong>{" "}
              share one read API: Bearer keys for your own code, OAuth for
              the CLI and for AI agents over MCP. Everything they can read,
              you can revoke.
            </span>,
          ]}
        />
      </DocSection>

      <DocSection title="Where to start">
        <DocList
          items={[
            <span key="qs">
              New here: the <DocLink slug="quick-start">quick start</DocLink>{" "}
              gets a site from zero to live numbers in a few minutes.
            </span>,
            <span key="install">
              Installing on a specific stack: the{" "}
              <DocLink slug="install">installation guides</DocLink> cover
              every major framework, plus WordPress, Webflow and Shopify.
            </span>,
            <span key="events">
              Already counting pageviews:{" "}
              <DocLink slug="custom-events">custom events</DocLink> and{" "}
              <DocLink slug="revenue">revenue attribution</DocLink> are the
              usual next steps.
            </span>,
            <span key="api">
              Building on top: start with{" "}
              <DocLink slug="api">the read API</DocLink> or{" "}
              <DocLink slug="mcp">MCP</DocLink>.
            </span>,
          ]}
        />
      </DocSection>
    </DocArticle>
  );
}
