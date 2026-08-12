import {
  Code,
  DocArticle,
  DocCode,
  DocLink,
  DocList,
  DocNote,
  DocSection,
} from "@/components/docs/doc-prose";
import { docPage, docsMetadata, hasDocPage } from "@/lib/docs";

const page = docPage("custom-events");
export const metadata = docsMetadata(page);

export default function CustomEventsPage() {
  return (
    <DocArticle page={page}>
      <DocSection title="Three ways in">
        <p>
          A custom event is a named thing a visitor did: a signup click, a
          checkout, a download. There are three ways to produce one, and they
          are the same event once it arrives; pick whichever fits how you
          work.
        </p>
        <DocList
          items={[
            "An HTML attribute on the element (no code, no dashboard step).",
            "A no-code rule defined in the dashboard (no deploy at all).",
            "The JavaScript API, for anything conditional or programmatic.",
          ]}
        />
      </DocSection>

      <DocSection title="1. The attribute: data-oa-event">
        <p>
          Mark any element and every click on it counts, under the name you
          wrote:
        </p>
        <DocCode caption="anywhere in your HTML">{`<button data-oa-event="signup_click">Sign up</button>`}</DocCode>
        <DocList
          items={[
            <span key="grammar">
              The name is letters or digits first, then letters, digits,{" "}
              <Code>_ . : -</Code>, up to 64 characters. An invalid name
              sends nothing, silently.
            </span>,
            "A click anywhere inside the marked element counts once; when marked elements nest, the innermost one wins.",
            <span key="form">
              On a <Code>&lt;form&gt;</Code> the attribute fires on submit
              instead of click.
            </span>,
            "A middle-click on a marked link counts too, the same as cmd or ctrl click: opening your CTA in a new tab is still following it.",
          ]}
        />
        <p>
          Add properties with <Code>data-oa-prop-*</Code> on the same
          element, so one event name can answer both how many and which:
        </p>
        <DocCode caption="one name, two placements">{`<a href="/signup" data-oa-event="signup" data-oa-prop-section="hero">Get started</a>
<a href="/signup" data-oa-event="signup" data-oa-prop-section="pricing">Get started</a>`}</DocCode>
        <DocNote>
          Write property keys in kebab-case: HTML lowercases attribute names,
          so <Code>data-oa-prop-buttonLabel</Code> silently becomes the key{" "}
          <Code>buttonlabel</Code>. Properties are read from the marked
          element only, never from parents or children.
        </DocNote>
      </DocSection>

      <DocSection title="2. No-code rules">
        <p>
          Under your site&apos;s Custom events tab you can define a rule
          (click, submit, or URL pattern) that produces an event without
          touching your site at all. Rules can read an element&apos;s text,
          an allowlisted attribute, the page path or a query parameter, and
          never the value of an input, at any layer. Publish the rule and it
          is live for the next pageview; no deploy.
        </p>
        <p>
          If a rule and an attribute would name the same click identically,
          the rule wins and exactly one event fires.
        </p>
      </DocSection>

      <DocSection title="3. The JavaScript API">
        <DocCode caption="anywhere after the snippet">{`oa.track("plan_selected", { plan: "growth" });

// a conversion is a custom event that marks an outcome;
// with an order_id it also ties revenue to the visit
oa.conversion("purchase", { order_id: "cs_live_a1B2c3" });`}</DocCode>
        <DocList
          items={[
            "Properties: up to 32 per event, keys up to 40 characters, string values up to 256.",
            <span key="reserved">
              Keys starting with <Code>oa_</Code> are reserved and dropped,
              and so are keys that name a secret (token, session, email and
              friends).
            </span>,
            "Values are redacted in the browser before sending: an email address or a card-shaped number becomes [redacted]. Do not rely on it, but a template mistake is not a leak.",
            "Nothing needs declaring first. There is no schema step; the event and its properties appear in the dashboard when they first fire.",
          ]}
        />
      </DocSection>

      <DocSection title="Double counting">
        <p>
          A custom event counts as one event, like a pageview
          {hasDocPage("usage-billing") ? (
            <>
              {" "}
              (the full matrix is on{" "}
              <DocLink slug="usage-billing">usage and billing</DocLink>)
            </>
          ) : null}
          . Two instruments describing the same click under the same name are the
          one case to avoid: an attribute plus an <Code>oa.track()</Code> of
          the same name on the same element bills twice. Pick one. A
          dashboard rule with the same name is safe; the rule wins and one
          event fires.
        </p>
      </DocSection>

      <DocSection title="Reading them">
        <p>
          Events appear in the dashboard&apos;s custom events breakdown with
          their count, when they last fired, a sample page path and a sample
          property bag, so you can tell what a name actually carries without
          leaving the list. Attaching a display name is optional labelling
          under Custom events; nothing depends on it.
        </p>
      </DocSection>
    </DocArticle>
  );
}
