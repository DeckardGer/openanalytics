import * as React from "react";
import { SquircleSurface } from "@/components/ui/squircle-card";
import { cn } from "@/lib/utils";

/**
 * The card every settings section sits in.
 *
 * Our anatomy, the same one the overview cards use: a white frame whose top
 * strip carries the title, and a grey inset that holds the content. Built on
 * `SquircleSurface` rather than `SquircleCard` because that one ships a
 * "See all" link, which a settings section has nowhere to go with.
 *
 * It lives in its own module so the sections that predate the settings screen
 * — team, API keys, public dashboard — can share it instead of each carrying
 * a hand-rolled panel.
 */
/**
 * The heading a settings screen opens with: what this group is, and one line
 * on what it does for you. Sits outside the panels, on the page itself, so a
 * screen made of several panels still reads as one thing.
 */
export function SectionHeading({
  title,
  description,
}: {
  title: string;
  description: React.ReactNode;
}) {
  return (
    <div className="px-1">
      <h2 className="text-base font-medium text-foreground/80">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

export function SettingsPanel({
  title,
  action,
  children,
  tone = "default",
  className,
}: {
  /** Usually a string; skeleton screens pass a bar in the same slot. */
  title: React.ReactNode;
  /** Sits opposite the title in the frame's strip: a count, a switch, a copy. */
  action?: React.ReactNode;
  children: React.ReactNode;
  tone?: "default" | "destructive";
  className?: string;
}) {
  const destructive = tone === "destructive";
  return (
    <SquircleSurface
      className={cn(
        "flex flex-col border p-1 shadow-[0_1px_2px_rgba(0,0,0,0.06)]",
        destructive ? "border-destructive/30" : "border-border",
        className
      )}
      render={<section />}
    >
      <div className="flex min-h-9 items-center justify-between gap-2 pb-2 pl-4 pr-2 pt-1.5">
        <h2
          className={cn(
            "text-sm font-medium",
            destructive ? "text-destructive-foreground" : "text-foreground/80"
          )}
        >
          {title}
        </h2>
        {action}
      </div>

      <SquircleSurface
        className={cn(
          "overflow-hidden rounded-[22px] border bg-[#f6f6f6] shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:12px] sm:rounded-[44px] sm:[--card-clip-radius:17px]",
          destructive ? "border-destructive/30 bg-destructive/10" : "border-border"
        )}
      >
        {children}
      </SquircleSurface>
    </SquircleSurface>
  );
}
