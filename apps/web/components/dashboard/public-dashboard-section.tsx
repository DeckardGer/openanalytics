"use client";

import * as React from "react";
import { useOrigin } from "@/lib/use-origin";
import { CopyButton } from "@/components/ui/copy-button";
import { ArrowUpRight03Icon } from "@/components/icons/hugeicons";
import { SettingsPanel } from "@/components/dashboard/settings-panel";
import { Button } from "@/components/ui/button";
import { SkeletonBar, SkeletonReveal } from "@/components/ui/skeleton-reveal";
import { Switch } from "@/components/ui/switch";
import {
  LIVE_API,
  publicDashboard,
  type PublicDashboardSettings,
  type SiteSummary,
} from "@/lib/api";
import { MOCK_PUBLIC_DASHBOARD } from "@/lib/mock";
import { useAction, useApi, type ApiState } from "@/lib/use-api";
import { cn } from "@/lib/utils";

/**
 * Public dashboard — `GET/PUT /v1/sites/{site_id}/public-dashboard`.
 *
 * `enabled` is the master switch and, since 2026-08-10, the data decision
 * too: turning it on opens every data surface in the same write, and only
 * live visitors and site identity stay separate switches (see the note on
 * `DATA_SURFACES`). The wire shape is unchanged — the server still keeps
 * nine independent flags, and no query parameter can widen a public payload.
 * Rotating the slug invalidates the old URL and cuts open public realtime
 * streams. Every write is the full settings object (PUT, not PATCH), so the
 * UI keeps one state object and sends it whole.
 *
 * The panel is built to the house model: the chrome — frame, title, the intro
 * line (all knowable from the site summary) — is static, and only what waits
 * on the settings read stands in as a skeleton and comes into focus. The
 * master switch sits in the title strip, so its slot swaps in place like the
 * API panel's key count.
 */

type Surface =
  | "share_identity"
  | "share_overview"
  | "share_timeseries"
  | "share_sessions"
  | "share_geography"
  | "share_pages"
  | "share_sources"
  | "share_devices"
  | "share_realtime";

/**
 * Three decisions, not nine (2026-08-10, by request): nine per-surface
 * switches produced enabled-but-empty boards — a link that answers with a
 * blank page because nobody realized "enabled" alone publishes nothing. So
 * the master switch now *is* the data decision: turning the dashboard on
 * opens every data surface at once, and the copy under it says exactly what
 * that shows.
 *
 * Two surfaces stay their own switches, because they answer different
 * questions than "may strangers see my numbers":
 *
 * - **Site identity** names the site. An anonymous board is a feature
 *   (ADR-0044) — share the shape, not whose shape it is.
 * - **Live visitors** is a present-tense signal about right now, not a
 *   statistic; some owners share history but not presence.
 *
 * The hints still say what turning a switch on *publishes* — this is the one
 * screen where someone decides what strangers may see, and a hint that
 * undersells a surface here is a privacy failure with a friendly tone.
 */
const DATA_SURFACES = [
  "share_overview",
  "share_timeseries",
  "share_sessions",
  "share_geography",
  "share_pages",
  "share_sources",
  "share_devices",
] as const satisfies readonly Surface[];

const EXCEPTIONS: { key: Surface; label: string; hint: string }[] = [
  {
    key: "share_realtime",
    label: "Live visitors",
    hint: "The active-visitor count only. No pages, countries or devices.",
  },
  {
    key: "share_identity",
    label: "Site identity",
    hint: "Your site's name and favicon in the page header. Off, the page stays anonymous and says only that it is a shared dashboard.",
  },
];

/** What the master switch publishes — printed under it, kept honest. */
const MASTER_HINT =
  "Visitor and pageview totals, the traffic chart, bounce rate and visit duration, countries and cities, top pages, traffic sources, and devices. Pages publishes your URL inventory, including pages nothing links to.";

/** The master switch's ON payload: the whole data board, opened at once. */
function withAllDataOpen(
  settings: PublicDashboardSettings
): PublicDashboardSettings {
  const next = { ...settings, enabled: true };
  for (const key of DATA_SURFACES) next[key] = true;
  return next;
}

/**
 * The read, hoisted out of the panel so the tab can pace the reveal.
 *
 * General has two fetching panels; if each revealed on its own read, their
 * contents would come into focus at two different moments. The tab starts
 * both reads in parallel and hands each panel a shared `revealed` flag.
 */
export function usePublicDashboard(siteId: string) {
  return useApi(
    () => publicDashboard.get(siteId),
    () => MOCK_PUBLIC_DASHBOARD,
    siteId
  );
}

/**
 * What waits on the settings read: three surface rows (label + hint left,
 * switch right), then the share-link block at its real 42px and the rotate
 * row at its 28px.
 */
function ContentSkeleton() {
  return (
    <>
      <div className="flex flex-col gap-1.5 px-5 py-3">
        <SkeletonBar className="h-3 w-full" />
        <SkeletonBar className="h-3 w-3/4" />
      </div>
      <ul className="divide-y divide-border border-t border-border">
        {EXCEPTIONS.map((surface) => (
          <li
            className="flex items-center justify-between gap-4 px-5 py-3"
            key={surface.key}
          >
            <div className="flex min-w-0 flex-col gap-1.5">
              <SkeletonBar className="h-3.5 w-24" />
              <SkeletonBar className="h-3 w-48" />
            </div>
            <SkeletonBar className="h-5 w-9 shrink-0 rounded-full" />
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-3 border-t border-border p-5">
        <SkeletonBar className="h-9 w-full rounded-xl" />
        <div className="flex items-center gap-3">
          <SkeletonBar className="h-7 w-24 shrink-0 rounded-full" />
          <SkeletonBar className="h-3 w-48 max-w-full" />
        </div>
      </div>
    </>
  );
}

/**
 * The whole panel as bars — for the settings board's page-level skeleton,
 * where not even the site summary is in hand yet and the intro line cannot be
 * real.
 */
export function PublicDashboardSkeleton() {
  return (
    <SettingsPanel
      action={<SkeletonBar className="mr-1 h-5 w-9 rounded-full" />}
      title="Public dashboard"
    >
      <div className="border-b border-border px-5 py-3">
        <SkeletonBar className="h-3.5 w-64 max-w-full" />
      </div>
      <ContentSkeleton />
    </SettingsPanel>
  );
}

export function PublicDashboardSection({
  site,
  loaded,
  revealed,
}: {
  site: SiteSummary;
  /** From `usePublicDashboard`, held by the tab. */
  loaded: ApiState<PublicDashboardSettings>;
  /** The tab's shared gate — flips when every panel's read has settled. */
  revealed: boolean;
}) {
  /**
   * Writes overlay the fetched value rather than living in a child that
   * mounts on `ready` — the panel chrome (and the master switch in it) has to
   * exist before the read answers. Keyed by site so a site switch cannot
   * carry the previous site's settings.
   */
  const [local, setLocal] = React.useState<{
    key: string;
    value: PublicDashboardSettings;
  } | null>(null);
  const settings =
    local !== null && local.key === site.site_id
      ? local.value
      : loaded.phase === "ready"
        ? loaded.data
        : null;
  const setSettings = React.useCallback(
    (value: PublicDashboardSettings) =>
      setLocal({ key: site.site_id, value }),
    [site.site_id]
  );

  // GET is any member; PUT is `credentials:manage` (owner and admin). A
  // viewer sees the settings and the share link read-only rather than
  // discovering a 403 on the first toggle.
  const canManage = site.role !== "viewer";

  const write = useAction(
    async (next: PublicDashboardSettings, rotate: boolean) => {
      if (!LIVE_API) {
        setSettings(
          rotate
            ? {
                ...next,
                share_slug: crypto.randomUUID().replaceAll("-", "").slice(0, 10),
              }
            : next
        );
        return;
      }
      // All nine, always. The write is a PUT of the whole object, so a flag
      // left out is not preserved — it is reset to the server's default,
      // which is off: omitting `share_identity` here would silently close an
      // opt-in the owner had opened. The later flags are optional in the
      // schema (a client compiled against an older shape keeps working), so
      // they are defaulted here rather than sent as `undefined`.
      const confirmed = await publicDashboard.put(site.site_id, {
        enabled: next.enabled,
        share_overview: next.share_overview,
        share_timeseries: next.share_timeseries ?? false,
        share_sessions: next.share_sessions ?? false,
        share_geography: next.share_geography,
        share_pages: next.share_pages ?? false,
        share_sources: next.share_sources ?? false,
        share_devices: next.share_devices ?? false,
        share_realtime: next.share_realtime,
        share_identity: next.share_identity ?? false,
        rotate_slug: rotate,
      });
      // The server owns the slug — read it back rather than assuming.
      setSettings(confirmed);
    }
  );

  // The link is to *this* app, so it is built from where this app is being
  // read rather than from a constant: a hardcoded origin sends a self-hosted
  // owner's share link to somebody else's deployment. Server-rendered first
  // pass has no `window`; the panel's own reveal covers that frame.
  const origin = useOrigin();
  const shareUrl =
    settings?.share_slug && origin
      ? `${origin}/share/${settings.share_slug}`
      : null;

  return (
    <SettingsPanel
      action={
        settings ? (
          <Switch
            aria-label="Enable public dashboard"
            checked={settings.enabled}
            className="mr-1"
            disabled={!canManage}
            // ON opens every data surface with it — the one-decision model.
            // OFF only closes the door: the flags keep their shape, so the
            // exceptions below come back exactly as they were left.
            onCheckedChange={(enabled: boolean) =>
              write.run(
                enabled
                  ? withAllDataOpen(settings)
                  : { ...settings, enabled: false },
                false
              )
            }
          />
        ) : (
          // Outside the reveal's skeleton wrapper, so it pulses on its own —
          // and swaps in place without the blur, like the API key count.
          <SkeletonBar className="mr-1 h-5 w-9 animate-pulse rounded-full" />
        )
      }
      title="Public dashboard"
    >
      <p className="border-b border-border px-5 py-3 text-sm text-muted-foreground">
        Share {site.name}&apos;s numbers with anyone, no account needed.
      </p>

      <SkeletonReveal ready={revealed} skeleton={<ContentSkeleton />}>
        {!revealed ? null : loaded.phase === "error" ? (
          <p className="p-5 text-sm text-muted-foreground">
            {loaded.error.body}
          </p>
        ) : settings ? (
          <div
            className={cn(
              "transition-opacity",
              settings.enabled ? "opacity-100" : "pointer-events-none opacity-50"
            )}
          >
            <p className="px-5 py-3 text-xs leading-5 text-muted-foreground">
              Turning the dashboard on shows everything at once:{" "}
              {MASTER_HINT}
            </p>
            <ul className="divide-y divide-border border-t border-border">
              {EXCEPTIONS.map((surface) => (
                <li
                  className="flex items-center justify-between gap-4 px-5 py-3"
                  key={surface.key}
                >
                  <div className="min-w-0">
                    <p className="text-sm">{surface.label}</p>
                    <p className="text-xs leading-5 text-muted-foreground">
                      {surface.hint}
                    </p>
                  </div>
                  <Switch
                    aria-label={`Share ${surface.label}`}
                    // `?? false` because the ADR-0039 flags are optional in
                    // the schema: an `undefined` here would silently turn a
                    // controlled switch into an uncontrolled one.
                    checked={settings[surface.key] ?? false}
                    disabled={!settings.enabled || !canManage}
                    onCheckedChange={(next: boolean) =>
                      write.run({ ...settings, [surface.key]: next }, false)
                    }
                  />
                </li>
              ))}
            </ul>

            <div className="flex flex-col gap-3 border-t border-border p-5">
              {shareUrl ? (
                <div className="flex items-center gap-2 rounded-xl border border-border bg-primary-foreground pb-1 pl-3 pr-2 pt-1 text-sm text-primary">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {shareUrl}
                  </span>
                  <CopyButton label="Copy share link" text={shareUrl} />
                  <Button
                    disabled={!settings.enabled}
                    render={
                      <a href={shareUrl} rel="noreferrer" target="_blank">
                        <ArrowUpRight03Icon className="size-4" />
                        Open
                      </a>
                    }
                    size="xs"
                    variant="outline"
                  />
                </div>
              ) : (
                <p className="text-xs leading-5 text-muted-foreground">
                  Turn the dashboard on and a share link is minted here.
                </p>
              )}

              {canManage ? (
                <div className="flex items-center gap-3">
                  <Button
                    disabled={!settings.enabled || !settings.share_slug}
                    loading={write.busy}
                    onClick={() => write.run(settings, true)}
                    size="xs"
                    variant="secondary"
                  >
                    Rotate link
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    The old link stops working immediately.
                  </span>
                </div>
              ) : (
                <p className="text-xs leading-5 text-muted-foreground">
                  Only owners and admins can change these settings.
                </p>
              )}

              {write.error ? (
                <p className="text-xs text-destructive-foreground">
                  {write.error.body}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </SkeletonReveal>
    </SettingsPanel>
  );
}
