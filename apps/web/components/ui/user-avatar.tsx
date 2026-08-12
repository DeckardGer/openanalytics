"use client";

import { Avatar } from "@avatune/react";
import theme from "@avatune/ashley-seo-theme/react";
import * as React from "react";

/**
 * Deterministic visitor avatar (Avatune, micah theme) — the same seed always
 * renders the same face, entirely locally. Shows a neutral circle until
 * mounted to avoid SSR/client markup mismatch.
 */
const emptySubscribe = () => () => {};

export function UserAvatar({ seed, size = 36 }: { seed: string; size?: number }) {
  // True only after hydration — SSR snapshot returns false. Effect-free
  // mounted detection (the repo lints against setState-in-effect).
  const mounted = React.useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );

  if (!mounted) {
    return (
      <span
        aria-hidden="true"
        style={{ width: size, height: size }}
        className="block shrink-0 rounded-full bg-accent"
      />
    );
  }
  return (
    <span className="block shrink-0 overflow-hidden rounded-full" aria-hidden="true">
      <Avatar theme={theme} size={size} seed={seed} />
    </span>
  );
}
