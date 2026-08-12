import { ACTIVITY_WINDOW_MS } from './constants.ts'
import type { EngagementPayload } from './types.ts'

/**
 * Engagement and duration (docs snapshot 02 §10, §11).
 *
 * `Page duration` is explicitly *not* how long the tab existed: it is visible,
 * active time. So two clocks run here — one that accumulates only while the
 * document is visible, and one that accumulates only inside an activity window
 * after a real interaction. A backgrounded tab left open overnight adds nothing
 * to either.
 *
 * Usage weight is 0 (D-101): engagement never bills.
 */

export interface EngagementDeps {
  readonly document: Pick<Document, 'addEventListener' | 'removeEventListener'> & {
    visibilityState?: DocumentVisibilityState
  }
  readonly window: Pick<Window, 'addEventListener' | 'removeEventListener'>
  readonly now: () => number
}

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'scroll', 'touchstart', 'wheel'] as const

export function createEngagement(deps: EngagementDeps) {
  let visibleSince: number | null = null
  let visibleMs = 0
  let activeMs = 0
  let activeStart: number | null = null
  let activeUntil = 0

  const isVisible = (): boolean => deps.document.visibilityState !== 'hidden'

  const closeActiveInterval = (at: number): void => {
    if (activeStart === null) return
    activeMs += Math.max(0, Math.min(at, activeUntil) - activeStart)
    activeStart = null
    activeUntil = 0
  }

  const onActivity = (): void => {
    if (!isVisible()) return
    const at = deps.now()

    if (activeStart === null || at > activeUntil) {
      closeActiveInterval(at)
      activeStart = at
    }
    activeUntil = at + ACTIVITY_WINDOW_MS
  }

  const onVisibilityChange = (): void => {
    const at = deps.now()
    if (isVisible()) {
      if (visibleSince === null) visibleSince = at
      return
    }
    if (visibleSince !== null) {
      visibleMs += at - visibleSince
      visibleSince = null
    }
    closeActiveInterval(at)
  }

  return {
    start(): void {
      visibleSince = isVisible() ? deps.now() : null
      for (const type of ACTIVITY_EVENTS) {
        deps.window.addEventListener(type, onActivity, { passive: true, capture: true })
      }
      deps.document.addEventListener('visibilitychange', onVisibilityChange)
    },

    stop(): void {
      for (const type of ACTIVITY_EVENTS) {
        deps.window.removeEventListener(type, onActivity, { capture: true })
      }
      deps.document.removeEventListener('visibilitychange', onVisibilityChange)
    },

    /**
     * Read and reset the counters. Called on a route change and on the way out,
     * so an SPA reports duration per route rather than one figure for the tab.
     * Returns `null` when there is nothing worth an event.
     */
    collect(): EngagementPayload | null {
      const at = deps.now()

      if (visibleSince !== null) {
        visibleMs += at - visibleSince
        visibleSince = at
      }
      const stillActive = activeStart !== null && at <= activeUntil
      closeActiveInterval(at)

      const payload: EngagementPayload = {
        active_ms: Math.round(activeMs),
        visible_ms: Math.round(visibleMs),
      }

      activeMs = 0
      visibleMs = 0
      if (stillActive) {
        activeStart = at
        activeUntil = at + ACTIVITY_WINDOW_MS
      }

      return payload.visible_ms === 0 && payload.active_ms === 0 ? null : payload
    },
  }
}

export type Engagement = ReturnType<typeof createEngagement>
