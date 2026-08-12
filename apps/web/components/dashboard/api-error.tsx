"use client";

import { TriangleAlertIcon } from "@/components/icons/hugeicons";
import { Button } from "@/components/ui/button";
import type { ErrorPresentation } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * A failed `/v1` read, rendered as something the user can actually read.
 *
 * The counterpart to `DataStatePanel`: that one is for a *successful* response
 * whose freshness is not `ok`; this one is for a response that never arrived.
 * Neither ever renders a zero — a screen that cannot load must not look like a
 * site with no traffic.
 *
 * Copy comes from `presentError` in `lib/api.ts`, which maps the contract's
 * `ErrorCode` to a title and body. Screens branch on `kind`, never on the
 * server's `message` — that is explicitly not contract surface.
 */
export function ApiErrorPanel({
  error,
  onRetry,
  className,
}: {
  error: ErrorPresentation;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-8 py-10 text-center",
        className
      )}
      role="alert"
    >
      <TriangleAlertIcon
        aria-hidden="true"
        className={cn(
          "size-5",
          error.kind === "unavailable" || error.kind === "rate_limited"
            ? "text-warning-foreground"
            : "text-destructive-foreground"
        )}
      />
      <p className="text-sm font-medium">{error.title}</p>
      <p className="max-w-80 text-sm leading-6 text-muted-foreground">
        {error.body}
      </p>
      {error.retryable && onRetry ? (
        <Button className="mt-1" onClick={onRetry} size="sm" variant="secondary">
          Try again
        </Button>
      ) : null}
    </div>
  );
}
