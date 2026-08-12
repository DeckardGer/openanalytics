import type { Metadata } from "next";
import { SessionGate } from "@/components/auth/session-gate";
import { ShaderBackdrop } from "@/components/auth/shader-backdrop";
import { SignOutCorner } from "@/components/auth/sign-out-corner";
import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";

export const metadata: Metadata = {
  title: "Set up | Open Analytics",
};

/**
 * The mandatory first-run screen. Signed-out visitors bounce to /login (the
 * SessionGate); signed-in ones land here from the OnboardingGate until they
 * finish creating their first site. Same stage dressing as the login screen —
 * this is still the front door, just its second room.
 */
export default function OnboardingPage() {
  return (
    <SessionGate>
      <main className="relative flex min-h-svh flex-1 items-center justify-center overflow-hidden bg-[#f6f6f6] px-4 py-12">
        <ShaderBackdrop />
        {/* The exit: onboarding is mandatory, and a mandatory screen with no
            way out traps whoever signed into the wrong account. */}
        <SignOutCorner />
        {/* explicit width: a shrink-wrapped flex child would collapse the
            card to its inputs' intrinsic width */}
        <div className="relative w-full max-w-md">
          <OnboardingFlow />
        </div>
      </main>
    </SessionGate>
  );
}
