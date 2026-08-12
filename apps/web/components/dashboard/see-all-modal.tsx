"use client";

import { Cancel01Icon } from "hugeicons-react";
import { motion, type Variants } from "motion/react";
import * as React from "react";
import { SkeletonBar } from "@/components/ui/skeleton-reveal";
import { SquircleSurface } from "@/components/ui/squircle-card";
import {
  INTERVALS,
  useAnalyticsInterval,
} from "@/components/dashboard/interval-context";

/**
 * The shared "See all" modal: every overview card opens the same tall,
 * narrow panel — the realtime visitor modal's silhouette — with a white
 * identity band up top and the full list on the grey band below, scrolling
 * as one column. One shell so eight cards cannot drift into eight dialects.
 *
 * The list inside shows everything the card's read returned for the
 * interval the screen is on; the interval's name rides the subtitle from
 * context, so the modal never claims more range than the numbers carry.
 */

/** Bouncy pop entrance for the modal panel. */
const POP_SPRING = { type: "spring", stiffness: 400, damping: 26 } as const;

const MODAL_CONTAINER: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.09, delayChildren: 0.15 } },
};
const MODAL_ITEM: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: {
    opacity: 1,
    y: 0,
    transition: { type: "spring", stiffness: 380, damping: 28 },
  },
};

/** The active interval's human name — "Last 7 days". */
export function useIntervalLabel(): string {
  const { interval } = useAnalyticsInterval();
  return (
    INTERVALS.find((entry) => entry.key === interval)?.label ?? "This range"
  );
}

/** Pulse rows in the list's shape, for a modal opened before its data. */
const SKELETON_WIDTHS = ["w-3/5", "w-1/2", "w-2/5", "w-1/2", "w-1/3", "w-2/5"];

export function SeeAllSkeleton() {
  return (
    <div aria-hidden="true">
      {SKELETON_WIDTHS.map((width, index) => (
        <div
          key={index}
          className="flex items-center justify-between gap-4 px-3 py-2.5"
        >
          <SkeletonBar className={`h-3.5 animate-pulse ${width}`} />
          <SkeletonBar className="h-3.5 w-10 animate-pulse" />
        </div>
      ))}
    </div>
  );
}

export function SeeAllModal({
  title,
  subtitle,
  header,
  onClose,
  children,
}: {
  title: string;
  /** One quiet line under the title — what the list is, over which range. */
  subtitle: React.ReactNode;
  /** Optional extra block in the white band (a snippet, a note). */
  header?: React.ReactNode;
  onClose: () => void;
  /** The grey band's content — the full list. */
  children: React.ReactNode;
}) {
  // Escape closes the modal.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    // z-[60]: above the floating tab bar (z-50)
    <div className="fixed inset-0 z-[60]">
      <motion.div
        key="see-all-scrim"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0, transition: { duration: 0.15 } }}
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
        <motion.div
          key="see-all-panel"
          role="dialog"
          aria-modal="true"
          aria-label={title}
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.12 } }}
          transition={POP_SPRING}
          className="pointer-events-auto relative h-[min(85vh,760px)] w-full max-w-lg rounded-[36px] shadow-[0_24px_80px_rgba(0,0,0,0.3)] sm:rounded-[48px]"
        >
          <SquircleSurface className="relative h-full w-full overflow-hidden rounded-[36px] border border-border bg-card [--card-clip-radius:20px] sm:rounded-[58px] sm:[--card-clip-handle:3px] sm:[--card-clip-radius:26px]">
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="absolute right-4 top-4 z-20 flex size-8 cursor-pointer items-center justify-center rounded-full bg-black/4 text-muted-foreground outline-none transition-colors hover:bg-black/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Cancel01Icon className="size-4" />
            </button>

            {/* one scrolling column; the grey band always reaches the
                bottom, and the rubber-band never flashes another color */}
            <motion.div
              variants={MODAL_CONTAINER}
              initial="hidden"
              animate="show"
              className="h-full overflow-y-auto overscroll-none bg-[#f6f6f6] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              <div className="flex min-h-full flex-col">
                <motion.div
                  variants={MODAL_ITEM}
                  className="flex flex-col gap-3 bg-card px-6 pb-5 pr-14 pt-8 sm:px-7 sm:pt-9"
                >
                  <div>
                    <p className="text-lg font-medium tracking-tight">
                      {title}
                    </p>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {subtitle}
                    </p>
                  </div>
                  {header}
                </motion.div>

                <motion.div
                  variants={MODAL_ITEM}
                  className="flex-1 px-3 py-3 sm:px-4"
                >
                  {children}
                </motion.div>
              </div>
            </motion.div>
          </SquircleSurface>
        </motion.div>
      </div>
    </div>
  );
}
