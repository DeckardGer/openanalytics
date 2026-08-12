"use client";

import { motion } from "motion/react";
import type { RealtimeStatus } from "@/lib/realtime";
import { cn } from "@/lib/utils";

/**
 * The live indicator for the realtime widget. Every state in the realtime
 * contract §States gets its own treatment — "empty" is not one of them: zero
 * active visitors is a real, healthy reading and stays on the `live` dot.
 */

const COPY: Record<RealtimeStatus, { label: string; dot: string; text: string }> = {
  connecting: {
    label: "Connecting",
    dot: "bg-muted-foreground",
    text: "text-muted-foreground",
  },
  live: {
    label: "Live",
    dot: "bg-success",
    text: "text-muted-foreground",
  },
  degraded: {
    label: "Live paused",
    dot: "bg-warning",
    text: "text-warning-foreground",
  },
  reconnecting: {
    label: "Reconnecting",
    dot: "bg-warning",
    text: "text-warning-foreground",
  },
  access_lost: {
    label: "Access ended",
    dot: "bg-destructive",
    text: "text-destructive-foreground",
  },
};

export function RealtimeStatusChip({
  status,
  className,
}: {
  status: RealtimeStatus;
  className?: string;
}) {
  const copy = COPY[status];
  const pulsing = status === "live" || status === "connecting";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-medium",
        copy.text,
        className
      )}
    >
      <span className="relative flex size-2">
        {pulsing ? (
          <motion.span
            animate={{ opacity: [0.6, 0, 0.6], scale: [1, 2.2, 1] }}
            aria-hidden="true"
            className={cn("absolute inset-0 rounded-full", copy.dot)}
            transition={{ duration: 2, repeat: Number.POSITIVE_INFINITY, ease: "easeOut" }}
          />
        ) : null}
        <span className={cn("relative size-2 rounded-full", copy.dot)} />
      </span>
      {copy.label}
    </span>
  );
}

/**
 * The explanatory line under the widget when the stream is not simply live.
 * `degraded` deliberately keeps the last snapshot on screen behind this hint,
 * because the data is stale rather than wrong.
 */
export function RealtimeStatusNote({ status }: { status: RealtimeStatus }) {
  if (status === "live" || status === "connecting") return null;

  const note =
    status === "degraded"
      ? "Showing the last snapshot. The live feed paused for a moment."
      : status === "reconnecting"
        ? "The stream dropped. Reconnecting…"
        : "Your access to this site ended, so the live feed stopped.";

  return <p className="text-xs leading-5 text-muted-foreground">{note}</p>;
}

/**
 * Banner for the realtime page. Stays completely silent while the stream is
 * healthy — the page deliberately carries no live-badge chrome — and only
 * speaks up when the numbers on screen can no longer be trusted as current.
 */
export function RealtimeConnectionBanner({
  status,
  className,
}: {
  status: RealtimeStatus;
  className?: string;
}) {
  if (status === "live" || status === "connecting") return null;

  return (
    <div
      className={cn(
        "mx-auto mb-4 flex w-full max-w-2xl items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-2.5",
        className
      )}
      role="status"
    >
      <RealtimeStatusChip status={status} />
      <RealtimeStatusNote status={status} />
    </div>
  );
}
