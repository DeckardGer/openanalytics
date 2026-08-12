"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import * as React from "react";
import {
  CircleCheckIcon,
  CircleDashedIcon,
} from "@/components/icons/hugeicons";
import { checklistSteps } from "@seam/slots";
import {
  eventDefinitions,
  funnels,
  LIVE_API,
  revenue,
  sites,
} from "@/lib/api";
import { useSession } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

/**
 * Getting started — a five-step checklist beside the profile, gone the day
 * it is finished.
 *
 * Every step is derived from reads the dashboard already has; nothing was
 * asked of the backend for this:
 *
 * - a site exists            → `GET /v1/sites`
 * - the snippet is installed → any site's `first_event_at` (ADR-0027's
 *                              install-verified signal — data arriving is the
 *                              only honest definition of "installed")
 * - something custom tracked → any site with a funnel or an event definition
 * - revenue connected        → any site's revenue connection
 *
 * A deployment may add rows of its own (`@seam/slots`); the hosted build adds
 * "Pick a plan", derived from its own entitlement read. Each extra row brings
 * the check that decides it, so the product never asks about a plan it has no
 * endpoint for.
 *
 * Completion is remembered per user in localStorage, so a finished user
 * never pays these reads again and never sees the pill flash. The cache
 * only ever records *done*: an unfinished checklist re-derives every load,
 * because steps can regress (a site deleted, a plan lapsed) and a stale nag
 * would lie. Any read failing simply hides the pill for the visit — a
 * checklist is decoration, and decoration never gets an error state.
 */

/** The user menu's own springs, so the two header panels open as one hand. */
const SPRING = { type: "spring", stiffness: 550, damping: 38 } as const;
const HOVER_TRANSITION = { duration: 0.04, ease: "easeOut" } as const;

type StepId = string;

const PRODUCT_STEPS = ["site", "install", "custom", "revenue"] as const;

/** The product's rows, then the deployment's, in that order. */
const STEP_ORDER: StepId[] = [
  ...PRODUCT_STEPS,
  ...checklistSteps.map((step) => step.id),
];

const STEP_LABEL: Record<StepId, string> = {
  site: "Create your first site",
  install: "Install the snippet",
  custom: "Track something custom",
  revenue: "Connect your revenue",
  ...Object.fromEntries(checklistSteps.map((step) => [step.id, step.label])),
};

type Progress = {
  done: Record<StepId, boolean>;
  /** For deep links into the first site's own screens. */
  firstSlug: string | null;
};

const storageKey = (userId: string) => `oa:getting-started:done:v1:${userId}`;

/** Where each unfinished step sends the user. */
function stepHref(step: StepId, firstSlug: string | null): string {
  const site = firstSlug ? `/dashboard/${encodeURIComponent(firstSlug)}` : null;
  switch (step) {
    case "site":
      return "/dashboard";
    case "install":
      return site ? `${site}/settings` : "/dashboard";
    case "custom":
      return site ? `${site}/funnels` : "/dashboard";
    case "revenue":
      return site ? `${site}/settings?tab=integrations` : "/dashboard";
    default:
      return (
        checklistSteps.find((entry) => entry.id === step)?.href ?? "/dashboard"
      );
  }
}

async function deriveProgress(): Promise<Progress> {
  const [siteList, extras] = await Promise.all([
    sites.list(),
    Promise.all(checklistSteps.map((step) => step.isDone())),
  ]);
  const items = siteList.items;

  const done: Record<StepId, boolean> = {
    site: items.length > 0,
    install: items.some((entry) => entry.first_event_at !== null),
    custom: false,
    revenue: false,
    ...Object.fromEntries(
      checklistSteps.map((step, index) => [step.id, extras[index] ?? false])
    ),
  };

  // Across sites, stopping at the first hit. Per-site failures are skipped
  // rather than fatal: a viewer membership may not open every read, and one
  // closed door must not blank the other four steps.
  for (const entry of items) {
    if (!done.custom) {
      try {
        const [funnelList, definitionList] = await Promise.all([
          funnels.list(entry.site_id),
          eventDefinitions.list(entry.site_id),
        ]);
        if (funnelList.items.length > 0 || definitionList.items.length > 0) {
          done.custom = true;
        }
      } catch {
        /* skip this site */
      }
    }
    if (!done.revenue) {
      try {
        const state = await revenue.state(entry.site_id);
        if (state.status !== "not_connected") done.revenue = true;
      } catch {
        /* skip this site */
      }
    }
    if (done.custom && done.revenue) break;
  }

  return { done, firstSlug: items[0]?.slug ?? null };
}

export function GettingStarted() {
  const { data: session } = useSession();
  const userId = LIVE_API ? (session?.user?.id ?? null) : "mock-user";
  const [progress, setProgress] = React.useState<Progress | null>(null);
  const [hidden, setHidden] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [hovered, setHovered] = React.useState<StepId | "dismiss" | null>(
    null
  );
  const rootRef = React.useRef<HTMLDivElement>(null);

  const close = React.useCallback(() => {
    setOpen(false);
    setHovered(null);
  }, []);

  // Close on outside click or Escape — the user menu's own manners.
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

  React.useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    // Microtask hop before any state write (the house pattern from the tab
    // deep links): the effect body itself stays write-free.
    void Promise.resolve().then(() => {
      if (cancelled) return;
      try {
        if (localStorage.getItem(storageKey(userId)) === "1") {
          setHidden(true);
          return;
        }
      } catch {
        /* storage may be unavailable; derive as usual */
      }

      if (!LIVE_API) {
        setProgress({
          done: {
            site: true,
            install: true,
            custom: false,
            revenue: false,
            ...Object.fromEntries(
              checklistSteps.map((step) => [step.id, false])
            ),
          },
          firstSlug: "design-mode",
        });
        return;
      }

      deriveProgress().then(
        (derived) => {
          if (cancelled) return;
          if (STEP_ORDER.every((step) => derived.done[step])) {
            try {
              localStorage.setItem(storageKey(userId), "1");
            } catch {
              /* remembering is best-effort */
            }
            setHidden(true);
            return;
          }
          setProgress(derived);
        },
        () => {
          if (!cancelled) setHidden(true);
        }
      );
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // The install step is the one that completes *outside* the dashboard: the
  // user pastes the snippet, loads their site, and comes back here to watch.
  // So it alone is polled (§38), at the onboarding connect step's own 2.5 s
  // cadence, and only the site read is repeated: `first_event_at` is the one
  // signal that moves without a deliberate in-dashboard action. The timer
  // dies the moment the step flips or the widget hides.
  const installPending = progress !== null && !progress.done.install;
  React.useEffect(() => {
    if (!LIVE_API || !userId || hidden || !installPending) return;
    let cancelled = false;
    const probe = async () => {
      try {
        const siteList = await sites.list();
        if (cancelled) return;
        if (siteList.items.some((entry) => entry.first_event_at !== null)) {
          setProgress((previous) =>
            previous === null
              ? previous
              : { ...previous, done: { ...previous.done, install: true } }
          );
        }
      } catch {
        /* the next tick retries; decoration never gets an error state */
      }
    };
    const timer = setInterval(() => void probe(), 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [userId, hidden, installPending]);

  // Completion can now arrive after mount (the poll above), so the
  // hide-and-remember exit is watched here too, not only at derive time.
  React.useEffect(() => {
    if (!userId || progress === null) return;
    if (!STEP_ORDER.every((step) => progress.done[step])) return;
    let cancelled = false;
    // The same microtask hop as above: the effect body stays write-free.
    void Promise.resolve().then(() => {
      if (cancelled) return;
      try {
        localStorage.setItem(storageKey(userId), "1");
      } catch {
        /* remembering is best-effort */
      }
      setHidden(true);
    });
    return () => {
      cancelled = true;
    };
  }, [userId, progress]);

  if (hidden || progress === null) return null;

  const completed = STEP_ORDER.filter((step) => progress.done[step]).length;
  // The first unfinished step wears the filled marker: it is the one to do.
  const nextStep = STEP_ORDER.find((step) => !progress.done[step]);

  return (
    <div className="relative hidden sm:block" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex h-8 cursor-pointer items-center gap-2.5 rounded-full border border-border bg-card px-3 text-sm shadow-xs outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={() => (open ? close() : setOpen(true))}
        type="button"
      >
        Getting started
        {/* the tick meter: ten hairline bars, filled in step order */}
        <span aria-hidden="true" className="flex items-center gap-[2.5px]">
          {Array.from({ length: 10 }, (_, index) => (
            <span
              className={cn(
                "h-3 w-[2.5px] rounded-full",
                index < Math.round((completed / STEP_ORDER.length) * 10)
                  ? "bg-emerald-500"
                  : "bg-border"
              )}
              key={index}
            />
          ))}
        </span>
        <span className="tabular-nums text-muted-foreground">
          {completed}/{STEP_ORDER.length}
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.ol
            animate={{ opacity: 1, scale: 1, y: 0 }}
            className="absolute right-0 top-full mt-3 w-72 origin-top-right rounded-2xl bg-[#26262a] p-1.5 shadow-[0_1px_1px_rgba(0,0,0,0.2),0_16px_40px_rgba(0,0,0,0.28)] ring-1 ring-white/8"
            exit={{
              opacity: 0,
              scale: 0.96,
              y: -4,
              transition: { duration: 0.12 },
            }}
            initial={{ opacity: 0, scale: 0.94, y: -6 }}
            key="getting-started"
            onMouseLeave={() => setHovered(null)}
            transition={SPRING}
          >
            {/* The user menu's own row anatomy, verbatim: the label first in
                its type (text-sm, font-medium), the icon after it, size-4 on
                the right. The step's state *is* the icon — a dashed circle
                for still-to-do, a check for done — so numbers and chevrons
                have nothing left to say. */}
            {STEP_ORDER.map((step) => {
              const isDone = progress.done[step];
              if (isDone) {
                // Done rows still take the sliding highlight — the pointer
                // travelling the list should never hit a dead patch — but
                // there is nothing left to do here, so nothing is clickable
                // and the cursor says so.
                return (
                  <li
                    className="relative flex w-full cursor-default select-none items-center gap-2.5 rounded-[10px] px-3 py-2 text-sm text-white/45"
                    key={step}
                    onMouseEnter={() => setHovered(step)}
                  >
                    {hovered === step && (
                      <motion.span
                        aria-hidden="true"
                        className="absolute inset-0 rounded-[10px] bg-white/10"
                        layoutId="getting-started-hover"
                        transition={HOVER_TRANSITION}
                      />
                    )}
                    <span className="relative flex-1 font-medium">
                      {STEP_LABEL[step]}
                    </span>
                    <CircleCheckIcon
                      aria-hidden="true"
                      className="relative size-4 text-emerald-400"
                    />
                  </li>
                );
              }
              return (
                <li key={step}>
                  <Link
                    className="group relative flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-3 py-2 text-left text-sm text-white/90 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-white/40"
                    href={stepHref(step, progress.firstSlug)}
                    onClick={close}
                    onMouseEnter={() => setHovered(step)}
                  >
                    {/* the user menu's sliding hover highlight, per panel */}
                    {hovered === step && (
                      <motion.span
                        aria-hidden="true"
                        className="absolute inset-0 rounded-[10px] bg-white/10"
                        layoutId="getting-started-hover"
                        transition={HOVER_TRANSITION}
                      />
                    )}
                    <span className="relative flex-1 font-medium">
                      {STEP_LABEL[step]}
                    </span>
                    <CircleDashedIcon
                      aria-hidden="true"
                      className={cn(
                        "relative size-4",
                        step === nextStep ? "text-white/80" : "text-white/40"
                      )}
                    />
                  </Link>
                </li>
              );
            })}
            {/* The way out for someone who will never finish (a checklist
                with a revenue step is a nag to anyone who never connects
                revenue). Dismissing writes the same done-key completion
                writes, so a hidden checklist stays hidden for good. */}
            <li className="mt-1 border-t border-white/8 pt-1">
              <button
                className="relative flex w-full cursor-pointer items-center rounded-[10px] px-3 py-2 text-left text-xs text-white/45 outline-none transition-colors hover:text-white/70 focus-visible:ring-2 focus-visible:ring-white/40"
                onClick={() => {
                  if (userId) {
                    try {
                      localStorage.setItem(storageKey(userId), "1");
                    } catch {
                      /* remembering is best-effort; hide for the visit */
                    }
                  }
                  setHidden(true);
                }}
                onMouseEnter={() => setHovered("dismiss")}
                type="button"
              >
                {hovered === "dismiss" && (
                  <motion.span
                    aria-hidden="true"
                    className="absolute inset-0 rounded-[10px] bg-white/10"
                    layoutId="getting-started-hover"
                    transition={HOVER_TRANSITION}
                  />
                )}
                <span className="relative">
                  Hide this checklist. It will not come back.
                </span>
              </button>
            </li>
          </motion.ol>
        )}
      </AnimatePresence>
    </div>
  );
}
