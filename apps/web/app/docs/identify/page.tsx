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

const page = docPage("identify");
export const metadata = docsMetadata(page);

export default function IdentifyPage() {
  return (
    <DocArticle page={page}>
      <DocSection title="What identify does">
        <p>
          By default every visitor is anonymous and the identifier expires
          daily. If your site has signed-in users, you can attach your own
          stable reference to their events:
        </p>
        <DocCode caption="after your user signs in">{`oa.identify("user_8f21c4");`}</DocCode>
        <p>
          From that moment the visitor&apos;s events carry your reference
          (hashed, site-scoped, never stored raw), so a returning signed-in
          user reads as the same person across visits, and revenue can be
          joined through Stripe&apos;s <Code>client_reference_id</Code> (see{" "}
          <DocLink slug="revenue">revenue attribution</DocLink>, recipe 2).
        </p>
      </DocSection>

      <DocSection title="It carries a consent obligation, and it is yours">
        <p>
          Recognising a person across visits is not ordinary audience
          measurement, so the reasoning that lets most sites run this script
          without a banner does not cover this call. You are the controller for
          it: the script sends what your code tells it to, and we do not hold it
          back on a consent state we cannot see.
        </p>
        <p>
          Decide how you ask, then wire the answer. If you use a banner or a
          preference centre, tell the script:
        </p>
        <DocCode caption="wherever you record the visitor's choice">{`oa.consent("granted"); // or "denied" — denied stops everything, immediately`}</DocCode>
        <p>
          Calling <Code>oa.identify()</Code> only after your own consent check
          is the straightforward pattern, and it is the one our privacy notice
          template describes for site owners.
        </p>
      </DocSection>

      <DocSection title="The rules">
        <DocList
          items={[
            "The ID is yours: an internal account number, a database key. Our terms require it not be directly identifying; no emails, no names.",
            "It is hashed before storage with a site-scoped key, so the same reference on two sites produces unrelated values.",
            "1 to 128 characters. The identify event itself is always free; it never counts against your plan.",
            "Unlike the anonymous identifier, it does not rotate daily. That is its purpose, and your own privacy notice should say you use it.",
          ]}
        />
      </DocSection>

      <DocSection title="What it does not do">
        <DocNote>
          Identify does not label the past: sessions from before the call
          stay anonymous, and an identified buyer&apos;s journey runs from
          the most recent daily rotation onward. It also never merges two
          sites; the site is part of the hash, by design.
        </DocNote>
      </DocSection>
    </DocArticle>
  );
}
