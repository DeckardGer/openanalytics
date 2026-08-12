import type { Metadata } from "next";
import { AcceptInviteCard } from "@/components/auth/accept-invite-card";
import { ShaderBackdrop } from "@/components/auth/shader-backdrop";

export const metadata: Metadata = {
  title: "Accept invite | Open Analytics",
};

/**
 * The landing page for `${APP_BASE_URL}/invites/accept?token=…` — the URL the
 * api writes into every invitation email (ADR-0019). Same stage as the login
 * page: the dither ribbon behind a single card.
 */
export default function AcceptInvitePage() {
  return (
    <main className="relative flex min-h-svh flex-1 items-center justify-center overflow-hidden bg-[#f6f6f6] px-4 py-12">
      <ShaderBackdrop />
      <div className="relative">
        <AcceptInviteCard />
      </div>
    </main>
  );
}
