"use client";

import * as React from "react";
import { LIVE_API, presentError, type ErrorPresentation } from "@/lib/api";

export type ApiState<T> =
  | { phase: "loading"; data: null; error: null }
  | { phase: "ready"; data: T; error: null }
  | { phase: "error"; data: null; error: ErrorPresentation };

type Settled<T> = {
  /** Which request this result answers — stale results never render. */
  id: string;
  data: T | null;
  error: ErrorPresentation | null;
};

/**
 * Load-on-mount for a screen's data, in the app's three phases: loading,
 * ready, or a presented error — never a silent zero (the partner's cardinal
 * rule; `presentError` keeps degraded states distinguishable from empty ones).
 *
 * `live` is the real loader; `mock` is what the screen was designed against.
 * Under `NEXT_PUBLIC_MOCK_API=1` the mock resolves through the same path, so
 * flipping the flag changes the data source and nothing else.
 *
 * `key` names what changes the request (a site id, a slug). Loading is
 * derived — the settled result carries the request id it answers, so a key
 * change is instantly "loading" without a state write in the effect body.
 */
export function useApi<T>(
  live: () => Promise<T>,
  mock: () => T,
  key: string | number = ""
): ApiState<T> & { reload: () => void } {
  const [attempt, setAttempt] = React.useState(0);
  const [settled, setSettled] = React.useState<Settled<T> | null>(null);
  const id = `${key}#${attempt}`;

  React.useEffect(() => {
    let cancelled = false;
    (LIVE_API ? live() : Promise.resolve(mock())).then(
      (data) => {
        if (!cancelled) setSettled({ id, data, error: null });
      },
      (raised: unknown) => {
        if (!cancelled) setSettled({ id, data: null, error: presentError(raised) });
      }
    );
    return () => {
      cancelled = true;
    };
    // The loaders are inline closures by design; `id` is the full identity of
    // a request, so depending on the closures would only re-run identical
    // fetches every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const reload = React.useCallback(() => setAttempt((n) => n + 1), []);

  if (settled === null || settled.id !== id) {
    return { phase: "loading", data: null, error: null, reload };
  }
  if (settled.error !== null) {
    return { phase: "error", data: null, error: settled.error, reload };
  }
  return { phase: "ready", data: settled.data as T, error: null, reload };
}

/**
 * A mutation the UI reflects only after the server confirms. Returns the
 * runner plus its in-flight and error state.
 */
export function useAction<Args extends unknown[]>(
  action: (...args: Args) => Promise<void>
): {
  run: (...args: Args) => void;
  busy: boolean;
  error: ErrorPresentation | null;
  clearError: () => void;
} {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<ErrorPresentation | null>(null);

  const run = React.useCallback(
    (...args: Args) => {
      setBusy(true);
      setError(null);
      action(...args).then(
        () => setBusy(false),
        (raised: unknown) => {
          setBusy(false);
          setError(presentError(raised));
        }
      );
    },
    [action]
  );

  const clearError = React.useCallback(() => setError(null), []);

  return { run, busy, error, clearError };
}
