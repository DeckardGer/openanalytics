"use client";

import {
  ArrowUpDownIcon,
  PlusSignIcon,
  Tick02Icon,
} from "hugeicons-react";
import { MoreVerticalCircleIcon } from "@/components/icons/hugeicons";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import * as React from "react";
import { SiteMark } from "@/components/dashboard/site-favicon";
import { useApiResource } from "@/hooks/use-api-resource";
import { listSites, LIVE_API, type SiteSummary } from "@/lib/api";
import { MOCK_SITES } from "@/lib/mock";

/**
 * Site switcher in the dashboard header, fed by `GET /v1/sites`.
 *
 * It owns its own read rather than taking a `sites` prop, and that is what
 * keeps the list from being fetched twice: this component is mounted only
 * inside `/dashboard/[site]`, and the only other caller of `listSites` is
 * `SitesGrid` on `/dashboard`. The two are never on screen together, so there
 * is nothing to share and no provider to hoist the list into.
 *
 * The route segment is the public **slug**, so that is what identifies a site
 * here and what every link carries — the internal `site_id` never reaches a
 * URL. The label is the site's `name` once the list has landed and falls back
 * to the slug before that, so the trigger is never blank and never invented.
 */

const SPRING = { type: "spring", stiffness: 550, damping: 38 } as const;
/** Snappy glide for the hover highlight — near-instant, no lag. */
const HOVER_TRANSITION = { duration: 0.04, ease: "easeOut" } as const;

const itemClass =
  "group relative flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-3 py-2 text-left text-sm text-white/90 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-white/40";

/** Sliding hover highlight shared per panel via layoutId. */
function Highlight() {
  return (
    <motion.span
      layoutId="site-switcher-hover"
      transition={HOVER_TRANSITION}
      aria-hidden="true"
      className="absolute inset-0 rounded-[10px] bg-white/10"
    />
  );
}

export interface SiteSwitcherProps {
  /** The `[site]` route segment: a public slug, already decoded. */
  currentSlug: string;
  /** Navigate to the same sub-page on another site, by slug. */
  onSelect: (slug: string) => void;
}

export function SiteSwitcher({ currentSlug, onSelect }: SiteSwitcherProps) {
  const [open, setOpen] = React.useState(false);
  const [hovered, setHovered] = React.useState<string | null>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);

  const load = React.useCallback(
    (signal: AbortSignal) =>
      LIVE_API
        ? listSites({ signal })
        : Promise.resolve({ items: MOCK_SITES }),
    []
  );
  const sites = useApiResource(load);

  const close = React.useCallback(() => {
    setOpen(false);
    setHovered(null);
  }, []);

  // Close on outside click or Escape
  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  const items: SiteSummary[] = sites.status === "ready" ? sites.data.items : [];
  // A slug the caller cannot see (a stale deep link) simply has no row here;
  // the trigger then keeps showing the slug rather than guessing a name.
  const current = items.find((site) => site.slug === currentSlug) ?? null;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        className="flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* the site's own favicon identifies it faster than a status colour
            could; lifecycle now has whole screens of its own (§15/§17), so
            the dot it replaces is no longer the only place status shows */}
        <SiteMark
          className="size-5"
          domain={current?.domains[0] ?? null}
          name={current ? current.name : currentSlug}
        />
        {current ? current.name : currentSlug}
        <MoreVerticalCircleIcon className="size-3.5 text-muted-foreground" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            key="site-switcher"
            role="menu"
            initial={{ opacity: 0, scale: 0.94, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -4, transition: { duration: 0.12 } }}
            transition={SPRING}
            onMouseLeave={() => setHovered(null)}
            className="absolute left-0 top-full mt-3 w-60 origin-top-left rounded-2xl bg-[#26262a] p-1.5 shadow-[0_1px_1px_rgba(0,0,0,0.2),0_16px_40px_rgba(0,0,0,0.28)] ring-1 ring-white/8"
          >
            <p className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-white/40">
              Sites
            </p>

            {sites.status === "loading" ? (
              <div aria-busy="true" className="flex flex-col gap-1 px-3 py-2">
                <span className="h-3 w-32 animate-pulse rounded bg-white/10" />
                <span className="h-3 w-24 animate-pulse rounded bg-white/10" />
                <span className="sr-only">Loading your sites…</span>
              </div>
            ) : null}

            {/* The list failing must not look like "you have one site". */}
            {sites.status === "error" ? (
              <div className="px-3 py-2" role="alert">
                <p className="text-xs font-medium text-white/80">
                  {sites.error.title}
                </p>
                <p className="mt-0.5 text-[11px] leading-4 text-white/40">
                  {sites.error.body}
                </p>
                {sites.error.retryable ? (
                  <button
                    type="button"
                    onClick={sites.retry}
                    className="mt-1.5 cursor-pointer rounded-md px-1.5 py-1 text-[11px] font-medium text-white/70 outline-none transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/40"
                  >
                    Try again
                  </button>
                ) : null}
              </div>
            ) : null}

            {sites.status === "ready" && items.length === 0 ? (
              <p className="px-3 py-2 text-xs leading-5 text-white/40">
                No sites yet. Sites you own or are invited to appear here.
              </p>
            ) : null}

            {items.map((site) => {
              const isCurrent = site.slug === currentSlug;
              return (
                <button
                  key={site.site_id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isCurrent}
                  onClick={() => {
                    close();
                    if (!isCurrent) onSelect(site.slug);
                  }}
                  onMouseEnter={() => setHovered(site.slug)}
                  className={itemClass}
                >
                  {hovered === site.slug && <Highlight />}
                  <SiteMark
                    className="relative size-5"
                    domain={site.domains[0] ?? null}
                    name={site.name}
                    tone="dark"
                  />
                  <span className="relative flex-1 truncate font-medium">
                    {site.name}
                  </span>
                  {/* a word beats a colour for the two states that matter */}
                  {site.status !== "active" ? (
                    <span className="relative shrink-0 text-[11px] text-white/40">
                      {site.status === "suspended"
                        ? "Paused"
                        : "Deleting"}
                    </span>
                  ) : null}
                  {isCurrent && (
                    <Tick02Icon className="relative size-4 text-white/70" />
                  )}
                </button>
              );
            })}

            <div className="my-1 h-px bg-white/8" />

            <Link
              href="/dashboard"
              role="menuitem"
              onClick={close}
              onMouseEnter={() => setHovered("all-sites")}
              className={itemClass}
            >
              {hovered === "all-sites" && <Highlight />}
              <span className="relative flex-1 font-medium">All sites</span>
              <ArrowUpDownIcon className="relative size-4 text-white/50" />
            </Link>

            {/* Creating a site lives on the sites picker, which owns the
                dialog and its validation — this row goes there rather than
                opening a second copy of it inside a dropdown. */}
            <Link
              href="/dashboard"
              role="menuitem"
              onClick={close}
              onMouseEnter={() => setHovered("add-site")}
              className={itemClass}
            >
              {hovered === "add-site" && <Highlight />}
              <span className="relative flex-1 font-medium">Add site</span>
              <PlusSignIcon className="relative size-4 text-white/50" />
            </Link>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
