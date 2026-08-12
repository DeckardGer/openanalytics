import { WORKER_METRICS } from '../ingest/metrics.ts'
import type { FinalizerDeps } from './deps.ts'
import { finalizeSite } from './finalizer.ts'

/**
 * The periodic driver of the session finalizer (plan Milestone 8 item 3).
 *
 * It discovers the sites that could have changed since the last pass — those
 * with events accepted recently, or with a session still provisional — and runs
 * each to a decided state. The recompute itself is bounded per site (D-211); the
 * discovery is what keeps the sweep from touching a site that cannot have moved.
 *
 * Failures are logged and swallowed per site, the operations-job discipline: the
 * finalizer observes the pipeline and must never be able to stop it. A site that
 * threw is simply retried on the next pass, its watermark unmoved.
 */

export interface SessionFinalizerHandle {
  /** Runs one discovery + finalize pass immediately. Exposed so tests skip the timer. */
  runOnce(): Promise<void>
  stop(): Promise<void>
}

export const DEFAULT_FINALIZER_INTERVAL_MS = 5 * 60 * 1000

export interface SessionFinalizerOptions {
  readonly intervalMs?: number
  /**
   * How far back to look for newly accepted events when discovering sites.
   * Defaults generously past the interval so a batch accepted between two passes
   * is never missed; the provisional-facts half of discovery covers a site that
   * stopped sending but still has a session to finalize.
   */
  readonly acceptedLookbackMs?: number
}

export function startSessionFinalizer(
  deps: FinalizerDeps,
  options: SessionFinalizerOptions = {},
): SessionFinalizerHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_FINALIZER_INTERVAL_MS
  const inactivityMs = deps.sessionConfig.SESSION_INACTIVITY_MINUTES * 60_000
  const acceptedLookbackMs = options.acceptedLookbackMs ?? Math.max(intervalMs * 4, 60 * 60 * 1000)
  let stopped = false

  const runOnce = async (): Promise<void> => {
    if (stopped) return
    const nowMs = deps.now().getTime()
    const acceptedSinceMs = nowMs - acceptedLookbackMs
    // The whole provisional window, generously: any session that could still be
    // provisional started no earlier than now - (lateness + inactivity), and a
    // day of slack absorbs a watermark that has not caught up.
    const provisionalFromMs = nowMs - (deps.latenessMs + inactivityMs) * 2 - 86_400_000

    const discovered = await deps.store.listSitesToFinalize({ acceptedSinceMs, provisionalFromMs })

    // The lifecycle fence (ADR-0030, decision 7). Discovery asks ClickHouse
    // "which sites have events" — a question about the past that a site being
    // deleted still answers yes to, right up until its purge runs. Postgres is
    // the only authority on whether the site may still be written to, so the
    // discovery is filtered through it before a single site is claimed.
    //
    // This is the *outer* of two layers and it is not sufficient on its own: a
    // run that claimed the site before deletion started outlives any filter,
    // which is why the deletion job takes and holds the finalizer lease
    // (`finalizer_fence`) and why `finalizeSite` re-checks after claiming.
    const siteIds = await deps.filterFinalizable(discovered)

    for (const siteId of siteIds) {
      if (stopped) return
      try {
        await finalizeSite(deps, siteId)
      } catch {
        // finalizeSite has already logged, metered and released the site. The
        // sweep continues so one bad site does not stall the rest.
      }
    }
  }

  const timer = setInterval(() => {
    void runOnce().catch((err: unknown) => {
      deps.logger.error('session_finalizer_pass_failed', { err, retryable: true })
      deps.metrics.increment(WORKER_METRICS.sessionFinalizeFailed, { scope: 'pass' })
    })
  }, intervalMs)
  timer.unref?.()

  return {
    runOnce,
    async stop(): Promise<void> {
      stopped = true
      clearInterval(timer)
    },
  }
}
