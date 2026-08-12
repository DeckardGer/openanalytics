"use client";

import { PauseIcon, Settings02Icon } from "hugeicons-react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import * as React from "react";
import { SuspendedSiteScreen } from "@seam/slots";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  errorCodeOf,
  LIVE_API,
  resolveSiteSlugCached,
  sites,
  type SiteSummary,
} from "@/lib/api";
import { mockSiteBySlug } from "@/lib/mock";
import { useApi } from "@/lib/use-api";

/**
 * Lifecycle gate for every `/dashboard/[site]` screen (frontend_tasks §15/§17).
 *
 * `suspended` replaces the analytics surfaces with the paused screen —
 * but never settings: team, keys and whatever lifts the suspension must stay
 * reachable while it holds, and only analytics reads answer
 * `403 SITE_SUSPENDED`.
 * `deleting` replaces everything: the purge takes minutes, exposes no
 * progress, and a deleting site is read-only by contract — a full screen is
 * how "no settings writes, no key creation, no invites" is actually enforced.
 * While the summary is still loading the children render as usual; their own
 * skeletons cover that window.
 */
/**
 * The 202 → gate bridge: the gate's summary read happened before the delete
 * started and nothing refetches it on navigation, so the delete dialog marks
 * the site here and the gate flips to the deleting screen immediately.
 */
const EMPTY_DELETING: ReadonlySet<string> = new Set();
let deletingIds: ReadonlySet<string> = EMPTY_DELETING;
const deletingListeners = new Set<() => void>();

export function markSiteDeleting(siteId: string) {
  const next = new Set(deletingIds);
  next.add(siteId);
  deletingIds = next;
  for (const listener of deletingListeners) listener();
}

const subscribeDeleting = (onChange: () => void) => {
  deletingListeners.add(onChange);
  return () => {
    deletingListeners.delete(onChange);
  };
};
const readDeleting = () => deletingIds;
const readDeletingServer = () => EMPTY_DELETING;

export function SiteLifecycleGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams<{ site?: string }>();
  const slug = params.site ? decodeURIComponent(params.site) : "";
  const pathname = usePathname();

  const summary = useApi(
    () => resolveSiteSlugCached(slug).then((found) => sites.get(found.site_id)),
    () => mockSiteBySlug(slug),
    slug
  );

  const locallyDeleting = React.useSyncExternalStore(
    subscribeDeleting,
    readDeleting,
    readDeletingServer
  );

  const onSettings = pathname?.includes("/settings") ?? false;

  // Fail open on load/error: the panels behind the gate present their own
  // states, and a gate that blanks the site on a flaky summary read would
  // hide screens that still work.
  if (summary.phase !== "ready") return <>{children}</>;

  const site = summary.data;
  // `deleted` never normally reaches here (by-id reads 404), but if it does,
  // the deleting screen's poll lands on the same 404 and routes out.
  if (
    site.status === "deleting" ||
    site.status === "deleted" ||
    locallyDeleting.has(site.site_id)
  ) {
    return <DeletingScreen site={site} />;
  }
  if (site.status === "suspended" && !onSettings) {
    return <BlockedScreen site={site} />;
  }
  return <>{children}</>;
}

/* ------------------------------------------------------------------ */

/**
 * The paused screen.
 *
 * The *state* is product — a site can be suspended on any install, and the api
 * closes its analytics with `403 SITE_SUSPENDED` either way — but the reason
 * is not. Only a deployment that suspends sites knows why it did and what
 * lifts it, so it contributes the screen that says so (`@seam/slots`); with no
 * such deployment behind it, this states the fact and points at the one place
 * that stays open.
 */
function BlockedScreen({ site }: { site: SiteSummary }) {
  if (SuspendedSiteScreen) {
    return (
      <SuspendedSiteScreen
        ingestGraceUntil={site.ingest_grace_until}
        name={site.name}
        retentionDeadline={site.retention_deadline}
        slug={site.slug}
        suspendedAt={site.suspended_at}
      />
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-4 py-24 text-center">
      <span
        aria-hidden="true"
        className="flex size-12 items-center justify-center rounded-full bg-black/4 text-muted-foreground"
      >
        <PauseIcon className="size-5" />
      </span>
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-medium tracking-tight">
          {site.name} is paused
        </h1>
        <p className="text-sm leading-6 text-muted-foreground">
          This site is suspended, so its analytics are closed. Everything
          already collected is kept; settings stay open.
        </p>
      </div>
      <Button
        render={
          <Link href={`/dashboard/${encodeURIComponent(site.slug)}/settings`}>
            <Settings02Icon className="size-4" />
            Site settings
          </Link>
        }
        size="sm"
        variant="secondary"
      />
    </div>
  );
}

/**
 * The deleting screen (§17). No phase, no percentage — the backend exposes
 * none and inventing a progress bar here would be a lie. Poll the by-id read:
 * `deleting` means still going, a 404 means done and permanent, so the only
 * exit is back to the site list.
 */
function DeletingScreen({ site }: { site: SiteSummary }) {
  const router = useRouter();

  React.useEffect(() => {
    if (!LIVE_API) {
      // Design mode has no purge to wait on — show the state, then move on.
      const timer = setTimeout(() => router.replace("/dashboard"), 4_000);
      return () => clearTimeout(timer);
    }
    const timer = setInterval(() => {
      sites.get(site.site_id).catch((raised: unknown) => {
        const code = errorCodeOf(raised);
        if (code === "SITE_NOT_FOUND" || code === "NOT_FOUND") {
          router.replace("/dashboard");
        }
      });
    }, 5_000);
    return () => clearInterval(timer);
  }, [site.site_id, router]);

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-4 py-24 text-center">
      <Spinner className="size-6 text-muted-foreground" />
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-medium tracking-tight">
          Deleting {site.name}
        </h1>
        <p className="text-sm leading-6 text-muted-foreground">
          Everything this site ever collected is being removed. This takes a
          few minutes and cannot be stopped. You&apos;ll be taken to your
          sites when it is done.
        </p>
      </div>
    </div>
  );
}
