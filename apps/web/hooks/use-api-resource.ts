"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { isUnauthenticated, presentError, type ErrorPresentation } from "@/lib/api";

/**
 * One `/v1` read, with the three states every screen has to design for.
 *
 * `401 UNAUTHENTICATED` is not one of them: it means the session is gone, so
 * the hook routes to `/login` instead of rendering an error. That redirect is
 * UX only — the api re-authorizes every request server-side.
 */
export type ApiResource<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: ErrorPresentation; retry: () => void };

type Settled<T> =
  | { status: "ready"; data: T }
  | { status: "error"; error: ErrorPresentation };

/**
 * `load` must be stable — wrap it in `useCallback` at the call site, or the
 * request refires on every render.
 */
export function useApiResource<T>(
  load: (signal: AbortSignal) => Promise<T>
): ApiResource<T> {
  const router = useRouter();
  const [attempt, setAttempt] = React.useState(0);

  // One identity per in-flight request. Results are tagged with the token they
  // were fetched under, so a stale answer cannot paint over a newer request and
  // "loading" is derived rather than assigned — no setState in the effect body.
  const token = React.useMemo(
    () => ({ load, attempt }),
    [load, attempt]
  );
  const [settled, setSettled] = React.useState<{
    token: unknown;
    result: Settled<T>;
  } | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();

    token.load(controller.signal).then(
      (data) => {
        if (controller.signal.aborted) return;
        setSettled({ token, result: { status: "ready", data } });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (isUnauthenticated(error)) {
          router.replace("/login");
          return;
        }
        setSettled({
          token,
          result: { status: "error", error: presentError(error) },
        });
      }
    );

    return () => controller.abort();
  }, [token, router]);

  const retry = React.useCallback(() => setAttempt((n) => n + 1), []);

  const current = settled?.token === token ? settled.result : null;
  if (current === null) return { status: "loading" };
  return current.status === "error" ? { ...current, retry } : current;
}
