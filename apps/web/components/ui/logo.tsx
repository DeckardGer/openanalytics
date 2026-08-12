import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Brand mark: the striped "O" — horizontal bands over the ring, a solid base
 * under them. Drawn geometrically to match the 2026-08 mark (source of
 * truth: public/web-app-manifest-512x512.png) instead of the old hand-traced
 * paths, and filled with `currentColor` so any usage can tint it
 * (`text-primary`, `text-white`) via className.
 */

/**
 * Band rhythm over the 512 grid: 20px of ink every 32px, then solid base.
 *
 * Exported because the mark is drawn twice — here, and animated band-by-band
 * in `components/ui/brand-loader.tsx`. Two hand-kept copies of a logo drift
 * the moment the mark is revised, and a loader wearing last season's brand is
 * a worse bug than a wrong colour: it is only ever seen by people who have not
 * finished signing up yet.
 */
export const BAND_TOPS = [4, 36, 68, 100, 132, 164, 196, 228, 260, 292];
export const BAND_HEIGHT = 20;
export const BASE_TOP = 324;

/** The ring: outer circle with the inner circle punched out (evenodd). */
export const RING_PATH =
  "M256 4a252 252 0 1 0 0 504 252 252 0 1 0 0-504Zm0 109a141 141 0 1 1 0 282 141 141 0 1 1 0-282Z";

export function Logo({ className }: { className?: string }) {
  // One clip per instance — inline SVGs share the document's id space, and
  // two logos on a page must not fight over one ring.
  const clipId = `logo-ring-${React.useId().replace(/:/g, "")}`;
  return (
    <svg
      viewBox="0 0 512 512"
      aria-hidden="true"
      className={cn("shrink-0", className)}
    >
      <clipPath id={clipId}>
        <path clipRule="evenodd" d={RING_PATH} fillRule="evenodd" />
      </clipPath>
      <g clipPath={`url(#${clipId})`} fill="currentColor">
        {BAND_TOPS.map((top) => (
          <rect height={BAND_HEIGHT} key={top} width="512" x="0" y={top} />
        ))}
        <rect height={512 - BASE_TOP} width="512" x="0" y={BASE_TOP} />
      </g>
    </svg>
  );
}
