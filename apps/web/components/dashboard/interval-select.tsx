"use client";

import { Tick02Icon } from "hugeicons-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MoreVerticalCircleIcon } from "@/components/icons/hugeicons";
import { useAnalyticsInterval } from "@/components/dashboard/interval-context";

const SPRING = { type: "spring", stiffness: 550, damping: 38 } as const;
/** Snappy glide for the hover highlight — near-instant, no lag. */
const HOVER_TRANSITION = { duration: 0.04, ease: "easeOut" } as const;

const itemClass =
  "group relative flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-3 py-2 text-left text-sm text-white/90 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-white/40";

/** Sliding hover highlight shared per panel via layoutId. */
function Highlight() {
  return (
    <motion.span
      layoutId="interval-select-hover"
      transition={HOVER_TRANSITION}
      aria-hidden="true"
      className="absolute inset-0 rounded-[10px] bg-white/10"
    />
  );
}

/**
 * Interval picker in the shared dropdown language: dark panel, spring
 * scale/fade, gliding hover highlight, tick on the active row. The value
 * lives in the screen's IntervalProvider — picking one refetches every
 * analytics panel on the page together.
 */
export function IntervalSelect() {
  const [open, setOpen] = useState(false);
  const {
    interval: value,
    setInterval: setValue,
    // The screen's own list, not every interval that exists: a surface may
    // withhold one it cannot serve.
    intervals: INTERVALS,
  } = useAnalyticsInterval();
  const [hovered, setHovered] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setHovered(null);
  }, []);

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  const current =
    INTERVALS.find((interval) => interval.key === value) ?? INTERVALS[0];

  return (
    <div ref={rootRef} className="relative z-20">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        className="flex h-8 cursor-pointer items-center gap-1 rounded-full border border-border bg-card pl-3 pr-2 text-sm shadow-xs outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {current.label}
        <MoreVerticalCircleIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            key="interval-select"
            role="menu"
            initial={{ opacity: 0, scale: 0.94, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -4, transition: { duration: 0.12 } }}
            transition={SPRING}
            onMouseLeave={() => setHovered(null)}
            className="absolute right-0 top-full mt-3 w-48 origin-top-right rounded-2xl bg-[#26262a] p-1.5 shadow-[0_1px_1px_rgba(0,0,0,0.2),0_16px_40px_rgba(0,0,0,0.28)] ring-1 ring-white/8"
          >
            {INTERVALS.map((interval) => {
              const isActive = interval.key === value;
              return (
                <button
                  key={interval.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isActive}
                  onClick={() => {
                    setValue(interval.key);
                    close();
                  }}
                  onMouseEnter={() => setHovered(interval.key)}
                  className={itemClass}
                >
                  {hovered === interval.key && <Highlight />}
                  <span className="relative flex-1 font-medium">
                    {interval.label}
                  </span>
                  {isActive && (
                    <Tick02Icon className="relative size-4 text-white/70" />
                  )}
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
