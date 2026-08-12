import { sessionize } from '@openanalytics/domain'
import type { SessionRollupUnit } from '@openanalytics/clickhouse'
import { WORKER_METRICS } from '../ingest/metrics.ts'
import type { FinalizerDeps } from './deps.ts'
import { planRollupSwap, planSessionFacts } from './plan.ts'

/**
 * The session finalizer (plan Milestone 8 items 2-4; docs snapshot 02 §10, §15,
 * 05 D-211). Milestone 8 Checkpoint B.
 *
 * One site, one run, and never any session logic of its own: it reads the raw
 * events of the recompute window, drives the pure `sessionize` from
 * @openanalytics/domain, and turns the diff between what that produces and what
 * is stored into versioned fact writes and a rollup swap. The order is the
 * guarantee — facts are made durable before the rollups that summarise them, and
 * the watermark advances only after both, so a crash at any point is recovered by
 * a re-run that recomputes the same window and finds nothing left to do.
 *
 *   1. **Claim.** A conditional lease (migration 0017); a site another worker
 *      holds is skipped.
 *   2. **Recompute.** Read `[watermark, now)` from `events_raw`, sessionize,
 *      read the stored facts of the same window.
 *   3. **Version.** Insert a strictly higher version for every changed session
 *      and a tombstone for every vanished one (finalized iff past the
 *      inactivity + lateness horizon).
 *   4. **Swap.** Recompute every affected hour/day bucket from the current
 *      non-retracted facts and insert it at a higher generation.
 *   5. **Advance.** Move the watermark to the earliest still-provisional session
 *      and release the lease.
 */

const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000

export interface FinalizeSiteResult {
  readonly siteId: string
  readonly skipped: boolean
  readonly changed: number
  readonly retracted: number
  readonly rollupSwaps: number
  readonly finalizedThroughMs: number
}

const UNIT_WIDTH_MS: Record<SessionRollupUnit, number> = {
  '1h': MS_PER_HOUR,
  '1d': MS_PER_DAY,
}

export async function finalizeSite(
  deps: FinalizerDeps,
  siteId: string,
): Promise<FinalizeSiteResult> {
  const claim = await deps.state.claim(siteId)
  if (!claim) {
    deps.metrics.increment(WORKER_METRICS.sessionFinalizeSkipped, { site_id: siteId })
    return {
      siteId,
      skipped: true,
      changed: 0,
      retracted: 0,
      rollupSwaps: 0,
      finalizedThroughMs: 0,
    }
  }

  // The *inner* half of the lifecycle fence (ADR-0030, decision 7). The driver
  // already filtered discovery, but this run may have been queued before the
  // site was marked `deleting`, and the claim above is what a deletion's
  // `finalizer_fence` phase competes for. Re-checking after the claim is what
  // makes the window between the two a no-op rather than a recompute that writes
  // rows into a table a purge is about to verify as empty.
  //
  // The lease is released, not held: this run has decided it has no work, and a
  // held lease would make the deletion job wait out the full TTL for nothing.
  const finalizable = await deps.filterFinalizable([siteId])
  if (finalizable.length === 0) {
    await deps.state.release(siteId).catch((releaseErr: unknown) => {
      deps.logger.error('session_finalize_release_failed', {
        site_id: siteId,
        err: releaseErr,
        retryable: false,
      })
    })
    deps.metrics.increment(WORKER_METRICS.sessionFinalizeSkipped, { site_id: siteId })
    deps.logger.info('session_finalize_skipped_lifecycle', { site_id: siteId })
    return {
      siteId,
      skipped: true,
      changed: 0,
      retracted: 0,
      rollupSwaps: 0,
      finalizedThroughMs: 0,
    }
  }

  const startedAt = Date.now()
  const nowMs = deps.now().getTime()
  const fromMs = claim.finalizedThroughMs
  const inactivityMs = deps.sessionConfig.SESSION_INACTIVITY_MINUTES * 60_000
  // The 24h session cap (ADR-0018), threaded from the same typed session config
  // the sessionizer is driven with, so the finalizer's watermark bound uses the
  // exact value the split enforces.
  const sessionMaxLengthMs = deps.sessionConfig.SESSION_MAX_LENGTH_HOURS * 60 * 60_000

  try {
    // 2. Recompute the window from the raw events, and read what is stored for it.
    const events = await deps.store.readWindowEvents({ siteId, fromMs })
    const recomputed = sessionize(siteId, events, deps.sessionConfig)
    const stored = await deps.store.readStoredFacts({ siteId, fromMs })

    const plan = planSessionFacts({
      siteId,
      recomputed,
      stored,
      nowMs,
      inactivityMs,
      latenessMs: deps.latenessMs,
      sessionMaxLengthMs,
    })

    // 3. Versions and tombstones. Durable before the rollups summarise them.
    if (plan.factRows.length > 0) {
      await deps.store.insertFactVersions(plan.factRows)
      if (plan.changed > 0)
        deps.metrics.increment(WORKER_METRICS.sessionFactVersions, {}, plan.changed)
      if (plan.retracted > 0)
        deps.metrics.increment(WORKER_METRICS.sessionFactRetractions, {}, plan.retracted)
    }

    // 4. Swap every affected bucket at a higher generation.
    let rollupSwaps = 0
    const unitBuckets: Record<SessionRollupUnit, readonly number[]> = {
      '1h': plan.affectedHourBucketsMs,
      '1d': plan.affectedDayBucketsMs,
    }
    for (const unit of ['1h', '1d'] as const) {
      const affectedMs = unitBuckets[unit]
      if (affectedMs.length === 0) continue

      const loMs = affectedMs[0]!
      const hiMs = affectedMs[affectedMs.length - 1]! + UNIT_WIDTH_MS[unit]

      const [recomputedBuckets, storedRollups] = await Promise.all([
        deps.store.aggregateRollupBuckets({ siteId, unit, loMs, hiMs }),
        deps.store.readStoredRollups({ siteId, unit, loMs, hiMs }),
      ])

      const rollupPlan = planRollupSwap({
        siteId,
        recomputed: recomputedBuckets,
        stored: storedRollups,
        affectedBucketSeconds: affectedMs.map((ms) => ms / 1000),
        computedAtMs: nowMs,
      })

      if (rollupPlan.rows.length > 0) {
        await deps.store.insertRollups({ unit, rows: rollupPlan.rows })
        rollupSwaps += rollupPlan.changed
      }
    }
    if (rollupSwaps > 0) deps.metrics.increment(WORKER_METRICS.sessionRollupSwaps, {}, rollupSwaps)

    // 5. Advance the watermark (monotonic) and release the lease.
    const finalizedThroughMs = Math.max(fromMs, plan.finalizedThroughMs)
    await deps.state.advance(siteId, finalizedThroughMs)

    deps.metrics.increment(WORKER_METRICS.sessionFinalizeRuns)
    deps.metrics.increment(WORKER_METRICS.sessionFinalizeMs, {}, Date.now() - startedAt)

    if (plan.changed > 0 || plan.retracted > 0 || rollupSwaps > 0) {
      deps.logger.info('session_finalized', {
        site_id: siteId,
        changed: plan.changed,
        retracted: plan.retracted,
        rollup_swaps: rollupSwaps,
        version: plan.version,
        finalized_through_ms: finalizedThroughMs,
      })
    }

    return {
      siteId,
      skipped: false,
      changed: plan.changed,
      retracted: plan.retracted,
      rollupSwaps,
      finalizedThroughMs,
    }
  } catch (err) {
    // Release without advancing so the next run retries the same window. Safe
    // because the whole recompute is a pure function of the events — a half-done
    // run left durable facts that a re-run recognises as already current.
    deps.metrics.increment(WORKER_METRICS.sessionFinalizeFailed, { site_id: siteId })
    deps.logger.error('session_finalize_failed', { site_id: siteId, err, retryable: true })
    await deps.state.release(siteId).catch((releaseErr: unknown) => {
      deps.logger.error('session_finalize_release_failed', {
        site_id: siteId,
        err: releaseErr,
        retryable: false,
      })
    })
    throw err
  }
}
