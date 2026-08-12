"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { GithubIcon, GoogleIcon } from "@/components/icons/hugeicons";
import { Logo } from "@/components/ui/logo";
import { BrandLoader } from "@/components/ui/brand-loader";
import { Button } from "@/components/ui/button";
import { SquircleSurface } from "@/components/ui/squircle-card";
import {
  auth,
  errorCodeOf,
  LIVE_API,
  presentError,
  type AuthProvider,
} from "@/lib/api";
import {
  authClient,
  authErrorFromThrown,
  presentAuthError,
  presentOAuthError,
  useSession,
} from "@/lib/auth-client";
import { hasSessionHint } from "@/lib/session-hint";

/**
 * The single door into the product. There is no separate sign-up: every route
 * here both signs an existing account in and creates one on first use — the
 * providers on their first callback, the magic link on its first click — so
 * the copy says "Continue with…" rather than promising one or the other.
 *
 * This is the original two-step card (pre-a4af585): the email panel hands off
 * to a "link sent" panel with a measured-height spring, and no password field
 * exists anywhere on it. The api half of the email path is
 * `/sign-in/magic-link`, served by the Better Auth `magicLink` plugin in
 * `packages/auth`. The copy promises a 15-minute expiry — the server pins that
 * with `MAGIC_LINK_EXPIRES_IN_SECONDS = 900`, and the two must move together.
 *
 * Two error vocabularies meet here and must not be conflated. A JSON call
 * fails with Better Auth's `{ code, message }` → `presentAuthError`. A
 * provider sign-in — and a dead or expired magic link — fails by *redirecting
 * back* with `?error=<code>` → `presentOAuthError`, read server-side by the
 * page. Neither is the `/v1` `ErrorEnvelope`.
 */

const SPRING = { type: "spring", stiffness: 550, damping: 38 } as const;

/**
 * The session hint, read through `useSyncExternalStore` rather than an effect.
 * The store never emits — a browser's stored hint does not change under a
 * mounted login form — so `subscribe` is a no-op and the two snapshots carry
 * the whole answer.
 */
const NEVER_CHANGES = () => () => {};
const clientHasSessionHint = () => hasSessionHint();
const serverHasSessionHint = () => false;

const panelVariants = {
  enter: { opacity: 0, y: 10 },
  center: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8, transition: { duration: 0.14 } },
};

/** Mirrors the api's own floor for the first account, so the two cannot disagree. */
const MIN_PASSWORD_LENGTH = 12;

/**
 * One text field, worn by four inputs now that the card has a password path.
 * Hoisted the moment the second one appeared, so the focus ring and the
 * invalid state cannot drift between the door somebody creates an account with
 * and the door they come back through.
 */
const FIELD_CLASS =
  "h-10 w-full rounded-xl border border-input bg-white px-3 text-sm outline-none transition-[box-shadow,border-color] placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:[outline:2px_solid_var(--ring)] focus-visible:[outline-offset:-2px] aria-invalid:border-destructive";

/** Good enough to catch a typo before we bother the api. */
const looksLikeEmail = (value: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

type Phase = "idle" | "sending" | "sent";
type Provider = "google" | "github";

/** Every path the deployment could offer — the fallback when the provider
 *  read itself fails: a login page with no doors is worse than one with a
 *  button that fails at the callback. */
const ALL_PROVIDER_IDS: AuthProvider["id"][] = [
  "google",
  "github",
  "magic_link",
];

export function LoginForm({
  oauthError,
  oauthErrorDescription,
  verified,
}: {
  /** `?error=` exactly as a failed callback left it; the page reads it. */
  oauthError: string | null;
  oauthErrorDescription: string | null;
  /** A verification link from the password era lands back here with `?verified=1`. */
  verified: boolean;
}) {
  const router = useRouter();

  // Somebody already signed in has no business on a login form: the landing's
  // "Sign in" cannot know the session (the cookie lives on the api origin and
  // only the app origin may ask), so *this* page is where a signed-in visitor
  // is recognised and bounced. Only a confirmed session moves anyone. Mock
  // mode is exempt — there is no session to read and the card itself is what a
  // reviewer wants.
  const { data: session, isPending } = useSession();
  React.useEffect(() => {
    if (!LIVE_API) return;
    if (session !== null && session !== undefined) router.replace("/dashboard");
  }, [session, router]);

  /**
   * Whether this browser remembers a session, read on the first client render
   * rather than in an effect.
   *
   * The pre-paint script in the root layout covers a page load, which is how
   * most people reach this route. It cannot cover a *client-side* navigation
   * — the landing's "Get Started" is a `<Link>`, and no script the browser
   * did not parse will ever run — so for that path the card would appear and
   * then vanish, which is the flash this whole mechanism exists to remove.
   *
   * `useSyncExternalStore` is what reads it without a hydration mismatch: the
   * server snapshot is `false`, which is also what a page load renders before
   * the script has had a chance to leave, and the client snapshot is the real
   * answer. Same reasoning as the logo menu's host-aware link.
   *
   * Deliberately not consulted when a callback failed: that visitor is here to
   * read an error, not to be forwarded past it.
   */
  const maybeSignedIn = React.useSyncExternalStore(
    NEVER_CHANGES,
    clientHasSessionHint,
    serverHasSessionHint
  );
  /**
   * Acted on far below, after every other hook has run: an early return here
   * would call fewer hooks on the standing-by render than on the next one.
   *
   * `isPending` rather than `session !== null` is the load-bearing part.
   * Better Auth answers `null` for *both* "still asking" and "signed out", so
   * a null check stands by for nobody: the form would render on the first
   * pass, which is the flash this exists to remove. Standing by lasts exactly
   * as long as the question is open, and a hint that turns out to be stale
   * gives the form back the moment the api says there is no session.
   */
  const standingBy =
    LIVE_API &&
    maybeSignedIn &&
    oauthError === null &&
    (isPending || session !== null);

  const [email, setEmail] = React.useState("");
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [resent, setResent] = React.useState(false);
  /**
   * Shared by the two password paths — creating the first account, and signing
   * in with one. They never appear together, so one field serves both.
   */
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  /**
   * The provider path's failure, kept apart so it renders under the buttons
   * that caused it rather than beneath the email form.
   *
   * Seeded from the redirect, so it is on screen in the first paint — no
   * effect, no cascading render, no hydration gap.
   */
  const [providerError, setProviderError] = React.useState<string | null>(() =>
    oauthError === null
      ? null
      : presentOAuthError(oauthError, oauthErrorDescription)
  );
  /**
   * Which provider button is mid-redirect. Held per provider so only the one
   * pressed spins, and it keeps spinning: on success the client navigates away,
   * so there is no "finished" state to render.
   */
  const [redirectingTo, setRedirectingTo] = React.useState<Provider | null>(
    null
  );

  /**
   * Which sign-in paths this deployment actually offers —
   * `GET /v1/auth/providers` (public, no cookie). A provider appears only
   * when the api holds both halves of its credential; a hard-coded button
   * for an unconfigured one could only fail at the callback. `null` while
   * the answer is in flight.
   */
  const [available, setAvailable] = React.useState<
    AuthProvider["id"][] | null
  >(null);
  /**
   * Whether this deployment has nobody in it yet.
   *
   * The same read answers it, because it is the same question asked one level
   * earlier: not "which door" but "is there anyone behind any of them". True
   * only on an install that has never been signed into, and it stops being
   * true the moment the first account exists.
   *
   * Degrades to `false` on a failed read, like the provider list degrades to
   * the full set: the honest failure here is showing a sign-in form to someone
   * who cannot use it yet, not offering to create an account on a deployment
   * that already has one.
   */
  const [setupRequired, setSetupRequired] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    if (!LIVE_API) {
      void Promise.resolve().then(() => {
        if (!cancelled) setAvailable(ALL_PROVIDER_IDS);
      });
      return () => {
        cancelled = true;
      };
    }
    auth
      .providers()
      .then((page) => {
        if (cancelled) return;
        setAvailable(page.items.map((item) => item.id));
        setSetupRequired(page.setup_required);
      })
      .catch(() => {
        // The config read failing must not brick the door — degrade to the
        // full set and let a truly unconfigured provider fail loudly later.
        if (!cancelled) setAvailable(ALL_PROVIDER_IDS);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const offers = (id: AuthProvider["id"]) =>
    available !== null && available.includes(id);

  /**
   * Strip the error out of the address bar once it has been rendered, so a
   * refresh does not resurrect a failure the person has already read. The
   * message stays — it lives in state now, not in the URL.
   */
  React.useEffect(() => {
    if (oauthError === null) return;

    const params = new URLSearchParams(window.location.search);
    params.delete("error");
    params.delete("error_description");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      query.length > 0 ? `?${query}` : window.location.pathname
    );
  }, [oauthError]);

  // The two states are different heights, so the panel animates between them
  // instead of snapping. Measuring the mounted step keeps the card honest —
  // a fixed height would strand empty space under the shorter one.
  const [panelHeight, setPanelHeight] = React.useState<number | null>(null);
  const measureStep = React.useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    // Border box, not `contentRect` — the step carries 24px of padding, and
    // measuring the content box alone would clip the last control away.
    const observer = new ResizeObserver(() => {
      setPanelHeight(node.getBoundingClientRect().height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const working = phase === "sending" || redirectingTo !== null;

  const originURL = (path: string) =>
    typeof window === "undefined" ? path : `${window.location.origin}${path}`;

  /**
   * Hands off to the provider. The client's redirect plugin navigates as soon
   * as the api answers with an authorization URL, so the success path has no
   * code after this call — only the failure paths do.
   *
   * `errorCallbackURL` is not optional in practice: without it a failed
   * callback lands on `${api}/api/auth/error`, a page this app does not serve.
   */
  const social = async (provider: Provider) => {
    if (working) return;

    setProviderError(null);
    if (!LIVE_API) {
      router.push("/dashboard");
      return;
    }

    setRedirectingTo(provider);
    try {
      const { error: failed } = await authClient.signIn.social({
        provider,
        callbackURL: originURL("/dashboard"),
        errorCallbackURL: originURL("/login"),
      });
      if (failed) {
        setProviderError(presentAuthError(failed).message);
        setRedirectingTo(null);
      }
    } catch (thrown) {
      setProviderError(authErrorFromThrown(thrown).message);
      setRedirectingTo(null);
    }
  };

  /**
   * Asks the api to email a sign-in link. The session is set when the link is
   * *clicked*, not here — success only means the email left. A dead link
   * redirects back to `/login?error=…`, which the page already presents.
   */
  const requestLink = async (): Promise<boolean> => {
    if (!LIVE_API) {
      // Mock: a beat of latency, then the outcome the api would produce.
      await new Promise((resolve) => window.setTimeout(resolve, 900));
      return true;
    }

    try {
      const { error: failed } = await authClient.signIn.magicLink({
        email: email.trim(),
        callbackURL: originURL("/dashboard"),
        errorCallbackURL: originURL("/login"),
      });
      if (failed) {
        setError(presentAuthError(failed).message);
        return false;
      }
      return true;
    } catch (thrown) {
      setError(authErrorFromThrown(thrown).message);
      return false;
    }
  };

  const sendLink = async (event: React.FormEvent) => {
    event.preventDefault();
    if (working) return;

    if (!looksLikeEmail(email.trim())) {
      setError("Enter an email address we can reach you at.");
      return;
    }
    setError(null);
    setPhase("sending");
    setPhase((await requestLink()) ? "sent" : "idle");
  };

  const resend = () => {
    setResent(true);
    // Fire and forget, like the first send's happy path: the panel already
    // says the link is out, and a failed resend has the first link to fall
    // back on.
    void requestLink();
  };

  /**
   * Claims a deployment that nobody has signed into yet.
   *
   * The api sets the session cookie on its own response, so a success needs no
   * second sign-in call — the onboarding gate takes it from here and sends the
   * new owner to create their first site.
   */
  const claimDeployment = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;

    if (!looksLikeEmail(email.trim())) {
      setError("Enter an email address we can reach you at.");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    setError(null);
    setBusy(true);

    if (!LIVE_API) {
      router.push("/dashboard");
      return;
    }

    try {
      await auth.setup({ email: email.trim(), password });
      // A full navigation, not `router.push`: the session arrived as a cookie
      // on a response this client did not route through, and the dashboard's
      // gate has to read it fresh.
      window.location.assign("/dashboard");
    } catch (thrown) {
      setBusy(false);
      setError(
        errorCodeOf(thrown) === "SETUP_COMPLETE"
          ? "Someone has already claimed this deployment. Sign in instead."
          : presentError(thrown).body
      );
      // Re-ask: if it is claimed, the card should stop offering to claim it.
      auth
        .providers()
        .then((page) => setSetupRequired(page.setup_required))
        .catch(() => {});
    }
  };

  /**
   * Signs in with a password, where the deployment offers one. Self-hosted
   * installs turn this on by default; the hosted one never does.
   */
  const signInWithPassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || working) return;

    if (!looksLikeEmail(email.trim())) {
      setError("Enter an email address we can reach you at.");
      return;
    }
    setError(null);
    setBusy(true);

    if (!LIVE_API) {
      router.push("/dashboard");
      return;
    }

    try {
      const { error: failed } = await authClient.signIn.email({
        email: email.trim(),
        password,
      });
      if (failed) {
        setBusy(false);
        setError(presentAuthError(failed).message);
        return;
      }
      window.location.assign("/dashboard");
    } catch (thrown) {
      setBusy(false);
      setError(authErrorFromThrown(thrown).message);
    }
  };

  if (standingBy) {
    // The courtesy `SessionGate` extends in the other direction: name where
    // the person is going, rather than showing them a door they are about to
    // be carried past. The box keeps the card's height so the shader behind
    // it does not jump when the redirect lands.
    return (
      <div className="flex min-h-[26rem] w-full max-w-sm items-center justify-center">
        <BrandLoader label="Taking you to your dashboard…" />
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm">
      {/* the shadow lives on this unclipped wrapper — the squircle clip-path
          would slice a drop shadow into a hard grey band along the bottom */}
      <div className="rounded-[26px] shadow-[0_1px_2px_rgba(0,0,0,0.06),0_24px_60px_rgba(0,0,0,0.10)] sm:rounded-[50px]">
        <SquircleSurface className="flex flex-col rounded-[26px] border border-border bg-[#f6f6f6] p-1 [--card-clip-handle:2.25px] [--card-clip-radius:14px] sm:rounded-[50px] sm:[--card-clip-handle:3px] sm:[--card-clip-radius:20px]">
          {/* frame strip — the brand mark sits in the gutter, like our cards */}
          <div className="flex h-9 items-center gap-2 pl-3.5 pr-3">
            <Logo className="size-4 text-primary" />
            <span className="text-sm font-medium text-foreground/80">
              Open Analytics
            </span>
          </div>

          <SquircleSurface className="relative overflow-hidden rounded-[22px] border border-border bg-card [--card-clip-radius:12px] sm:rounded-[44px] sm:[--card-clip-radius:17px]">
            <motion.div
              animate={{ height: panelHeight ?? "auto" }}
              className="overflow-hidden"
              initial={false}
              transition={SPRING}
            >
              <AnimatePresence initial={false} mode="wait">
                {phase === "sent" ? (
                  <motion.div
                    animate="center"
                    className="flex flex-col gap-4 p-6"
                    exit="exit"
                    initial="enter"
                    key="sent"
                    ref={measureStep}
                    transition={SPRING}
                    variants={panelVariants}
                  >
                    <MailAnimation />
                    <div>
                      <h1 className="text-base font-medium tracking-tight">
                        Check your email
                      </h1>
                      <p className="mt-1 text-sm leading-6 text-muted-foreground">
                        We sent a sign-in link to{" "}
                        <span className="font-medium text-foreground">
                          {email.trim()}
                        </span>
                        . It expires in 15 minutes.
                      </p>
                    </div>
                    <div className="flex flex-col gap-2">
                      <Button
                        disabled={resent}
                        onClick={resend}
                        size="sm"
                        variant="secondary"
                      >
                        {resent ? "Link sent again" : "Resend link"}
                      </Button>
                      <Button
                        onClick={() => {
                          setPhase("idle");
                          setResent(false);
                        }}
                        size="sm"
                        variant="ghost"
                      >
                        Use a different email
                      </Button>
                    </div>
                  </motion.div>
                ) : (
                  <motion.div
                    animate="center"
                    className="flex flex-col gap-4 p-6"
                    exit="exit"
                    initial="enter"
                    key="idle"
                    ref={measureStep}
                    transition={SPRING}
                    variants={panelVariants}
                  >
                    <div>
                      <h1 className="text-base font-medium tracking-tight">
                        {setupRequired
                          ? "Create the first account"
                          : "Welcome back!"}
                      </h1>
                      <p className="mt-1 text-sm leading-6 text-muted-foreground">
                        {setupRequired
                          ? "Nobody has signed into this deployment yet. Whoever claims it first owns it, so do this now."
                          : "Sign in with your account or continue with a provider."}
                      </p>
                    </div>

                    {verified ? (
                      <p className="rounded-xl bg-success/10 px-3 py-2 text-xs leading-5 text-success-foreground">
                        Email verified. Sign in to continue.
                      </p>
                    ) : null}

                    {available === null ? (
                      // the provider read is in flight — hold the space with
                      // quiet skeletons so the card doesn't jump when the
                      // real buttons land
                      <div aria-hidden="true" className="flex flex-col gap-2">
                        <span className="h-10 animate-pulse rounded-xl bg-muted-foreground/10" />
                        <span className="h-10 animate-pulse rounded-xl bg-muted-foreground/10" />
                        <span className="h-10 animate-pulse rounded-xl bg-muted-foreground/10" />
                      </div>
                    ) : setupRequired ? (
                      /* One face, and no doors beside it. Every provider
                         button on this deployment leads to an account that
                         does not exist yet, and offering them here would be
                         offering to fail. */
                      <form
                        className="flex flex-col gap-2"
                        onSubmit={(event) => void claimDeployment(event)}
                      >
                        <input
                          aria-invalid={error !== null}
                          aria-label="Email address"
                          autoComplete="email"
                          className={FIELD_CLASS}
                          disabled={busy}
                          onChange={(event) => {
                            setEmail(event.target.value);
                            setError(null);
                          }}
                          placeholder="you@company.com"
                          type="email"
                          value={email}
                        />
                        <input
                          aria-invalid={error !== null}
                          aria-label="Password"
                          autoComplete="new-password"
                          className={FIELD_CLASS}
                          disabled={busy}
                          minLength={MIN_PASSWORD_LENGTH}
                          onChange={(event) => {
                            setPassword(event.target.value);
                            setError(null);
                          }}
                          placeholder={`Password, ${MIN_PASSWORD_LENGTH}+ characters`}
                          type="password"
                          value={password}
                        />
                        <Button className="w-full" loading={busy} type="submit">
                          {busy ? "Creating account" : "Create account"}
                        </Button>
                        <p className="text-xs leading-5 text-muted-foreground">
                          You can add Google, GitHub or a magic link afterwards,
                          from Settings.
                        </p>
                        {error ? (
                          <p
                            className="text-xs text-destructive-foreground"
                            role="alert"
                          >
                            {error}
                          </p>
                        ) : null}
                      </form>
                    ) : (
                      <>
                        {offers("google") || offers("github") ? (
                          <div className="flex flex-col gap-2">
                            {offers("google") ? (
                              <Button
                                className="w-full"
                                disabled={working}
                                loading={redirectingTo === "google"}
                                onClick={() => void social("google")}
                                variant="secondary"
                              >
                                <GoogleIcon className="size-4" />
                                Continue with Google
                              </Button>
                            ) : null}
                            {offers("github") ? (
                              <Button
                                className="w-full"
                                disabled={working}
                                loading={redirectingTo === "github"}
                                onClick={() => void social("github")}
                                variant="secondary"
                              >
                                <GithubIcon className="size-4" />
                                Continue with GitHub
                              </Button>
                            ) : null}

                            {providerError ? (
                              <p
                                className="text-xs leading-5 text-destructive-foreground"
                                role="alert"
                              >
                                {providerError}
                              </p>
                            ) : null}
                          </div>
                        ) : null}

                        {(offers("google") || offers("github")) &&
                        offers("magic_link") ? (
                          <div className="flex items-center gap-3">
                            <span className="h-px flex-1 bg-border" />
                            <span className="text-xs text-muted-foreground">
                              or
                            </span>
                            <span className="h-px flex-1 bg-border" />
                          </div>
                        ) : null}

                        {offers("magic_link") ? (
                          <form
                            className="flex flex-col gap-2"
                            onSubmit={(event) => void sendLink(event)}
                          >
                            <input
                              aria-invalid={error !== null}
                              aria-label="Email address"
                              autoComplete="email"
                              className={FIELD_CLASS}
                              disabled={working}
                              onChange={(event) => {
                                setEmail(event.target.value);
                                setError(null);
                              }}
                              placeholder="you@company.com"
                              type="email"
                              value={email}
                            />
                            <Button
                              className="w-full"
                              loading={phase === "sending"}
                              type="submit"
                            >
                              {phase === "sending"
                                ? "Sending link"
                                : "Email me a link"}
                            </Button>
                          </form>
                        ) : null}

                        {/* The password door, where the deployment offers one.
                            Last, and quietly: it is the fallback for an install
                            with no mail and no OAuth app, not the way anybody
                            should be encouraged to sign in. The address field
                            above is reused, so this adds one input rather than
                            a second form asking for the same thing. */}
                        {offers("password") ? (
                          <form
                            className="flex flex-col gap-2"
                            onSubmit={(event) => void signInWithPassword(event)}
                          >
                            {offers("magic_link") ? null : (
                              <input
                                aria-invalid={error !== null}
                                aria-label="Email address"
                                autoComplete="email"
                                className={FIELD_CLASS}
                                disabled={busy}
                                onChange={(event) => {
                                  setEmail(event.target.value);
                                  setError(null);
                                }}
                                placeholder="you@company.com"
                                type="email"
                                value={email}
                              />
                            )}
                            <input
                              aria-invalid={error !== null}
                              aria-label="Password"
                              autoComplete="current-password"
                              className={FIELD_CLASS}
                              disabled={busy}
                              onChange={(event) => {
                                setPassword(event.target.value);
                                setError(null);
                              }}
                              placeholder="Password"
                              type="password"
                              value={password}
                            />
                            <Button
                              className="w-full"
                              loading={busy}
                              type="submit"
                              variant="secondary"
                            >
                              {busy ? "Signing in" : "Sign in with password"}
                            </Button>
                          </form>
                        ) : null}

                        {error ? (
                          <p
                            className="text-xs text-destructive-foreground"
                            role="alert"
                          >
                            {error}
                          </p>
                        ) : null}
                      </>
                    )}

                    {/* the consent sits with the action it applies to */}
                    <p className="text-center text-xs leading-5 text-muted-foreground">
                      By continuing you agree to our{" "}
                      <Link
                        className="underline underline-offset-2 hover:text-foreground"
                        href="/terms"
                      >
                        Terms
                      </Link>{" "}
                      and{" "}
                      <Link
                        className="underline underline-offset-2 hover:text-foreground"
                        href="/privacy"
                      >
                        Privacy Policy
                      </Link>
                      .
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          </SquircleSurface>
        </SquircleSurface>
      </div>
    </div>
  );
}

/** A small envelope that seals itself — one beat of delight on the sent state. */
function MailAnimation() {
  return (
    <motion.span
      animate={{ scale: 1, opacity: 1 }}
      className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary"
      initial={{ scale: 0.8, opacity: 0 }}
      transition={{ type: "spring", stiffness: 400, damping: 22 }}
    >
      <svg
        aria-hidden="true"
        className="size-5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.8}
        viewBox="0 0 24 24"
      >
        <rect height="14" rx="2" width="18" x="3" y="5" />
        <motion.path
          animate={{ pathLength: 1 }}
          d="m3.5 7 8.5 6 8.5-6"
          initial={{ pathLength: 0 }}
          transition={{ duration: 0.5, ease: [0.32, 0.72, 0, 1], delay: 0.15 }}
        />
      </svg>
    </motion.span>
  );
}
