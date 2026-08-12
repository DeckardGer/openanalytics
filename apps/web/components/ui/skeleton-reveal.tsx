import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The house skeleton language: while cold, a pulsing stand-in; once the data
 * lands, the real thing comes into focus in its place (`.skel-in`, defined in
 * `globals.css`).
 *
 * Two rules hold the reveal together, and both were paid for in blinks:
 *
 * - *It is an animation, not a transition.* The content mounts already in its
 *   final state, so a transition has no previous value to run from and the
 *   content simply appeared.
 * - *A zero blur stays declared on the element afterwards.* A filter dropped
 *   when its animation ends tears down the element's composited layer and
 *   repaints the whole subtree in one frame — a flick that lands *after* the
 *   content has sharpened, which is what made it read as a glitch rather than
 *   as part of the motion.
 *
 * The skeleton itself is a plain conditional swap: it renders, it pulses, it
 * is replaced. Nothing measures it, nothing lifts it out of flow, and
 * `AnimatePresence`/`popLayout` are deliberately not involved — letting the
 * library manage the exit cost a one-frame flick of its own.
 *
 * Every skeleton must be pixel-matched to the content it stands in for: same
 * paddings, same line heights, same row counts. A skeleton taller or shorter
 * than its content shoves the rest of the page around at reveal time, which is
 * worse than no skeleton at all.
 *
 * And the stand-in is the *content*, never the card. A panel's chrome — its
 * frame, its title, its static forms — is knowable before any request
 * answers, so it renders real from the first frame and the reveal wraps only
 * what actually waits (the API-keys panel is the reference). Revealing a
 * whole panel makes it read as a new card arriving at the end of the blur.
 * A chrome slot that does wait (a count, a copy button) swaps in place with
 * a bar instead — outside the reveal, so the bar carries its own
 * `animate-pulse`; inside, the skeleton branch's wrapper provides it.
 */
export function SkeletonReveal({
  ready,
  skeleton,
  children,
  className,
  contentClassName,
}: {
  ready: boolean;
  skeleton: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /**
   * Layout for the swapped pane, applied to **both** branches.
   *
   * A caller that hands over a fragment of sibling panels — Installation's
   * five, Usage's two — loses whatever spacing its parent flex was giving
   * them, because the wrapper below sits in between and carries none of its
   * own. `contentClassName="flex flex-col gap-6"` puts it back.
   *
   * One prop for both branches on purpose: these two panes are meant to be
   * pixel-matched, and a layout that could differ between them is exactly how
   * a swap starts shifting things.
   */
  contentClassName?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      {ready ? (
        // `skel-in` (globals.css) is the reveal: the content arrives blurred
        // and comes into focus. It is an animation rather than a transition
        // because this element mounts already in its final state, and it
        // keeps a zero blur declared afterwards so the composited layer is
        // never torn down — that teardown repaint is what used to blink.
        <div className={cn("skel-in", contentClassName)}>{children}</div>
      ) : (
        <div
          aria-hidden="true"
          className={cn("w-full animate-pulse", contentClassName)}
        >
          {skeleton}
        </div>
      )}
    </div>
  );
}

/** One grey bar. Size it with width/height utilities at the call site. */
export function SkeletonBar({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("block rounded bg-muted-foreground/15", className)}
    />
  );
}

/** A circular stand-in (avatars, marks). */
export function SkeletonCircle({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "block shrink-0 rounded-full bg-muted-foreground/15",
        className
      )}
    />
  );
}
