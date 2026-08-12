"use client";

import { AnimatePresence, motion } from "motion/react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { createPortal } from "react-dom";
import { markSiteDeleting } from "@/components/dashboard/site-lifecycle-gate";
import { SettingsPanel } from "@/components/dashboard/settings-panel";
import { Button } from "@/components/ui/button";
import { SkeletonBar, SkeletonReveal } from "@/components/ui/skeleton-reveal";
import {
  errorCodeOf,
  LIVE_API,
  presentError,
  sites,
  type SiteSummary,
} from "@/lib/api";

/**
 * The Danger zone with a real endpoint behind it (frontend_tasks §16):
 * `DELETE /v1/sites/{site_id}` starts fenced deletion and answers `202`.
 *
 * Owner-only by placement — `site:delete` is not held by admins, so the
 * caller renders this section only for owners rather than disabling a button
 * that pretends. There is no cancel and no undo anywhere on the backend, and
 * the copy says so instead of softening it.
 */
/**
 * The danger content as bars — one sentence and a button. Shared by the site
 * and account danger zones and by the settings board's page skeleton, so the
 * three can never drift apart.
 */
export function DangerZoneContentSkeleton() {
  return (
    <div className="flex flex-col items-start justify-between gap-3 p-5 sm:flex-row sm:items-center">
      <SkeletonBar className="h-3.5 w-72 max-w-full" />
      <SkeletonBar className="h-8 w-24 shrink-0 rounded-full" />
    </div>
  );
}

export function DeleteSiteSection({
  site,
  revealed,
}: {
  site: SiteSummary;
  /**
   * The tab's shared gate. The panel fetches nothing itself, but a finished
   * card beside pulsing ones reads as a glitch — so its content stands in
   * and comes into focus with the rest of the tab.
   */
  revealed: boolean;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <SettingsPanel title="Danger zone" tone="destructive">
      <SkeletonReveal ready={revealed} skeleton={<DangerZoneContentSkeleton />}>
        {!revealed ? null : (
          <div className="flex flex-col items-start justify-between gap-3 p-5 sm:flex-row sm:items-center">
            <p className="text-sm leading-6 text-muted-foreground">
              Deleting this site removes every event, session, key and team
              membership it has, permanently. There is no undo.
            </p>
            <Button
              onClick={() => setOpen(true)}
              size="sm"
              variant="destructive"
            >
              Delete site
            </Button>
          </div>
        )}
      </SkeletonReveal>
      <AnimatePresence>
        {open ? (
          <DeleteSiteDialog onClose={() => setOpen(false)} site={site} />
        ) : null}
      </AnimatePresence>
    </SettingsPanel>
  );
}

function DeleteSiteDialog({
  site,
  onClose,
}: {
  site: SiteSummary;
  onClose: () => void;
}) {
  const router = useRouter();
  const [confirm, setConfirm] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // One key per dialog open, reused across retries of this attempt — a
  // timed-out delete retried with the same key converges on one deletion.
  const [idempotencyKey] = React.useState(() => crypto.randomUUID());

  const matches = confirm === site.name;

  const started = () => {
    markSiteDeleting(site.site_id);
    router.push(`/dashboard/${encodeURIComponent(site.slug)}`);
  };

  const run = () => {
    if (!matches || busy) return;
    setError(null);
    if (!LIVE_API) {
      started();
      return;
    }
    setBusy(true);
    sites.remove(site.site_id, confirm, idempotencyKey).then(started, (
      raised: unknown
    ) => {
      setBusy(false);
      const code = errorCodeOf(raised);
      if (code === "SITE_NOT_FOUND") {
        // Already gone — permanently. Converge on the same exit.
        started();
        return;
      }
      setError(
        code === "REAUTH_REQUIRED"
          ? "This needs a fresh sign-in. Sign out and back in, then retry within 5 minutes."
          : code === "VALIDATION_FAILED"
            ? "That doesn't match the site's current name; it may have been renamed. Reload the page and try again."
            : presentError(raised).body
      );
    });
  };

  // Portalled to <body>: rendered in place it sits inside the SettingsPanel's
  // SquircleSurface, whose clip-path clips even fixed-position descendants.
  return createPortal(
    <div className="fixed inset-0 z-[60]">
      <motion.div
        animate={{ opacity: 1 }}
        className="absolute inset-0 bg-black/40"
        exit={{ opacity: 0, transition: { duration: 0.15 } }}
        initial={{ opacity: 0 }}
        onClick={busy ? undefined : onClose}
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
          <h3 className="text-base font-medium tracking-tight">
            Delete {site.name}?
          </h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Every event, session, funnel, API key and team membership this
            site has is removed permanently. Once it starts, nothing can stop
            it; there is no cancel and no undo.
          </p>

          <label className="mt-4 block">
            <span className="text-xs font-medium text-muted-foreground">
              Type <span className="text-foreground">{site.name}</span> to
              confirm
            </span>
            <input
              autoFocus
              className="mt-1.5 h-9 w-full rounded-xl border border-input bg-white px-3 text-sm outline-none transition-[box-shadow,border-color] focus-visible:border-ring focus-visible:[outline:2px_solid_var(--ring)] focus-visible:[outline-offset:-2px]"
              onChange={(event) => setConfirm(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") run();
              }}
              placeholder={site.name}
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
              Keep the site
            </Button>
            <Button
              disabled={!matches}
              loading={busy}
              onClick={run}
              size="sm"
              variant="destructive"
            >
              Delete forever
            </Button>
          </div>
        </motion.div>
      </div>
    </div>,
    document.body
  );
}
