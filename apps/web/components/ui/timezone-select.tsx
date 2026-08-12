"use client";

import { AnimatePresence, motion } from "motion/react";
import * as React from "react";
import { ArrowDown01Icon, Tick02Icon } from "hugeicons-react";
import {
  filterZones,
  zoneEntries,
  zoneLabel,
  type ZoneEntry,
} from "@/lib/timezone-index";
import { cn } from "@/lib/utils";

/**
 * The one timezone picker, everywhere a timezone is picked.
 *
 * The list is timezones — one row per zone — but each row wears its city and
 * country ("Istanbul, Türkiye"), and the search box reads all of it at once:
 * country, city, IANA id, even the two-letter code, so "US" surfaces every
 * American clock and "new york" needs no underscore (`lib/timezone-index`).
 *
 * Two bodies for two homes:
 *
 * - `header`: the share board's pill — the interval selector's dark dropdown
 *   dialect (spring pop, gliding hover highlight, tick), opening rightward
 *   because it sits mid-header beside the site name.
 * - `field`: a form control for settings panels and the onboarding card.
 *   Those panels clip overflow (`SettingsPanel`'s inner surface), so this
 *   variant does not float a panel at all: it expands **in the flow**,
 *   pushing the card taller — which the onboarding card's measured-height
 *   spring absorbs as growth, not clipping.
 *
 * `nullLabel`, when given, leads the unfiltered list as a first row and is
 * what `value: null` means there ("Browser default…", "Not set…"). Callers
 * without it never receive null from `onPick`.
 */

const SPRING = { type: "spring", stiffness: 550, damping: 38 } as const;
const HOVER_TRANSITION = { duration: 0.04, ease: "easeOut" } as const;

export function TimezoneSelect({
  value,
  onPick,
  nullLabel,
  disabled = false,
  variant,
  ariaLabel,
  className,
}: {
  value: string | null;
  onPick: (zone: string | null) => void;
  /** The meaning of `null`, offered as the list's first unfiltered row. */
  nullLabel?: string;
  disabled?: boolean;
  variant: "header" | "field";
  ariaLabel: string;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [hovered, setHovered] = React.useState<string | null>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);

  const entries = React.useMemo(() => {
    const known = zoneEntries();
    // A stored zone this runtime does not list (an older tzdb, a future
    // name) still has to be pickable-away-from, so it joins the list.
    if (value === null || known.some((entry) => entry.zone === value)) {
      return known;
    }
    const city = (value.split("/").pop() ?? value).replaceAll("_", " ");
    const stranger: ZoneEntry = {
      zone: value,
      city,
      country: null,
      label: city,
      haystack: `${value.replaceAll("_", " ")} ${city}`.toLowerCase(),
    };
    return [stranger, ...known];
  }, [value]);

  const filtered = React.useMemo(
    () => filterZones(entries, query),
    [entries, query]
  );
  const showNullRow = nullLabel !== undefined && query.trim() === "";

  const close = React.useCallback(() => {
    setOpen(false);
    setQuery("");
    setHovered(null);
  }, []);

  // Close on outside click or Escape — the interval selector's own manners.
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

  const pick = (zone: string | null) => {
    onPick(zone);
    close();
  };

  const triggerLabel =
    value !== null ? zoneLabel(value) : (nullLabel ?? "Pick a timezone");

  if (variant === "header") {
    return (
      <div className={cn("relative min-w-0", className)} ref={rootRef}>
        <button
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label={ariaLabel}
          className="flex h-7 w-full min-w-0 max-w-48 cursor-pointer items-center gap-1 rounded-full border border-border bg-card pl-2.5 pr-2 text-xs text-muted-foreground shadow-xs outline-none transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          disabled={disabled}
          onClick={() => (open ? close() : setOpen(true))}
          type="button"
        >
          <span className="truncate">{triggerLabel}</span>
          <ArrowDown01Icon
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground/70"
          />
        </button>

        <AnimatePresence>
          {open && (
            <motion.div
              animate={{ opacity: 1, scale: 1, y: 0 }}
              // left-0/origin-top-left, unlike the header's other menus: this
              // one sits mid-header, and growing rightward keeps it over the
              // board instead of colliding with the site name beside it.
              className="absolute left-0 top-full z-30 mt-2 w-72 origin-top-left rounded-2xl bg-[#26262a] p-1.5 shadow-[0_1px_1px_rgba(0,0,0,0.2),0_16px_40px_rgba(0,0,0,0.28)] ring-1 ring-white/8"
              exit={{
                opacity: 0,
                scale: 0.96,
                y: -4,
                transition: { duration: 0.12 },
              }}
              initial={{ opacity: 0, scale: 0.94, y: -6 }}
              key="zone-select"
              onMouseLeave={() => setHovered(null)}
              role="listbox"
              transition={SPRING}
            >
              {/* the autocomplete on top: type to narrow, Enter takes the
                  first match */}
              <input
                autoFocus
                className="mb-1.5 w-full rounded-[10px] bg-white/5 px-3 py-2 text-sm text-white outline-none ring-1 ring-white/10 placeholder:text-white/35 focus-visible:ring-white/25"
                onChange={(event) => {
                  setQuery(event.target.value);
                  setHovered(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && filtered[0] !== undefined) {
                    event.preventDefault();
                    pick(filtered[0].zone);
                  }
                }}
                placeholder="Country, city or timezone…"
                value={query}
              />
              {/* ~ten rows tall (36px each); the rest scroll behind them */}
              <div className="max-h-[360px] overflow-y-auto overscroll-contain">
                {filtered.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-white/45">
                    Nothing matches “{query.trim()}”.
                  </p>
                ) : (
                  filtered.map((entry) => {
                    const isActive = entry.zone === value;
                    return (
                      <button
                        aria-selected={isActive}
                        className="group relative flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-3 py-2 text-left text-sm text-white/90 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-white/40"
                        key={entry.zone}
                        onClick={() => pick(entry.zone)}
                        onMouseEnter={() => setHovered(entry.zone)}
                        role="option"
                        type="button"
                      >
                        {hovered === entry.zone && (
                          <motion.span
                            aria-hidden="true"
                            className="absolute inset-0 rounded-[10px] bg-white/10"
                            layoutId="zone-select-hover"
                            transition={HOVER_TRANSITION}
                          />
                        )}
                        <span className="relative min-w-0 flex-1 truncate font-medium">
                          {entry.city}
                        </span>
                        {entry.country ? (
                          <span className="relative max-w-[45%] truncate text-xs text-white/40">
                            {entry.country}
                          </span>
                        ) : null}
                        {isActive && (
                          <Tick02Icon className="relative size-4 shrink-0 text-white/70" />
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col", className)} ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className={cn(
          "flex h-9 w-full items-center gap-2 rounded-xl border border-input bg-white px-3 text-left text-sm outline-none transition-[box-shadow,border-color] focus-visible:border-ring focus-visible:[outline:2px_solid_var(--ring)] focus-visible:[outline-offset:-2px]",
          disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
        )}
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
        type="button"
      >
        <span className="min-w-0 flex-1 truncate">{triggerLabel}</span>
        <ArrowDown01Icon
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-muted-foreground/70 transition-transform",
            open && "rotate-180"
          )}
        />
      </button>

      {/* In the flow on purpose: settings panels clip overflow, so instead of
          floating (and being cut), the list pushes the panel taller. */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            animate={{ height: "auto", opacity: 1 }}
            className="overflow-hidden"
            exit={{ height: 0, opacity: 0 }}
            initial={{ height: 0, opacity: 0 }}
            key="zone-field"
            transition={SPRING}
          >
            <div className="flex flex-col gap-1.5 pt-1.5">
              <input
                autoFocus
                className="h-9 w-full rounded-xl border border-input bg-white px-3 text-sm outline-none transition-[box-shadow,border-color] placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:[outline:2px_solid_var(--ring)] focus-visible:[outline-offset:-2px]"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && filtered[0] !== undefined) {
                    event.preventDefault();
                    pick(filtered[0].zone);
                  }
                }}
                placeholder="Country, city or timezone…"
                value={query}
              />
              <div
                className="max-h-56 overflow-y-auto overscroll-contain rounded-xl border border-border bg-white"
                role="listbox"
              >
                {showNullRow ? (
                  <button
                    aria-selected={value === null}
                    className="flex w-full cursor-pointer items-center justify-between gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50"
                    onClick={() => pick(null)}
                    role="option"
                    type="button"
                  >
                    <span className="min-w-0 flex-1 truncate">{nullLabel}</span>
                    {value === null && (
                      <Tick02Icon className="size-4 shrink-0 text-muted-foreground" />
                    )}
                  </button>
                ) : null}
                {filtered.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-muted-foreground">
                    Nothing matches “{query.trim()}”.
                  </p>
                ) : (
                  filtered.map((entry) => {
                    const isActive = entry.zone === value;
                    return (
                      <button
                        aria-selected={isActive}
                        className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50"
                        key={entry.zone}
                        onClick={() => pick(entry.zone)}
                        role="option"
                        type="button"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {entry.city}
                        </span>
                        {entry.country ? (
                          <span className="max-w-[45%] truncate text-xs text-muted-foreground">
                            {entry.country}
                          </span>
                        ) : null}
                        {isActive && (
                          <Tick02Icon className="size-4 shrink-0 text-muted-foreground" />
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
