"use client";

import { CheckmarkCircle02Icon, PlusSignIcon } from "hugeicons-react";
import { AnimatePresence, motion } from "motion/react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { InstallOptions } from "@/components/dashboard/install-options";
import { Favicon } from "@/components/dashboard/site-favicon";
import { Logo } from "@/components/ui/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SquircleSurface } from "@/components/ui/squircle-card";
import {
  errorCodeOf,
  LIVE_API,
  presentError,
  sites,
  trackerSnippet,
  type CreatedSite,
} from "@/lib/api";
import { MOCK_CREATED_SITE } from "@/lib/mock";

const SPRING = { type: "spring", stiffness: 550, damping: 38 } as const;

/** Horizontal slide between steps — direction-aware, content-only. */
const stepVariants = {
  enter: (dir: number) => ({ x: dir * 32, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir * -32, opacity: 0 }),
};

const STEP_TITLES = {
  1: "Add a new site",
  2: "Install the tracker",
  3: "Connect your site",
} as const;

/* The favicon itself lives in site-favicon.tsx — a site's mark is used on the
   sites grid, the switcher and the usage split too, so it has one home. */

/** Distance from each favicon's center to the middle of the connection row. */
const MERGE_X = 68;

/** The contract's slug shape, derived from whatever name the user typed. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 63);
}

/** A bare hostname with at least one dot — what the domains allowlist takes. */
export function cleanDomain(value: string): string | null {
  const bare = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
    bare
  )
    ? bare
    : null;
}

/**
 * Self-contained trigger + dialog, for the sites overview page.
 */
export function AddSiteDialog() {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        size="xs"
        variant="secondary"
        className="gap-2"
      >
        <PlusSignIcon size={4} />
        Add New Project
      </Button>
      <AnimatePresence>
        {open ? <AddSiteFlow onClose={() => setOpen(false)} /> : null}
      </AnimatePresence>
    </>
  );
}

/**
 * The three-step modal, controlled — the header's site switcher opens it too.
 *
 * Live wiring per the contract: `POST /v1/sites {slug, name}` under one
 * `Idempotency-Key` per attempt (a timed-out create retried must not make two
 * sites), then `PATCH {domains}` — the create deliberately takes no domains,
 * the allowlist is a second call. The 201 carries the tracking key, so step 2
 * renders the real snippet with no extra fetch.
 */
export function AddSiteFlow({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [step, setStep] = React.useState<1 | 2 | 3>(1);
  const [dir, setDir] = React.useState(1);
  const [name, setName] = React.useState("");
  const [domain, setDomain] = React.useState("");
  const [connected, setConnected] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [created, setCreated] = React.useState<CreatedSite | null>(null);
  /** One key per attempt, reused by retries of that same attempt. */
  const idempotencyKey = React.useRef(crypto.randomUUID());
  const timeout = React.useRef<ReturnType<typeof setTimeout>>(undefined);

  // The steps are different heights, so the panel animates between them
  // instead of holding one fixed frame — onboarding's measured-height
  // spring. Border box, not `contentRect`: the step carries padding, and
  // the content box alone would clip the last control away.
  const [panelHeight, setPanelHeight] = React.useState<number | null>(null);
  const measureStep = React.useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const observer = new ResizeObserver(() => {
      setPanelHeight(node.getBoundingClientRect().height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => () => clearTimeout(timeout.current), []);

  const goTo = (next: 1 | 2 | 3) => {
    setDir(next > step ? 1 : -1);
    if (next === 3) setConnected(false);
    setStep(next);
  };

  const slug = created?.slug ?? slugify(name) ?? "site";
  const dashboardHref = `/dashboard/${encodeURIComponent(slug)}`;
  const publicToken =
    created?.tracking_key.public_token ??
    MOCK_CREATED_SITE.tracking_key.public_token;
  const snippet = trackerSnippet(publicToken);

  const create = () => {
    const trimmedName = name.trim();
    const siteSlug = slugify(trimmedName);
    if (siteSlug.length < 2) {
      setError("Give the site a longer name. The slug needs 2+ characters.");
      return;
    }
    const bareDomain = cleanDomain(domain);
    if (!bareDomain) {
      setError("Enter a bare domain like example.com, with no https:// or path.");
      return;
    }
    setError(null);

    if (!LIVE_API) {
      setCreated({ ...MOCK_CREATED_SITE, slug: siteSlug, name: trimmedName });
      goTo(2);
      return;
    }

    setBusy(true);
    sites
      .create({ slug: siteSlug, name: trimmedName }, idempotencyKey.current)
      .then(async (site) => {
        // The allowlist is a follow-up PATCH by design. Best-effort: a
        // rejected domain must not strand the created site, so it degrades to
        // "configure it in settings" rather than failing the whole flow.
        try {
          await sites.update(site.site_id, { domains: [bareDomain] });
        } catch {
          /* settings screen owns fixing the allowlist */
        }
        setBusy(false);
        setCreated(site);
        goTo(2);
      })
      .catch((raised: unknown) => {
        setBusy(false);
        const code = errorCodeOf(raised);
        if (code === "VALIDATION_FAILED") {
          setError("That name gives a slug that is taken or invalid. Try another.");
        } else if (code === "SUBSCRIPTION_REQUIRED") {
          setError("You need a plan first. Pick one on the billing page, then retry.");
        } else if (code === "SITE_CAPACITY_EXCEEDED") {
          setError("Your plan is at its site limit. Upgrade, or remove a site.");
        } else {
          setError(presentError(raised).body);
        }
      });
  };

  // Escape closes
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Step 3 in mock mode plays the first event arriving on a timer.
  React.useEffect(() => {
    if (step !== 3 || LIVE_API) return;
    const firstEvent = setTimeout(() => setConnected(true), 4000);
    return () => clearTimeout(firstEvent);
  }, [step]);

  // Live mode watches the truth instead, exactly as onboarding does:
  // `first_event_at` on the site read (ADR-0027) — never an analytics query,
  // whose empty answer cannot tell an uninstalled tracker from a quiet
  // minute. It fills within about one batch flush and never moves once set.
  React.useEffect(() => {
    if (step !== 3 || !LIVE_API || created === null || connected) return;
    let cancelled = false;
    const probe = async () => {
      try {
        const site = await sites.get(created.site_id);
        if (!cancelled && site.first_event_at !== null) setConnected(true);
      } catch {
        // The next tick retries; Back and Go to project stay available.
      }
    };
    void probe();
    const timer = setInterval(() => void probe(), 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [step, created, connected]);

  React.useEffect(() => {
    if (!connected) return;
    const redirect = setTimeout(() => router.push(dashboardHref), 1400);
    return () => clearTimeout(redirect);
  }, [connected, router, dashboardHref]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* backdrop */}
      <motion.div
        key="add-site-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0, transition: { duration: 0.15 } }}
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />

      {/* card — same entrance language as the dropdowns */}
      <motion.div
        key="add-site-card"
        role="dialog"
        aria-modal="true"
        aria-label="Add a new site"
        initial={{ opacity: 0, scale: 0.94, y: -6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: -4, transition: { duration: 0.12 } }}
        transition={SPRING}
        className="relative w-full max-w-md"
      >
        {/* the shadow lives on this unclipped wrapper — the squircle
            clip-path cannot clip a box shadow, and carrying it on the
            surface leaks grey past the bottom corners */}
        <div className="rounded-[26px] shadow-[0_1px_2px_rgba(0,0,0,0.06),0_24px_60px_rgba(0,0,0,0.18)] sm:rounded-[50px]">
        <SquircleSurface className="flex flex-col rounded-[26px] border border-border bg-[#f6f6f6] p-1 [--card-clip-handle:2.25px] [--card-clip-radius:14px] sm:rounded-[50px] sm:[--card-clip-handle:3px] sm:[--card-clip-radius:20px]">
          {/* header strip — title swaps with the step */}
          <div className="flex h-9 items-center justify-between pl-3.5 pr-3">
            <AnimatePresence mode="popLayout" initial={false} custom={dir}>
              <motion.span
                key={step}
                custom={dir}
                variants={stepVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={SPRING}
                className="text-sm font-medium text-foreground/80"
              >
                {STEP_TITLES[step]}
              </motion.span>
            </AnimatePresence>
            <span className="text-xs tabular-nums text-muted-foreground/70">
              {step} / 3
            </span>
          </div>

          {/* inset panel — fixed height; steps slide inside, the card
              itself never grows or shrinks */}
          {/* inset panel — measured height: the card breathes with each
              step's content while the steps slide horizontally. popLayout
              pops the exiting step out of flow, so the incoming one is what
              the measurement follows. */}
          <SquircleSurface className="relative overflow-hidden rounded-[22px] border border-border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:12px] sm:rounded-[44px] sm:[--card-clip-radius:17px]">
            <motion.div
              animate={{ height: panelHeight ?? "auto" }}
              className="overflow-hidden"
              initial={false}
              transition={SPRING}
            >
            <AnimatePresence mode="popLayout" initial={false} custom={dir}>
              {step === 1 && (
                <motion.div
                  key="step-1"
                  ref={measureStep}
                  custom={dir}
                  variants={stepVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={SPRING}
                  // min-h: the fixed frame this dialog used to hold — the two
                  // inputs alone measure cramped, so the first step keeps its
                  // old stature while the later steps size to their content.
                  className="flex min-h-[196px] flex-col gap-3 p-4"
                >
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">
                      Project name
                    </span>
                    <Input
                      value={name}
                      onChange={(event) => {
                        setName(event.target.value);
                        setError(null);
                      }}
                      placeholder="My project"
                      autoFocus
                    />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">
                      Domain
                    </span>
                    {/* live favicon preview on the left as the domain is typed */}
                    <span className="relative">
                      <span className="pointer-events-none absolute left-2.5 top-1/2 z-10 flex size-4 -translate-y-1/2 items-center justify-center">
                        <Favicon key={domain} domain={domain} className="size-4" />
                      </span>
                      <Input
                        value={domain}
                        onChange={(event) => {
                          setDomain(event.target.value);
                          setError(null);
                        }}
                        placeholder="example.com"
                        className="[&_input]:pl-8!"
                      />
                    </span>
                  </label>
                  {error ? (
                    <p className="text-xs leading-4 text-destructive-foreground">
                      {error}
                    </p>
                  ) : null}
                </motion.div>
              )}
              {step === 2 && (
                <motion.div
                  key="step-2"
                  ref={measureStep}
                  custom={dir}
                  variants={stepVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={SPRING}
                  className="flex flex-col gap-3 p-4"
                >
                  <InstallOptions
                    snippet={snippet}
                    publicToken={publicToken}
                    host={cleanDomain(domain) ?? "your site"}
                  />
                </motion.div>
              )}
              {step === 3 && (
                <motion.div
                  key="step-3"
                  ref={measureStep}
                  custom={dir}
                  variants={stepVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={SPRING}
                  className="flex flex-col items-center justify-center gap-4 p-4 py-8"
                >
                  {/* connection row: site favicon ↔ animated line ↔ our logo */}
                  <div className="relative flex items-center gap-3">
                    <motion.div
                      animate={
                        connected
                          ? { x: MERGE_X, opacity: 0, scale: 0.6 }
                          : { x: 0, opacity: 1, scale: 1 }
                      }
                      transition={SPRING}
                      className="flex size-12 items-center justify-center rounded-2xl border border-border bg-white shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
                    >
                      <Favicon key={domain} domain={domain} className="size-6" />
                    </motion.div>

                    {/* pulses traveling along the wire — the wire fades
                        away with the favicons once connected */}
                    <motion.div
                      animate={{ opacity: connected ? 0 : 1 }}
                      transition={SPRING}
                      className="relative h-px w-16 overflow-hidden bg-border"
                    >
                      {!connected &&
                        [0, 0.4, 0.8].map((delay) => (
                          <motion.span
                            key={delay}
                            initial={{ x: -8, opacity: 0 }}
                            animate={{ x: 72, opacity: [0, 1, 1, 0] }}
                            transition={{
                              duration: 1.1,
                              delay,
                              repeat: Infinity,
                              ease: "linear",
                            }}
                            className="absolute top-1/2 h-[3px] w-2 -translate-y-1/2 rounded-full bg-primary"
                          />
                        ))}
                    </motion.div>

                    <motion.div
                      animate={
                        connected
                          ? { x: -MERGE_X, opacity: 0, scale: 0.6 }
                          : { x: 0, opacity: 1, scale: 1 }
                      }
                      transition={SPRING}
                      className="flex size-12 items-center justify-center rounded-2xl border border-border bg-white shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
                    >
                      <Logo className="size-6 text-primary" />
                    </motion.div>

                    {/* the two merge into a green check */}
                    <AnimatePresence>
                      {connected && (
                        <motion.div
                          key="connected-check"
                          initial={{ scale: 0.4, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          transition={SPRING}
                          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
                        >
                          <CheckmarkCircle02Icon className="size-10 text-success-foreground" />
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>

                  <div className="text-center">
                    <p className="text-sm font-medium text-foreground/80">
                      {connected
                        ? "First event received!"
                        : "Waiting for the first event…"}
                    </p>
                    <p className="mt-1 max-w-64 text-xs leading-5 text-muted-foreground">
                      {connected
                        ? "Taking you to your project."
                        : `Open ${cleanDomain(domain) ?? "your site"} and browse around. We pick up the first pageview within seconds.`}
                    </p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            </motion.div>
          </SquircleSurface>

          {/* footer strip — CTAs live in the frame, like the header */}
          <div className="flex h-12 items-center justify-end gap-2 pb-1 pl-3.5 pr-1 pt-1">
            {step === 1 && (
              <>
                <Button variant="ghost" size="xs" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  size="xs"
                  disabled={!name.trim() || !domain.trim()}
                  loading={busy}
                  onClick={create}
                >
                  Continue
                </Button>
              </>
            )}
            {step === 2 && (
              <>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => router.push(dashboardHref)}
                >
                  I&apos;ll do this later
                </Button>
                <Button size="xs" onClick={() => goTo(3)}>
                  Continue
                </Button>
              </>
            )}
            {step === 3 && (
              <>
                <Button variant="ghost" size="xs" onClick={() => goTo(2)}>
                  Back
                </Button>
                <Button
                  size="xs"
                  loading={!LIVE_API && !connected}
                  onClick={() => router.push(dashboardHref)}
                >
                  {connected || LIVE_API ? "Go to project" : "Waiting…"}
                </Button>
              </>
            )}
          </div>
        </SquircleSurface>
        </div>
      </motion.div>
    </div>
  );
}
