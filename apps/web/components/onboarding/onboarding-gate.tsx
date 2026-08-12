"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { BrandLoader } from "@/components/ui/brand-loader";
import { LIVE_API, sites } from "@/lib/api";
import { useSession } from "@/lib/auth-client";

/**
 * The mandatory-onboarding gate, mounted inside the dashboard's SessionGate:
 * a signed-in user who has not been onboarded is sent to `/onboarding`
 * before any dashboard chrome renders.
 *
 * **"Onboarded" is a local flag until the api owns one** (pending).
 * The flag is seeded two ways: finishing the onboarding flow sets it, and a
 * user who already has sites is grandfathered in on first check — an
 * existing account must never be marched through a first-run wizard. The
 * check fails *open*: if the sites read errors, the dashboard renders and
 * its own panels surface the problem; a gate that locks people out on a
 * flaky request would be worse than no gate.
 *
 * Mock mode passes through so the dashboard stays reviewable; the flow
 * itself is still reviewable directly at `/onboarding`.
 */

const onboardedKey = (userId: string) => `oa:onboarded:v1:${userId}`;

/** Called by the onboarding flow's final step. */
export function markOnboarded(userId: string): void {
  try {
    window.localStorage.setItem(onboardedKey(userId), "1");
  } catch {
    // Blocked storage: the has-sites check re-derives it next visit.
  }
}

export function OnboardingGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { data: session } = useSession();
  const userId = LIVE_API ? (session?.user?.id ?? null) : null;

  const [checked, setChecked] = React.useState<{
    userId: string;
    onboarded: boolean;
  } | null>(null);

  React.useEffect(() => {
    if (!LIVE_API || userId === null) return;
    let cancelled = false;
    void (async () => {
      // Microtask hop: the flag read resolves synchronously, and the state
      // write belongs in a continuation, not the effect body.
      await Promise.resolve();
      if (cancelled) return;
      try {
        if (window.localStorage.getItem(onboardedKey(userId)) === "1") {
          setChecked({ userId, onboarded: true });
          return;
        }
      } catch {
        // Unreadable storage: fall through to the sites check.
      }
      try {
        const { items } = await sites.list();
        if (cancelled) return;
        if (items.length > 0) {
          markOnboarded(userId);
          setChecked({ userId, onboarded: true });
        } else {
          setChecked({ userId, onboarded: false });
        }
      } catch {
        // Fail open — the dashboard's own panels present api trouble.
        if (!cancelled) setChecked({ userId, onboarded: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const decision: "pass" | "checking" | "redirect" = !LIVE_API
    ? "pass"
    : checked !== null && checked.userId === userId
      ? checked.onboarded
        ? "pass"
        : "redirect"
      : "checking";

  React.useEffect(() => {
    if (decision === "redirect") router.replace("/onboarding");
  }, [decision, router]);

  if (decision === "pass") return <>{children}</>;

  if (decision === "redirect") {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <BrandLoader label="Taking you to set up your first site…" />
      </div>
    );
  }

  return (
    <div className="flex min-h-svh items-center justify-center">
      <BrandLoader label="Checking your workspace…" />
    </div>
  );
}
