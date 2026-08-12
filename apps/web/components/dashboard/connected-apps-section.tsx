"use client";

import { PlugSocketIcon } from "hugeicons-react";
import * as React from "react";
import { DeleteIcon, LockIcon } from "@/components/icons/hugeicons";
import { SettingsPanel } from "@/components/dashboard/settings-panel";
import { Badge } from "@/components/ui/badge";
import { SkeletonBar, SkeletonReveal } from "@/components/ui/skeleton-reveal";
import { connectedApps, LIVE_API, type ConnectedApp } from "@/lib/api";
import { MOCK_CONNECTED_APPS } from "@/lib/mock";
import { useAction, useApi } from "@/lib/use-api";

/**
 * Connected apps — `GET /v1/me/connected-apps`, `DELETE .../{client_id}`
 * (ADR-0048 D4). Everything the signed-in user has authorized to act as
 * them: the CLI's device logins, MCP connectors like Claude, any client
 * that registered itself through DCR. Self only; an admin sees their own
 * connections, never another member's.
 *
 * The one action is disconnect, and it is total by contract: the server
 * deletes the client's tokens and its standing consents together, so the
 * app stops working everywhere at once and reconnecting starts from a
 * fresh approval screen. There is nothing to edit here — scopes are fixed
 * at approval, and changing what an app may do *is* reconnecting.
 */

const dateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function ConnectedAppsSection() {
  const list = useApi(
    () => connectedApps.list().then((response) => response.apps),
    () => MOCK_CONNECTED_APPS
  );
  // Mock mode has no server to reload from, so removal is mirrored locally;
  // live always re-reads, because the list is derived from live grants and
  // only the server knows what a revoke actually severed.
  const [localApps, setLocalApps] = React.useState<ConnectedApp[] | null>(
    null
  );
  const apps = localApps ?? list.data ?? [];

  const revokeAction = useAction(async (app: ConnectedApp) => {
    if (LIVE_API) {
      await connectedApps.revoke(app.client_id);
      list.reload();
      return;
    }
    setLocalApps(apps.filter((entry) => entry.client_id !== app.client_id));
  });

  const ready = list.phase !== "loading";

  return (
    <SettingsPanel
      action={
        ready ? (
          <span className="text-xs text-muted-foreground">
            {apps.length} connected
          </span>
        ) : (
          <SkeletonBar className="h-3.5 w-16 animate-pulse" />
        )
      }
      title="Connected apps"
    >
      <SkeletonReveal
        ready={ready}
        skeleton={
          // Pixel-matched to an app row: tile, name + id lines, date column.
          <ul className="divide-y divide-border">
            {[0, 1].map((index) => (
              <li className="flex items-center gap-3 px-5 py-3" key={index}>
                <SkeletonBar className="size-8 shrink-0 rounded-lg" />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <SkeletonBar className="h-3.5 w-24" />
                  <SkeletonBar className="h-3 w-40 max-w-full" />
                </div>
                <SkeletonBar className="hidden h-3 w-20 sm:block" />
              </li>
            ))}
          </ul>
        }
      >
        {list.phase === "error" ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            {list.error.body}
          </p>
        ) : apps.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            Nothing is connected. When you authorize an app to use your
            account, from the CLI to an AI assistant like Claude, it shows up
            here with exactly what it may do.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {apps.map((app) => (
              <li
                className="group flex items-start gap-3 px-5 py-3"
                key={app.client_id}
              >
                <span
                  aria-hidden="true"
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground"
                >
                  <PlugSocketIcon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate text-sm font-medium">
                      {app.name}
                    </span>
                    {/* What this client may do, in the open — the scope's
                        title carries the consent screen's sentence. */}
                    {app.scopes.map((entry) => (
                      <Badge
                        icon={<LockIcon />}
                        key={entry.scope}
                        size="sm"
                        title={entry.description}
                        variant="outline"
                      >
                        <span className="font-mono">{entry.scope}</span>
                      </Badge>
                    ))}
                  </span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {app.client_id}
                    <span className="font-sans">
                      {" · "}
                      {app.active_token_count}{" "}
                      {app.active_token_count === 1 ? "session" : "sessions"}
                    </span>
                  </span>
                </span>
                <span className="hidden flex-col items-end pt-0.5 text-xs tabular-nums text-muted-foreground sm:flex">
                  <span>
                    since {dateFmt.format(Date.parse(app.first_authorized_at))}
                  </span>
                  <span className="text-muted-foreground/70">
                    last used{" "}
                    {dateFmt.format(Date.parse(app.last_authorized_at))}
                  </span>
                </span>
                <button
                  aria-label={`Disconnect ${app.name}`}
                  className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground/0 outline-none transition-colors hover:bg-destructive/10 hover:text-destructive-foreground focus-visible:ring-2 focus-visible:ring-ring group-hover:text-muted-foreground"
                  onClick={() => revokeAction.run(app)}
                  type="button"
                >
                  <DeleteIcon className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </SkeletonReveal>

      {revokeAction.error ? (
        <p className="px-5 pb-4 text-xs text-destructive-foreground">
          {revokeAction.error.body}
        </p>
      ) : null}

      <p className="border-t border-border px-5 py-3 text-xs leading-5 text-muted-foreground">
        Disconnecting an app signs it out everywhere at once and clears its
        standing approval, so it cannot quietly let itself back in. To use it
        again you approve it from scratch. Your data is untouched either way.
      </p>
    </SettingsPanel>
  );
}
