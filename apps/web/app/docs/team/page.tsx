import {
  DocArticle,
  DocList,
  DocNote,
  DocSection,
  DocTable,
} from "@/components/docs/doc-prose";
import { docPage, docsMetadata } from "@/lib/docs";

const page = docPage("team");
export const metadata = docsMetadata(page);

export default function TeamDocsPage() {
  return (
    <DocArticle page={page}>
      <DocSection title="Roles">
        <DocTable
          head={["Role", "What it can do"]}
          rows={[
            [
              "Owner",
              "Everything, including deleting the site, managing every member, and the transfer flows. Every site has exactly one owner.",
            ],
            [
              "Admin",
              "Manage settings, keys, sharing, funnels and members, everything except deleting the site or removing its owner.",
            ],
            [
              "Viewer",
              "Read everything, change nothing: dashboards, funnels and settings are visible read-only, and the first toggle they cannot flip says so up front.",
            ],
          ]}
        />
      </DocSection>

      <DocSection title="Invitations">
        <DocList
          items={[
            "Invite by email from the site's Team tab; the invitation shows its status and expiry beside each pending entry.",
            "Resending mints a fresh link and the previous one stops working.",
            "Membership is per site: someone can be an admin on one site and a viewer on another.",
          ]}
        />
      </DocSection>

      <DocSection title="Who pays, and handing that over">
        <p>
          One member is the billing owner: the site counts against their
          plan. Two flows exist for changing that, both under Settings:
        </p>
        <DocList
          items={[
            "Billing transfer: the billing owner nominates a member, who accepts or declines. If the acceptor's plan has no room, the transfer completes and the site pauses until they upgrade; the copy in the flow says so before anyone commits.",
            "Leaving or being removed: an owner leaving names a successor first, so a site is never left ownerless.",
          ]}
        />
      </DocSection>

      <DocSection title="Security">
        <DocNote>
          Destructive steps (deleting a site, deleting an account, removing
          a member&apos;s access to money) ask for a recent
          re-authentication, not just a live cookie. Every credential event
          on an account (a key created, an app connected, a first use from a
          new source) is journalled and visible to the account owner.
        </DocNote>
      </DocSection>
    </DocArticle>
  );
}
