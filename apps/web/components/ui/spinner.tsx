import type React from "react";
import { cn } from "@/lib/utils";

/** Smooth ring spinner — a circle with a transparent gap, spinning. */
export function Spinner({
  className,
  ...props
}: React.ComponentProps<"span">): React.ReactElement {
  return (
    <span
      aria-label="Loading"
      role="status"
      className={cn(
        "inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent",
        className,
      )}
      {...props}
    />
  );
}
