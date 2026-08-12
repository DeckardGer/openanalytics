"use client";

import { useParams } from "next/navigation";
import { HoverList, HoverRow } from "@/components/dashboard/hover-list";
import {
  RealtimeStatusChip,
  RealtimeStatusNote,
} from "@/components/dashboard/realtime-status";
import { SquircleCardScroll } from "@/components/ui/squircle-card";
import { useRealtime } from "@/hooks/use-realtime";

/**
 * The overview screen's realtime card: active visitors and the pages they
 * are on right now, straight from the private snapshot. The contract's
 * snapshot carries pages, countries and devices only — there is no per-view
 * "seconds ago" feed, so this card does not pretend to have one.
 */
export function RealtimeCard() {
  const params = useParams<{ site: string }>();
  const slug = params.site ? decodeURIComponent(params.site) : "";
  const { status, snapshot } = useRealtime(slug);

  if (snapshot === null) {
    // No data yet: connecting, first reconnect, or access already lost.
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <RealtimeStatusChip status={status} />
        <RealtimeStatusNote status={status} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 px-5 pb-1 pt-0.5">
        <span className="text-sm tabular-nums">
          <span className="font-medium">
            {snapshot.active_visitors.toLocaleString("en-US")}
          </span>{" "}
          <span className="text-muted-foreground">live now</span>
        </span>
        <RealtimeStatusChip status={status} />
      </div>
      {snapshot.active_visitors === 0 ? (
        <p className="flex flex-1 items-center justify-center px-6 pb-4 text-center text-sm leading-6 text-muted-foreground">
          No one is browsing right now.
        </p>
      ) : (
        <SquircleCardScroll className="flex-1">
          <HoverList>
            {snapshot.pages.map((page) => (
              <HoverRow key={page.path}>
                <div className="flex items-center justify-between gap-4 px-5 py-1.5">
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {page.path}
                  </span>
                  <span className="text-sm tabular-nums text-muted-foreground">
                    {page.visitors.toLocaleString("en-US")}
                  </span>
                </div>
              </HoverRow>
            ))}
          </HoverList>
        </SquircleCardScroll>
      )}
    </div>
  );
}
