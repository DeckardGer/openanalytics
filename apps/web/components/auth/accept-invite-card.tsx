"use client";

import { Tick02Icon } from "hugeicons-react";
import { motion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Logo } from "@/components/ui/logo";
import { Button } from "@/components/ui/button";
import { SquircleSurface } from "@/components/ui/squircle-card";
import {
  errorCodeOf,
  LIVE_API,
  presentError,
  team,
  type AcceptedInvite,
} from "@/lib/api";
import { useSession } from "@/lib/auth-client";

/**
 * `POST /v1/invites/accept` with the token from the email link.
 *
 * The branches the contract names:
 *  - 403 — signed in with a different email than the invitation's. The remedy
 *    is switching accounts, not retrying.
 *  - 404 — the token is invalid, expired or already used; every failure looks
 *    the same by design.
 *  - No session at all → sign in first, then come back to this same URL.
 */

type Phase =
  | { kind: "idle" }
  | { kind: "accepting" }
  | { kind: "accepted"; invite: AcceptedInvite }
  | { kind: "failed"; title: string; body: string };

export function AcceptInviteCard() {
  const router = useRouter();
  const session = useSession();
  const [phase, setPhase] = React.useState<Phase>({ kind: "idle" });
  const [token] = React.useState(
    () =>
      typeof window !== "undefined"
        ? (new URLSearchParams(window.location.search).get("token") ?? "")
        : ""
  );

  const signedIn = LIVE_API ? session.data !== null : true;
  const pendingSession = LIVE_API && session.isPending;

  const accept = () => {
    setPhase({ kind: "accepting" });

    if (!LIVE_API) {
      window.setTimeout(
        () =>
          setPhase({
            kind: "accepted",
            invite: { site_id: "mock", role: "admin" },
          }),
        700
      );
      return;
    }

    team.acceptInvite(token).then(
      (invite) => setPhase({ kind: "accepted", invite }),
      (raised: unknown) => {
        const code = errorCodeOf(raised);
        if (code === "FORBIDDEN") {
          setPhase({
            kind: "failed",
            title: "Wrong account",
            body: "This invitation was sent to a different email address. Sign out, sign in with the invited address, and open the link again.",
          });
        } else if (code === "NOT_FOUND" || code === "SITE_NOT_FOUND") {
          setPhase({
            kind: "failed",
            title: "This invite is no longer valid",
            body: "It may have expired, been revoked, or already been used. Ask for a fresh one.",
          });
        } else if (code === "UNAUTHENTICATED") {
          setPhase({
            kind: "failed",
            title: "Sign in first",
            body: "Sign in with the invited email address, then open this link again.",
          });
        } else {
          const presented = presentError(raised);
          setPhase({ kind: "failed", title: presented.title, body: presented.body });
        }
      }
    );
  };

  return (
    <div className="w-full max-w-sm">
      <div className="rounded-[26px] shadow-[0_1px_2px_rgba(0,0,0,0.06),0_24px_60px_rgba(0,0,0,0.10)] sm:rounded-[50px]">
        <SquircleSurface className="flex flex-col rounded-[26px] border border-border bg-[#f6f6f6] p-1 [--card-clip-handle:2.25px] [--card-clip-radius:14px] sm:rounded-[50px] sm:[--card-clip-handle:3px] sm:[--card-clip-radius:20px]">
          <div className="flex h-9 items-center gap-2 pl-3.5 pr-3">
            <Logo className="size-4 text-primary" />
            <span className="text-sm font-medium text-foreground/80">
              Open Analytics
            </span>
          </div>

          <SquircleSurface className="rounded-[22px] border border-border bg-card [--card-clip-radius:12px] sm:rounded-[44px] sm:[--card-clip-radius:17px]">
            <div className="flex flex-col gap-4 p-6">
              {phase.kind === "accepted" ? (
                <>
                  <motion.span
                    animate={{ scale: 1 }}
                    className="flex size-10 items-center justify-center rounded-xl bg-success/15 text-success-foreground"
                    initial={{ scale: 0.6 }}
                    transition={{ type: "spring", stiffness: 400, damping: 26 }}
                  >
                    <Tick02Icon className="size-5" />
                  </motion.span>
                  <div>
                    <h1 className="text-base font-medium tracking-tight">
                      You&apos;re on the team
                    </h1>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      The invite made you {phase.invite.role === "admin" ? "an" : "a"}{" "}
                      <span className="font-medium text-foreground">
                        {phase.invite.role}
                      </span>
                      . The site is in your dashboard now.
                    </p>
                  </div>
                  <Button onClick={() => router.push("/dashboard")} size="sm">
                    Open the dashboard
                  </Button>
                </>
              ) : phase.kind === "failed" ? (
                <>
                  <div>
                    <h1 className="text-base font-medium tracking-tight">
                      {phase.title}
                    </h1>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      {phase.body}
                    </p>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Button
                      render={<Link href="/login">Go to sign in</Link>}
                      size="sm"
                      variant="secondary"
                    />
                    <Button
                      onClick={() => setPhase({ kind: "idle" })}
                      size="sm"
                      variant="ghost"
                    >
                      Try again
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <h1 className="text-base font-medium tracking-tight">
                      Join a site on Open Analytics
                    </h1>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      {token.length === 0
                        ? "This link is missing its invitation token. Open the link from your email again."
                        : signedIn
                          ? "Accept the invitation and the site appears in your dashboard."
                          : "Sign in with the invited email address first, then accept."}
                    </p>
                  </div>
                  {token.length > 0 && signedIn ? (
                    <Button
                      loading={phase.kind === "accepting" || pendingSession}
                      onClick={accept}
                      size="sm"
                    >
                      Accept invitation
                    </Button>
                  ) : token.length > 0 ? (
                    <Button
                      render={<Link href="/login">Sign in to accept</Link>}
                      size="sm"
                    />
                  ) : null}
                </>
              )}
            </div>
          </SquircleSurface>
        </SquircleSurface>
      </div>
    </div>
  );
}
