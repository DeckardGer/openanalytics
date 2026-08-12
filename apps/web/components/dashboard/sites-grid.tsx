"use client";

import * as React from "react";
import { AddSiteDialog } from "@/components/dashboard/add-site-dialog";
import { ApiErrorPanel } from "@/components/dashboard/api-error";
import { SiteCard } from "@/components/dashboard/site-card";
import { InboxIcon } from "@/components/icons/hugeicons";
import { SkeletonReveal } from "@/components/ui/skeleton-reveal";
import { SquircleSurface } from "@/components/ui/squircle-card";
import { useApiResource } from "@/hooks/use-api-resource";
import { listSites, LIVE_API } from "@/lib/api";
import { useSession } from "@/lib/auth-client";
import { MOCK_SITES } from "@/lib/mock";

/**
 * The sites picker, fed by `GET /v1/sites`.
 *
 * Client-side because it needs the session cookie, which is host-only on the
 * api origin and therefore invisible to a Server Component. The greeting comes
 * from the session too — `name` never appears in a `/v1` response.
 */
export function SitesGrid() {
  const { data: session } = useSession();
  const load = React.useCallback(
    (signal: AbortSignal) =>
      LIVE_API
        ? listSites({ signal })
        : Promise.resolve({ items: MOCK_SITES }),
    []
  );
  const sites = useApiResource(load);

  const firstName = LIVE_API
    ? (session?.user.name?.trim().split(/\s+/)[0] ?? null)
    : "Alex";

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-medium tracking-tight">
            {firstName ? `Welcome back, ${firstName}!` : "Your sites"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick a site to open its dashboard.
          </p>
        </div>
        <AddSiteDialog />
      </div>

      {/* The house reveal. Nothing per-card is knowable before the list
          answers — not even how many cards there are — so unlike a settings
          panel there is no chrome to hold static: the stand-in is three
          whole cards at the common shape, and the swap comes into focus
          instead of snapping. An error and the empty state are settled
          answers, so they arrive through the same reveal. */}
      <SkeletonReveal
        ready={sites.status !== "loading"}
        skeleton={
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((index) => (
              <SiteCardSkeleton key={index} />
            ))}
          </div>
        }
      >
        {sites.status === "error" ? (
          <SquircleSurface className="border border-border shadow-[0_1px_2px_rgba(0,0,0,0.06)]">
            <ApiErrorPanel error={sites.error} onRetry={sites.retry} />
          </SquircleSurface>
        ) : sites.status === "ready" && sites.data.items.length === 0 ? (
          <SquircleSurface className="border border-border shadow-[0_1px_2px_rgba(0,0,0,0.06)]">
            <div className="flex flex-col items-center justify-center gap-2 px-8 py-14 text-center">
              <InboxIcon
                aria-hidden="true"
                className="size-5 text-muted-foreground"
              />
              <p className="text-sm font-medium">No sites yet</p>
              <p className="max-w-80 text-sm leading-6 text-muted-foreground">
                Sites you own or have been invited to will appear here.
              </p>
            </div>
          </SquircleSurface>
        ) : sites.status === "ready" ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {sites.data.items.map((site) => (
              <SiteCard key={site.site_id} site={site} />
            ))}
          </div>
        ) : null}
      </SkeletonReveal>
    </div>
  );
}

/**
 * Same anatomy as `SiteCard`, so the grid does not reflow when data lands.
 * The bars carry no pulse of their own — the reveal's skeleton wrapper
 * provides it, and doubling up would beat twice.
 */
function SiteCardSkeleton() {
  return (
    <SquircleSurface className="flex flex-col rounded-[24px] border border-border p-1 shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:13px] sm:rounded-[30px] sm:[--card-clip-handle:2.5px] sm:[--card-clip-radius:17px]">
      <div className="flex items-center gap-2.5 pb-1.5 pl-3.5 pr-3 pt-1">
        <span className="size-2 shrink-0 rounded-full bg-muted-foreground/20" />
        <span className="h-3 w-28 rounded bg-muted-foreground/15" />
      </div>
      <SquircleSurface className="flex-1 rounded-[20px] border border-border bg-[#f6f6f6] px-4 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:11px] sm:rounded-[26px] sm:[--card-clip-handle:2.5px] sm:[--card-clip-radius:14px]">
        {/* the mark, the domain and the slug under it — the ready anatomy */}
        <div className="flex h-12 items-center gap-3">
          <span className="size-7 shrink-0 rounded-lg bg-muted-foreground/15" />
          <div className="min-w-0 flex-1">
            <span className="block h-3.5 w-32 rounded bg-muted-foreground/15" />
            <span className="mt-1 block h-3 w-20 rounded bg-muted-foreground/10" />
          </div>
        </div>
        <div className="mt-3 h-3 w-full rounded bg-muted-foreground/10" />
      </SquircleSurface>
    </SquircleSurface>
  );
}
