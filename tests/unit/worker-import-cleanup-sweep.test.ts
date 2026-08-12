import type { ObjectStorage } from '@openanalytics/integrations'
import { createRecordingMetrics } from '@openanalytics/observability'
import type { CleanableImportRun, Database } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The lifecycle sweeper's terminal-run cleanup backstop (ADR-0032, D7).
 *
 * The **backstop**, not the mechanism of record: a run's staged rows are deleted
 * by the prepare job that failed it or by the publish that made it a
 * grandparent. This duty exists because a worker can die between the state
 * change and the cleanup, and because a site that never imports again would
 * leave its last grandparent behind forever.
 *
 * The two properties asserted here are the ones that make it safe to run
 * repeatedly against a live installation:
 *
 * - **`swept_at` is written last, and only after the ClickHouse delete
 *   succeeded.** Written first, a failed delete would become a permanent leak
 *   that nothing looks at again; written last, the worst case is a run examined
 *   twice, whose second pass submits mutations over an already-empty part set.
 * - **A missing credential defers rather than skips.** Marking a run clean whose
 *   rows are still there would be a leak with a note saying it was handled.
 *
 * Which runs the *query* covers — and, crucially, that a `superseded` run some
 * published run still points at is excluded — is a database fact and is proven
 * in `tests/migration/import-publish.test.ts` against real Postgres.
 */

const SITE = '11111111-1111-4111-8111-111111111111'
const RUN_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const RUN_B = 'bbbbbbbb-0000-4000-8000-000000000002'

const world = {
  cleanable: [] as CleanableImportRun[],
  deleteFails: false,
  objectFails: false,
  /** Whether the guarded claim matches. False models a run another cleaner took,
   * or one a concurrent rollback republished between the list and the claim. */
  claims: true,
  ttlSeen: [] as { ttlDays: number; limit: number }[],
}

const calls = {
  chDeleted: [] as string[],
  objectsDeleted: [] as string[],
  claimed: [] as string[],
  released: [] as string[],
  order: [] as string[],
}

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    listExpirableSubscriptions: async () => [],
    listSitesPastRetentionDeadline: async () => [],
    listExpiredImportUploads: async () => [],
    listCleanableImportRuns: async (_db: unknown, input: { ttlDays: number; limit: number }) => {
      world.ttlSeen.push(input)
      return world.cleanable
    },
    claimImportRunForCleanup: async (_db: unknown, input: { importRunId: string }) => {
      if (!world.claims) return false
      calls.claimed.push(input.importRunId)
      calls.order.push(`claim:${input.importRunId}`)
      return true
    },
    releaseImportRunCleanupClaim: async (_db: unknown, input: { importRunId: string }) => {
      calls.released.push(input.importRunId)
      calls.order.push(`release:${input.importRunId}`)
    },
  }
})

const { sweepLifecycleOnce } = await import('../../apps/worker/src/lifecycle/sweeper.ts')

const maintenance = {
  async deleteImportRunRows(key: { importRunId: string }) {
    await Promise.resolve()
    if (world.deleteFails) throw new Error('clickhouse down')
    calls.chDeleted.push(key.importRunId)
    calls.order.push(`clickhouse:${key.importRunId}`)
    return { tables: 8 }
  },
  async countImportRunRows() {
    await Promise.resolve()
    return 0
  },
  async ping() {
    await Promise.resolve()
    return true
  },
  async close() {
    await Promise.resolve()
  },
}

const objectStorage = {
  async delete(refs: readonly { key: string }[]) {
    await Promise.resolve()
    if (world.objectFails) throw new Error('storage down')
    for (const ref of refs) {
      calls.objectsDeleted.push(ref.key)
      calls.order.push(`object:${ref.key}`)
    }
  },
} as unknown as ObjectStorage

function cleanable(id: string): CleanableImportRun {
  return { importRunId: id, siteId: SITE, objectKey: `imports/${SITE}/${id}/archive.zip` }
}

function deps(overrides: Record<string, unknown> = {}) {
  const { logger, find } = createCapturedLogger()
  const metrics = createRecordingMetrics()
  return {
    find,
    metrics,
    input: {
      db: {} as Database,
      logger,
      metrics,
      pageSize: 50,
      importUploadTtlDays: 7,
      importedAggregatesMaintenance: maintenance,
      objectStorage,
      ...overrides,
    } as Parameters<typeof sweepLifecycleOnce>[0],
  }
}

beforeEach(() => {
  world.cleanable = []
  world.deleteFails = false
  world.objectFails = false
  world.claims = true
  world.ttlSeen = []
  calls.chDeleted = []
  calls.objectsDeleted = []
  calls.claimed = []
  calls.released = []
  calls.order = []
  // `testEnv` is imported for parity with the other worker suites; the sweeper
  // itself reads no environment.
  void testEnv
})

describe('lifecycle sweeper — terminal import run cleanup', () => {
  it('claims the run FIRST, then deletes the staged rows, then the archive', async () => {
    // The order is the correctness argument, not a preference. The candidate list
    // is read outside any transaction and the deletes take seconds; claiming
    // afterwards would leave a window in which a concurrent rollback republishes
    // the run and this cleanup erases the rows it just restored.
    world.cleanable = [cleanable(RUN_A)]
    const d = deps()

    const result = await sweepLifecycleOnce(d.input)

    expect(result.importRunsCleaned).toBe(1)
    expect(calls.order).toEqual([
      `claim:${RUN_A}`,
      `clickhouse:${RUN_A}`,
      `object:imports/${SITE}/${RUN_A}/archive.zip`,
    ])
    expect(d.find('import_cleanup_done')).toHaveLength(1)
  })

  it('does nothing at all to a run it cannot claim', async () => {
    // Somebody else is cleaning it, or its state moved out of the cleanable set
    // between being listed and being claimed.
    world.cleanable = [cleanable(RUN_A)]
    world.claims = false
    const d = deps()

    expect((await sweepLifecycleOnce(d.input)).importRunsCleaned).toBe(0)
    expect(calls.chDeleted).toEqual([])
    expect(calls.objectsDeleted).toEqual([])
    expect(d.find('import_cleanup_not_claimed')).toHaveLength(1)
  })

  it('passes the policy TTL and the page size through to the query', async () => {
    await sweepLifecycleOnce(deps().input)
    expect(world.ttlSeen).toEqual([{ ttlDays: 7, limit: 50 }])
  })

  it('hands the claim back when the ClickHouse delete fails', async () => {
    // The only failure that must undo the claim: `swept_at` is what removes the
    // run from the backstop's candidate set, so a run left marked with its rows
    // still present is a leak nothing revisits.
    world.cleanable = [cleanable(RUN_A)]
    world.deleteFails = true
    const d = deps()

    const result = await sweepLifecycleOnce(d.input)

    expect(result.importRunsCleaned).toBe(0)
    expect(calls.released).toEqual([RUN_A])
    expect(d.find('import_cleanup_clickhouse_failed')).toHaveLength(1)
  })

  it('keeps the claim when only the object delete fails', async () => {
    // Asymmetric on purpose: the bucket's `imports/` lifecycle rule expires the
    // prefix on the same schedule, so storage has a backstop of its own —
    // whereas re-examining the run forever would re-issue eight ClickHouse
    // mutations per pass to chase one object that storage already removes.
    world.cleanable = [cleanable(RUN_A)]
    world.objectFails = true
    const d = deps()

    expect((await sweepLifecycleOnce(d.input)).importRunsCleaned).toBe(1)
    expect(calls.released).toEqual([])
    expect(d.find('import_cleanup_object_delete_failed')).toHaveLength(1)
  })

  it('defers, rather than skipping, when the maintenance credential is missing', async () => {
    world.cleanable = [cleanable(RUN_A)]
    const d = deps({ importedAggregatesMaintenance: undefined })

    expect((await sweepLifecycleOnce(d.input)).importRunsCleaned).toBe(0)
    expect(calls.claimed).toEqual([])
    expect(d.find('import_cleanup_deferred')).toHaveLength(1)
  })

  it('does not run at all without the TTL policy value', async () => {
    world.cleanable = [cleanable(RUN_A)]
    const d = deps({ importUploadTtlDays: undefined })

    expect((await sweepLifecycleOnce(d.input)).importRunsCleaned).toBe(0)
    expect(world.ttlSeen).toEqual([])
  })

  it('keeps going after one run fails and meters the ones that worked', async () => {
    world.cleanable = [cleanable(RUN_A), { importRunId: RUN_B, siteId: SITE, objectKey: null }]
    const d = deps()

    const result = await sweepLifecycleOnce(d.input)

    expect(result.importRunsCleaned).toBe(2)
    // A run with no upload row still has its ClickHouse rows cleaned.
    expect(calls.chDeleted).toEqual([RUN_A, RUN_B])
    expect(calls.objectsDeleted).toEqual([`imports/${SITE}/${RUN_A}/archive.zip`])
    const metered = d.metrics.recorded.filter(
      (entry) => entry.name === 'worker_lifecycle_import_runs_cleaned',
    )
    expect(metered).toHaveLength(2)
  })
})
