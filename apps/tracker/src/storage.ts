import { RETRY_MAX_EVENTS, RETRY_TTL_MS, SESSION_INACTIVITY_MS } from './constants.ts'
import type { TrackerEvent } from './types.ts'

/**
 * Browser storage, the analytics session and the bounded offline retry queue.
 *
 * Every storage access is guarded. `localStorage` throws in Safari private mode,
 * when a third-party context is blocked and when a quota is exceeded — and an
 * analytics script that throws on a customer's site is a far worse defect than
 * one that loses a queued event. Failure degrades to memory-only.
 */

export interface SafeStorage {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

/**
 * A `SafeStorage` that lives and dies with the page.
 *
 * Two callers. `safeStorage` falls back to it when the real store throws or is
 * absent — Safari private mode, a blocked third-party context, an exceeded
 * quota. And strict mode (ADR-0064) *chooses* it: `data-storage="none"` makes
 * the tracker write nothing to the device at all, at the cost of the session
 * hint, the offline retry queue and the config cache lasting one page load.
 */
export const memoryStorage = (): SafeStorage => {
  const map = new Map<string, string>()
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => void map.set(key, value),
    remove: (key) => void map.delete(key),
  }
}

export function safeStorage(candidate: Storage | null | undefined): SafeStorage {
  if (!candidate) return memoryStorage()
  try {
    const probe = '__oa__'
    candidate.setItem(probe, '1')
    candidate.removeItem(probe)
  } catch {
    return memoryStorage()
  }

  return {
    get: (key) => {
      try {
        return candidate.getItem(key)
      } catch {
        return null
      }
    },
    set: (key, value) => {
      try {
        candidate.setItem(key, value)
      } catch {
        // Quota or a storage policy change mid-session. Dropping the write is
        // the correct outcome; the tracker keeps working in memory.
      }
    },
    remove: (key) => {
      try {
        candidate.removeItem(key)
      } catch {
        /* see above */
      }
    },
  }
}

const SESSION_KEY = 'oa.session'

interface StoredSession {
  id: string
  last: number
}

/**
 * The client session hint (docs snapshot 02 §10).
 *
 * Held in `sessionStorage`, rotated after 30 minutes of inactivity. It is only a
 * hint: the server HMACs it site-scoped and the canonical session is rebuilt by
 * the sessionizer, so a stale or forged value cannot merge two visitors.
 */
export function createSessionTracker(storage: SafeStorage, newId: () => string) {
  return {
    current(now: number): string {
      const raw = storage.get(SESSION_KEY)
      let session: StoredSession | null = null

      if (raw) {
        try {
          const parsed: unknown = JSON.parse(raw)
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            typeof (parsed as StoredSession).id === 'string' &&
            typeof (parsed as StoredSession).last === 'number'
          ) {
            session = parsed as StoredSession
          }
        } catch {
          session = null
        }
      }

      if (!session || now - session.last > SESSION_INACTIVITY_MS) {
        session = { id: newId(), last: now }
      } else {
        session = { id: session.id, last: now }
      }

      storage.set(SESSION_KEY, JSON.stringify(session))
      return session.id
    },
  }
}

const QUEUE_KEY = 'oa.retry'

interface QueuedEvent {
  /** When the event was first queued, for the TTL. */
  q: number
  e: TrackerEvent
}

/**
 * Bounded, TTL'd offline retry queue (docs snapshot 02 §7.3).
 *
 * Two rules the legacy tracker did not have: the queue never grows without
 * bound, and it never outlives the server's 24h acceptance boundary. An event
 * the collector would reject as too old is dropped here instead of being
 * retried until it is.
 */
export function createRetryQueue(storage: SafeStorage) {
  const read = (): QueuedEvent[] => {
    const raw = storage.get(QUEUE_KEY)
    if (!raw) return []
    try {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as QueuedEvent[]) : []
    } catch {
      return []
    }
  }

  const write = (entries: readonly QueuedEvent[]): void => {
    if (entries.length === 0) {
      storage.remove(QUEUE_KEY)
      return
    }
    storage.set(QUEUE_KEY, JSON.stringify(entries))
  }

  const live = (entries: readonly QueuedEvent[], now: number): QueuedEvent[] =>
    entries.filter(
      (entry) =>
        entry &&
        typeof entry.q === 'number' &&
        now - entry.q < RETRY_TTL_MS &&
        entry.e !== undefined,
    )

  return {
    /** Queue events for a later attempt, newest last, oldest dropped first. */
    push(events: readonly TrackerEvent[], now: number): void {
      const pending = live(read(), now).concat(events.map((event) => ({ q: now, e: event })))
      write(pending.slice(Math.max(0, pending.length - RETRY_MAX_EVENTS)))
    },

    /** Remove and return everything still inside the TTL. */
    take(now: number): TrackerEvent[] {
      const pending = live(read(), now)
      write([])
      return pending.map((entry) => entry.e)
    },

    /** Non-destructive count of live entries, for tests and debug mode. */
    size(now: number): number {
      return live(read(), now).length
    },
  }
}

export type RetryQueue = ReturnType<typeof createRetryQueue>
export type SessionTracker = ReturnType<typeof createSessionTracker>
