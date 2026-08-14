"use client";

import * as React from "react";
import { CopyButton } from "@/components/ui/copy-button";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";

/**
 * The line a site pastes wherever it records the visitor's answer.
 *
 * Byte-for-byte the one in `/docs/revenue`, on purpose: a customer who copies
 * it here and then reads the docs must not find two spellings of the same call
 * and wonder which one is current.
 */
export const CONSENT_SNIPPET = `oa.consent("granted"); // or "denied", which stops collection entirely`;

/** The stored flag is a boolean; the radio needs two names for it. */
type Mode = "totals" | "attributed";

/**
 * The two answers a site can give about revenue, and the only place their
 * wording lives.
 *
 * It appears twice, as a step in the Stripe connect flow and as a control in
 * the site's settings, because the flag is a property of the *site* rather than
 * of the connection: `site_ingest_settings.attributed_revenue` (ADR-0064 D4a)
 * holds whether or not a provider is connected, and it has to be changeable
 * after the connect dialog has been closed and forgotten. Two surfaces, one
 * component, so the second one cannot drift into describing the choice
 * differently from the first.
 *
 * **Presentational only.** It reads a boolean and reports a boolean; who
 * persists it, and when, differs between the two callers. The connect flow
 * holds the answer until the connection succeeds, settings writes on change.
 *
 * The note under the opt-in is informational and nothing here gates on it. We
 * cannot see a visitor's consent state and do not pretend to: the obligation
 * belongs to the site as its own controller, so the honest thing is to say so
 * and hand over the one line that wires it, not to add a checkbox that claims
 * we checked.
 *
 * **The copy carries D4b, and it has to.** The switch decides whether a payment
 * is attributed at all, not what the browser sends, so "off" also stops the two
 * signals that never pass through a browser: a checkout `client_reference_id`
 * and an identity on the Stripe object. Describing it as a browser setting
 * would be a screen that says one thing while the product does another. Two
 * consequences ride with it and are stated rather than discovered: revenue
 * figures are bucket reads and do not move in either position, and the switch
 * is forward-only, so turning it off strands nothing and turning it back on
 * reaches back one rolling horizon. `/docs/revenue` says all three; a customer
 * who reads one and then the other must not find two accounts of the same flag.
 */
export function RevenueModeChoice({
  value,
  onValueChange,
  disabled = false,
}: {
  /** `attributed_revenue` as stored. */
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const mode: Mode = value ? "attributed" : "totals";
  const noteId = React.useId();

  return (
    <div className="flex flex-col gap-3">
      <RadioGroup
        aria-label="Revenue mode"
        disabled={disabled}
        onValueChange={(next) => onValueChange(next === "attributed")}
        value={mode}
      >
        <Option
          checked={mode === "totals"}
          description="Nothing is asked of your visitors, and no payment is tied to one. That holds on both sides: a payment carrying a reference from your own Stripe integration is not matched to a visit either. Totals, refunds, disputes and fees all work, and journeys stay empty."
          title="Revenue totals"
          value="totals"
        />

        <Option
          aria-describedby={mode === "attributed" ? noteId : undefined}
          checked={mode === "attributed"}
          description="Ties a payment back to the visit that produced it. Your pages send an order_id with the conversion, which is what turns a count into a link."
          title="Attributed revenue"
          value="attributed"
        >
          {/* Only under the option it belongs to, and only once chosen: this is
              what the choice asks of them, so it is a consequence rather than a
              warning, and reading it before choosing would make it look like a
              reason not to. */}
          {mode === "attributed" ? (
            <div
              className="mt-3 flex flex-col gap-2 rounded-md border border-border/60 bg-muted/40 p-3"
              id={noteId}
            >
              <p className="text-xs leading-5 text-muted-foreground">
                Linking a visitor to an order carries a consent obligation, and
                you meet it as your site&apos;s controller. The script does not
                hold the hint back until somebody answers, so wiring this is
                yours to do. Ask on your own checkout page: consent taken inside
                Stripe Checkout covers the payment, and this is a different
                purpose with a different controller, you.
              </p>
              <div className="flex items-center gap-1">
                <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1.5 font-mono text-[11px] text-foreground/80">
                  {CONSENT_SNIPPET}
                </code>
                <CopyButton
                  label="Copy consent snippet"
                  text={CONSENT_SNIPPET}
                />
              </div>
            </div>
          ) : null}
        </Option>
      </RadioGroup>

      {/* Under both options because it is true under both, and it answers the
          question the choice provokes rather than the one it asks: somebody
          reading "totals only" wonders whether the money goes away, and finding
          out that it does not by switching is the wrong way to learn it. */}
      <p className="text-xs leading-5 text-muted-foreground">
        Totals, refunds, disputes and fees are read from the payments
        themselves, so neither answer changes your revenue figures. What changes
        is whether journeys carry money: switch it off and the journeys you
        already have stay while no new ones are made, and switch it back on and
        roughly the last month of payments is picked up on the next pass,
        nothing older.
      </p>
    </div>
  );
}

/**
 * One option, as a label wrapping its own radio so the whole row is the hit
 * target. The chosen row keeps a slightly stronger border rather than a fill:
 * the expanded note under it already carries a fill, and two of them nested
 * read as two separate cards.
 */
function Option({
  checked,
  children,
  description,
  title,
  value,
  ...rest
}: {
  checked: boolean;
  children?: React.ReactNode;
  description: string;
  title: string;
  value: Mode;
} & React.ComponentPropsWithoutRef<"label">) {
  return (
    <label
      className={cn(
        "flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors",
        checked ? "border-foreground/24" : "border-border/60 hover:border-border"
      )}
      {...rest}
    >
      <Radio className="mt-0.5" value={value} />
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium text-foreground">
          {title}
        </span>
        <span className="mt-1 block text-xs leading-5 text-muted-foreground">
          {description}
        </span>
        {children}
      </span>
    </label>
  );
}
