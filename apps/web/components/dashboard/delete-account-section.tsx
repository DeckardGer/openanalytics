"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import * as React from "react";
import { createPortal } from "react-dom";
import { DangerZoneContentSkeleton } from "@/components/dashboard/delete-site-section";
import { SettingsPanel } from "@/components/dashboard/settings-panel";
import { Button } from "@/components/ui/button";
import { SkeletonReveal } from "@/components/ui/skeleton-reveal";
import {
  account,
  accountDeletionBlockers,
  errorCodeOf,
  LIVE_API,
  presentError,
  type AccountDeletionBlockingSite,
} from "@/lib/api";
import { signOut, useSession } from "@/lib/auth-client";

/**
 * Account deletion (frontend_tasks §18): `DELETE /v1/me` with the account's
 * own email as `confirm`. The screen that matters is the refusal — a
 * `409 ACCOUNT_DELETION_BLOCKED` carries `details.blocking_sites`, and that
 * list *is* the UI: a checklist of links with the remedy per reason. There
 * is no preflight endpoint; re-checking is calling the endpoint again.
 */
export function DeleteAccountSection() {
  const { data: session, isPending } = useSession();
  const email = LIVE_API
    ? (session?.user?.email ?? null)
    : "design@example.com";
  const [open, setOpen] = React.useState(false);

  // Same gate as the Profile panel above it — the session — so the two
  // contents come into focus in the same frame. The copy itself waits on
  // nothing, but a finished card beside a pulsing one reads as a glitch.
  const revealed = !LIVE_API || !isPending;

  return (
    <SettingsPanel title="Danger zone" tone="destructive">
      <SkeletonReveal ready={revealed} skeleton={<DangerZoneContentSkeleton />}>
        {!revealed ? null : (
          <div className="flex flex-col items-start justify-between gap-3 p-5 sm:flex-row sm:items-center">
            <p className="text-sm leading-6 text-muted-foreground">
              Deleting your account removes your sites and their data,
              permanently. Sites you solely own must be handed over or deleted
              first.
            </p>
            <Button
              disabled={email === null}
              onClick={() => setOpen(true)}
              size="sm"
              variant="destructive"
            >
              Delete account
            </Button>
          </div>
        )}
      </SkeletonReveal>
      <AnimatePresence>
        {open && email !== null ? (
          <DeleteAccountDialog email={email} onClose={() => setOpen(false)} />
        ) : null}
      </AnimatePresence>
    </SettingsPanel>
  );
}

/** The remedy per blocking reason, as the contract words it. */
const REASON_COPY: Record<AccountDeletionBlockingSite["reason"], string> = {
  billing_owner:
    "You pay for this site. Offer billing to another owner in Settings → Team and have them accept, or delete the site.",
  sole_owner:
    "You are its only owner. Promote another member to owner in Settings → Team, or delete the site.",
};

function DeleteAccountDialog({
  email,
  onClose,
}: {
  email: string;
  onClose: () => void;
}) {
  const [confirm, setConfirm] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [blockers, setBlockers] = React.useState<
    AccountDeletionBlockingSite[]
  >([]);
  const [done, setDone] = React.useState(false);
  // One key per dialog open. A refused request releases its key, so the
  // retry after clearing a blocker safely reuses it.
  const [idempotencyKey] = React.useState(() => crypto.randomUUID());

  const matches = confirm === email;

  const run = () => {
    if (!matches || busy) return;
    setError(null);
    if (!LIVE_API) {
      setDone(true);
      return;
    }
    setBusy(true);
    account.remove(confirm, idempotencyKey).then(
      () => {
        setBusy(false);
        setDone(true);
      },
      (raised: unknown) => {
        setBusy(false);
        const blocking = accountDeletionBlockers(raised);
        if (blocking.length > 0) {
          setBlockers(blocking);
          return;
        }
        setError(
          errorCodeOf(raised) === "REAUTH_REQUIRED"
            ? "This needs a fresh sign-in. Sign out and back in, then retry within 5 minutes."
            : presentError(raised).body
        );
      }
    );
  };

  // §18: after the 202 the session stays valid for a few seconds until the
  // job removes it — that is not a sign-out, so the exit clears local state
  // itself. A hard navigation resets every client cache along the way.
  const leave = () => {
    void Promise.resolve(signOut())
      .catch(() => null)
      .then(() => window.location.assign("/login"));
  };

  // Portalled to <body>: the SettingsPanel's SquircleSurface clip-path clips
  // even fixed-position descendants.
  return createPortal(
    <div className="fixed inset-0 z-[60]">
      <motion.div
        animate={{ opacity: 1 }}
        className="absolute inset-0 bg-black/40"
        exit={{ opacity: 0, transition: { duration: 0.15 } }}
        initial={{ opacity: 0 }}
        onClick={busy || done ? undefined : onClose}
      />
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
        <motion.div
          animate={{ opacity: 1, scale: 1 }}
          aria-modal="true"
          className="pointer-events-auto w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-[0_24px_80px_rgba(0,0,0,0.3)]"
          exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.12 } }}
          initial={{ opacity: 0, scale: 0.94 }}
          role="dialog"
          transition={{ type: "spring", stiffness: 400, damping: 26 }}
        >
          {done ? (
            <>
              <h3 className="text-base font-medium tracking-tight">
                Your account is being deleted
              </h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                It takes a few moments to finish. Sites you handed over keep
                running under their new owner. Signing in with this address
                later creates a new, empty account: nothing comes back.
              </p>
              <div className="mt-5 flex justify-end">
                <Button onClick={leave} size="sm">
                  Done
                </Button>
              </div>
            </>
          ) : (
            <>
              <h3 className="text-base font-medium tracking-tight">
                Delete your account?
              </h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                This permanently removes your account and every site only you
                depend on. There is no recovery window; signing in with the
                same address later starts a new, empty account.
              </p>

              {blockers.length > 0 ? (
                <div className="mt-4 rounded-xl border border-border bg-secondary/50 p-4">
                  <p className="text-xs font-medium">
                    These sites still depend on this account:
                  </p>
                  <ul className="mt-2 flex flex-col gap-2.5">
                    {blockers.map((entry) => (
                      <li className="text-xs leading-5" key={entry.site_id}>
                        <Link
                          className="font-medium underline decoration-border underline-offset-2 hover:decoration-foreground"
                          href={`/dashboard/${encodeURIComponent(entry.slug)}/settings`}
                        >
                          {entry.slug}
                        </Link>{" "}
                        <span className="text-muted-foreground">
                          {REASON_COPY[entry.reason]}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2.5 text-xs leading-5 text-muted-foreground">
                    Resolve them, then try again; a site you delete stops
                    blocking as soon as its deletion starts.
                  </p>
                </div>
              ) : null}

              <label className="mt-4 block">
                <span className="text-xs font-medium text-muted-foreground">
                  Type <span className="text-foreground">{email}</span> to
                  confirm
                </span>
                <input
                  autoFocus
                  className="mt-1.5 h-9 w-full rounded-xl border border-input bg-white px-3 text-sm outline-none transition-[box-shadow,border-color] focus-visible:border-ring focus-visible:[outline:2px_solid_var(--ring)] focus-visible:[outline-offset:-2px]"
                  onChange={(event) => setConfirm(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") run();
                  }}
                  placeholder={email}
                  value={confirm}
                />
              </label>

              {error ? (
                <p className="mt-3 text-xs leading-5 text-destructive-foreground">
                  {error}
                </p>
              ) : null}

              <div className="mt-5 flex justify-end gap-2">
                <Button
                  disabled={busy}
                  onClick={onClose}
                  size="sm"
                  variant="secondary"
                >
                  Keep my account
                </Button>
                <Button
                  disabled={!matches}
                  loading={busy}
                  onClick={run}
                  size="sm"
                  variant="destructive"
                >
                  {blockers.length > 0 ? "Try again" : "Delete forever"}
                </Button>
              </div>
            </>
          )}
        </motion.div>
      </div>
    </div>,
    document.body
  );
}
