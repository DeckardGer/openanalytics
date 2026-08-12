"use client";

import { AnimatePresence, motion } from "motion/react";
import * as React from "react";
import { createPortal } from "react-dom";
import { SquircleSurface } from "@/components/ui/squircle-card";

/**
 * The add-site dialog's anatomy, extracted: the squircle frame on grey, the
 * header strip whose title slides with the step, the inset white panel the
 * step content slides inside, the footer strip where the CTAs live. One
 * home, because four flows wear it now — add-site stays as built, and the
 * connect / import / key-create / invite modals share this shell.
 *
 * Portaled to `document.body`: the settings panels sit under reveal
 * animations whose transforms and filters make an ancestor the containing
 * block for `position: fixed`, which pins a "full-screen" modal to the
 * middle of the card instead of the viewport. Every caller mounts this on a
 * click, client-only, so `document` always exists here. z-[60] rides above
 * the floating tab bar (z-50), same as the visitor modal.
 *
 * The inset panel measures its height (the onboarding flow's spring)
 * rather than fixing it: steps are different heights, and a fixed frame
 * clips one or floats the other.
 */

export const FLOW_SPRING = {
  type: "spring",
  stiffness: 550,
  damping: 38,
} as const;

/** Horizontal slide between steps — direction-aware, content-only. */
const stepVariants = {
  enter: (dir: number) => ({ x: dir * 32, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir * -32, opacity: 0 }),
};

export function FlowDialog({
  ariaLabel,
  title,
  counter,
  dir,
  panelKey,
  onClose,
  footer,
  children,
}: {
  ariaLabel: string;
  /** The header-strip title for the current step — swaps with the slide. */
  title: string;
  /** The "1 / 2" mark. Omit it for a single-step flow, where it would only
   * announce that there is nothing to count. */
  counter?: string;
  /** Slide direction: 1 going forward, -1 going back. */
  dir: number;
  /** Keys the sliding panel — changing it is what changes the step. */
  panelKey: string | number;
  onClose: () => void;
  /** The footer strip's buttons — conditionals, not animations, exactly as
   * the add-site dialog swaps its own. */
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  // Escape closes
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // `offsetHeight`, and deliberately not `getBoundingClientRect`: the card
  // enters through a `scale: 0.94 → 1` spring, and a bounding rect measures
  // the *transformed* box — the first reading came in ~6% short and the
  // panel visibly grew from the bottom as the entrance played out.
  // `offsetHeight` is the layout (border-box) height, transform-independent,
  // so the panel is its true size from the first frame.
  const [panelHeight, setPanelHeight] = React.useState<number | null>(null);
  const measureStep = React.useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const observer = new ResizeObserver(() => {
      setPanelHeight(node.offsetHeight);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  /**
   * The first measurement applies *instantly*, and only step changes ride
   * the spring. The observer's initial callback lands one frame after the
   * modal is already on screen at `height: auto`; springing from that to
   * the measured pixel value — even a near-identical one — played out as
   * the panel visibly growing a beat after opening. `settled` flips one
   * timer-hop after that first value lands, so the render that carries it
   * still has the transition switched off, and every later change (a step,
   * an error line appearing) animates as designed.
   */
  const [settled, setSettled] = React.useState(false);
  React.useEffect(() => {
    if (panelHeight === null || settled) return;
    const raise = setTimeout(() => setSettled(true), 0);
    return () => clearTimeout(raise);
  }, [panelHeight, settled]);

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      {/* backdrop */}
      <motion.div
        key="flow-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0, transition: { duration: 0.15 } }}
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />

      {/* card — same entrance language as the dropdowns and add-site */}
      <motion.div
        key="flow-card"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        initial={{ opacity: 0, scale: 0.94, y: -6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: -4, transition: { duration: 0.12 } }}
        transition={FLOW_SPRING}
        className="relative w-full max-w-md"
      >
        {/* the shadow lives on this unclipped wrapper — the squircle
            clip-path cannot clip a box shadow */}
        <div className="rounded-[26px] shadow-[0_1px_2px_rgba(0,0,0,0.06),0_24px_60px_rgba(0,0,0,0.18)] sm:rounded-[50px]">
          <SquircleSurface className="flex flex-col rounded-[26px] border border-border bg-[#f6f6f6] p-1 [--card-clip-handle:2.25px] [--card-clip-radius:14px] sm:rounded-[50px] sm:[--card-clip-handle:3px] sm:[--card-clip-radius:20px]">
            {/* header strip — title swaps with the step */}
            <div className="flex h-9 items-center justify-between pl-3.5 pr-3">
              <AnimatePresence mode="popLayout" initial={false} custom={dir}>
                <motion.span
                  key={panelKey}
                  custom={dir}
                  variants={stepVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={FLOW_SPRING}
                  className="text-sm font-medium text-foreground/80"
                >
                  {title}
                </motion.span>
              </AnimatePresence>
              {counter ? (
                <span className="text-xs tabular-nums text-muted-foreground/70">
                  {counter}
                </span>
              ) : null}
            </div>

            {/* inset panel — measured height, steps slide inside */}
            <SquircleSurface className="relative overflow-hidden rounded-[22px] border border-border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:12px] sm:rounded-[44px] sm:[--card-clip-radius:17px]">
              <motion.div
                animate={{ height: panelHeight ?? "auto" }}
                className="overflow-hidden"
                initial={false}
                transition={settled ? FLOW_SPRING : { duration: 0 }}
              >
                <AnimatePresence mode="popLayout" initial={false} custom={dir}>
                  <motion.div
                    key={panelKey}
                    ref={measureStep}
                    custom={dir}
                    variants={stepVariants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={FLOW_SPRING}
                  >
                    {children}
                  </motion.div>
                </AnimatePresence>
              </motion.div>
            </SquircleSurface>

            {/* footer strip — CTAs live in the frame, like the header */}
            <div className="flex h-12 items-center justify-end gap-2 pb-1 pl-3.5 pr-1 pt-1">
              {footer}
            </div>
          </SquircleSurface>
        </div>
      </motion.div>
    </div>,
    document.body
  );
}
