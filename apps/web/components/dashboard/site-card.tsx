"use client";

import { ArrowRight01Icon as ChevronRight } from "hugeicons-react";
import Link from "next/link";
import { SiteMark } from "@/components/dashboard/site-favicon";
import { Button } from "@/components/ui/button";
import { SquircleSurface } from "@/components/ui/squircle-card";
import type { SiteRole, SiteStatus, SiteSummary } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Site card in the overview-card anatomy: squircle frame with the site's name
 * in the top strip, and its identity on the inset gray panel.
 *
 * It shows only what `GET /v1/sites` actually returns. The sparkline, live
 * count and visitor delta this card used to render came from a mock; the list
 * endpoint carries no numbers and fetching an analytics range per card would
 * be N+1 requests for a screen whose job is to pick a site. So the card is a
 * name, a domain, a role and a status — and it never shows a number it does
 * not have.
 */

const STATUS: Record<SiteStatus, { dot: string; label: string; pulse: boolean }> =
  {
    active: { dot: "bg-success", label: "Active", pulse: true },
    suspended: {
      dot: "bg-destructive",
      label: "Billing blocked",
      pulse: false,
    },
    deleting: { dot: "bg-muted-foreground/50", label: "Deleting", pulse: false },
    deleted: { dot: "bg-muted-foreground/50", label: "Deleted", pulse: false },
  };

/**
 * An active site that has never been seen by the pipeline. `first_event_at`
 * is the install-verified signal (ADR-0027): required-and-nullable, filled
 * once per site ever, so `null` states plainly that no event has ever
 * arrived — the tracker is not on the page yet. Amber and still, because a
 * green pulse would claim traffic that does not exist.
 *
 * It deliberately does not mean "quiet lately": the list endpoint carries no
 * numbers, and a card whose job is to pick a site does not fetch a range per
 * card just to dim a dot.
 */
const WAITING = { dot: "bg-warning", label: "Waiting for data", pulse: false };

const ROLE: Record<SiteRole, string> = {
  owner: "Owner",
  admin: "Admin",
  viewer: "Viewer",
};

export function SiteCard({ site }: { site: SiteSummary }) {
  const waiting = site.status === "active" && site.first_event_at === null;
  const status = waiting ? WAITING : STATUS[site.status];
  const [primaryDomain, ...otherDomains] = site.domains;

  return (
    <SquircleSurface
      className={cn(
        "group relative flex flex-col rounded-[24px] border border-border p-1 shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:13px] sm:rounded-[30px] sm:[--card-clip-handle:2.5px] sm:[--card-clip-radius:17px]",
        "transition-colors duration-300 active:scale-[0.99]"
      )}
    >
      {/* top strip — status dot + name, then the chevron or, for a site with
          no data yet, the way to fix that */}
      <div className="flex items-center justify-between gap-3 pb-1.5 pl-3.5 pr-3 pt-1">
        <span className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden="true"
            className={cn(
              "size-2 shrink-0 rounded-full",
              status.dot,
              status.pulse && "bp-pulse",
            )}
          />
          {/* The card's link is the site name, stretched over the whole card
              by a pseudo-element — so the install shortcut below can be a
              real link of its own instead of a button nested inside one.
              `z-10` matters: the inset panel underneath is `relative`, and
              without it the overlay would sit below the panel and only the
              top strip would be clickable. */}
          <Link
            className="truncate text-sm font-medium text-foreground/80 outline-none before:absolute before:inset-0 before:z-10 before:rounded-[24px] focus-visible:before:ring-2 focus-visible:before:ring-ring sm:before:rounded-[30px]"
            // URLs carry the public slug, never the internal site_id.
            href={`/dashboard/${encodeURIComponent(site.slug)}`}
          >
            {site.name}
          </Link>
        </span>
        {/* Only for someone who can act on it: the install screen reads the
            site key, which needs `credentials:manage` — a viewer following
            this would land on a 403. Their dot still says amber. */}
        {waiting && site.role !== "viewer" ? (
          // Above the stretched overlay (z-20), so this is the one spot on
          // the card that goes somewhere else.
          <Button
            className="relative z-20 shrink-0 text-warning-foreground hover:bg-warning/10 hover:text-warning-foreground"
            render={
              <Link
                href={`/dashboard/${encodeURIComponent(site.slug)}/settings?tab=installation`}
              >
                See installation
              </Link>
            }
            size="xs"
            variant="ghost"
          />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground/50 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:text-primary" />
        )}
      </div>

      {/* inset panel — the site's identity, no invented numbers */}
      <SquircleSurface className="flex-1 rounded-[20px] border border-border bg-[#f6f6f6] px-4 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:11px] sm:rounded-[26px] sm:[--card-clip-handle:2.5px] sm:[--card-clip-radius:14px]">
        {/* the site's own mark beside its domain — the fastest way to
            recognise a card is the icon the site puts in a browser tab —
            with the slug under it, since that is what the URL carries */}
        <div className="flex h-12 items-center gap-3">
          <SiteMark
            className="size-8"
            domain={primaryDomain}
            name={site.name}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {primaryDomain ?? "No domain set"}
            </p>
            <p className="truncate font-mono text-xs text-muted-foreground">
              {site.slug}
            </p>
          </div>
        </div>

        <div className="mt-3 flex items-baseline justify-between gap-2 text-xs">
          <span className="truncate text-muted-foreground">
            {otherDomains.length > 0
              ? `+${otherDomains.length} more ${otherDomains.length === 1 ? "domain" : "domains"}`
              : primaryDomain
                ? ""
                : // An empty allowlist is not "unknown": the collector reads
                  // it as "accept any origin", so saying nothing would mislead.
                  "Accepts any origin"}
          </span>
          <span className="shrink-0 text-muted-foreground">
            {ROLE[site.role]}
            {site.is_billing_owner ? " · Billing" : ""} · {status.label}
          </span>
        </div>
      </SquircleSurface>
    </SquircleSurface>
  );
}
