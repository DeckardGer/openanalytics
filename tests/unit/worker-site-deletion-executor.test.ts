import { DELETION_CLICKHOUSE_TARGETS } from '@openanalytics/domain'
import type { Database } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { encodeSiteQueueIndexEntry, siteQueueIndexKey, utcDayOffset } from '@openanalytics/redis'
import { createRecordingMetrics } from '@openanalytics/observability'
import { createCapturedLogger } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The site-deletion phase machine (ADR-0030, decision 4).
 *
 * Every store is faked here on purpose. What this suite proves is the *ordering
 * and the resumability* — which phase runs when, what makes it wait rather than
 * fail, and what a re-entry skips — and those are properties of the executor's
 * control flow, not of Redis, ClickHouse or Postgres. The SQL has
 * `tests/migration/site-deletion.test.ts`; the ClickHouse mutation has the live
 * suite in `tests/migration/clickhouse-maintenance.test.ts`.
 *
 * The rules asserted, in the order they matter:
 *
 * 1. A phase is only entered after the durable `jobs.phase` write, so a crash
 *    resumes at the phase that was running rather than one before it.
 * 2. Waiting is a returned `retry`, never a throw — a deletion may wait days on
 *    a drain and must still hold its full `JOB_MAX_ATTEMPTS` budget for the
 *    ClickHouse work that follows.
 * 3. A stolen lease stops the run before it touches a store.
 * 4. A re-entry skips every `completed` target and re-verifies nothing.
 */

const REQUEST = '11111111-1111-4111-8111-111111111111'
const SITE = '22222222-2222-4222-8222-222222222222'

type TargetRow = {
  id: string
  store: 'clickhouse' | 'redis' | 'postgres' | 'object'
  target: string
  phase: 'pending' | 'running' | 'completed'
  attempts: number
  verified: boolean
  mutationId: string | null
  lastError: string | null
  verification: Record<string, unknown> | null
}

const state = {
  context: {
    siteId: SITE,
    status: 'deleting' as string,
    ingestGeneration: 2,
    requestStatus: 'pending' as string,
    requestedAt: new Date('2026-07-28T00:00:00.000Z'),
  } as {
    siteId: string
    status: string
    ingestGeneration: number
    requestStatus: string
    requestedAt: Date
  } | null,
  inFlight: 0,
  finalizerClaimable: true,
  targets: [] as TargetRow[],
  members: ['aaaaaaaa-0000-4000-8000-000000000001'],
}

const calls = {
  markRunning: [] as string[],
  finalizerClaims: [] as string[],
  purgedPostgres: [] as string[],
  finalized: [] as { deletionRequestId: string; siteId: string }[],
  markFailed: [] as { deletionRequestId?: string; siteId: string; reason: string }[],
}

const readSiteDeletionContext = vi.fn(
  async (_db: unknown, _id: string) => await Promise.resolve(state.context),
)
const countInFlightWriters = vi.fn(
  async (_db: unknown, _input: { siteId: string; currentGeneration: number }) =>
    await Promise.resolve(state.inFlight),
)
const markDeletionRequestRunning = vi.fn(async (_db: unknown, id: string) => {
  calls.markRunning.push(id)
  await Promise.resolve()
})
const claimFinalizerSite = vi.fn(async (_db: unknown, input: { claimedBy: string }) => {
  calls.finalizerClaims.push(input.claimedBy)
  return state.finalizerClaimable ? { finalizedThrough: new Date(0), runSeq: 0 } : null
})
const listDeletionTargets = vi.fn(
  async (_db: unknown, input: { store?: TargetRow['store'] }) =>
    await Promise.resolve(
      input.store === undefined
        ? state.targets
        : state.targets.filter((row) => row.store === input.store),
    ),
)
const updateDeletionTarget = vi.fn(
  async (
    _db: unknown,
    input: {
      targetId: string
      phase?: TargetRow['phase']
      verified?: boolean
      verification?: Record<string, unknown>
      mutationId?: string | null
      lastError?: string | null
    },
  ) => {
    const row = state.targets.find((target) => target.id === input.targetId)
    if (row) {
      if (input.phase !== undefined) row.phase = input.phase
      if (input.verified !== undefined) row.verified = input.verified
      if (input.verification !== undefined) row.verification = input.verification
      if (input.mutationId !== undefined) row.mutationId = input.mutationId
      if (input.lastError !== undefined) row.lastError = input.lastError
    }
    await Promise.resolve()
  },
)
const purgeSitePostgres = vi.fn(async (_db: unknown, input: { siteId: string }) => {
  calls.purgedPostgres.push(input.siteId)
  return { deleted: { site_members: 3, api_keys: 1 } }
})
const listSiteMemberUserIds = vi.fn(
  async (_db: unknown, _siteId: string) => await Promise.resolve(state.members),
)
const finalizeSiteDeletion = vi.fn(
  async (_db: unknown, input: { deletionRequestId: string; siteId: string }) => {
    calls.finalized.push(input)
    await Promise.resolve()
  },
)
const markSiteDeletionFailed = vi.fn(
  async (_db: unknown, input: { deletionRequestId?: string; siteId: string; reason: string }) => {
    calls.markFailed.push(input)
    await Promise.resolve()
  },
)

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    readSiteDeletionContext: (db: unknown, id: never) => readSiteDeletionContext(db, id),
    countInFlightWriters: (db: unknown, input: never) => countInFlightWriters(db, input),
    markDeletionRequestRunning: (db: unknown, id: string) => markDeletionRequestRunning(db, id),
    claimFinalizerSite: (db: unknown, input: never) => claimFinalizerSite(db, input),
    listDeletionTargets: (db: unknown, input: never) => listDeletionTargets(db, input),
    updateDeletionTarget: (db: unknown, input: never) => updateDeletionTarget(db, input),
    purgeSitePostgres: (db: unknown, input: never) => purgeSitePostgres(db, input),
    listSiteMemberUserIds: (db: unknown, id: never) => listSiteMemberUserIds(db, id),
    finalizeSiteDeletion: (db: unknown, input: never) => finalizeSiteDeletion(db, input),
    markSiteDeletionFailed: (db: unknown, input: never) => markSiteDeletionFailed(db, input),
  }
})

const { SITE_DELETION_REGISTRATION, executeSiteDeletion } =
  await import('../../apps/worker/src/jobs/site-deletion.ts')
const { SITE_DELETION_TARGETS } = await import('@openanalytics/domain')

/** A fake Redis client that records every command it was asked to run. The range
 * reads honour `start`/`stop` the way Redis does (inclusive, clamped), which is
 * what makes the paged day-bucket walk observable. */
function fakeRedis(seed: Record<string, string[]> = {}) {
  const commands: { op: string; key: string; args: string[] }[] = []
  return {
    commands,
    async lrange(key: string, start: number, stop: number): Promise<string[]> {
      commands.push({ op: 'lrange', key, args: [String(start), String(stop)] })
      const list = seed[key] ?? []
      return await Promise.resolve(stop < 0 ? list.slice(start) : list.slice(start, stop + 1))
    },
    async zrange(key: string, start: number, stop: number): Promise<string[]> {
      commands.push({ op: 'zrange', key, args: [String(start), String(stop)] })
      const list = seed[key] ?? []
      return await Promise.resolve(stop < 0 ? list.slice(start) : list.slice(start, stop + 1))
    },
    async xdel(key: string, ...ids: string[]): Promise<number> {
      commands.push({ op: 'xdel', key, args: ids })
      return await Promise.resolve(ids.length)
    },
    async del(...keys: string[]): Promise<number> {
      for (const key of keys) commands.push({ op: 'del', key, args: [] })
      return await Promise.resolve(keys.length)
    },
  }
}

function fakeClickhouse(overrides: { done?: boolean; failReason?: string; rows?: number } = {}) {
  const submitted: string[] = []
  return {
    submitted,
    submitSiteDelete: async (table: string) => {
      submitted.push(table)
      return await Promise.resolve({ mutationId: `mut-${table}` })
    },
    pollMutation: async () =>
      await Promise.resolve({
        done: overrides.done ?? true,
        failReason: overrides.failReason ?? null,
        missing: false,
      }),
    countSiteRows: async () => await Promise.resolve(overrides.rows ?? 0),
    ping: async () => await Promise.resolve(true),
    close: async () => {
      await Promise.resolve()
    },
  }
}

const POLICY = {
  siteQueueIndexTtlDays: 2,
  ingestConfigCacheTtlSeconds: 30,
  deletionAcceptanceMarginMs: 30_000,
  ceilingAlertConsecutiveDays: 3,
  leaseTtlMs: 60_000,
}

interface Harness {
  phases: string[]
  leaseHeld: { value: boolean }
  extends: number
  find: ReturnType<typeof createCapturedLogger>['find']
  metrics: ReturnType<typeof createRecordingMetrics>
  context: Parameters<typeof executeSiteDeletion>[0]
}

function harness(
  options: {
    phase?: string | null
    payload?: Record<string, unknown>
    resources?: Record<string, unknown>
  } = {},
): Harness {
  const phases: string[] = []
  const leaseHeld = { value: true }
  let extendCount = 0
  const { logger, find } = createCapturedLogger()
  const metrics = createRecordingMetrics()

  const context = {
    job: {
      id: 'job-1',
      type: 'site_deletion',
      subjectId: SITE,
      payload: options.payload ?? { deletion_request_id: REQUEST },
      phase: options.phase ?? null,
      attempts: 1,
      claimedBy: 'w-1',
      leaseExpiresAt: new Date(),
      createdAt: new Date(),
    },
    db: {} as Database,
    logger,
    metrics,
    resources: {
      deletionPolicy: POLICY,
      ...options.resources,
    },
    extendLease: async () => {
      extendCount += 1
      return await Promise.resolve(leaseHeld.value)
    },
    updatePhase: async (phase: string) => {
      if (!leaseHeld.value) return await Promise.resolve(false)
      phases.push(phase)
      return await Promise.resolve(true)
    },
  } as unknown as Parameters<typeof executeSiteDeletion>[0]

  return {
    phases,
    leaseHeld,
    get extends() {
      return extendCount
    },
    find,
    metrics,
    context,
  }
}

/** Every target as the start transaction snapshots it: pending, unverified. */
function freshTargets(): TargetRow[] {
  return SITE_DELETION_TARGETS.map((target, index) => ({
    id: `t-${String(index)}`,
    store: target.store as TargetRow['store'],
    target: target.target,
    phase: 'pending' as const,
    attempts: 0,
    verified: false,
    mutationId: null,
    lastError: null,
    // The object target carries its key list from the snapshot; every other
    // store derives its work from an index it can still reach.
    verification: target.store === 'object' ? { keys: [] } : null,
  }))
}

const READY_RESOURCES = () => ({
  queue: fakeRedis(),
  realtime: fakeRedis(),
  clickhouse: fakeClickhouse(),
})

beforeEach(() => {
  state.context = {
    siteId: SITE,
    status: 'deleting',
    ingestGeneration: 2,
    requestStatus: 'pending',
    // Well in the past, so the acceptance clock has elapsed unless a test says
    // otherwise.
    requestedAt: new Date(Date.now() - 600_000),
  }
  state.inFlight = 0
  state.finalizerClaimable = true
  state.targets = freshTargets()
  state.members = ['aaaaaaaa-0000-4000-8000-000000000001']
  calls.markRunning = []
  calls.finalizerClaims = []
  calls.purgedPostgres = []
  calls.finalized = []
  calls.markFailed = []
  vi.clearAllMocks()
})

describe('site_deletion executor — the terminal hook', () => {
  const runHook = async (payload: Record<string, unknown>, subjectId: string | null = SITE) => {
    await SITE_DELETION_REGISTRATION.onTerminal?.(
      {
        id: 'job-s1',
        type: 'site_deletion',
        subjectId,
        payload,
        phase: 'clickhouse_purge',
        attempts: 100,
        claimedBy: 'w-1',
        leaseExpiresAt: new Date(),
        createdAt: new Date(),
      },
      'attempts exhausted: clickhouse unavailable',
      { db: {} as Database } as unknown as Parameters<
        NonNullable<typeof SITE_DELETION_REGISTRATION.onTerminal>
      >[2],
    )
  }

  it('marks the request failed so the site is not stuck deleting forever', async () => {
    // The site keeps its `deleting` status — its data is half-purged and its
    // keys are revoked — but the *request* must leave the live set, because
    // `startSiteDeletion` decides what to do by finding exactly that row. A
    // pending request behind a dead job is a site nobody is deleting that every
    // later DELETE reports as being deleted.
    await runHook({ deletion_request_id: REQUEST, reason: 'user_requested' })

    expect(calls.markFailed).toEqual([
      {
        deletionRequestId: REQUEST,
        siteId: SITE,
        reason: 'attempts exhausted: clickhouse unavailable',
      },
    ])
  })

  it('settles by site alone when the payload never named a request', async () => {
    // The bad-row terminal. There is still a site stuck `deleting`, and its live
    // request — whatever produced it — is the thing that has to stop claiming.
    await runHook({ reason: 'retention_expired' })

    expect(calls.markFailed).toEqual([
      { siteId: SITE, reason: 'attempts exhausted: clickhouse unavailable' },
    ])
  })

  it('does nothing for a job with no subject at all', async () => {
    await runHook({ deletion_request_id: REQUEST }, null)
    expect(calls.markFailed).toEqual([])
  })
})

describe('site_deletion executor — the happy path', () => {
  it('runs every phase in order and finishes with the tombstone', async () => {
    const h = harness({ resources: READY_RESOURCES() })

    const outcome = await executeSiteDeletion(h.context)

    expect(outcome).toBe('succeeded')
    expect(h.phases).toEqual([
      'fence_drain',
      'finalizer_fence',
      'redis_purge',
      'object_purge',
      'clickhouse_purge',
      'postgres_purge',
      'verify_finalize',
    ])
    expect(calls.markRunning).toEqual([REQUEST])
    expect(calls.purgedPostgres).toEqual([SITE])
    expect(calls.finalized).toEqual([{ deletionRequestId: REQUEST, siteId: SITE }])
    // Every one of the 51 snapshot rows ends completed and verified; the
    // tombstone is written only against that.
    expect(state.targets.every((target) => target.phase === 'completed' && target.verified)).toBe(
      true,
    )
  })

  it('meters every phase entry, so a job waiting still reports movement', async () => {
    const h = harness({ resources: READY_RESOURCES() })
    await executeSiteDeletion(h.context)

    const entered = h.metrics.recorded
      .filter((entry) => entry.name === 'worker_deletion_phase')
      .map((entry) => entry.labels?.['phase'])
    expect(entered).toEqual([
      'fence_drain',
      'finalizer_fence',
      'redis_purge',
      'object_purge',
      'clickhouse_purge',
      'postgres_purge',
      'verify_finalize',
    ])
  })

  it('reads the site members before the postgres purge deletes them', async () => {
    // The whole reason `redis_purge` precedes `postgres_purge`: the epoch keys
    // are addressable only from the membership rows the purge removes.
    const h = harness({ resources: READY_RESOURCES() })
    await executeSiteDeletion(h.context)

    expect(listSiteMemberUserIds).toHaveBeenCalled()
    const memberReadOrder = listSiteMemberUserIds.mock.invocationCallOrder[0] as number
    const purgeOrder = purgeSitePostgres.mock.invocationCallOrder[0] as number
    expect(memberReadOrder).toBeLessThan(purgeOrder)
  })
})

describe('site_deletion executor — fence_drain', () => {
  it('waits out the config cache TTL plus the acceptance margin', async () => {
    // Started five seconds ago: TTL (30 s) + margin (30 s) has not elapsed.
    state.context = { ...state.context!, requestedAt: new Date(Date.now() - 5_000) }
    const h = harness({ resources: READY_RESOURCES() })

    const outcome = await executeSiteDeletion(h.context)

    expect(outcome).toEqual({ retry: { delayMs: 5_000 } })
    // The clock is checked before the ledger: no point asking Postgres a
    // question whose answer cannot yet matter.
    expect(countInFlightWriters).not.toHaveBeenCalled()
    expect(h.phases).toEqual(['fence_drain'])
  })

  it('waits while a writer is still registered at a superseded generation', async () => {
    state.inFlight = 1
    const h = harness({ resources: READY_RESOURCES() })

    const outcome = await executeSiteDeletion(h.context)

    expect(outcome).toEqual({ retry: { delayMs: 5_000 } })
    expect(calls.markRunning).toEqual([])
    expect(h.find('site_deletion_draining')).toHaveLength(1)
  })

  it('advances once the clock has elapsed and the ledger is empty', async () => {
    const h = harness({ resources: READY_RESOURCES() })
    await executeSiteDeletion(h.context)

    expect(countInFlightWriters).toHaveBeenCalledWith(expect.anything(), {
      siteId: SITE,
      currentGeneration: 2,
    })
  })
})

describe('site_deletion executor — finalizer_fence', () => {
  it('retries until the live finalizer run releases its lease', async () => {
    state.finalizerClaimable = false
    const h = harness({ resources: READY_RESOURCES() })

    const outcome = await executeSiteDeletion(h.context)

    expect(outcome).toEqual({ retry: { delayMs: 5_000 } })
    expect(h.phases).toEqual(['fence_drain', 'finalizer_fence'])
    expect(h.find('site_deletion_finalizer_busy')).toHaveLength(1)
    // Nothing was purged: the fence is what stops a finalizer writing rows after
    // a verified purge, so no purge may start before it holds.
    expect(calls.purgedPostgres).toEqual([])
  })

  it('holds the lease under a job-scoped identity through every purge phase', async () => {
    const h = harness({ resources: READY_RESOURCES() })
    await executeSiteDeletion(h.context)

    // Claimed at the fence, then re-taken at the top of clickhouse_purge and
    // postgres_purge. Never in verify_finalize: the row it lived on is gone, and
    // the claim is an upsert that would resurrect it.
    expect(calls.finalizerClaims).toEqual(['deletion:job-1', 'deletion:job-1', 'deletion:job-1'])
  })
})

describe('site_deletion executor — missing resources', () => {
  it('waits, meters and logs rather than failing when Redis is not configured', async () => {
    const h = harness({ resources: { clickhouse: fakeClickhouse() } })

    const outcome = await executeSiteDeletion(h.context)

    expect(outcome).toEqual({ retry: { delayMs: 30_000 } })
    expect(h.find('site_deletion_redis_unavailable')).toHaveLength(1)
    expect(h.metrics.recorded).toContainEqual(
      expect.objectContaining({
        name: 'worker_deletion_target_failed',
        labels: { store: 'redis' },
      }),
    )
  })

  it('waits when the oa_maintenance ClickHouse credential is absent', async () => {
    const h = harness({ resources: { queue: fakeRedis(), realtime: fakeRedis() } })

    const outcome = await executeSiteDeletion(h.context)

    expect(outcome).toEqual({ retry: { delayMs: 30_000 } })
    expect(h.find('site_deletion_clickhouse_unavailable')).toHaveLength(1)
    // Redis was purged first and stays purged — the phases are independent, so a
    // missing credential does not undo work already verified.
    expect(
      state.targets
        .filter((target) => target.store === 'redis')
        .every((t) => t.phase === 'completed'),
    ).toBe(true)
  })
})

describe('site_deletion executor — redis_purge', () => {
  it('pages the day-bucket read rather than pulling the whole list', async () => {
    // A busy site's bucket holds one entry per accepted event. `lrange(key, 0,
    // -1)` would materialise all of them in the worker's heap and in one reply
    // buffer; the walk is bounded by REDIS_CHUNK (500) instead.
    const bucket = siteQueueIndexKey(SITE, utcDayOffset(new Date(), 0))
    const entries = Array.from({ length: 1_200 }, (_unused, index) =>
      encodeSiteQueueIndexEntry(`${String(1_700_000_000_000 + index)}-0`, `evt-${String(index)}`),
    )
    const queue = fakeRedis({ [bucket]: entries })
    const h = harness({
      resources: { queue, realtime: fakeRedis(), clickhouse: fakeClickhouse() },
    })

    expect(await executeSiteDeletion(h.context)).toBe('succeeded')

    // Three inclusive windows, the last one short — which is what ends the walk.
    expect(
      queue.commands.filter((c) => c.op === 'lrange' && c.key === bucket).map((c) => c.args),
    ).toEqual([
      ['0', '499'],
      ['500', '999'],
      ['1000', '1499'],
    ])
    // Paging must not lose entries: every stream id and every dedup key of all
    // three pages is removed.
    expect(queue.commands.filter((c) => c.op === 'xdel').flatMap((c) => c.args)).toHaveLength(1_200)
    expect(
      queue.commands.filter((c) => c.op === 'del' && c.key.startsWith('ingest_dedup:')),
    ).toHaveLength(1_200)
    // And the bucket itself is deleted once, after the walk.
    expect(queue.commands.filter((c) => c.op === 'del' && c.key === bucket)).toHaveLength(1)
  })

  it('records last_error and meters the store when a redis command throws', async () => {
    // Without this the target sits `running` with a NULL `last_error` — the one
    // state the table exists to explain. The throw itself is deliberate: it is
    // what the runner counts as a failed attempt and retries with backoff, as
    // distinct from a returned `retry`, which is a decision to wait.
    const queue = fakeRedis()
    queue.lrange = async () => {
      await Promise.resolve()
      throw new Error('LOADING Redis is loading the dataset in memory')
    }
    const h = harness({
      resources: { queue, realtime: fakeRedis(), clickhouse: fakeClickhouse() },
    })

    await expect(executeSiteDeletion(h.context)).rejects.toThrow(/LOADING/u)

    const target = state.targets.find((t) => t.target === 'queue_index')
    expect(target?.phase).toBe('running')
    expect(target?.lastError).toContain('LOADING')
    expect(h.metrics.recorded).toContainEqual(
      expect.objectContaining({
        name: 'worker_deletion_target_failed',
        labels: { store: 'redis' },
      }),
    )
  })
})

describe('site_deletion executor — object_purge', () => {
  /** Point the object target at some keys, as the start transaction would. */
  const withObjectKeys = (keys: string[]): void => {
    for (const target of state.targets) {
      if (target.store === 'object') target.verification = { keys }
    }
  }

  /** A bucket that records what it was asked to remove and answers `head`
   * from what it has removed — the only shape in which "prove it is gone" is a
   * real assertion rather than a restatement of the delete call. */
  function fakeBucket(options: { stubborn?: string[] } = {}) {
    const deleted: string[] = []
    return {
      deleted,
      delete: async (refs: readonly { key: string }[]) => {
        for (const ref of refs) deleted.push(ref.key)
        await Promise.resolve()
      },
      head: async (ref: { key: string }) =>
        await Promise.resolve(
          options.stubborn?.includes(ref.key) === true
            ? {
                key: ref.key,
                size: 1,
                contentType: 'application/zip',
                lastModified: new Date(0),
                etag: '',
              }
            : null,
        ),
    }
  }

  it('completes trivially for a site that never imported anything', async () => {
    // Most sites are this one. A target that could not be worked would have to
    // be either skipped or waited on forever, and both are worse than an honest
    // empty completion — which is why the row is written even for a site with
    // no keys.
    const h = harness({ resources: READY_RESOURCES() })

    expect(await executeSiteDeletion(h.context)).toBe('succeeded')
    const target = state.targets.find((t) => t.store === 'object')
    expect(target?.phase).toBe('completed')
    expect(target?.verified).toBe(true)
    expect(target?.verification).toMatchObject({ keys: [], deleted: 0 })
  })

  it('deletes the snapshotted keys and verifies each one is gone', async () => {
    // The keys come from the snapshot, not from a live read: the port has no
    // `list`, and by `verify_finalize` the `import_uploads` rows they were read
    // from no longer exist.
    const keys = [`imports/${SITE}/r1/archive.zip`, `imports/${SITE}/r2/archive.zip`]
    withObjectKeys(keys)
    const storage = fakeBucket()
    const h = harness({ resources: { ...READY_RESOURCES(), objectStorage: storage } })

    expect(await executeSiteDeletion(h.context)).toBe('succeeded')
    expect(storage.deleted).toEqual(keys)
    const target = state.targets.find((t) => t.store === 'object')
    // Both halves are kept: the list is the evidence of what this deletion
    // promised to remove, which an operator reading the row later still needs.
    expect(target?.verification).toMatchObject({ keys, deleted: 2 })
  })

  it('waits — never skips — when the bucket is not configured but keys exist', async () => {
    // A phase reporting "nothing to purge" because a credential was missing
    // would be a deletion claiming to have erased bytes it never reached.
    withObjectKeys([`imports/${SITE}/r1/archive.zip`])
    const h = harness({ resources: READY_RESOURCES() })

    const outcome = await executeSiteDeletion(h.context)

    expect(outcome).toEqual({ retry: { delayMs: 30_000 } })
    expect(h.find('site_deletion_object_storage_unavailable')).toHaveLength(1)
    expect(h.metrics.recorded).toContainEqual(
      expect.objectContaining({
        name: 'worker_deletion_target_failed',
        labels: { store: 'object' },
      }),
    )
    // And nothing downstream ran: the phase order is what stops a later phase
    // from advancing past unfinished work.
    expect(state.targets.find((t) => t.store === 'object')?.verified).toBe(false)
    expect(calls.purgedPostgres).toEqual([])
  })

  it('refuses to complete a target whose object still heads', async () => {
    // `delete` is idempotent by contract and therefore cannot itself tell
    // "removed it" from "storage never saw it". An observation of absence is
    // the only evidence that counts — the same rule the ClickHouse phase's
    // `count() = 0` follows.
    const key = `imports/${SITE}/r1/archive.zip`
    withObjectKeys([key])
    const h = harness({
      resources: { ...READY_RESOURCES(), objectStorage: fakeBucket({ stubborn: [key] }) },
    })

    const outcome = await executeSiteDeletion(h.context)

    expect(outcome).toEqual({ retry: { delayMs: 30_000 } })
    const target = state.targets.find((t) => t.store === 'object')
    expect(target?.verified).toBe(false)
    expect(target?.lastError).toContain('still exist')
  })

  it('rewinds to object_purge when the object target is the unfinished one', async () => {
    // `phaseForStore` has to name the store explicitly: before ADR-0032 an
    // unknown store fell through to `redis_purge`, which would re-run the whole
    // Redis walk to reach a phase that follows it.
    for (const target of state.targets) {
      target.phase = 'completed'
      target.verified = target.store !== 'object'
    }
    const h = harness({ phase: 'verify_finalize', resources: READY_RESOURCES() })

    await executeSiteDeletion(h.context)

    expect(h.phases).toEqual(['verify_finalize', 'object_purge'])
    expect(h.find('site_deletion_targets_unfinished')[0]?.['resume_phase']).toBe('object_purge')
  })
})

describe('site_deletion executor — clickhouse_purge', () => {
  it('records the mutation id, then verifies with a count before completing', async () => {
    const clickhouse = fakeClickhouse()
    const h = harness({
      resources: { queue: fakeRedis(), realtime: fakeRedis(), clickhouse },
    })

    await executeSiteDeletion(h.context)

    expect(clickhouse.submitted).toHaveLength(DELETION_CLICKHOUSE_TARGETS.length)
    const chTargets = state.targets.filter((target) => target.store === 'clickhouse')
    expect(chTargets.every((target) => target.mutationId?.startsWith('mut-') === true)).toBe(true)
    expect(chTargets.every((target) => target.verified)).toBe(true)
  })

  it('records latest_fail_reason, meters the failure and retries', async () => {
    // A target that already carries a mutation id is polled rather than
    // re-submitted — the resume path.
    for (const target of state.targets) {
      if (target.store === 'clickhouse') target.mutationId = 'mut-existing'
    }
    const clickhouse = fakeClickhouse({ done: false, failReason: 'MEMORY_LIMIT_EXCEEDED' })
    const h = harness({
      resources: { queue: fakeRedis(), realtime: fakeRedis(), clickhouse },
    })

    const outcome = await executeSiteDeletion(h.context)

    expect(outcome).toEqual({ retry: { delayMs: 10_000 } })
    expect(clickhouse.submitted).toEqual([])
    expect(state.targets.find((t) => t.store === 'clickhouse')?.lastError).toBe(
      'MEMORY_LIMIT_EXCEEDED',
    )
    expect(h.metrics.recorded).toContainEqual(
      expect.objectContaining({
        name: 'worker_deletion_target_failed',
        labels: { store: 'clickhouse' },
      }),
    )
  })

  it('keeps the mutation id it just recorded while the mutation is still running', async () => {
    // The resubmit loop this guards against: a freshly submitted mutation has
    // almost always not finished when the count is taken, and clearing the id on
    // that reading would make every pass submit a *new* mutation over the same
    // part set, forever.
    const clickhouse = fakeClickhouse({ rows: 5 })
    const h = harness({
      resources: { queue: fakeRedis(), realtime: fakeRedis(), clickhouse },
    })

    const outcome = await executeSiteDeletion(h.context)

    expect(outcome).toEqual({ retry: { delayMs: 10_000 } })
    const target = state.targets.find((t) => t.store === 'clickhouse')
    expect(target?.mutationId).toBe('mut-events_raw')
    // Not an anomaly — nothing reported itself done — so no error is recorded.
    expect(target?.lastError).toBeNull()
    expect(clickhouse.submitted).toHaveLength(DELETION_CLICKHOUSE_TARGETS.length)
  })

  it('refuses to complete a target whose count is not zero', async () => {
    for (const target of state.targets) {
      if (target.store === 'clickhouse') target.mutationId = 'mut-existing'
    }
    const h = harness({
      resources: {
        queue: fakeRedis(),
        realtime: fakeRedis(),
        // `is_done` says finished; the table still has rows. `is_done` is
        // progress, `count()` is truth.
        clickhouse: fakeClickhouse({ done: true, rows: 7 }),
      },
    })

    const outcome = await executeSiteDeletion(h.context)

    expect(outcome).toEqual({ retry: { delayMs: 10_000 } })
    const target = state.targets.find((t) => t.store === 'clickhouse')
    expect(target?.verified).toBe(false)
    // The id is cleared so the next attempt re-submits rather than polling a
    // mutation that has already reported itself done.
    expect(target?.mutationId).toBeNull()
    expect(target?.lastError).toContain('7 rows remaining')
  })
})

describe('site_deletion executor — resumability', () => {
  it('resumes at the recorded phase and skips completed targets', async () => {
    for (const target of state.targets) {
      if (target.store !== 'postgres') {
        target.phase = 'completed'
        target.verified = true
      }
    }
    const clickhouse = fakeClickhouse()
    const h = harness({
      phase: 'clickhouse_purge',
      resources: { queue: fakeRedis(), realtime: fakeRedis(), clickhouse },
    })

    const outcome = await executeSiteDeletion(h.context)

    expect(outcome).toBe('succeeded')
    // The drain and the fence are behind it; the phases before the recorded one
    // are never re-entered.
    expect(h.phases).toEqual(['clickhouse_purge', 'postgres_purge', 'verify_finalize'])
    // No mutation re-submitted: a completed ClickHouse target is skipped, which
    // is what makes the resume cheap rather than a second full purge.
    expect(clickhouse.submitted).toEqual([])
    expect(calls.finalized).toHaveLength(1)
  })

  it('succeeds immediately when the request is already completed', async () => {
    state.context = { ...state.context!, requestStatus: 'completed' }
    const h = harness({ resources: READY_RESOURCES() })

    expect(await executeSiteDeletion(h.context)).toBe('succeeded')
    // A lease stolen after the final transaction committed replays into this
    // branch; re-running the phases would re-purge nothing but would re-claim a
    // finalizer row the purge deleted.
    expect(h.phases).toEqual([])
  })

  it('waits in verify_finalize while a target is unverified', async () => {
    for (const target of state.targets) {
      target.phase = 'completed'
      target.verified = target.store !== 'clickhouse'
    }
    const h = harness({ phase: 'verify_finalize', resources: READY_RESOURCES() })

    const outcome = await executeSiteDeletion(h.context)

    expect(outcome).toEqual({ retry: { delayMs: 10_000 } })
    expect(calls.finalized).toEqual([])
    expect(h.find('site_deletion_targets_unfinished')).toHaveLength(1)
  })

  it('rewinds the phase to the store that owns the unfinished target', async () => {
    // Without the rewind the job resumes at `verify_finalize` on every claim,
    // re-reads the same table, finds the same unfinished target and returns the
    // same retry — forever, because nothing between two passes runs a purge.
    for (const target of state.targets) {
      target.phase = 'completed'
      target.verified = target.store !== 'clickhouse'
    }
    const h = harness({ phase: 'verify_finalize', resources: READY_RESOURCES() })

    const outcome = await executeSiteDeletion(h.context)

    expect(outcome).toEqual({ retry: { delayMs: 10_000 } })
    expect(h.phases).toEqual(['verify_finalize', 'clickhouse_purge'])
    expect(h.find('site_deletion_targets_unfinished')[0]?.['resume_phase']).toBe('clickhouse_purge')
  })

  it('rewinds to the EARLIEST outstanding store when several are unfinished', async () => {
    // `redis_purge` precedes `clickhouse_purge`, and a rewind that landed on the
    // later one would leave the Redis target permanently unworked.
    for (const target of state.targets) {
      target.phase = 'completed'
      target.verified = target.store === 'postgres'
    }
    const h = harness({ phase: 'verify_finalize', resources: READY_RESOURCES() })

    await executeSiteDeletion(h.context)

    expect(h.phases).toEqual(['verify_finalize', 'redis_purge'])
  })

  it('claims no finalizer lease when postgres_purge has nothing left to do', async () => {
    // `claimFinalizerSite` is an UPSERT, so re-entering the phase after a
    // successful purge would *re-create* the `session_finalizer_state` row the
    // purge deleted and then advance, leaving it behind for a site whose events
    // no longer exist. A phase with no outstanding target must touch nothing.
    for (const target of state.targets) {
      target.phase = 'completed'
      target.verified = true
    }
    const h = harness({ phase: 'postgres_purge', resources: READY_RESOURCES() })

    expect(await executeSiteDeletion(h.context)).toBe('succeeded')
    expect(calls.finalizerClaims).toEqual([])
    expect(calls.purgedPostgres).toEqual([])
    expect(calls.finalized).toHaveLength(1)
  })
})

describe('site_deletion executor — a payload with no request', () => {
  it('is terminal, which is why the sweeper must run the start transaction', async () => {
    // The lifecycle sweeper used to enqueue `{reason: 'retention_expired'}` on
    // its own. This is what such a job did: settled terminal on its first claim,
    // with no deletion_request, no target snapshot and no `deleting` status ever
    // written. The sweeper now calls `startSiteDeletion`, which produces all
    // three in one transaction and enqueues the job itself.
    const h = harness({ payload: { reason: 'retention_expired' } })

    const outcome = await executeSiteDeletion(h.context)

    expect(outcome).toEqual({
      terminal: { reason: expect.stringContaining('deletion_request_id') as unknown as string },
    })
    expect(h.phases).toEqual([])
  })
})

describe('site_deletion executor — lease loss', () => {
  it('stops before touching any store when the phase write is refused', async () => {
    const h = harness({ resources: READY_RESOURCES() })
    h.leaseHeld.value = false

    const outcome = await executeSiteDeletion(h.context)

    // A retry the runner's guarded write will refuse, which is how it becomes a
    // `lost` settlement rather than a counted failure.
    expect(outcome).toEqual({ retry: { delayMs: 5_000 } })
    expect(h.phases).toEqual([])
    expect(countInFlightWriters).not.toHaveBeenCalled()
    expect(h.find('site_deletion_lease_lost')).toHaveLength(1)
  })
})
