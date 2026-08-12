"use client";

/**
 * The globe's selection, as a tiny external store: clicking an avatar on the
 * map picks a visitor, and the floating tab bar — a different tree entirely —
 * subscribes and morphs open to present them. A store instead of context
 * because the two components share no ancestor below the layout.
 */

export type GlobeVisitor = {
  /** D-102 rotating hash — the identity seed. */
  hash: string;
  name: string;
  /** Two-letter code or "unknown". */
  country: string;
  deviceType: string;
  browser: string | null;
  os: string | null;
  /** The last presence signal's instant, ms — `present[].last_seen_at`. */
  lastSeenMs: number;
  /**
   * Always true for a pick made off the globe now: markers are built from
   * `snapshot.present`, the server-owned online set (ADR-0035). The field
   * stays because the tab bar renders a last-seen line for the false case,
   * and a stored pick could grow one again if a future surface selects
   * visitors who are not on the planet.
   */
  online: boolean;
};

let selected: GlobeVisitor | null = null;
const listeners = new Set<() => void>();

export function subscribeGlobeVisitor(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

export function readGlobeVisitor(): GlobeVisitor | null {
  return selected;
}

export function readGlobeVisitorServer(): null {
  return null;
}

export function setGlobeVisitor(next: GlobeVisitor | null): void {
  selected = next;
  for (const listener of listeners) listener();
}
