import type { Database } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { createRecordingMetrics } from '@openanalytics/observability'
import { createCapturedLogger } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The account-deletion phase machine (ADR-0030, decision 8).
 *
 * Postgres and Stripe are both faked. What this suite proves is the *ordering
 * and the settlement policy* — which phase runs when, what makes it wait rather
 * than fail, what counts an attempt and what does not — and those are properties
 * of the executor's control flow. The SQL has
 * `tests/migration/account-deletion.test.ts`; the Stripe wire mapping has
 * `tests/unit/stripe-adapter.test.ts`.
 *
 * The rules asserted, in the order they matter:
 *
 * 1. Sites come first, and `deleting` is a wait while a live site is a terminal
 *    failure — the gate promised there was none, so one appearing is a
 *    precondition that something undid, not something to poll for.
 * 2. Stripe's cancellation is not complete until Stripe *confirms* it. An
 *    unreachable provider waits; a rejected request counts an attempt.
 * 3. A missing credential waits and says so, exactly as the ClickHouse
 *    maintenance user does — a half-provisioned host must not fail deletions.
 * 4. A re-entry skips completed targets and touches nothing.
 */

const REQUEST = '33333333-3333-4333-8333-333333333333'
const USER = '44444444-4444-4444-8444-444444444444'
const SUBSCRIPTION = 'sub_live_1'

type TargetRow = {
  id: string
  store: 'stripe' | 'postgres'
  target: string
  phase: 'pending' | 'running' | 'completed'
  attempts: number
  verified: boolean
  mutationId: string | null
  lastError: string | null
}

type SiteState = { siteId: string; slug: string; status: string }

const state = {
  context: {
    userId: USER,
    requestStatus: 'pending' as string,
    requestedAt: new Date('2026-07-28T00:00:00.000Z'),
    email: 'person@example.test',
  } as {
    userId: string
    requestStatus: string
    requestedAt: Date
    email: string | null
  } | null,
  sites: [] as SiteState[],
  subscriptionId: SUBSCRIPTION as string | null,
  targets: [] as TargetRow[],
  purgeThrows: null as Error | null,
}

const calls = {
  markRunning: [] as string[],
  markFailed: [] as { deletionRequestId: string; reason: string }[],
  purged: [] as string[],
  finalized: [] as { deletionRequestId: string; userId: string }[],
}

const readAccountDeletionContext = vi.fn(
  async (_db: unknown, _id: string) => await Promise.resolve(state.context),
)
const listBilledSiteStates = vi.fn(
  async (_db: unknown, _userId: string) => await Promise.resolve(state.sites),
)
const markAccountDeletionRunning = vi.fn(async (_db: unknown, id: string) => {
  calls.markRunning.push(id)
  await Promise.resolve()
})
const markAccountDeletionFailed = vi.fn(
  async (_db: unknown, input: { deletionRequestId: string; reason: string }) => {
    calls.markFailed.push(input)
    await Promise.resolve()
  },
)
const listDeletionTargets = vi.fn(
  async (_db: unknown, input: { store?: 'stripe' | 'postgres' }) =>
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
      lastError?: string | null
      countAttempt?: boolean
    },
  ) => {
    const row = state.targets.find((target) => target.id === input.targetId)
    if (row) {
      if (input.phase !== undefined) row.phase = input.phase
      if (input.verified !== undefined) row.verified = input.verified
      if (input.lastError !== undefined) row.lastError = input.lastError
      if (input.countAttempt === true) row.attempts += 1
    }
    await Promise.resolve()
  },
)
const purgeAccountPostgres = vi.fn(async (_db: unknown, input: { userId: string }) => {
  if (state.purgeThrows) throw state.purgeThrows
  calls.purged.push(input.userId)
  return { affected: { sessions: 2, user_tombstone: 1 }, scrubbedFrom: 'person@example.test' }
})
const finalizeAccountDeletion = vi.fn(
  async (_db: unknown, input: { deletionRequestId: string; userId: string }) => {
    calls.finalized.push(input)
    await Promise.resolve()
  },
)

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    readAccountDeletionContext: (db: unknown, id: never) => readAccountDeletionContext(db, id),
    listBilledSiteStates: (db: unknown, id: never) => listBilledSiteStates(db, id),
    markAccountDeletionRunning: (db: unknown, id: string) => markAccountDeletionRunning(db, id),
    markAccountDeletionFailed: (db: unknown, input: never) => markAccountDeletionFailed(db, input),
    listDeletionTargets: (db: unknown, input: never) => listDeletionTargets(db, input),
    updateDeletionTarget: (db: unknown, input: never) => updateDeletionTarget(db, input),
    purgeAccountPostgres: (db: unknown, input: never) => purgeAccountPostgres(db, input),
    finalizeAccountDeletion: (db: unknown, input: never) => finalizeAccountDeletion(db, input),
  }
})

const { ACCOUNT_DELETION_REGISTRATION, executeAccountDeletion } =
  await import('../../apps/worker/src/jobs/account-deletion.ts')
const { AccountDeletionBlockedError } = await import('@openanalytics/postgres')
const { ACCOUNT_DELETION_TARGETS } = await import('@openanalytics/domain')

type StripeOutcome<T> =
  { ok: true; data: T } | { ok: false; reason: string; detail: string; resourceMissing?: boolean }

/** A Stripe stand-in whose two answers are set independently, because the phase
 * treats "accepted" and "confirmed" as different facts. */
function fakeStripe(
  options: {
    cancel?: StripeOutcome<{ id: string; status: string; missing: boolean }>
    retrieve?: StripeOutcome<{ status: string }>
  } = {},
) {
  const calledWith: string[] = []
  return {
    calledWith,
    cancelSubscription: async (id: string) => {
      calledWith.push(`cancel:${id}`)
      return await Promise.resolve(
        options.cancel ?? { ok: true, data: { id, status: 'canceled', missing: false } },
      )
    },
    retrieveSubscription: async (id: string) => {
      calledWith.push(`retrieve:${id}`)
      return await Promise.resolve(options.retrieve ?? { ok: true, data: { status: 'canceled' } })
    },
  }
}

interface Harness {
  phases: string[]
  leaseHeld: { value: boolean }
  find: ReturnType<typeof createCapturedLogger>['find']
  metrics: ReturnType<typeof createRecordingMetrics>
  context: Parameters<typeof executeAccountDeletion>[0]
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
  const { logger, find } = createCapturedLogger()
  const metrics = createRecordingMetrics()

  const context = {
    job: {
      id: 'job-a1',
      type: 'account_deletion',
      subjectId: USER,
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
    resources: { ...options.resources },
    extendLease: async () => await Promise.resolve(leaseHeld.value),
    updatePhase: async (phase: string) => {
      if (!leaseHeld.value) return await Promise.resolve(false)
      phases.push(phase)
      return await Promise.resolve(true)
    },
  } as unknown as Parameters<typeof executeAccountDeletion>[0]

  return { phases, leaseHeld, find, metrics, context }
}

/** Every target as the start transaction snapshots it: pending, unverified. */
function freshTargets(): TargetRow[] {
  return ACCOUNT_DELETION_TARGETS.map((target, index) => ({
    id: `t-${String(index)}`,
    store: target.store as TargetRow['store'],
    target: target.target,
    phase: 'pending' as const,
    attempts: 0,
    verified: false,
    mutationId: null,
    lastError: null,
  }))
}

beforeEach(() => {
  state.context = {
    userId: USER,
    requestStatus: 'pending',
    requestedAt: new Date('2026-07-28T00:00:00.000Z'),
    email: 'person@example.test',
  }
  state.sites = []
  state.subscriptionId = SUBSCRIPTION
  state.targets = freshTargets()
  state.purgeThrows = null
  calls.markRunning = []
  calls.markFailed = []
  calls.purged = []
  calls.finalized = []
})

describe('account deletion executor', () => {
  it('runs every phase in order and finalizes', async () => {
    const h = harness()
    const outcome = await executeAccountDeletion(h.context)

    expect(outcome).toBe('succeeded')
    // Three phases, not four: `stripe_cancel` is spliced in by the surface that
    // owns it (`tests/unit/cloud/worker-account-deletion-stripe.test.ts`), and
    // what this pins is the sequence a build without that surface runs.
    expect(h.phases).toEqual(['await_site_deletions', 'postgres_teardown', 'verify_finalize'])
    expect(calls.markRunning).toEqual([REQUEST])
    expect(calls.purged).toEqual([USER])
    expect(calls.finalized).toEqual([{ deletionRequestId: REQUEST, userId: USER }])
    // Every target completed and verified: the tombstone is only written against
    // what the table observed, not against what the phases believed.
    expect(state.targets.every((target) => target.phase === 'completed' && target.verified)).toBe(
      true,
    )
  })

  describe('await_site_deletions', () => {
    it('waits while a billed site is still deleting, without touching Stripe', async () => {
      state.sites = [{ siteId: 's-1', slug: 'acme', status: 'deleting' }]
      const stripe = fakeStripe()
      const h = harness({ resources: { stripe } })

      const outcome = await executeAccountDeletion(h.context)

      expect(outcome).toEqual({ retry: { delayMs: 30_000 } })
      // The site's own job still needs the `site_members` rows the teardown
      // deletes, so nothing downstream may run yet.
      expect(stripe.calledWith).toEqual([])
      expect(calls.purged).toEqual([])
      expect(calls.markRunning).toEqual([])
    })

    it('advances once every billed site is deleted', async () => {
      state.sites = [
        { siteId: 's-1', slug: 'acme', status: 'deleted' },
        { siteId: 's-2', slug: 'beta', status: 'deleted' },
      ]
      const h = harness()
      expect(await executeAccountDeletion(h.context)).toBe('succeeded')
      expect(calls.purged).toEqual([USER])
    })

    it('fails terminally when a live billed site reappeared after the gate', async () => {
      // The gate guaranteed there was none, under a locking read. One here means
      // something re-billed the account — a transfer offer accepted in the
      // seconds before the job ran. Waiting would wait forever for something
      // nobody has asked for.
      state.sites = [{ siteId: 's-9', slug: 'gamma', status: 'active' }]
      const h = harness()

      const outcome = await executeAccountDeletion(h.context)

      expect(outcome).toMatchObject({ terminal: {} })
      expect((outcome as { terminal: { reason: string } }).terminal.reason).toContain('gamma')
      // The request is marked failed, so the next DELETE /v1/me can start a real
      // one instead of forever reporting a deletion that will never run.
      expect(calls.markFailed).toEqual([
        { deletionRequestId: REQUEST, userId: USER, reason: expect.stringContaining('gamma') },
      ])
      expect(h.find('account_deletion_site_reacquired')).toHaveLength(1)
    })
  })

  describe('postgres_teardown', () => {
    it('records the failure on every outstanding target and rethrows', async () => {
      state.purgeThrows = new Error('deadlock detected')
      const h = harness()

      await expect(executeAccountDeletion(h.context)).rejects.toThrow(/deadlock/u)

      // One transaction over nine targets, so one failure belongs to all of them.
      const postgresTargets = state.targets.filter((row) => row.store === 'postgres')
      expect(postgresTargets.every((row) => row.lastError === 'deadlock detected')).toBe(true)
    })

    it('settles terminally when the purge refuses a late-acquired live site', async () => {
      // The teardown re-runs both gate checks inside its own transaction, so a
      // site acquired after the request — a transfer offer accepted while the
      // deletion waited — is refused at the only moment where refusing is
      // race-free. Nothing about that fixes itself, so it is terminal rather
      // than a retry: the site is somebody's live property and no phase here can
      // hand it over.
      state.purgeThrows = new AccountDeletionBlockedError([
        { siteId: 's-77', slug: 'late', reason: 'billing_owner' },
      ])
      const h = harness()

      const outcome = await executeAccountDeletion(h.context)

      expect(outcome).toMatchObject({ terminal: {} })
      expect((outcome as { terminal: { reason: string } }).terminal.reason).toContain(
        'late=billing_owner',
      )
      // Marked failed, so the customer can resolve the site and ask again
      // instead of holding a request that will never complete.
      expect(calls.markFailed).toEqual([
        { deletionRequestId: REQUEST, userId: USER, reason: expect.stringContaining('late') },
      ])
      const [logged] = h.find('account_deletion_site_reacquired')
      expect(logged).toMatchObject({ phase: 'postgres_teardown', retryable: false })
      expect(calls.finalized).toEqual([])
      // The failure is on the targets too, so the table alone explains the stop.
      expect(
        state.targets
          .filter((row) => row.store === 'postgres')
          .every((row) => row.lastError !== null),
      ).toBe(true)
    })

    it('touches nothing when every target is already completed', async () => {
      // Re-entry after a successful teardown — a stolen lease, or a crash
      // between the last target write and the phase advance. Re-running would
      // rewrite every verification to say zero rows were affected, erasing the
      // record of what the erasure actually removed.
      for (const target of state.targets) {
        target.phase = 'completed'
        target.verified = true
      }
      const h = harness({ phase: 'postgres_teardown' })

      expect(await executeAccountDeletion(h.context)).toBe('succeeded')
      expect(calls.purged).toEqual([])
      expect(calls.finalized).toEqual([{ deletionRequestId: REQUEST, userId: USER }])
    })
  })

  describe('verify_finalize', () => {
    it('rewinds to the phase that owns an unfinished target rather than polling', async () => {
      // Entered straight at the last phase with a Postgres target outstanding.
      // Returning a retry without moving `jobs.phase` would re-enter here, find
      // the same target and return the same retry — forever, with nothing in
      // between ever doing the work.
      for (const target of state.targets) {
        target.phase = target.store === 'stripe' ? 'completed' : 'pending'
        target.verified = target.store === 'stripe'
      }
      const h = harness({ phase: 'verify_finalize' })

      expect(await executeAccountDeletion(h.context)).toEqual({ retry: { delayMs: 30_000 } })
      expect(h.phases).toEqual(['verify_finalize', 'postgres_teardown'])
      expect(calls.finalized).toEqual([])
    })
  })

  describe('the terminal hook', () => {
    const hookContext = { db: {} as Database, logger: undefined, metrics: undefined }

    const runHook = async (payload: Record<string, unknown>): Promise<void> => {
      await ACCOUNT_DELETION_REGISTRATION.onTerminal?.(
        {
          id: 'job-a1',
          type: 'account_deletion',
          subjectId: USER,
          payload,
          phase: null,
          attempts: 100,
          claimedBy: 'w-1',
          leaseExpiresAt: new Date(),
          createdAt: new Date(),
        },
        'attempts exhausted: deadlock detected',
        hookContext as unknown as Parameters<
          NonNullable<typeof ACCOUNT_DELETION_REGISTRATION.onTerminal>
        >[2],
      )
    }

    it('marks the request failed when the runner gives the job up', async () => {
      // A dead job with a `pending` request makes every later DELETE /v1/me
      // return that request's id — an account permanently unable to be deleted,
      // reporting success each time.
      await runHook({ deletion_request_id: REQUEST })

      expect(calls.markFailed).toEqual([
        {
          deletionRequestId: REQUEST,
          userId: USER,
          reason: 'attempts exhausted: deadlock detected',
        },
      ])
    })

    it('has nothing to settle when the payload never named a request', async () => {
      // The one terminal that names no request at all. The runner's ERROR log is
      // the whole record of it; there is no row to mark.
      await runHook({})
      expect(calls.markFailed).toEqual([])
    })
  })

  describe('settlement', () => {
    it('succeeds immediately on an already-completed request', async () => {
      state.context = {
        userId: USER,
        requestStatus: 'completed',
        requestedAt: new Date(),
        email: null,
      }
      const h = harness()

      expect(await executeAccountDeletion(h.context)).toBe('succeeded')
      expect(h.phases).toEqual([])
      expect(calls.purged).toEqual([])
    })

    it('is terminal on a request that was marked failed', async () => {
      state.context = {
        userId: USER,
        requestStatus: 'failed',
        requestedAt: new Date(),
        email: null,
      }
      expect(await executeAccountDeletion(harness().context)).toMatchObject({ terminal: {} })
    })

    it('is terminal on a payload with no request id', async () => {
      const h = harness({ payload: {} })
      expect(await executeAccountDeletion(h.context)).toMatchObject({ terminal: {} })
    })

    it('abandons the run when the lease was stolen, before any store work', async () => {
      const h = harness()
      h.leaseHeld.value = false

      expect(await executeAccountDeletion(h.context)).toEqual({ retry: { delayMs: 30_000 } })
      expect(h.phases).toEqual([])
      expect(calls.purged).toEqual([])
      expect(h.find('account_deletion_lease_lost')).toHaveLength(1)
    })
  })
})
