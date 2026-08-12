"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { BrandLoader } from "@/components/ui/brand-loader";
import { Button } from "@/components/ui/button";
import { API_BASE_URL, LIVE_API } from "@/lib/api";
import { useSession } from "@/lib/auth-client";

/**
 * Client-side route guard for the signed-in shell.
 *
 * It has to be client-side: the session cookie is host-only on the api origin,
 * so a request to this app never carries it and `cookies()` in a Server
 * Component is always empty (auth_integration.md §"Why a Server Component
 * cannot read the session"). There is no SSR session to render from — hence the
 * loading state rather than a server-rendered user.
 *
 * This is UX only. Every `/v1` response is authorized again on the server; a
 * user who defeats this guard sees an empty shell and a pile of 401s.
 */
export function SessionGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { data, isPending, error, refetch } = useSession();
  const signedIn = data !== null && data !== undefined;

  // A 401 from /get-session is "signed out". Anything else — a thrown fetch,
  // a 5xx, a preflight the browser refused — is a broken api, and bouncing to
  // /login for that would send the user somewhere that cannot work either.
  const status = (error as { status?: number } | null)?.status;
  const unreachable = error !== null && status !== 401;

  React.useEffect(() => {
    if (!LIVE_API || isPending || unreachable || signedIn) return;
    router.replace("/login");
  }, [isPending, unreachable, signedIn, router]);

  // Mock mode has no session to check — the gate stands aside so the
  // dashboard stays reviewable without an api behind it.
  if (!LIVE_API) return <>{children}</>;

  if (isPending) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <BrandLoader label="Checking your session…" />
      </div>
    );
  }

  if (unreachable) {
    return (
      <div
        className="mx-auto flex min-h-svh max-w-md flex-col items-center justify-center gap-3 px-6 text-center"
        role="alert"
      >
        <p className="text-base font-medium">Cannot reach the API</p>
        <p className="text-sm leading-6 text-muted-foreground">
          {API_BASE_URL} did not answer the session check. It may be down, or
          this origin may be missing from <code>AUTH_TRUSTED_ORIGINS</code> on
          the api host; a blocked CORS preflight is indistinguishable from
          being offline here.
        </p>
        <Button onClick={() => void refetch()} size="sm" variant="secondary">
          Try again
        </Button>
      </div>
    );
  }

  if (!signedIn) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <BrandLoader label="Taking you to sign in…" />
      </div>
    );
  }

  return <>{children}</>;
}
