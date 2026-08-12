import { createRecordingMetrics } from '@openanalytics/observability'
import type { CleanableImportRun, Database, ImportRunRow } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import type { ObjectStorage } from '@openanalytics/integrations'
import { createCapturedLogger } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The `import_publish` executor (ADR-0032, D3/D7).
 *
 * Two things are proven here that nothing else can prove:
 *
 * 1. **Retry safety after the swap.** A lease stolen between the commit and the
 *    settlement makes this executor run again over a run that is already
 *    `published`. It must recognise that, skip the swap and go straight to the
 *    cleanup — which is only possible because the predecessor is a *column*
 *    (`superseded_run_id`) rather than an inference. This is the case that would
 *    otherwise erase the rollback generation.
 * 2. **Cleanup is outside the transaction and never gates the publish.** The
 *    swap is committed and the dashboard already shows the new data, so a
 *    ClickHouse mutation that fails must not make the job retry the publish; the
 *    sweeper's backstop exists for exactly that.
 */

const SITE = '11111111-1111-4111-8111-111111111111'
const RUN = '22222222-2222-4222-8222-222222222222'
const PREVIOUS = '33333333-3333-4333-8333-333333333333'
const GRANDPARENT = '44444444-4444-4444-8444-444444444444'

const world = {
  run: null as ImportRunRow | null,
  publish: null as unknown,
  cleanable: [] as CleanableImportRun[],
  deleteFails: false,
  leaseHeld: true,
  phaseHeld: true,
}

const calls = {
  publishes: [] as { siteId: string; importRunId: string }[],
  cleanupQueries: [] as { predecessorRunId: string | null; ttlDays: number }[],
  chDeleted: [] as string[],
  objectsDeleted: [] as string[],
  claimed: [] as string[],
  released: [] as string[],
  transitions: [] as { to: string }[],
}

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    readImportRun: async () => world.run,
    publishImportRun: async (_db: unknown, input: { siteId: string; importRunId: string }) => {
      calls.publishes.push(input)
      return world.publish
    },
    listCleanableSiteImportRuns: async (
      _db: unknown,
      input: { predecessorRunId: string | null; ttlDays: number },
    ) => {
      calls.cleanupQueries.push({
        predecessorRunId: input.predecessorRunId,
        ttlDays: input.ttlDays,
      })
      return world.cleanable
    },
    claimImportRunForCleanup: async (_db: unknown, input: { importRunId: string }) => {
      calls.claimed.push(input.importRunId)
      return true
    },
    releaseImportRunCleanupClaim: async (_db: unknown, input: { importRunId: string }) => {
      calls.released.push(input.importRunId)
    },
    transitionImportRun: async (_db: unknown, input: { to: string }) => {
      calls.transitions.push(input)
      return true
    },
  }
})

const { executeImportPublish, IMPORT_PUBLISH_REGISTRATION } =
  await import('../../apps/worker/src/jobs/import-publish.ts')

function runRow(overrides: Partial<ImportRunRow> = {}): ImportRunRow {
  return {
    id: RUN,
    siteId: SITE,
    provider: 'plausible',
    state: 'publishing',
    summary: null,
    cutoverDate: '2024-04-01',
    stagingChunkBytes: 8_388_608,
    stagingProgress: null,
    supersededRunId: null,
    sweptAt: null,
    errorCode: null,
    createdAt: new Date('2026-07-29T00:00:00.000Z'),
    updatedAt: new Date('2026-07-29T00:00:00.000Z'),
    finishedAt: null,
    ...overrides,
  }
}

const maintenance = {
  async deleteImportRunRows(key: { importRunId: string }) {
    await Promise.resolve()
    if (world.deleteFails) throw new Error('clickhouse down')
    calls.chDeleted.push(key.importRunId)
    return { tables: 8 }
  },
}

const objectStorage = {
  async delete(refs: readonly { key: string }[]) {
    await Promise.resolve()
    for (const ref of refs) calls.objectsDeleted.push(ref.key)
  },
} as unknown as ObjectStorage

function context(overrides: Record<string, unknown> = {}) {
  const { logger, find } = createCapturedLogger()
  const metrics = createRecordingMetrics()
  return {
    find,
    input: {
      job: {
        id: 'job-1',
        type: 'import_publish',
        subjectId: SITE,
        payload: { import_run_id: RUN },
        phase: null,
        attempts: 1,
        claimedBy: 'w-1',
        leaseExpiresAt: new Date(),
        createdAt: new Date(),
      },
      db: {} as Database,
      logger,
      metrics,
      resources: {
        importedAggregatesMaintenance: maintenance,
        objectStorage,
        importPolicy: {
          maxArchiveBytes: 1,
          maxEntries: 1,
          maxEntryBytes: 1,
          maxTotalUncompressedBytes: 1,
          maxRowBytes: 1,
          stagingChunkBytes: 1,
          uploadTtlDays: 7,
        },
      },
      extendLease: async () => {
        await Promise.resolve()
        return world.leaseHeld
      },
      updatePhase: async () => {
        await Promise.resolve()
        return world.phaseHeld
      },
      ...overrides,
    } as unknown as Parameters<typeof executeImportPublish>[0],
  }
}

function cleanable(id: string): CleanableImportRun {
  return { importRunId: id, siteId: SITE, objectKey: `imports/${SITE}/${id}/archive.zip` }
}

beforeEach(() => {
  world.run = runRow()
  world.publish = { ok: true, swapped: true, predecessorRunId: PREVIOUS }
  world.cleanable = []
  world.deleteFails = false
  world.leaseHeld = true
  world.phaseHeld = true
  calls.publishes = []
  calls.cleanupQueries = []
  calls.chDeleted = []
  calls.objectsDeleted = []
  calls.claimed = []
  calls.released = []
  calls.transitions = []
})

describe('import_publish — the swap', () => {
  it('performs the swap and then cleans the grandparent', async () => {
    world.cleanable = [cleanable(GRANDPARENT)]
    const c = context()

    expect(await executeImportPublish(c.input)).toBe('succeeded')
    expect(calls.publishes).toEqual([{ siteId: SITE, importRunId: RUN }])
    // The predecessor is passed to the cleanup query as the run it must NOT
    // touch — the single rollback generation D3 keeps.
    expect(calls.cleanupQueries).toEqual([{ predecessorRunId: PREVIOUS, ttlDays: 7 }])
    expect(calls.chDeleted).toEqual([GRANDPARENT])
    expect(calls.objectsDeleted).toEqual([`imports/${SITE}/${GRANDPARENT}/archive.zip`])
    // Claimed before anything was deleted, so a concurrent rollback cannot
    // republish it mid-cleanup (ADR-0032, D3).
    expect(calls.claimed).toEqual([GRANDPARENT])
    expect(c.find('import_published')).toHaveLength(1)
  })

  it('re-runs safely over a run that is already published', async () => {
    // A lease stolen between the commit and the settlement. The recorded
    // predecessor is what makes "which run did this supersede" answerable at
    // all after the swap.
    world.run = runRow({ state: 'published', supersededRunId: PREVIOUS })
    world.publish = { ok: true, swapped: false, predecessorRunId: PREVIOUS }
    world.cleanable = [cleanable(GRANDPARENT)]
    const c = context()

    expect(await executeImportPublish(c.input)).toBe('succeeded')
    expect(calls.cleanupQueries).toEqual([{ predecessorRunId: PREVIOUS, ttlDays: 7 }])
    expect(calls.chDeleted).toEqual([GRANDPARENT])
    // Nothing was published a second time.
    expect(c.find('import_published')).toHaveLength(0)
  })

  it('leaves everything alone when the run moved under it', async () => {
    world.publish = { ok: false, conflict: 'state' }
    const c = context()

    expect(await executeImportPublish(c.input)).toBe('succeeded')
    expect(calls.cleanupQueries).toEqual([])
    expect(c.find('import_publish_lost_transition')).toHaveLength(1)
  })

  it('succeeds without waiting when the site is being deleted', async () => {
    // Its own deletion job purges the staged rows and the pointer, so there is
    // nothing here to do and nothing to wait for.
    world.publish = { ok: false, conflict: 'site_unavailable' }
    const c = context()

    expect(await executeImportPublish(c.input)).toBe('succeeded')
    expect(calls.cleanupQueries).toEqual([])
  })

  it('is a no-op for a run that was rolled back before the job ran', async () => {
    world.run = runRow({ state: 'rolled_back' })
    const c = context()

    expect(await executeImportPublish(c.input)).toBe('succeeded')
    expect(calls.publishes).toEqual([])
  })
})

describe('import_publish — cleanup', () => {
  it('does not fail the publish when the ClickHouse delete fails', async () => {
    // The swap is committed and the customer's dashboard already shows the new
    // data. The sweeper's backstop is what retries the delete.
    world.cleanable = [cleanable(GRANDPARENT)]
    world.deleteFails = true
    const c = context()

    expect(await executeImportPublish(c.input)).toBe('succeeded')
    // The claim is handed back, so the backstop looks again.
    expect(calls.released).toEqual([GRANDPARENT])
    expect(c.find('import_cleanup_clickhouse_failed')).toHaveLength(1)
  })

  it('retries only when the cleanup credential is missing', async () => {
    // A deployment state a retry can actually resolve, unlike a mutation that
    // failed.
    const c = context({ resources: {} })
    expect(await executeImportPublish(c.input)).toMatchObject({ retry: expect.anything() })
  })

  it('stops cleaning when the lease is stolen mid-loop', async () => {
    world.cleanable = [cleanable(GRANDPARENT), cleanable('55555555-5555-4555-8555-555555555555')]
    world.leaseHeld = false
    const c = context()

    expect(await executeImportPublish(c.input)).toBe('succeeded')
    expect(calls.chDeleted).toEqual([GRANDPARENT])
  })
})

describe('import_publish — abandonment', () => {
  it('returns the run to ready_for_review when the job is given up on', async () => {
    // `publishing` is inside the live-run unique's predicate: leaving a run
    // there would block every later import of the site while the pointer still
    // named the old run.
    const { logger } = createCapturedLogger()
    const metrics = createRecordingMetrics()
    await IMPORT_PUBLISH_REGISTRATION.onTerminal?.(
      {
        id: 'job-1',
        type: 'import_publish',
        subjectId: SITE,
        payload: { import_run_id: RUN },
        phase: 'publishing',
        attempts: 100,
        claimedBy: 'w-1',
        leaseExpiresAt: new Date(),
        createdAt: new Date(),
      },
      'attempts exhausted',
      { db: {} as Database, logger, metrics },
    )

    expect(calls.transitions).toMatchObject([{ from: ['publishing'], to: 'ready_for_review' }])
  })
})
