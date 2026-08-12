"use client";

import { Tick02Icon } from "hugeicons-react";
import { AnimatePresence, motion } from "motion/react";
import * as React from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const SPRING = { type: "spring", stiffness: 550, damping: 40 } as const;

export type SaveState = "idle" | "saving" | "saved";

/**
 * A button that narrates its save instead of just spinning: the resting
 * label morphs to "Saving" beside the spinner, then to a brief "Saved ✓"
 * beat inside the button itself, then back to rest. The label swaps with a
 * small vertical slide; the button itself **does not move** — it is pinned
 * to the widest of its three states, measured from invisible ghost twins,
 * so the frame stands still and only the words travel through it. (It used
 * to spring its width along with the label; a control that resizes mid-save
 * reads as the layout stumbling, not as feedback.)
 *
 * For buttons that *persist* something only. A plain fetch keeps the plain
 * `loading` treatment; a save is a promise to the user, and the button is
 * where that promise should be seen kept.
 *
 * The caller owns the state machine (busy → "saving", a ~2 s "saved" beat,
 * back to "idle") — this component only renders it.
 */
export function SaveButton({
  state,
  children,
  disabled,
  className,
  onClick,
  ...props
}: Omit<ButtonProps, "loading"> & { state: SaveState }) {
  // Three ghost twins — one per state — render at natural size; the real
  // button holds the widest, so no state change can move it. Observed
  // rather than measured once, because the idle label and the font can
  // both change after mount.
  const [width, setWidth] = React.useState<number | null>(null);
  const ghostsRef = React.useCallback((node: HTMLSpanElement | null) => {
    if (!node) return;
    const update = () => {
      const widest = Math.max(
        ...Array.from(node.children).map(
          (child) => child.getBoundingClientRect().width
        )
      );
      if (Number.isFinite(widest) && widest > 0) setWidth(widest);
    };
    const observer = new ResizeObserver(update);
    for (const child of Array.from(node.children)) observer.observe(child);
    update();
    return () => observer.disconnect();
  }, []);

  const savedLabel = (
    <>
      <Tick02Icon aria-hidden="true" className="size-3.5" />
      Saved
    </>
  );
  const label =
    state === "saved" ? savedLabel : state === "saving" ? "Saving" : children;

  return (
    <span className="relative inline-flex">
      {/* ghost twins — invisible, non-interactive, purely rulers */}
      <span
        ref={ghostsRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute left-0 top-0 inline-flex whitespace-nowrap"
      >
        <span className="inline-flex">
          <Button {...props} className={className} disabled tabIndex={-1}>
            {children}
          </Button>
        </span>
        <span className="inline-flex">
          <Button
            {...props}
            className={className}
            disabled
            loading
            tabIndex={-1}
          >
            Saving
          </Button>
        </span>
        <span className="inline-flex">
          <Button {...props} className={className} disabled tabIndex={-1}>
            {savedLabel}
          </Button>
        </span>
      </span>

      <Button
        {...props}
        onClick={onClick}
        // overflow-hidden: during the swap frame both labels exist and
        // would paint past the pinned width as a momentary bulge
        className={cn(className, "overflow-hidden whitespace-nowrap")}
        loading={state === "saving"}
        disabled={disabled === true || state === "saving"}
        style={width !== null ? { width } : undefined}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={state}
            initial={{ y: 9, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -9, opacity: 0, transition: { duration: 0.1 } }}
            transition={SPRING}
            className="flex items-center gap-1.5"
          >
            {label}
          </motion.span>
        </AnimatePresence>
      </Button>
    </span>
  );
}
