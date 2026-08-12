"use client";

import Image from "next/image";
import type * as React from "react";
import { SkeletonBar } from "@/components/ui/skeleton-reveal";
import { cn } from "@/lib/utils";

/**
 * The logo tile the import and integration cards are marked with.
 *
 * Every logo we ship is square, so the mark is a rounded tile the image fills
 * edge to edge — the way an app icon renders. Marks that arrive on a
 * transparent background get `inset` instead, so they sit on the tile rather
 * than bleeding off it, and the hairline ring gives them an edge they would
 * otherwise lose against the white card.
 */
export function ProviderMark({
  src,
  alt = "",
  bg = "#ffffff",
  inset,
  className,
  children,
}: {
  /** Path under `/public`. Omit and pass `children` to render a glyph instead. */
  src?: string;
  alt?: string;
  bg?: string;
  /** For logos with no background of their own. */
  inset?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg ring-1 ring-border",
        inset && "p-1",
        className
      )}
      style={{ backgroundColor: bg }}
    >
      {src ? (
        <Image
          alt={alt}
          className="size-full object-cover"
          height={72}
          src={src}
          // SVG is refused by the optimizer without `dangerouslyAllowSVG`, and
          // AVIF is already compressed — pass both through untouched.
          unoptimized={src.endsWith(".svg") || src.endsWith(".avif")}
          width={72}
        />
      ) : (
        children
      )}
    </span>
  );
}

/**
 * The stand-in for a list of provider rows, while a catalog is in flight.
 *
 * It lives beside the mark because the row's height *is* the mark's: a
 * `size-9` tile inside `py-3` makes 60px, and the two text lines — `text-sm`
 * at 20px over `text-xs` at 16px — add up to exactly the same 36px. The bars
 * below are set at those two line boxes rather than at their own heights, so
 * the swap cannot move a row by a pixel.
 *
 * Shared by imports and revenue because both lists are the same row. Two
 * hand-rolled copies would be two chances for one of them to drift.
 */
export function ProviderRowsSkeleton({
  rows,
  action,
}: {
  rows: number;
  /** The trailing control's stand-in — its size differs per list. */
  action?: React.ReactNode;
}) {
  return (
    <ul className="divide-y divide-border">
      {Array.from({ length: rows }, (_, index) => (
        <li className="flex items-center gap-3 px-5 py-3" key={index}>
          <SkeletonBar className="size-9 shrink-0 rounded-lg" />
          <span className="min-w-0 flex-1">
            <span className="flex h-5 items-center">
              <SkeletonBar className="h-3.5 w-28" />
            </span>
            <span className="flex h-4 items-center">
              <SkeletonBar className="h-3 w-64 max-w-full" />
            </span>
          </span>
          {action}
        </li>
      ))}
    </ul>
  );
}
