import type { Database, ExpiredImportUpload } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import type { ObjectStorage } from '@openanalytics/integrations'
import { createRecordingMetrics } from '@openanalytics/observability'
import { createCapturedLogger } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The lifecycle sweeper's abandoned-upload duty (ADR-0032, D7).
 *
 * A signed upload URL is handed to a browser and nothing guarantees the browser
 * comes back — a closed tab, a dropped connection, a change of mind. The run
 * then sits in `uploading` forever, and because a site may hold only one
 * non-terminal run (D3) it blocks *every later import of that site*. That is the
 * failure this sweep exists to prevent, and it is why the test asserts the state
 * change and the object deletion separately: freeing the slot is the correctness
 * half, and removing the bytes is the housekeeping half with the bucket's own
 * lifecycle rule behind it.
 *
 * The other two duties are stubbed to empty. They have their own Postgres suite
 * (`tests/migration/lifecycle-sweeper.test.ts`); what is asserted here is that
 * this one runs, in what order it does its two writes, and what it does when
 * each of its dependencies is missing.
 */

const SITE = '22222222-2222-4222-8222-222222222222'
const RUN_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const RUN_B = 'bbbbbbbb-0000-4000-8000-000000000002'

const world = {
  expired: [] as ExpiredImportUpload[],
  /** Whether the guarded transition matched. False models a run that a
   * `complete` call moved between the page read and this write. */
  moves: true,
  ttlSeen: [] as { ttlDays: number; limit: number }[],
}

const calls = {
  transitions: [] as {
    importRunId: string
    from: readonly string[]
    to: string
    errorCode?: string | null
  }[],
  deleted: [] as string[],
  /** Interleaving of the two side effects, so their order is assertable. */
  order: [] as string[],
}

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    listExpirableSubscriptions: async () => [],
    listSitesPastRetentionDeadline: async () => [],
    // The terminal-run cleanup backstop is the sibling duty and has its own
    // suite; stubbed empty here so this file asserts one duty at a time.
    listCleanableImportRuns: async () => [],
    listExpiredImportUploads: async (_db: unknown, input: { ttlDays: number; limit: number }) => {
      world.ttlSeen.push(input)
      return world.expired
    },
    transitionImportRun: async (
      _db: unknown,
      input: {
        importRunId: string
        from: readonly string[]
        to: string
        errorCode?: string | null
      },
    ) => {
      calls.transitions.push(input)
      calls.order.push(`transition:${input.importRunId}`)
      return world.moves
    },
  }
})

const { sweepLifecycleOnce } = await import('../../apps/worker/src/lifecycle/sweeper.ts')

function bucket(options: { fail?: boolean } = {}): ObjectStorage {
  return {
    async delete(refs: readonly { key: string }[]) {
      await Promise.resolve()
      if (options.fail === true) throw new Error('storage down')
      for (const ref of refs) {
        calls.deleted.push(ref.key)
        calls.order.push(`delete:${ref.key}`)
      }
    },
  } as unknown as ObjectStorage
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
      pageSize: 100,
      importUploadTtlDays: 7,
      ...overrides,
    } as Parameters<typeof sweepLifecycleOnce>[0],
  }
}

function expiredRun(id: string, key: string | null): ExpiredImportUpload {
  return { importRunId: id, siteId: SITE, objectKey: key }
}

beforeEach(() => {
  world.expired = []
  world.moves = true
  world.ttlSeen = []
  calls.transitions = []
  calls.deleted = []
  calls.order = []
})

describe('lifecycle sweeper — abandoned import uploads', () => {
  it('fails the run with `upload_expired` and deletes its archive', async () => {
    world.expired = [expiredRun(RUN_A, `imports/${SITE}/${RUN_A}/archive.zip`)]
    const d = deps({ objectStorage: bucket() })

    const result = await sweepLifecycleOnce(d.input)

    expect(result.importUploadsExpired).toBe(1)
    expect(calls.transitions).toEqual([
      {
        importRunId: RUN_A,
        // Both pre-upload states: a run that reached `uploaded` and whose
        // prepare job never ran is abandoned in exactly the same way.
        from: ['uploading', 'uploaded'],
        to: 'failed',
        // A safe category rendered to the customer, never a provider message.
        errorCode: 'upload_expired',
        finished: true,
      },
    ])
    expect(calls.deleted).toEqual([`imports/${SITE}/${RUN_A}/archive.zip`])
  })

  it('changes the state BEFORE touching the object', async () => {
    // The order is the correctness argument. The transition is guarded on
    // `('uploading','uploaded')`, so a run that a `complete` call moved between
    // the page read and this write simply does not match — and its archive is
    // then left alone. Deleting first would have destroyed the archive of a run
    // that had just legitimately become somebody's live import.
    world.expired = [expiredRun(RUN_A, `imports/${SITE}/${RUN_A}/archive.zip`)]
    await sweepLifecycleOnce(deps({ objectStorage: bucket() }).input)

    expect(calls.order).toEqual([
      `transition:${RUN_A}`,
      `delete:imports/${SITE}/${RUN_A}/archive.zip`,
    ])
  })

  it('leaves the archive alone when the run moved under it', async () => {
    world.expired = [expiredRun(RUN_A, `imports/${SITE}/${RUN_A}/archive.zip`)]
    world.moves = false

    const result = await sweepLifecycleOnce(deps({ objectStorage: bucket() }).input)

    // A normal outcome, not a failure: the candidate list is a hint and the
    // guard is the decision.
    expect(result.importUploadsExpired).toBe(0)
    expect(result.failures).toBe(0)
    expect(calls.deleted).toEqual([])
  })

  it('meters and logs each expiry so a broken upload path is visible', async () => {
    world.expired = [expiredRun(RUN_A, null), expiredRun(RUN_B, null)]
    const d = deps({ objectStorage: bucket() })

    await sweepLifecycleOnce(d.input)

    expect(
      d.metrics.recorded.filter((e) => e.name === 'worker_lifecycle_import_uploads_expired'),
    ).toHaveLength(2)
    expect(d.find('lifecycle_import_upload_expired')).toHaveLength(2)
  })

  it('still frees the site slot when object storage is not configured', async () => {
    // The state change is the half that matters: without it the site can never
    // import again. The bytes are reaped by the bucket's own `imports/` expiry
    // rule, which is the backstop for exactly this case.
    world.expired = [expiredRun(RUN_A, `imports/${SITE}/${RUN_A}/archive.zip`)]

    const result = await sweepLifecycleOnce(deps().input)

    expect(result.importUploadsExpired).toBe(1)
    expect(calls.deleted).toEqual([])
  })

  it('does not count a storage failure as a sweep failure', async () => {
    world.expired = [expiredRun(RUN_A, `imports/${SITE}/${RUN_A}/archive.zip`)]
    const d = deps({ objectStorage: bucket({ fail: true }) })

    const result = await sweepLifecycleOnce(d.input)

    // The run is already terminal and the lifecycle rule will reap the orphan;
    // treating this as a failure would re-report a run that is settled.
    expect(result.importUploadsExpired).toBe(1)
    expect(result.failures).toBe(0)
    expect(d.find('lifecycle_import_object_delete_failed')).toHaveLength(1)
  })

  it('passes the policy TTL and the page size through, and asks the DB for the deadline', async () => {
    // The deadline itself is decided in SQL against `now()` — `created_at` is
    // stamped by the database, and a worker clock running ahead would otherwise
    // expire a run whose upload is still in flight (the M10 rule). All this
    // duty supplies is the TTL, which is why no `now` is threaded into it.
    world.expired = []
    await sweepLifecycleOnce(deps({ importUploadTtlDays: 3, pageSize: 25 }).input)

    expect(world.ttlSeen).toEqual([{ ttlDays: 3, limit: 25 }])
  })

  it('does not run at all without a configured TTL', async () => {
    // Optional-until-used applied to a duty: a deployment that predates M11
    // keeps exactly its previous behaviour.
    const result = await sweepLifecycleOnce(deps({ importUploadTtlDays: undefined }).input)

    expect(world.ttlSeen).toEqual([])
    expect(result.importUploadsExpired).toBe(0)
  })
})
