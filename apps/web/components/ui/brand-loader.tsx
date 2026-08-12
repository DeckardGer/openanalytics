import * as React from "react";
import {
  BAND_HEIGHT,
  BAND_TOPS,
  BASE_TOP,
  RING_PATH,
} from "@/components/ui/logo";
import { cn } from "@/lib/utils";

/**
 * The waiting indicator, for screens that are only ever a hand-off.
 *
 * The gates that mount this — signed-in checks, the fork at `/`, the bounce
 * into onboarding — are the first thing a new account sees after signing up,
 * and they used to be a line of grey text on an empty page. A sentence is a
 * poor loading indicator: it does not move, so a slow hop and a stuck one look
 * identical, and it spends a first impression on prose nobody reads.
 *
 * So the mark waits instead. A crest travels down its bands, bottom to top,
 * on a loop — the mark's own rhythm animated rather than a spinner borrowed
 * from anywhere. It is deliberately **indeterminate**: a redirect has no
 * measurable progress, and bands that filled like a gauge would be claiming
 * one. Geometry comes from `components/ui/logo.tsx`, so a revised mark
 * revises this too.
 *
 * The sentence survives as the accessible name — a screen reader still hears
 * where it is being taken, which is the one audience the text was serving.
 *
 * No `motion/react` and no JavaScript: this renders in the first frame of a
 * cold navigation, before the app has settled, and it must cost nothing.
 */
export function BrandLoader({
  className,
  label,
}: {
  className?: string;
  /** Where the person is being taken. Announced, never drawn. */
  label: string;
}) {
  // One clip per instance — inline SVGs share the document's id space.
  const clipId = `brand-loader-${React.useId().replace(/:/g, "")}`;

  // Bottom to top: the base is the widest stripe, so starting there reads as
  // the crest rising out of the solid ground rather than falling into it.
  const bands = [
    { height: 512 - BASE_TOP, y: BASE_TOP },
    ...[...BAND_TOPS].reverse().map((top) => ({ height: BAND_HEIGHT, y: top })),
  ];

  return (
    <span
      className="inline-flex items-center justify-center text-primary"
      role="status"
    >
      <svg
        aria-hidden="true"
        className={cn("size-10 shrink-0", className)}
        viewBox="0 0 512 512"
      >
        <clipPath id={clipId}>
          <path clipRule="evenodd" d={RING_PATH} fillRule="evenodd" />
        </clipPath>
        <g clipPath={`url(#${clipId})`} fill="currentColor">
          {bands.map((band, index) => (
            <rect
              className="brand-band"
              height={band.height}
              key={band.y}
              style={{ animationDelay: `${index * 80}ms` }}
              width="512"
              x="0"
              y={band.y}
            />
          ))}
        </g>
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}
