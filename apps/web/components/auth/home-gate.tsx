"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { BrandLoader } from "@/components/ui/brand-loader";
import { LIVE_API } from "@/lib/api";
import { useSession } from "@/lib/auth-client";

/**
 * `/` on the app domain is not a page, it is a fork: the dashboard for someone
 * signed in, the login card for everyone else. The marketing site belongs on
 * the apex domain and is a separate deployment.
 *
 * The decision has to happen in the browser. The session cookie is HttpOnly and
 * host-only on the api origin, so a request to *this* app never carries it and a
 * Server Component cannot read it (docs/frontend/auth_integration.md
 * §"Why a Server Component cannot read the session"). Hence a spinner and a
 * client-side replace rather than a server redirect.
 *
 * `replace`, never `push`: the fork must not become a back-button trap that
 * bounces the person straight forward again.
 */
export function HomeGate() {
  const router = useRouter();
  const { data, isPending } = useSession();
  const signedIn = data !== null && data !== undefined;

  React.useEffect(() => {
    // Mock mode has no session to read, and the dashboard is the half worth
    // reviewing without an api behind it — the same stance SessionGate takes.
    if (!LIVE_API) {
      router.replace("/dashboard");
      return;
    }
    if (isPending) return;
    // An unreachable api reads as "signed out" here, and that is the right
    // destination anyway: /login is where the reason is shown and retried.
    router.replace(signedIn ? "/dashboard" : "/login");
  }, [isPending, signedIn, router]);

  return (
    <div className="flex min-h-svh items-center justify-center">
      <BrandLoader label="Taking you to the right place…" />
    </div>
  );
}
