import { BATCH_DELAY_MS, LIMITS, TRACKER_SCHEMA_VERSION } from './constants.ts'
import type { RetryQueue } from './storage.ts'
import type { EventBatchBody, HeartbeatBody, TrackerContext, TrackerEvent } from './types.ts'

/**
 * Batching and delivery.
 *
 * Docs snapshot 02 §7.3 and §11: a small client batch, `sendBeacon` on the way
 * out, and a bounded retry queue behind both. Two rules shape everything here:
 *
 * - A historical event is either delivered or kept for a bounded retry. It is
 *   never silently dropped because a request failed.
 * - A heartbeat is neither. It is realtime-only, so a failed heartbeat is
 *   forgotten and the next interval takes over (§7.2) — queueing it would turn a
 *   presence ping into fake history.
 *
 * Requests are sent as `text/plain;charset=UTF-8` containing JSON. That is not
 * cosmetic: `navigator.sendBeacon` cannot set headers, and an
 * `application/json` cross-origin POST triggers a CORS preflight on every
 * batch. The collector reads the body as text either way.
 */

export const INGEST_CONTENT_TYPE = 'text/plain;charset=UTF-8'

export interface TransportDeps {
  readonly collectorUrl: string
  readonly trackingKey: string
  readonly context: TrackerContext
  readonly queue: RetryQueue
  readonly now: () => number
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
  readonly beaconImpl?: (url: string, body: string) => boolean
  readonly schedule?: (task: () => void, delayMs: number) => void
  readonly onError?: (reason: string) => void
}

function endpoint(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

/** Split a run of events into batches inside both contract limits. */
function chunk(events: readonly TrackerEvent[], serialize: (batch: TrackerEvent[]) => string) {
  const batches: TrackerEvent[][] = []
  let current: TrackerEvent[] = []

  for (const event of events) {
    current.push(event)
    if (current.length >= LIMITS.maxEventsPerBatch) {
      batches.push(current)
      current = []
    }
  }
  if (current.length > 0) batches.push(current)

  // Byte limit second: one oversized batch is halved until it fits, so a single
  // large event cannot wedge the queue.
  const sized: TrackerEvent[][] = []
  const stack = batches.reverse()
  while (stack.length > 0) {
    const batch = stack.pop()
    if (!batch || batch.length === 0) continue
    if (batch.length === 1 || serialize(batch).length <= LIMITS.maxBatchBytes) {
      sized.push(batch)
      continue
    }
    const middle = Math.ceil(batch.length / 2)
    stack.push(batch.slice(middle), batch.slice(0, middle))
  }

  return sized
}

export function createTransport(deps: TransportDeps) {
  const eventsUrl = endpoint(deps.collectorUrl, '/v1/events')
  const heartbeatUrl = endpoint(deps.collectorUrl, '/v1/realtime/heartbeat')

  const schedule =
    deps.schedule ??
    ((task: () => void, delayMs: number) => {
      setTimeout(task, delayMs)
    })

  let buffer: TrackerEvent[] = []
  let flushScheduled = false

  const body = (events: readonly TrackerEvent[]): string => {
    const batch: EventBatchBody = {
      schema_version: TRACKER_SCHEMA_VERSION,
      tracking_key: deps.trackingKey,
      sent_at: new Date(deps.now()).toISOString(),
      context: deps.context,
      events,
    }
    return JSON.stringify(batch)
  }

  const serialize = (batch: TrackerEvent[]): string => body(batch)

  const requeue = (events: readonly TrackerEvent[], reason: string): void => {
    deps.queue.push(events, deps.now())
    deps.onError?.(reason)
  }

  const post = async (payload: string, events: readonly TrackerEvent[]): Promise<void> => {
    const fetchImpl = deps.fetchImpl
    if (!fetchImpl) {
      requeue(events, 'no_transport')
      return
    }

    try {
      const response = await fetchImpl(eventsUrl, {
        method: 'POST',
        body: payload,
        keepalive: true,
        credentials: 'omit',
        mode: 'cors',
        headers: { 'Content-Type': INGEST_CONTENT_TYPE },
      })

      if (response.ok) return

      // A rejected batch is rejected deterministically: retrying a validation
      // failure or a blocked site forever would only burn the visitor's battery.
      // Rate limiting and server faults are the retryable cases.
      if (response.status === 429 || response.status >= 500) {
        requeue(events, `status_${response.status}`)
        return
      }
      deps.onError?.(`dropped_${response.status}`)
    } catch {
      requeue(events, 'network_error')
    }
  }

  const sendBeacon = (payload: string, events: readonly TrackerEvent[]): void => {
    const beaconImpl = deps.beaconImpl
    if (!beaconImpl) {
      void post(payload, events)
      return
    }
    let delivered = false
    try {
      delivered = beaconImpl(eventsUrl, payload)
    } catch {
      delivered = false
    }
    // A refused beacon (queue full, payload too large) still has to survive the
    // page unload, so it goes back to the durable retry queue.
    if (!delivered) requeue(events, 'beacon_refused')
  }

  const flush = (options: { beacon?: boolean } = {}): void => {
    flushScheduled = false

    // Queued events first: they are older, and the collector orders on
    // `occurred_at` anyway.
    const pending = deps.queue.take(deps.now()).concat(buffer)
    buffer = []
    if (pending.length === 0) return

    for (const batch of chunk(pending, serialize)) {
      const payload = body(batch)
      if (options.beacon === true) sendBeacon(payload, batch)
      else void post(payload, batch)
    }
  }

  return {
    /**
     * Buffer an event. `immediate` is for the pageview: docs snapshot 02 §7.3
     * asks for the critical pageview to leave at the first opportunity rather
     * than wait for a batching window.
     */
    enqueue(event: TrackerEvent, options: { immediate?: boolean } = {}): void {
      buffer.push(event)

      if (options.immediate === true) {
        flush()
        return
      }
      if (!flushScheduled) {
        flushScheduled = true
        schedule(() => flush(), BATCH_DELAY_MS)
      }
    },

    flush,

    /** Number of events waiting in memory. Used by tests and debug mode. */
    pending(): number {
      return buffer.length
    },

    /**
     * Realtime presence. Separate endpoint, no `event_id`, never queued and
     * never retried (docs snapshot 02 §7.2, D-101: usage weight 0).
     */
    sendHeartbeat(payload: Omit<HeartbeatBody, 'schema_version' | 'tracking_key' | 'sent_at'>) {
      const heartbeat: HeartbeatBody = {
        schema_version: TRACKER_SCHEMA_VERSION,
        tracking_key: deps.trackingKey,
        sent_at: new Date(deps.now()).toISOString(),
        ...payload,
      }
      const serialized = JSON.stringify(heartbeat)

      const beaconImpl = deps.beaconImpl
      const fetchImpl = deps.fetchImpl
      try {
        if (beaconImpl) {
          beaconImpl(heartbeatUrl, serialized)
          return
        }
        if (fetchImpl) {
          void fetchImpl(heartbeatUrl, {
            method: 'POST',
            body: serialized,
            keepalive: true,
            credentials: 'omit',
            mode: 'cors',
            headers: { 'Content-Type': INGEST_CONTENT_TYPE },
          }).catch(() => {
            // Realtime only: the next interval is the retry.
          })
        }
      } catch {
        // Same reasoning; a presence ping never becomes history.
      }
    },
  }
}

export type Transport = ReturnType<typeof createTransport>
