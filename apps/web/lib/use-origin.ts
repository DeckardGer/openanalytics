"use client";

import * as React from "react";

/**
 * Where this app is being read from, as an origin — `https://app.example.com`.
 *
 * Any link that points back into *this* deployment has to be built from this
 * rather than from a constant. A hardcoded origin is correct on exactly one
 * install and quietly wrong on every fork of it: a self-hosted owner copying
 * their public dashboard link would hand out a URL to somebody else's server.
 *
 * `null` on the server and for the first client render, because there is no
 * origin to know yet and guessing one would put a wrong URL on screen for a
 * frame. Callers render the link's absence, never a placeholder.
 */
export function useOrigin(): string | null {
  // `useSyncExternalStore` rather than state written from an effect: the origin
  // is external, immutable data that never changes for the life of the document,
  // so subscribing to nothing and reading it in the client snapshot is exactly
  // what this hook means. Writing it with `setState` inside an effect said the
  // same thing by scheduling a second render, which is what
  // `react-hooks/set-state-in-effect` objects to.
  return React.useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => null,
  );
}
