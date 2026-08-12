import { loadSessionConfig } from '@openanalytics/domain'
import type { SessionFactsStore } from '@openanalytics/clickhouse'
import { createRecordingMetrics } from '@openanalytics/observability'
import { createCapturedLogger } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it } from 'vitest'
import type { FinalizerDeps } from '../../apps/worker/src/sessions/deps.ts'
import type { FinalizerState } from '../../apps/worker/src/sessions/state.ts'
import { finalizeSite } from '../../apps/worker/src/sessions/finalizer.ts'
import { startSessionFinalizer } from '../../apps/worker/src/sessions/job.ts'

/**
 * The session finalizer's lifecycle fence (ADR-0030, decision 7).
 *
 * Two layers, and the suite exists because they answer different halves of one
 * race:
 *
 * - The **driver filter** stops a site being picked up at all. Discovery is a
 *   ClickHouse read — "which sites have events" — and a site being deleted still
 *   answers yes right up until its purge runs, so without the filter every sweep
 *   would keep recomputing a site whose analytics are being erased.
 * - The **post-claim re-check** covers the window the filter cannot: a run whose
 *   discovery predates the deletion. It releases the lease rather than holding
 *   it, because the deletion job's `finalizer_fence` phase is waiting for exactly
 *   that lease, and holding it would make the deletion wait out a full TTL for a
 *   run that has already decided it has nothing to do.
 *
 * Everything is faked: what is asserted is which calls happen and in what order,
 * and neither ClickHouse nor Postgres has an opinion about that.
 */

const ACTIVE = 'site-active'
const DELETING = 'site-deleting'

const discovered: string[] = []
const readWindow: string[] = []
const released: string[] = []
const advanced: string[] = []

/** Sites the Postgres fence refuses. */
const blocked = new Set<string>()
/** Sites whose lease is already held by somebody else. */
const unclaimable = new Set<string>()

const store = {
  listSitesToFinalize: async () => await Promise.resolve([...discovered]),
  readWindowEvents: async (input: { siteId: string }) => {
    readWindow.push(input.siteId)
    return await Promise.resolve([])
  },
  readStoredFacts: async () => await Promise.resolve([]),
  insertFactVersions: async () => {
    await Promise.resolve()
  },
  aggregateRollupBuckets: async () => await Promise.resolve([]),
  readStoredRollups: async () => await Promise.resolve([]),
  insertRollups: async () => {
    await Promise.resolve()
  },
  close: async () => {
    await Promise.resolve()
  },
} as unknown as SessionFactsStore

const state: FinalizerState = {
  claim: async (siteId) =>
    unclaimable.has(siteId)
      ? await Promise.resolve(null)
      : await Promise.resolve({ finalizedThroughMs: 0, runSeq: 0 }),
  advance: async (siteId) => {
    advanced.push(siteId)
    await Promise.resolve()
  },
  release: async (siteId) => {
    released.push(siteId)
    await Promise.resolve()
  },
}

function deps(): FinalizerDeps & { find: ReturnType<typeof createCapturedLogger>['find'] } {
  const { logger, find } = createCapturedLogger()
  return {
    store,
    state,
    filterFinalizable: async (siteIds) =>
      await Promise.resolve(siteIds.filter((siteId) => !blocked.has(siteId))),
    sessionConfig: loadSessionConfig(),
    latenessMs: 24 * 60 * 60 * 1000,
    logger,
    metrics: createRecordingMetrics(),
    now: () => new Date('2026-07-28T12:00:00.000Z'),
    find,
  }
}

beforeEach(() => {
  discovered.length = 0
  readWindow.length = 0
  released.length = 0
  advanced.length = 0
  blocked.clear()
  unclaimable.clear()
})

describe('the finalizer driver filters discovery through Postgres', () => {
  it('never claims a site the lifecycle fence refuses', async () => {
    discovered.push(ACTIVE, DELETING)
    blocked.add(DELETING)

    const handle = startSessionFinalizer(deps(), { intervalMs: 60_000 })
    await handle.runOnce()
    await handle.stop()

    // The deleting site is not merely skipped after a claim — it is never
    // reached, so its lease stays free for the deletion job's fence phase.
    expect(readWindow).toEqual([ACTIVE])
    expect(released).toEqual([])
  })

  it('runs nothing when every discovered site is refused', async () => {
    discovered.push(DELETING)
    blocked.add(DELETING)

    const handle = startSessionFinalizer(deps(), { intervalMs: 60_000 })
    await handle.runOnce()
    await handle.stop()

    expect(readWindow).toEqual([])
  })
})

describe('finalizeSite re-checks the status after claiming', () => {
  it('skips and releases when the site flipped to deleting between the two', async () => {
    // The window the filter cannot close: this run's discovery predates the
    // deletion, so it arrives holding a legitimate claim on a site that must not
    // be written to.
    blocked.add(DELETING)

    const result = await finalizeSite(deps(), DELETING)

    expect(result.skipped).toBe(true)
    expect(readWindow).toEqual([])
    // Released, not held: the deletion job's `finalizer_fence` is waiting for
    // this exact lease, and holding it would cost a full TTL for nothing.
    expect(released).toEqual([DELETING])
    expect(advanced).toEqual([])
  })

  it('logs the skip so a stalled deletion is explainable', async () => {
    blocked.add(DELETING)
    const context = deps()

    await finalizeSite(context, DELETING)

    expect(context.find('session_finalize_skipped_lifecycle')).toHaveLength(1)
  })

  it('proceeds normally for a site the fence allows', async () => {
    const result = await finalizeSite(deps(), ACTIVE)

    expect(result.skipped).toBe(false)
    expect(readWindow).toEqual([ACTIVE])
    expect(advanced).toEqual([ACTIVE])
  })

  it('does not re-check a site whose lease another worker holds', async () => {
    // The claim already refused; there is nothing to re-check and no lease to
    // release, so the status read is never made.
    unclaimable.add(ACTIVE)

    const result = await finalizeSite(deps(), ACTIVE)

    expect(result.skipped).toBe(true)
    expect(released).toEqual([])
  })
})
