import type { Metadata } from "next";
import { SessionGate } from "@/components/auth/session-gate";
import { DashboardBanner } from "@seam/slots";
import { DashboardHeader } from "@/components/dashboard/dashboard-header";
import { OnboardingGate } from "@/components/onboarding/onboarding-gate";

export const metadata: Metadata = {
  title: "Dashboard | Open Analytics",
};

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // A signed-out visitor is bounced to /login here. This is UX only — the api
    // re-authorizes every request, so the guard protects nobody, it just stops
    // the shell from rendering around a wall of 401s.
    <SessionGate>
      {/* A signed-in user with no sites and no finished onboarding is sent
          to /onboarding before any dashboard chrome renders. */}
      <OnboardingGate>
        {/* pt-14 stands in for the fixed header's height — it left normal
            flow so it could stop riding the overscroll bounce */}
        <div className="flex min-h-full flex-1 flex-col pt-14">
          <DashboardHeader />
          {/* the deployment's own standing notice, if it has one: the hosted
              build floats a warning here while a renewal is failing. Layout
              never shifts either way. */}
          {DashboardBanner ? <DashboardBanner /> : null}
          {/* width is set per-scope: sites picker caps at 5xl, site pages at 6xl */}
          <main className="w-full flex-1 px-4 pb-36 pt-8 sm:px-6 bg-white">{children}</main>
        </div>
      </OnboardingGate>
    </SessionGate>
  );
}
