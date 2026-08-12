"use client";

import { Cancel01Icon as XIcon } from "hugeicons-react";
import { motion } from "motion/react";
import * as React from "react";

const SPRING = { type: "spring", stiffness: 400, damping: 30 } as const;

/**
 * Measures whichever step is currently mounted so the dialog body can spring
 * between step heights instead of snapping.
 *
 * The ref goes on each step rather than on a static wrapper: with
 * `AnimatePresence mode="wait"` the wrapper is briefly empty between steps, and
 * an observer watching it would read a height of zero and collapse the card.
 */
export function useStepHeight() {
  const [height, setHeight] = React.useState<number | null>(null);
  // `HTMLElement`, not `HTMLDivElement` — a step is sometimes a <form>.
  const measure = React.useCallback((node: HTMLElement | null) => {
    if (!node) return;
    // Border box, not `contentRect` — steps carry padding, and the content box
    // alone would clip the last control away.
    const observer = new ResizeObserver(() => {
      setHeight(node.getBoundingClientRect().height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { height, measure };
}

/** Steps slide in from the right and leave to the left, like the login card. */
export const stepVariants = {
  enter: { opacity: 0, x: 12 },
  center: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -12, transition: { duration: 0.12 } },
} as const;

/**
 * Modal shell for the settings screen: dimmed backdrop, a card that springs in,
 * and a body that animates between step heights. Escape and a backdrop click
 * both close it, and focus lands inside on open so the keyboard follows.
 */
export function SettingsDialog({
  title,
  mark,
  bodyHeight,
  onClose,
  children,
}: {
  title: string;
  /** The provider's mark, so the dialog says which one you opened. */
  mark?: React.ReactNode;
  /** From `useStepHeight` — omit to let the body size itself. */
  bodyHeight?: number | null;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const titleId = React.useId();
  const cardRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    cardRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[60]">
      <motion.div
        animate={{ opacity: 1 }}
        className="absolute inset-0 bg-black/40"
        exit={{ opacity: 0, transition: { duration: 0.15 } }}
        initial={{ opacity: 0 }}
        onClick={onClose}
      />
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
        <motion.div
          animate={{ opacity: 1, scale: 1 }}
          aria-labelledby={titleId}
          aria-modal="true"
          className="pointer-events-auto w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-card shadow-[0_24px_80px_rgba(0,0,0,0.3)] outline-none"
          exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.12 } }}
          initial={{ opacity: 0, scale: 0.94 }}
          ref={cardRef}
          role="dialog"
          tabIndex={-1}
          transition={{ type: "spring", stiffness: 400, damping: 26 }}
        >
          <div className="flex items-center gap-3 border-b border-border py-3 pl-4 pr-3">
            {mark}
            <h3
              className="min-w-0 flex-1 truncate text-base font-medium tracking-tight"
              id={titleId}
            >
              {title}
            </h3>
            <button
              aria-label="Close"
              className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={onClose}
              type="button"
            >
              <XIcon className="size-4" />
            </button>
          </div>

          <motion.div
            animate={{ height: bodyHeight ?? "auto" }}
            className="overflow-hidden"
            initial={false}
            transition={SPRING}
          >
            {children}
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
}
