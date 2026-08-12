"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import * as React from "react";
import { GettingStarted } from "@/components/dashboard/getting-started";
import { SiteSwitcher } from "@/components/dashboard/site-switcher";
import { UserMenu, type MenuUser } from "@/components/dashboard/user-menu";
import { Logo } from "@/components/ui/logo";
import { useAccountUsage } from "@seam/slots";
import { LIVE_API } from "@/lib/api";
import {
  authErrorFromThrown,
  presentAuthError,
  signOut as endSession,
  useSession,
} from "@/lib/auth-client";

/**
 * The signed-in shell's header. Nothing in it is invented any more:
 *
 * - identity comes from the Better Auth session, which is the only identity
 *   surface there is — `name` and `image` never appear in a `/v1` response
 *   (auth_integration.md), so there is nothing else to read them from;
 * - the block under the identity row is the deployment's (`@seam/slots`): the
 *   hosted build reads its quota there, a self-hosted one has none;
 * - the site list comes from `GET /v1/sites`, inside `SiteSwitcher`, which is
 *   mounted only on `/dashboard/[site]` — the one screen that also reads that
 *   list (`SitesGrid`, on `/dashboard`) is never mounted at the same time, so
 *   the list is fetched once per screen and no context provider is needed.
 *
 * `useApiResource` sends a `401 UNAUTHENTICATED` to `/login` on its own, the
 * same as every other screen.
 */
export function DashboardHeader() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams<{ site?: string }>();
  const currentSlug = params.site ? decodeURIComponent(params.site) : null;

  const { data: session, isPending } = useSession();
  // Mock mode has no session behind it — a fixed user keeps the shell
  // reviewable; live derives strictly from the session, never a placeholder.
  const user: MenuUser | null = !LIVE_API
    ? {
        // The seed the Account profile's mock avatar draws with.
        id: "mock-user",
        name: "Alex Morgan",
        email: "alex@example.com",
        image: null,
      }
    : isPending || !session
      ? null
      : {
          id: session.user.id,
          name: session.user.name,
          email: session.user.email,
          image: session.user.image ?? null,
        };

  const usage = useAccountUsage();

  const [signingOut, setSigningOut] = React.useState(false);
  const [signOutError, setSignOutError] = React.useState<string | null>(null);

  /**
   * Revoking the cookie is the api's job, so we wait for it. A failure leaves
   * the user signed in — saying so beats routing to /login and bouncing
   * straight back off `SessionGate`.
   */
  const signOut = React.useCallback(async () => {
    if (signingOut) return;
    if (!LIVE_API) {
      router.replace("/login");
      return;
    }
    setSigningOut(true);
    setSignOutError(null);
    try {
      // The wrapper, not `authClient.signOut`: it drops the session hint
      // before the api call, so the /login we land on stays put.
      const { error } = await endSession();
      if (error) {
        setSignOutError(presentAuthError(error).message);
        setSigningOut(false);
        return;
      }
      router.replace("/login");
    } catch (thrown) {
      setSignOutError(authErrorFromThrown(thrown).message);
      setSigningOut(false);
    }
  }, [router, signingOut]);

  /** Jump to the same sub-page on another site (realtime stays realtime). */
  const switchSite = React.useCallback(
    (slug: string) => {
      if (!params.site) return;
      const next = pathname.replace(
        `/dashboard/${params.site}`,
        `/dashboard/${encodeURIComponent(slug)}`
      );
      router.push(next);
    },
    [params.site, pathname, router]
  );

  return (
    // fixed, not sticky: a sticky header rides the rubber-band overscroll
    // and visibly bounces; fixed is anchored to the viewport and stays put.
    // The dashboard layout compensates with pt-14.
    <header className="fixed inset-x-0 top-0 z-40">
      {/* Pure progressive blur — no colour at all. Four stacked backdrop
          layers, each stronger and each masked to die out earlier, so
          *sharpness itself* is what fades: strong glass at the top, cleanly
          sharp content by 88px. With zero tint there is nothing to draw a
          band over any background — white pages and the globe's ocean alike. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-22"
      >
        <div className="absolute inset-0 backdrop-blur-[2px] [mask-image:linear-gradient(to_bottom,black_55%,transparent_84%)]" />
        <div className="absolute inset-0 backdrop-blur-[6px] [mask-image:linear-gradient(to_bottom,black_42%,transparent_70%)]" />
        <div className="absolute inset-0 backdrop-blur-[14px] [mask-image:linear-gradient(to_bottom,black_28%,transparent_56%)]" />
        <div className="absolute inset-0 backdrop-blur-[28px] [mask-image:linear-gradient(to_bottom,black_12%,transparent_42%)]" />
      </div>
      <div
        className={
          "relative mx-auto flex h-14 w-full items-center justify-between px-4 sm:px-6 " +
          (currentSlug ? "max-w-6.5xl" : "max-w-6.5xl")
        }
      >
        <div className="flex items-center gap-1">
          <Link
            href="/dashboard"
            className="rounded-lg p-1 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Your sites"
          >
            <Logo className="size-6 text-primary" />
          </Link>

          {/* site selector — only inside a site's dashboard, which is also
              what keeps `GET /v1/sites` from being fetched twice */}
          {currentSlug && (
            <>
              <span
                aria-hidden="true"
                className="mx-1 h-4 w-px rotate-12 bg-border"
              />
              <SiteSwitcher currentSlug={currentSlug} onSelect={switchSite} />
            </>
          )}
        </div>

        <div className="flex items-center gap-2.5">
          {/* the five-step checklist, gone once every step is done */}
          <GettingStarted />
          <UserMenu
            onSignOut={() => void signOut()}
            signOutError={signOutError}
            signingOut={signingOut}
            usage={usage}
            user={user}
          />
        </div>
      </div>
    </header>
  );
}
