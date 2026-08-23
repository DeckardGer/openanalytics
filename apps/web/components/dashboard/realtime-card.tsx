"use client";

import { motion } from "motion/react";
import { useParams } from "next/navigation";
import * as React from "react";
import { HoverList, HoverRow } from "@/components/dashboard/hover-list";
import {
  RealtimeStatusChip,
  RealtimeStatusNote,
} from "@/components/dashboard/realtime-status";
import {
  SquircleCardScroll,
  useSquircleCardHeaderChip,
} from "@/components/ui/squircle-card";
import { useRealtime } from "@/hooks/use-realtime";
import { cn } from "@/lib/utils";

/**
 * The live-visitor count, published once for the whole overview screen.
 *
 * Two places wear the same number: the Realtime card's title and the page's
 * "Overview" heading. `useRealtime` opens one SSE stream per caller, so the
 * heading must not subscribe on its own; the card is the screen's one
 * subscriber and hands the count over through this module store. `null`
 * means no snapshot, and the heading badge simply is not there.
 */
let liveNowCount: number | null = null;
const liveNowListeners = new Set<() => void>();

function publishLiveNow(next: number | null): void {
  if (next === liveNowCount) return;
  liveNowCount = next;
  for (const listener of liveNowListeners) listener();
}

function subscribeLiveNow(listener: () => void): () => void {
  liveNowListeners.add(listener);
  return () => liveNowListeners.delete(listener);
}

const readLiveNow = (): number | null => liveNowCount;
const readLiveNowServer = (): number | null => null;

/**
 * "● 4 Live", the one live badge both homes wear: the Realtime card's title
 * and the page's "Overview" heading, sized per home through `className`.
 * Green with a pulsing dot while anyone is actually on the site; at zero the
 * dot holds still and everything goes grey, because a green pulse over a
 * zero would be a light saying the opposite of its number.
 *
 * text-sm matches the card title, so equal line boxes under items-center put
 * badge and title on one baseline; the heading passes text-base down and
 * aligns through its own items-baseline group instead.
 */
function LiveBadge({
  count,
  className,
}: {
  count: number;
  className?: string;
}) {
  const someone = count > 0;
  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-1.5 whitespace-nowrap text-sm tabular-nums",
        someone ? "text-success-foreground/80" : "text-muted-foreground",
        className
      )}
    >
      <span className="relative flex size-2 self-center">
        {someone ? (
          <motion.span
            animate={{ opacity: [0.6, 0, 0.6], scale: [1, 2.2, 1] }}
            aria-hidden="true"
            className="absolute inset-0 rounded-full bg-success"
            transition={{
              duration: 2,
              repeat: Number.POSITIVE_INFINITY,
              ease: "easeOut",
            }}
          />
        ) : null}
        <span
          className={cn(
            "relative size-2 rounded-full",
            someone ? "bg-success" : "bg-muted-foreground"
          )}
        />
      </span>
      <span
        className={cn(
          "font-medium",
          someone ? "text-success-foreground" : "text-foreground/80"
        )}
      >
        {count.toLocaleString("en-US")}
      </span>{" "}
      Live
    </span>
  );
}

/** The same badge beside the page's "Overview" heading; nothing until a
 *  snapshot arrives. */
export function OverviewLiveBadge() {
  const count = React.useSyncExternalStore(
    subscribeLiveNow,
    readLiveNow,
    readLiveNowServer
  );
  if (count === null) return null;
  return <LiveBadge className="text-base" count={count} />;
}

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
  const setHeaderChip = useSquircleCardHeaderChip();

  // The count rides beside the card's TITLE ("Realtime · ● 4 Live"),
  // through the shell's header slot: it is a fact about the whole card, not
  // the first row of its list. Keyed on the number so a snapshot tick with
  // the same count never re-registers.
  const liveCount = snapshot === null ? null : snapshot.active_visitors;
  React.useEffect(() => {
    if (setHeaderChip === null || liveCount === null) return;
    setHeaderChip(<LiveBadge count={liveCount} />);
    return () => setHeaderChip(null);
  }, [setHeaderChip, liveCount]);

  // The same number, for the "Overview" heading (see the store above). The
  // card is the screen's one realtime subscriber, so it is also the one
  // publisher; unmounting takes the heading's badge with it.
  React.useEffect(() => {
    publishLiveNow(liveCount);
    return () => publishLiveNow(null);
  }, [liveCount]);

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
      {/* No green "Live" badge row: a populated card is its own live signal,
          and the count now sits beside the title. The chip returns only when
          the feed is NOT healthy, because "Live paused" or "Reconnecting" is
          a caveat about every number below it. */}
      {status !== "live" && (
        <div className="flex items-center justify-end px-5 pb-1 pt-0.5">
          <RealtimeStatusChip status={status} />
        </div>
      )}
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
