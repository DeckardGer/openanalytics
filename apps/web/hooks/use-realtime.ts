"use client";

import type { RealtimeSnapshot } from "@openanalytics/contracts";
import { useRouter } from "next/navigation";
import * as React from "react";
import {
  errorCodeOf,
  isUnauthenticated,
  LIVE_API,
  mintRealtimeToken,
  resolveSiteSlugCached,
} from "@/lib/api";
import { MOCK_REALTIME_SNAPSHOT } from "@/lib/mock";
import {
  backoffDelay,
  DEFAULT_RETRY_MS,
  readSseRecords,
  STREAM_URL,
  statusAfterControl,
  toFrame,
  type RealtimeStatus,
} from "@/lib/realtime";

/**
 * The authenticated live-visitors stream for one site
 * (frontend_realtime_contract): mint a ≤60 s token, fetch-stream the SSE
 * endpoint with it, and hand every snapshot to the caller — each one fully
 * supersedes the last, so state is replaced, never accumulated.
 *
 * Reconnects mint a fresh token (the old one has expired by then) and resume
 * with `Last-Event-ID`, backing off around the stream's own `retry:` hint.
 * `access_lost` is terminal for the hook's lifetime: the server said this
 * user no longer sees this site, and only a remount re-arbitrates that.
 */
export function useRealtime(slug: string): {
  status: RealtimeStatus;
  snapshot: RealtimeSnapshot | null;
} {
  const router = useRouter();
  const [status, setStatus] = React.useState<RealtimeStatus>(
    LIVE_API ? "connecting" : "live"
  );
  const [snapshot, setSnapshot] = React.useState<RealtimeSnapshot | null>(
    LIVE_API ? null : MOCK_REALTIME_SNAPSHOT
  );

  React.useEffect(() => {
    // No site, no stream: callers like the tab bar mount on slug-less pages
    // too, and an empty slug would only loop through resolve failures.
    if (!LIVE_API || slug === "") return;

    const abort = new AbortController();

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        abort.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true }
        );
      });

    const run = async () => {
      let attempt = 0;
      let lastId: string | null = null;
      let retryHintMs = DEFAULT_RETRY_MS;

      while (!abort.signal.aborted) {
        try {
          const { site_id } = await resolveSiteSlugCached(slug);
          const { token } = await mintRealtimeToken(site_id);
          const response = await fetch(STREAM_URL, {
            headers: {
              accept: "text/event-stream",
              authorization: `Bearer ${token}`,
              ...(lastId ? { "last-event-id": lastId } : {}),
            },
            signal: abort.signal,
          });

          if ([401, 403, 404].includes(response.status)) {
            // The token minted a moment ago no longer opens the stream —
            // the gateway is the arbiter, and it said no.
            setStatus("access_lost");
            return;
          }
          if (!response.ok || !response.body) {
            throw new Error(`stream answered ${response.status}`);
          }

          attempt = 0;
          setStatus("live");

          for await (const record of readSseRecords(
            response.body,
            abort.signal
          )) {
            if (record.retry !== undefined) retryHintMs = record.retry;
            const frame = toFrame(record, "private");
            if (!frame) continue;
            if (frame.type === "retry") continue;
            if (frame.type === "snapshot") {
              if (frame.id) lastId = frame.id;
              setSnapshot(frame.data as RealtimeSnapshot);
              setStatus("live");
              continue;
            }
            const next = statusAfterControl(frame.data);
            setStatus(next);
            if (frame.data.action === "disconnect") {
              if (next === "access_lost") return;
              break; // polite server disconnect — reconnect with a new token
            }
          }
          // Stream ended (network drop or server break) — fall through to
          // the backoff and reconnect.
          if (!abort.signal.aborted) setStatus("reconnecting");
        } catch (raised: unknown) {
          if (abort.signal.aborted) return;
          if (isUnauthenticated(raised)) {
            router.replace("/login");
            return;
          }
          const code = errorCodeOf(raised);
          if (
            code === "SITE_NOT_FOUND" ||
            code === "FORBIDDEN" ||
            code === "SITE_SUSPENDED"
          ) {
            setStatus("access_lost");
            return;
          }
          setStatus("reconnecting");
        }

        attempt += 1;
        await sleep(backoffDelay(retryHintMs, attempt));
      }
    };

    void run();
    return () => abort.abort();
  }, [slug, router]);

  return { status, snapshot };
}
