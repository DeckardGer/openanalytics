"use client";

import { Tick02Icon as Check, Copy01Icon as Copy } from "hugeicons-react";
import { AnimatePresence, motion } from "motion/react";
import * as React from "react";
import { Button } from "@/components/ui/button";

/**
 * Icon-only copy control.
 *
 * The tick swaps in for the copy glyph with the same scale-and-fade the
 * landing hero's CLI pill uses, so one copy gesture reads the same wherever
 * it appears — settings, the API keys screen, the landing page.
 */
export function CopyButton({
  text,
  label = "Copy",
}: {
  text: string;
  /** What this button copies, for the accessible name: "Copy site key". */
  label?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const timeout = React.useRef<ReturnType<typeof setTimeout>>(undefined);

  React.useEffect(() => () => clearTimeout(timeout.current), []);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return; // Clipboard unavailable (permissions/insecure context) — stay put.
    }
    setCopied(true);
    clearTimeout(timeout.current);
    timeout.current = setTimeout(() => setCopied(false), 1600);
  };

  return (
    <Button
      aria-label={copied ? "Copied" : label}
      onClick={onCopy}
      size="icon-sm"
      variant="ghost"
    >
      <span aria-hidden="true" className="relative size-4">
        <AnimatePresence initial={false} mode="wait">
          <motion.span
            animate={{ opacity: 1, scale: 1 }}
            className="absolute inset-0 flex items-center justify-center"
            exit={{ opacity: 0, scale: 0.6 }}
            initial={{ opacity: 0, scale: 0.6 }}
            key={copied ? "tick" : "copy"}
            transition={{ duration: 0.12, ease: "easeOut" }}
          >
            {copied ? (
              <Check className="size-4 text-success-foreground" />
            ) : (
              <Copy className="size-4" />
            )}
          </motion.span>
        </AnimatePresence>
      </span>
    </Button>
  );
}
