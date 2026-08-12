"use client";

import { Logout01Icon } from "hugeicons-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { LIVE_API } from "@/lib/api";
import {
  authErrorFromThrown,
  presentAuthError,
  signOut as endSession,
} from "@/lib/auth-client";

/**
 * The way out of the front-door screens (2026-08-10, a live report):
 * onboarding is mandatory and had no exit, so somebody signed into the
 * wrong account was simply stuck. A quiet pill in the top-right corner,
 * outside the card, is the exit: it ends the session and lands on /login.
 *
 * Same sign-out mechanics as the dashboard header; the one difference is
 * that failure prints beside the button, because there is no menu here to
 * carry the message.
 */
export function SignOutCorner() {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const signOut = React.useCallback(async () => {
    if (busy) return;
    if (!LIVE_API) {
      router.replace("/login");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // The wrapper, not `authClient.signOut`: it drops the session hint
      // before the api call, so the /login we land on stays put.
      const { error: raised } = await endSession();
      if (raised) {
        setError(presentAuthError(raised).message);
        setBusy(false);
        return;
      }
      router.replace("/login");
    } catch (thrown) {
      setError(authErrorFromThrown(thrown).message);
      setBusy(false);
    }
  }, [busy, router]);

  return (
    <div className="absolute right-4 top-4 z-10 flex items-center gap-3 sm:right-6 sm:top-6">
      {error ? (
        <span className="max-w-56 text-right text-xs leading-4 text-destructive-foreground">
          {error}
        </span>
      ) : null}
      <button
        className="flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card px-3 text-sm text-muted-foreground shadow-xs outline-none transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60"
        disabled={busy}
        onClick={() => void signOut()}
        type="button"
      >
        <Logout01Icon aria-hidden="true" className="size-4" />
        {busy ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}
