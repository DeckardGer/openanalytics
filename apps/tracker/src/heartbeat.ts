/**
 * Realtime presence (docs snapshot 02 §7.2, §11).
 *
 * A heartbeat only says "this visitor is still here". It goes to the realtime
 * endpoint, is never queued and never retried: if one fails, the next interval
 * is the retry, and a lost ping costs one realtime tick rather than a hole in
 * history. Usage weight is 0 (D-101).
 *
 * Nothing is sent while the document is hidden — a backgrounded tab is not a
 * visitor on the site. That is a product decision and not a byte budget
 * (ADR-0035, D2): dropping the guard would *save* 5 bytes gzipped, and a
 * quarter-rate hidden beat costs 34. Plausible, Fathom, Matomo and Umami all
 * send one ping at the transition to hidden and nothing afterwards; none of them
 * runs a timer behind a backgrounded tab, and neither do we.
 *
 * The counterpart is `ping()`: the moment the tab becomes visible again, one
 * beat goes out, so a returning visitor is back on the board immediately rather
 * than up to a full interval later.
 */

export interface HeartbeatDeps {
  readonly document: { visibilityState?: DocumentVisibilityState }
  readonly intervalSeconds: () => number
  readonly send: () => void
  readonly setIntervalImpl?: (task: () => void, ms: number) => unknown
  readonly clearIntervalImpl?: (handle: unknown) => void
}

export function createHeartbeat(deps: HeartbeatDeps) {
  const setIntervalImpl =
    deps.setIntervalImpl ?? ((task: () => void, ms: number) => setInterval(task, ms))
  const clearIntervalImpl =
    deps.clearIntervalImpl ?? ((handle: unknown) => clearInterval(handle as never))

  let handle: unknown = null

  const tick = (): void => {
    if (deps.document.visibilityState === 'hidden') return
    deps.send()
  }

  return {
    start(): void {
      if (handle !== null) return
      const seconds = Math.max(5, Math.min(300, deps.intervalSeconds()))
      handle = setIntervalImpl(tick, seconds * 1_000)
      tick()
    },
    /**
     * Send one now, if the visit is running and the tab is visible.
     *
     * Called when the document *becomes* visible, so a returning visitor
     * reappears on the board at once instead of waiting out up to a full
     * interval. It goes through the same `tick`, so the hidden guard still
     * decides: firing this on the wrong edge of a `visibilitychange` sends
     * nothing.
     *
     * The `handle` check is what makes it safe on its own rather than by the
     * caller's discipline — a ping from a tracker whose heartbeat feature is off
     * would be the one heartbeat a site that disabled them ever received.
     */
    ping(): void {
      if (handle === null) return
      tick()
    },
    stop(): void {
      if (handle === null) return
      clearIntervalImpl(handle)
      handle = null
    },
    /** Restart with a new interval, e.g. after tracker config arrives. */
    restart(): void {
      this.stop()
      this.start()
    },
  }
}

export type Heartbeat = ReturnType<typeof createHeartbeat>
