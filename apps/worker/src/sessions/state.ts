import {
  advanceFinalizerWatermark,
  claimFinalizerSite,
  releaseFinalizerSite,
  type Database,
} from '@openanalytics/postgres'

/**
 * The finalizer's control-state port (docs snapshot 02 §15, 05 D-211).
 *
 * A narrow interface so the recompute can be driven against a real Postgres
 * lease in production and against an in-memory watermark in the ClickHouse-only
 * data tests, without either knowing about the other. The watermark is carried
 * as epoch milliseconds here; the Postgres adapter maps it to `timestamptz`.
 */
export interface FinalizerState {
  /** Claim a site, returning its watermark (epoch ms) and run counter, or null if held. */
  claim(siteId: string): Promise<{ finalizedThroughMs: number; runSeq: number } | null>
  /** Advance the watermark and release the lease at the end of a successful run. */
  advance(siteId: string, finalizedThroughMs: number): Promise<void>
  /** Release a claimed site without advancing, for a run that failed before writing. */
  release(siteId: string): Promise<void>
}

/** Postgres-backed control state: the per-site lease + watermark of migration 0017. */
export function createPostgresFinalizerState(input: {
  db: Database
  claimedBy: string
  leaseTtlMs: number
  now: () => Date
}): FinalizerState {
  return {
    async claim(siteId): Promise<{ finalizedThroughMs: number; runSeq: number } | null> {
      const claim = await claimFinalizerSite(input.db, {
        siteId,
        claimedBy: input.claimedBy,
        leaseTtlMs: input.leaseTtlMs,
        now: input.now(),
      })
      if (!claim) return null
      return { finalizedThroughMs: claim.finalizedThrough.getTime(), runSeq: claim.runSeq }
    },
    async advance(siteId, finalizedThroughMs): Promise<void> {
      await advanceFinalizerWatermark(input.db, {
        siteId,
        claimedBy: input.claimedBy,
        finalizedThrough: new Date(finalizedThroughMs),
        now: input.now(),
      })
    },
    async release(siteId): Promise<void> {
      await releaseFinalizerSite(input.db, {
        siteId,
        claimedBy: input.claimedBy,
        now: input.now(),
      })
    },
  }
}
