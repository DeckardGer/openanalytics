import {
  publicRealtimeSnapshotSchema,
  realtimeControlSchema,
  realtimeSnapshotSchema,
  type PublicRealtimeSnapshot,
  type RealtimeControl,
  type RealtimeSnapshot,
} from "@openanalytics/contracts";
import { REALTIME_BASE_URL } from "./api";

/**
 * The live-visitors stream (frontend_realtime_contract).
 *
 * `EventSource` is deliberately not used: it cannot set an Authorization
 * header, which would force the token into the URL — and the gateway rejects
 * any token-shaped query parameter outright (401 `query_token_rejected`). So
 * the transport is `fetch` with a streaming reader.
 */

export const STREAM_URL = `${REALTIME_BASE_URL}/v1/realtime/stream`;

/** The states the widget has to design for (realtime contract §States). */
export type RealtimeStatus =
  | "connecting"
  | "live"
  | "degraded"
  | "reconnecting"
  | "access_lost";

export type RealtimeFrame =
  | { type: "snapshot"; data: RealtimeSnapshot | PublicRealtimeSnapshot; id: string | null }
  | { type: "control"; data: RealtimeControl }
  | { type: "retry"; ms: number };

type SseRecord = { event?: string; id?: string; data: string; retry?: number };

/** Splits an SSE byte stream into records; `:` lines are keepalive comments. */
export async function* readSseRecords(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<SseRecord> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const record = parseSseBlock(block);
        if (record) yield record;
        separator = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseBlock(block: string): SseRecord | null {
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;
  const dataLines: string[] = [];

  for (const line of block.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const rawValue = colon === -1 ? "" : line.slice(colon + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    if (field === "event") event = value;
    else if (field === "id") id = value;
    else if (field === "data") dataLines.push(value);
    else if (field === "retry") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) retry = parsed;
    }
  }

  if (dataLines.length === 0 && retry === undefined) return null;
  return {
    ...(event ? { event } : {}),
    ...(id ? { id } : {}),
    ...(retry === undefined ? {} : { retry }),
    data: dataLines.join("\n"),
  };
}

/**
 * Validates a record against the contract schemas. The public snapshot is a
 * separate, narrower shape on purpose — the two are never merged.
 */
export function toFrame(
  record: SseRecord,
  scope: "private" | "public"
): RealtimeFrame | null {
  if (record.retry !== undefined && record.data.length === 0) {
    return { type: "retry", ms: record.retry };
  }
  if (record.data.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(record.data);
  } catch {
    return null;
  }

  const control = realtimeControlSchema.safeParse(parsed);
  if (control.success) return { type: "control", data: control.data };

  const snapshot =
    scope === "public"
      ? publicRealtimeSnapshotSchema.safeParse(parsed)
      : realtimeSnapshotSchema.safeParse(parsed);
  if (snapshot.success) {
    return { type: "snapshot", data: snapshot.data, id: record.id ?? null };
  }
  return null;
}

/**
 * Maps a control frame onto the widget's next status. `degraded` keeps the
 * last snapshot on screen — auth is fine, only the data feed paused.
 */
export function statusAfterControl(control: RealtimeControl): RealtimeStatus {
  if (control.action === "degraded") return "degraded";
  if (control.action === "recovered") return "live";
  return control.reason === "access_revoked" ? "access_lost" : "reconnecting";
}

/** Backoff around the stream's own `retry:` hint, with jitter. */
export function backoffDelay(retryHintMs: number, attempt: number): number {
  const base = Math.min(retryHintMs * 2 ** Math.max(0, attempt - 1), 30_000);
  return Math.round(base * (0.7 + Math.random() * 0.6));
}

export const DEFAULT_RETRY_MS = 3000;
