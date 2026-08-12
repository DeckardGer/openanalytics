"use client";

import { CheckmarkCircle02Icon } from "hugeicons-react";
import { AnimatePresence, motion } from "motion/react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { cleanDomain, slugify } from "@/components/dashboard/add-site-dialog";
import { InstallOptions } from "@/components/dashboard/install-options";
import { Favicon } from "@/components/dashboard/site-favicon";
import { Logo } from "@/components/ui/logo";
import { markOnboarded } from "@/components/onboarding/onboarding-gate";
import { BrandLoader } from "@/components/ui/brand-loader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SquircleSurface } from "@/components/ui/squircle-card";
import { TimezoneSelect } from "@/components/ui/timezone-select";
import { onboardingStep } from "@seam/slots";
import {
  errorCodeOf,
  keys,
  LIVE_API,
  preferences,
  presentError,
  sites,
  trackerSnippet,
  type CreatedSite,
} from "@/lib/api";
import { useSession } from "@/lib/auth-client";
import { MOCK_CREATED_SITE } from "@/lib/mock";

/**
 * The mandatory first-run flow, in the order the product wants it
 * (ADR-0040): create the site, set the timezone, install the snippet, verify
 * the first event. Same wiring as the add-site dialog (`POST /v1/sites` under
 * one Idempotency-Key, then the domains PATCH), same step choreography, same
 * footer language.
 *
 * The steps are a *list*, not four numbered branches, because a deployment can
 * add one: the hosted build inserts plan selection before verification
 * (`@seam/slots`), which is why the counter says "x / 4" here and "x / 5" there.
 * Everything else — the springs, the measured panel, the footer — is written
 * once against whatever the list turns out to be.
 *
 * There is deliberately no close and no Escape: the onboarding gate sends
 * people here because they have nowhere else to be yet, and finishing is
 * what opens the dashboard. A never-funded site has no countdown and is
 * never deleted for waiting, so "I'll do this later" is honest, not a trap.
 *
 * The timezone step writes `PATCH /v1/me/preferences` — the same value the
 * session then carries as `user.timezone`, which every analytics read
 * resolves through. The connect step watches `first_event_at` on the site
 * read: the install-verified signal, filled within ~1.5 s of the first event
 * and never moved again.
 */

const SPRING = { type: "spring", stiffness: 550, damping: 40 } as const;

/** Horizontal slide between steps — direction-aware, content-only. */
const stepVariants = {
  enter: (dir: number) => ({ opacity: 0, x: dir * 32 }),
  center: { opacity: 1, x: 0 },
  exit: (dir: number) => ({
    opacity: 0,
    x: dir * -32,
    transition: { duration: 0.12 },
  }),
};

/** How far each end of the connect wire travels to meet in the middle. */
const MERGE_X = 68;

type Step = "site" | "timezone" | "install" | "extra" | "verify";

const STEP_TITLES: Record<Exclude<Step, "extra">, string> = {
  site: "Create your first site",
  timezone: "Set your timezone",
  install: "Install the tracker",
  verify: "Connect your site",
};

/**
 * The order, with the optional step folded in where it belongs. Built once at
 * module scope: which steps exist is a property of the build, not of a render.
 */
const STEPS: readonly Step[] = [
  "site",
  "timezone",
  "install",
  ...(onboardingStep ? (["extra"] as const) : []),
  "verify",
];

const stepTitle = (step: Step): string =>
  step === "extra"
    ? (onboardingStep?.title ?? "")
    : STEP_TITLES[step];

/**
 * Persists the chosen zone as the account preference. Fire-and-forget: a
 * failed write must not block onboarding — the browser zone stands in until
 * the settings screen stores one.
 */
function saveTimezone(timezone: string): void {
  if (!LIVE_API) return;
  void preferences.update(timezone).catch(() => {
    // Settings owns retrying; analytics reads fall back to the browser zone.
  });
}

export function OnboardingFlow() {
  const router = useRouter();
  const { data: session } = useSession();
  const [step, setStep] = React.useState<Step>("site");
  const [dir, setDir] = React.useState(1);
  const [name, setName] = React.useState("");
  const [domain, setDomain] = React.useState("");
  const [connected, setConnected] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [created, setCreated] = React.useState<CreatedSite | null>(null);
  /** One key per attempt, reused by retries of that same attempt. */
  const idempotencyKey = React.useRef(crypto.randomUUID());

  // The steps are different heights, so the panel animates between them
  // instead of holding one fixed frame — the login card's measured-height
  // spring. Border box, not `contentRect`: the step carries padding, and the
  // content box alone would clip the last control away.
  const [panelHeight, setPanelHeight] = React.useState<number | null>(null);
  const measureStep = React.useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const observer = new ResizeObserver(() => {
      setPanelHeight(node.getBoundingClientRect().height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Timezone step state. The browser's zone is the default — most people
  // only ever press Continue here.
  const [timezone, setTimezone] = React.useState<string>(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC"
  );

  /** The verify step: whether the site is accepting events yet. */
  const [siteActive, setSiteActive] = React.useState(!LIVE_API);

  /**
   * Whether the account has been asked what it already has.
   *
   * Every field above is memory, and this screen used to have nothing else:
   * a refresh anywhere in the flow reopened it at *Create your first site*
   * with the site already created on the server, inviting a duplicate. The
   * step someone is on is not a fact about the browser, it is a fact about
   * the account — so it is read back rather than remembered. That also
   * survives a different browser, which any stored step would not.
   */
  const [resuming, setResuming] = React.useState(LIVE_API);

  React.useEffect(() => {
    if (!LIVE_API) return;
    let cancelled = false;
    void (async () => {
      try {
        const { items } = await sites.list();
        const site = items[0];
        if (site === undefined) return;
        // The snippet needs the write-only tracking key, which the create
        // response carries and nothing else remembers. It is readable back
        // from the site's key list, since a `tracking_write` key is public
        // by design and keeps showing its token.
        const { items: minted } = await keys.list(site.site_id);
        const trackingKey = minted.find(
          (key) => key.type === "tracking_write" && key.public_token !== null
        );
        if (cancelled || trackingKey?.public_token == null) return;
        setName(site.name);
        setDomain(site.domains[0] ?? "");
        setCreated({
          site_id: site.site_id,
          slug: site.slug,
          name: site.name,
          status: site.status,
          role: site.role,
          is_billing_owner: site.is_billing_owner,
          created_at: site.created_at,
          tracking_key: {
            id: trackingKey.id,
            public_token: trackingKey.public_token,
            key_prefix: trackingKey.key_prefix,
          },
        });
        setSiteActive(site.status === "active");
        // `first_event_at` is the same signal the verify step polls, so an
        // account that already got its first event lands on the finished
        // state and is sent to its dashboard, not asked to install again.
        if (site.first_event_at !== null) setConnected(true);
        setStep(site.first_event_at !== null ? "verify" : "install");
      } catch {
        // A failed read is not a reason to block the front door: the flow
        // opens where it always did, and creating again is idempotent per
        // attempt anyway.
      } finally {
        if (!cancelled) setResuming(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const goTo = (next: Step) => {
    setDir(STEPS.indexOf(next) > STEPS.indexOf(step) ? 1 : -1);
    if (next === "verify") setConnected(false);
    setStep(next);
  };

  /** The step after the snippet — the optional one where it exists. */
  const afterInstall: Step = onboardingStep ? "extra" : "verify";

  const slug = created?.slug ?? slugify(name) ?? "site";
  const publicToken =
    created?.tracking_key.public_token ??
    MOCK_CREATED_SITE.tracking_key.public_token;
  const snippet = trackerSnippet(publicToken);

  const create = () => {
    const trimmedName = name.trim();
    const siteSlug = slugify(trimmedName);
    if (siteSlug.length < 2) {
      setError("Give the site a longer name; the slug needs 2+ characters.");
      return;
    }
    const bareDomain = cleanDomain(domain);
    if (!bareDomain) {
      setError("Enter a bare domain like example.com (no https:// or path).");
      return;
    }
    setError(null);

    if (!LIVE_API) {
      setCreated({ ...MOCK_CREATED_SITE, slug: siteSlug, name: trimmedName });
      goTo("timezone");
      return;
    }

    setBusy(true);
    sites
      .create({ slug: siteSlug, name: trimmedName }, idempotencyKey.current)
      .then(async (site) => {
        // The allowlist is a follow-up PATCH by design; a rejected domain
        // must not strand the created site.
        try {
          await sites.update(site.site_id, { domains: [bareDomain] });
        } catch {
          /* the settings screen owns fixing the allowlist */
        }
        setBusy(false);
        setCreated(site);
        goTo("timezone");
      })
      .catch((raised: unknown) => {
        setBusy(false);
        const code = errorCodeOf(raised);
        if (code === "VALIDATION_FAILED") {
          setError(
            "That name gives a slug that is taken or invalid. Try another."
          );
        } else if (code === "SUBSCRIPTION_REQUIRED") {
          // ADR-0040: the first site creates without a plan, so this code
          // only fires on a *second* unfunded site. The recovery is funding
          // the one they have, not creating a different one.
          setError(
            "You already have a site waiting for its plan. Finish setting that one up, or delete it first."
          );
        } else if (code === "SITE_CAPACITY_EXCEEDED") {
          setError("Your plan is at its site limit. Upgrade, or remove a site.");
        } else {
          setError(presentError(raised).body);
        }
      });
  };

  const finish = React.useCallback(() => {
    const userId = session?.user?.id;
    if (userId) markOnboarded(userId);
    router.replace(`/dashboard/${encodeURIComponent(slug)}`);
  }, [session, router, slug]);

  // The verify step in mock mode plays the first event arriving on a timer.
  React.useEffect(() => {
    if (step !== "verify" || LIVE_API) return;
    const firstEvent = setTimeout(() => setConnected(true), 4000);
    return () => clearTimeout(firstEvent);
  }, [step]);

  // Live mode watches the truth instead: `first_event_at` on the site read
  // (ADR-0027) — never an analytics query, whose empty answer cannot tell an
  // uninstalled tracker from a quiet minute. It fills within about one batch
  // flush of the first event and never moves once set. The same read carries
  // `status`, which a deployment may hold at `suspended` (on the hosted
  // build, until the subscription webhook lands) — while it does, events are
  // being refused, so the copy says the site is not open yet rather than
  // blaming the install.
  React.useEffect(() => {
    if (step !== "verify" || !LIVE_API || created === null || connected) return;
    let cancelled = false;
    const probe = async () => {
      try {
        const site = await sites.get(created.site_id);
        if (cancelled) return;
        setSiteActive(site.status === "active");
        if (site.first_event_at !== null) setConnected(true);
      } catch {
        // The next tick retries; the person can leave via Back meanwhile.
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
    const redirect = setTimeout(() => finish(), 1400);
    return () => clearTimeout(redirect);
  }, [connected, finish]);

  // Below every hook, so the early return cannot change the hook order.
  // Holding the first paint rather than opening on step one and jumping:
  // the flash *is* the bug being fixed, and half a second of a loader reads
  // as the app checking, which is exactly what it is doing.
  if (resuming) {
    return (
      <div className="flex min-h-[26rem] w-full items-center justify-center">
        <BrandLoader label="Picking up where you left off…" />
      </div>
    );
  }

  return (
    <div className="w-full">
      <div className="rounded-[26px] shadow-[0_1px_2px_rgba(0,0,0,0.06),0_24px_60px_rgba(0,0,0,0.10)] sm:rounded-[50px]">
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
                {stepTitle(step)}
              </motion.span>
            </AnimatePresence>
            <span className="text-xs tabular-nums text-muted-foreground/70">
              {STEPS.indexOf(step) + 1} / {STEPS.length}
            </span>
          </div>

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
              {step === "site" && (
                <motion.div
                  key="step-site"
                  ref={measureStep}
                  custom={dir}
                  variants={stepVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={SPRING}
                  // min-height matches the add-site dialog's step frame, so
                  // the first step reads identically there and here — the
                  // measured spring only takes over when a step outgrows it.
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
                    <span className="relative">
                      <span className="pointer-events-none absolute left-2.5 top-1/2 z-10 flex size-4 -translate-y-1/2 items-center justify-center">
                        <Favicon
                          key={domain}
                          domain={domain}
                          className="size-4"
                        />
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
              {step === "timezone" && (
                <motion.div
                  key="step-timezone"
                  ref={measureStep}
                  custom={dir}
                  variants={stepVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={SPRING}
                  className="flex flex-col gap-2.5 p-4"
                >
                  <p className="text-xs leading-5 text-muted-foreground">
                    Your reports cut their days on this timezone. We picked
                    your browser&apos;s.
                  </p>
                  {/* The shared picker's field dress: collapsed it is one
                      input-height row, and the list it expands sits in the
                      flow, so the card's measured-height spring grows with
                      it instead of clipping it. */}
                  <TimezoneSelect
                    ariaLabel="Your timezone"
                    onPick={(zone) => {
                      if (zone !== null) setTimezone(zone);
                    }}
                    value={timezone}
                    variant="field"
                  />
                </motion.div>
              )}
              {step === "install" && (
                <motion.div
                  key="step-install"
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
              {step === "extra" && onboardingStep && (
                <motion.div
                  key="step-extra"
                  ref={measureStep}
                  custom={dir}
                  variants={stepVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={SPRING}
                  className="flex flex-col gap-2.5 p-4"
                >
                  <onboardingStep.Body onDone={() => goTo("verify")} />
                </motion.div>
              )}
              {step === "verify" && (
                <motion.div
                  key="step-verify"
                  ref={measureStep}
                  custom={dir}
                  variants={stepVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={SPRING}
                  className="flex flex-col items-center justify-center gap-4 p-4 py-8"
                >
                  {/* connection row: site favicon ↔ animated wire ↔ our logo */}
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

                    {/* pulses traveling along the wire — the wire fades away
                        with the favicons once connected */}
                    <motion.div
                      animate={{ opacity: connected ? 0 : 1 }}
                      transition={SPRING}
                      className="relative h-px w-16 overflow-hidden bg-border"
                    >
                      {[0, 0.35, 0.7].map((delay) => (
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
                        : !siteActive
                          ? // The site is not open for events yet — no
                            // snippet is wrong yet, and the copy must not say
                            // it is. On the hosted build this is the window
                            // between checkout returning and the webhook
                            // landing; it usually lasts seconds.
                            "This site isn't open for events yet (a few seconds, usually). We start counting the moment it is."
                          : `Open ${cleanDomain(domain) ?? (domain || "your site")} and browse around. We'll pick up the first pageview within seconds.`}
                    </p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            </motion.div>
          </SquircleSurface>

          {/* footer strip — CTAs live in the frame, like the header */}
          <div className="flex h-12 items-center justify-end gap-2 pb-1 pl-3.5 pr-1 pt-1">
            {step === "site" && (
              <Button
                size="xs"
                disabled={!name.trim() || !domain.trim()}
                loading={busy}
                onClick={create}
              >
                Continue
              </Button>
            )}
            {step === "timezone" && (
              <Button
                size="xs"
                onClick={() => {
                  saveTimezone(timezone);
                  goTo("install");
                }}
              >
                Continue
              </Button>
            )}
            {step === "install" && (
              <Button size="xs" onClick={() => goTo(afterInstall)}>
                Continue
              </Button>
            )}
            {step === "extra" && onboardingStep && (
              <>
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={() => goTo("install")}
                >
                  Back
                </Button>
                <onboardingStep.Footer onSkip={finish} />
              </>
            )}
            {step === "verify" && (
              <>
                {/* Back goes to the snippet, never to the optional step: that
                    one advances itself, so landing on it already satisfied
                    would bounce straight back here. */}
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={() => goTo("install")}
                >
                  Back
                </Button>
                <Button size="xs" loading={!connected} onClick={finish}>
                  {connected ? "Go to project" : "Waiting…"}
                </Button>
              </>
            )}
          </div>
        </SquircleSurface>
      </div>
    </div>
  );
}
