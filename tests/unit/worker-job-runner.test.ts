import type { ClaimedJob, Database, JobsBacklogRow } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { createRecordingMetrics } from '@openanalytics/observability'
import { createCapturedLogger } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The generic job runner (ADR-0030, decision 3).
 *
 * Everything asserted here is a rule about *settlement* — which of the five
 * terminal-or-not outcomes a job reaches, and under whose lease. The claim query
 * itself is SQL and is proven against a real Postgres in
 * `tests/migration/lifecycle-jobs.test.ts`; a fake database cannot say anything
 * true about `SKIP LOCKED`.
 *
 * The `site_deletion` executor's own phase machine has its own suite
 * (`tests/unit/worker-site-deletion-executor.test.ts`); what is asserted here is
 * only the part the runner owns — its registration and the one settlement it can
 * reach without any store at all.
 */

const claimed = { rows: [] as ClaimedJob[] }
const backlog = { rows: [] as JobsBacklogRow[] }
/** Simulates a stolen lease: the guarded UPDATE matches no row. */
const leaseHeld = { value: true }

const completed: { jobId: string; status: string; error?: string | undefined }[] = []
const failedRetryable: {
  jobId: string
  error: string
  retryDelayMs: number
  resetAttempts?: boolean | undefined
}[] = []
const extended: { jobId: string; claimedBy: string }[] = []
const phased: { jobId: string; claimedBy: string; phase: string }[] = []

const claimDueJobs = vi.fn(async (_db: unknown, _input: unknown) => claimed.rows)
const readJobsBacklog = vi.fn(async (_db: unknown) => backlog.rows)
const completeJob = vi.fn(
  async (
    _db: unknown,
    input: { jobId: string; claimedBy: string; status: string; error?: string },
  ) => {
    if (!leaseHeld.value) return false
    completed.push({ jobId: input.jobId, status: input.status, error: input.error })
    return true
  },
)
const failJobRetryable = vi.fn(
  async (
    _db: unknown,
    input: {
      jobId: string
      claimedBy: string
      error: string
      retryDelayMs: number
      resetAttempts?: boolean
    },
  ) => {
    if (!leaseHeld.value) return false
    failedRetryable.push({
      jobId: input.jobId,
      error: input.error,
      retryDelayMs: input.retryDelayMs,
      resetAttempts: input.resetAttempts,
    })
    return true
  },
)
const extendJobLease = vi.fn(async (_db: unknown, input: { jobId: string; claimedBy: string }) => {
  extended.push({ jobId: input.jobId, claimedBy: input.claimedBy })
  return leaseHeld.value
})
const updateJobPhase = vi.fn(
  async (_db: unknown, input: { jobId: string; claimedBy: string; phase: string }) => {
    phased.push(input)
    return leaseHeld.value
  },
)

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    claimDueJobs: (db: unknown, input: unknown) => claimDueJobs(db, input),
    readJobsBacklog: (db: unknown) => readJobsBacklog(db),
    completeJob: (db: unknown, input: never) => completeJob(db, input),
    failJobRetryable: (db: unknown, input: never) => failJobRetryable(db, input),
    extendJobLease: (db: unknown, input: never) => extendJobLease(db, input),
    updateJobPhase: (db: unknown, input: never) => updateJobPhase(db, input),
  }
})

const { DEFAULT_JOB_REGISTRATIONS, publishJobsBacklog, runJobsOnce } =
  await import('../../apps/worker/src/jobs/runner.ts')
type Registration = (typeof DEFAULT_JOB_REGISTRATIONS)[number]

const db = {} as Database

const POLICY = {
  leaseTtlMs: 60_000,
  maxAttempts: 100,
  retryBaseMs: 500,
  retryMaxMs: 30_000,
} as const

const deps = () => {
  const { logger, find } = createCapturedLogger()
  return { db, logger, find, metrics: createRecordingMetrics(), policy: POLICY, claimedBy: 'w-1' }
}

function job(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    id: 'job-1',
    type: 'site_deletion',
    subjectId: 'site-a',
    payload: { reason: 'retention_expired' },
    phase: null,
    attempts: 1,
    claimedBy: 'w-1',
    leaseExpiresAt: new Date('2026-07-28T12:01:00.000Z'),
    createdAt: new Date('2026-07-28T12:00:00.000Z'),
    ...overrides,
  }
}

beforeEach(() => {
  claimed.rows = []
  backlog.rows = []
  leaseHeld.value = true
  completed.length = 0
  failedRetryable.length = 0
  extended.length = 0
  phased.length = 0
  claimDueJobs.mockClear()
  readJobsBacklog.mockClear()
  completeJob.mockClear()
  failJobRetryable.mockClear()
  extendJobLease.mockClear()
  updateJobPhase.mockClear()
})

describe('job runner registry', () => {
  it('registers every job type and claims exactly them', async () => {
    // One claim statement for every registered type, not one per type: the page
    // stays globally ordered by `available_at`, so the oldest work runs first
    // whichever kind of subject it names.
    //
    // `import_prepare` and `import_publish` are deliberately two types
    // (ADR-0032, D7), which is why the jobs table's `(type, subject_id)` unique
    // is not what serializes imports — the one-non-terminal-run-per-site index
    // is (D3). `export_run` is the mirror image and is why the list is worth
    // pinning: it is ONE type, so that same unique *is* one live export per site
    // (D8), and the export surface adds no serializer of its own.
    expect(DEFAULT_JOB_REGISTRATIONS.map((r) => r.type)).toEqual([
      'site_deletion',
      'account_deletion',
      'import_prepare',
      'import_publish',
      'export_run',
      'revenue_backfill',
    ])

    await runJobsOnce(deps(), DEFAULT_JOB_REGISTRATIONS)

    expect(claimDueJobs).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        types: [
          'site_deletion',
          'account_deletion',
          'import_prepare',
          'import_publish',
          'export_run',
          'revenue_backfill',
        ],
        claimedBy: 'w-1',
        leaseTtlMs: 60_000,
      }),
    )
  })

  it('claims nothing at all when no type is registered', async () => {
    const result = await runJobsOnce(deps(), [])
    expect(claimDueJobs).not.toHaveBeenCalled()
    expect(result.claimed).toBe(0)
  })

  it('routes each claimed job to the executor registered for its type', async () => {
    claimed.rows = [job({ id: 'a', type: 'alpha' }), job({ id: 'b', type: 'beta' })]
    const seen: string[] = []
    const make = (type: string): Registration => ({
      type,
      execute: (context) => {
        seen.push(`${type}:${context.job.id}`)
        return Promise.resolve('succeeded')
      },
    })

    await runJobsOnce(deps(), [make('alpha'), make('beta')])

    expect(seen).toEqual(['alpha:a', 'beta:b'])
  })
})

describe('job settlement', () => {
  const registration = (execute: Registration['execute']): Registration[] => [
    { type: 'site_deletion', execute },
  ]

  it("marks a job succeeded when the executor returns 'succeeded'", async () => {
    claimed.rows = [job()]
    const context = deps()

    const result = await runJobsOnce(
      context,
      registration(() => Promise.resolve('succeeded')),
    )

    expect(completed).toEqual([{ jobId: 'job-1', status: 'succeeded', error: undefined }])
    expect(result).toMatchObject({ claimed: 1, succeeded: 1, retried: 0, failedTerminal: 0 })
    expect(
      context.metrics.recorded.filter(
        (entry) =>
          entry.name === 'worker_job_completed' && entry.labels?.['status'] === 'succeeded',
      ),
    ).toHaveLength(1)
  })

  it('requeues with the executor’s own delay when it asks to retry', async () => {
    claimed.rows = [job()]
    const result = await runJobsOnce(
      deps(),
      registration(() => Promise.resolve({ retry: { delayMs: 60_000 } })),
    )

    expect(failedRetryable).toEqual([
      {
        jobId: 'job-1',
        error: 'executor requested a retry',
        retryDelayMs: 60_000,
        resetAttempts: true,
      },
    ])
    expect(completed).toEqual([])
    expect(result.retried).toBe(1)
  })

  it('does not spend an attempt when the executor asked to be retried', async () => {
    // `attempts` counts claims, not failures. A job that only ever *asks* to
    // wait — the CP3-less stub polling every minute — would otherwise exhaust
    // JOB_MAX_ATTEMPTS in about two hours and be marked failed_terminal without
    // one error ever having occurred.
    claimed.rows = [job({ attempts: 99 })]

    const result = await runJobsOnce(
      deps(),
      registration(() => Promise.resolve({ retry: { delayMs: 60_000 } })),
    )

    expect(failedRetryable[0]?.resetAttempts).toBe(true)
    expect(completed).toEqual([])
    expect(result).toMatchObject({ retried: 1, failedTerminal: 0 })
  })

  it('does spend an attempt when the executor asked for a COUNTING retry', async () => {
    // The infrastructure case (ADR-0032, D7). A ClickHouse grant that was never
    // given, or a credential a deployment will not add, never resolves on its
    // own — so a non-counting retry over one is an immortal job, and an immortal
    // job whose subject is pinned meanwhile (an import run parked in
    // `validating` holds its site's only import slot) is a permanent lockout.
    claimed.rows = [job({ attempts: 3 })]

    const result = await runJobsOnce(
      deps(),
      registration(() => Promise.resolve({ retry: { delayMs: 60_000, counts: true } })),
    )

    expect(failedRetryable[0]?.resetAttempts).toBe(false)
    expect(completed).toEqual([])
    expect(result).toMatchObject({ retried: 1, failedTerminal: 0 })
  })

  it('terminals a counting retry once the attempts guard is reached', async () => {
    // And the terminal hook fires, which is what releases the pinned subject.
    // Without it, counting the retries would only trade an immortal job for a
    // dead job and a subject nobody is even polling any more.
    claimed.rows = [job({ attempts: 100 })]
    const terminals: string[] = []

    const result = await runJobsOnce(deps(), [
      {
        type: 'site_deletion',
        execute: () => Promise.resolve({ retry: { delayMs: 60_000, counts: true } }),
        onTerminal: (settled, reason) => {
          terminals.push(`${settled.id}:${reason}`)
          return Promise.resolve()
        },
      },
    ])

    expect(failedRetryable).toEqual([])
    expect(completed).toEqual([
      {
        jobId: 'job-1',
        status: 'failed_terminal',
        error: 'attempts exhausted: executor kept requesting an infrastructure retry',
      },
    ])
    expect(terminals).toEqual([
      'job-1:attempts exhausted: executor kept requesting an infrastructure retry',
    ])
    expect(result).toMatchObject({ retried: 0, failedTerminal: 1 })
  })

  it('never terminals a NON-counting retry, however many times it has waited', async () => {
    // The deletion executors' waits are unbounded by design: a fence drain can
    // legitimately take days, and nothing about waiting is a failure.
    claimed.rows = [job({ attempts: 100_000 })]

    const result = await runJobsOnce(
      deps(),
      registration(() => Promise.resolve({ retry: { delayMs: 60_000 } })),
    )

    expect(completed).toEqual([])
    expect(failedRetryable[0]?.resetAttempts).toBe(true)
    expect(result).toMatchObject({ retried: 1, failedTerminal: 0 })
  })

  it('does spend an attempt when the executor threw', async () => {
    // The counter the guard reads is the run of consecutive throws, so a real
    // failure must still be counted.
    claimed.rows = [job({ attempts: 3 })]

    await runJobsOnce(
      deps(),
      registration(() => Promise.reject(new Error('clickhouse unavailable'))),
    )

    expect(failedRetryable[0]?.resetAttempts).toBeUndefined()
  })

  it('backs off exponentially on a throw, and never marks it terminal', async () => {
    // A throw is always a retry. Attempts 1..4 produce 500/1000/2000/4000ms —
    // the shared WORKER_RETRY_BASE_MS schedule the batch pipeline uses.
    for (const [attempts, expected] of [
      [1, 500],
      [2, 1_000],
      [3, 2_000],
      [4, 4_000],
    ] as const) {
      failedRetryable.length = 0
      claimed.rows = [job({ attempts })]
      await runJobsOnce(
        deps(),
        registration(() => Promise.reject(new Error('clickhouse unavailable'))),
      )
      expect(failedRetryable[0]).toEqual({
        jobId: 'job-1',
        error: 'clickhouse unavailable',
        retryDelayMs: expected,
        resetAttempts: undefined,
      })
      expect(completed).toEqual([])
    }
  })

  it('caps the backoff at the maximum rather than growing forever', async () => {
    claimed.rows = [job({ attempts: 40 })]
    await runJobsOnce(
      deps(),
      registration(() => Promise.reject(new Error('boom'))),
    )
    expect(failedRetryable[0]?.retryDelayMs).toBe(30_000)
  })

  it('gives up only once attempts are exhausted, and says so', async () => {
    claimed.rows = [job({ attempts: 100 })]
    const context = deps()

    const result = await runJobsOnce(
      context,
      registration(() => Promise.reject(new Error('still broken'))),
    )

    expect(failedRetryable).toEqual([])
    expect(completed).toEqual([
      { jobId: 'job-1', status: 'failed_terminal', error: 'attempts exhausted: still broken' },
    ])
    expect(result.failedTerminal).toBe(1)
    // ERROR, not warn: work a customer was promised will now never happen
    // unless a human intervenes.
    const [exhausted] = context.find('job_attempts_exhausted')
    expect(exhausted?.['level']).toBe('error')
    expect(exhausted).toMatchObject({
      job_id: 'job-1',
      type: 'site_deletion',
      subject_id: 'site-a',
    })
  })

  it('lets an executor fail terminally on purpose, with a reason', async () => {
    claimed.rows = [job()]
    const context = deps()
    await runJobsOnce(
      context,
      registration(() => Promise.resolve({ terminal: { reason: 'site no longer exists' } })),
    )

    expect(completed).toEqual([
      { jobId: 'job-1', status: 'failed_terminal', error: 'site no longer exists' },
    ])
    const [terminal] = context.find('job_failed_terminal')
    expect(terminal?.['level']).toBe('error')
    expect(terminal).toMatchObject({
      job_id: 'job-1',
      type: 'site_deletion',
      subject_id: 'site-a',
      reason: 'site no longer exists',
    })
  })

  it('fails only the job whose executor threw, and keeps going', async () => {
    claimed.rows = [job({ id: 'a' }), job({ id: 'b' }), job({ id: 'c' })]
    let seen = 0
    const result = await runJobsOnce(
      deps(),
      registration(() => {
        seen += 1
        return seen === 1 ? Promise.reject(new Error('one bad job')) : Promise.resolve('succeeded')
      }),
    )

    expect(result).toMatchObject({ claimed: 3, succeeded: 2, retried: 1 })
    expect(completed.map((entry) => entry.jobId)).toEqual(['b', 'c'])
  })
})

describe('terminal hook', () => {
  type HookCall = { jobId: string; reason: string; hasDb: boolean }

  const hooked = (
    execute: Registration['execute'],
    calls: HookCall[],
    options: { throws?: boolean } = {},
  ): Registration[] => [
    {
      type: 'site_deletion',
      execute,
      onTerminal: async (settledJob, reason, context) => {
        calls.push({ jobId: settledJob.id, reason, hasDb: context.db === db })
        if (options.throws === true) throw new Error('the request row is gone')
        await Promise.resolve()
      },
    },
  ]

  it('tells the job type when the executor gave up, with the same reason', async () => {
    // The runner settles `jobs`; the request row that promised a customer an
    // erasure lives in another table this file knows nothing about. Without the
    // hook that row stays `pending` forever behind a dead job.
    claimed.rows = [job()]
    const calls: HookCall[] = []

    const result = await runJobsOnce(
      deps(),
      hooked(() => Promise.resolve({ terminal: { reason: 'site no longer exists' } }), calls),
    )

    expect(result.failedTerminal).toBe(1)
    expect(calls).toEqual([{ jobId: 'job-1', reason: 'site no longer exists', hasDb: true }])
  })

  it('tells it on the attempts-exhausted path too, carrying that reason', async () => {
    // The second terminal path, and the one nobody chose: a job that kept
    // throwing until the guard fired. The subject is just as undeletable.
    claimed.rows = [job({ attempts: 100 })]
    const calls: HookCall[] = []

    await runJobsOnce(
      deps(),
      hooked(() => Promise.reject(new Error('still broken')), calls),
    )

    expect(calls).toEqual([
      { jobId: 'job-1', reason: 'attempts exhausted: still broken', hasDb: true },
    ])
  })

  it('leaves the hook alone for a success, a retry and a counted failure', async () => {
    const calls: HookCall[] = []

    for (const outcome of [
      () => Promise.resolve('succeeded' as const),
      () => Promise.resolve({ retry: { delayMs: 1_000 } }),
      () => Promise.reject(new Error('transient')),
    ]) {
      claimed.rows = [job({ attempts: 2 })]
      await runJobsOnce(deps(), hooked(outcome, calls))
    }

    expect(calls).toEqual([])
  })

  it('does not run the hook when the settlement was refused by a stolen lease', async () => {
    // The write matched no row, so the job belongs to another worker — and so
    // does the decision about what its failure means. Marking the request failed
    // from here would settle a deletion the new holder may still complete.
    claimed.rows = [job()]
    const calls: HookCall[] = []

    const result = await runJobsOnce(
      deps(),
      hooked(() => {
        leaseHeld.value = false
        return Promise.resolve({ terminal: { reason: 'gone' } })
      }, calls),
    )

    expect(result).toMatchObject({ failedTerminal: 0, lost: 1 })
    expect(calls).toEqual([])
  })

  it('keeps the terminal settlement when the hook itself throws, and says so', async () => {
    // The settlement is already durable. A notification that could not be
    // delivered is a second thing to fix, not a reason to lose the first.
    claimed.rows = [job()]
    const calls: HookCall[] = []
    const context = deps()

    const result = await runJobsOnce(
      context,
      hooked(() => Promise.resolve({ terminal: { reason: 'gone' } }), calls, { throws: true }),
    )

    expect(result.failedTerminal).toBe(1)
    expect(completed).toEqual([{ jobId: 'job-1', status: 'failed_terminal', error: 'gone' }])
    const [failure] = context.find('job_terminal_hook_failed')
    expect(failure?.['level']).toBe('error')
    expect(failure).toMatchObject({ job_id: 'job-1', type: 'site_deletion', reason: 'gone' })
  })

  it('registers a terminal hook for every job type whose subject would stay pinned', () => {
    // The whole point of the hook: no job may leave a *second* row claiming to
    // be in progress behind work that has been given up on. Five types need it —
    // the two deletions leave a `deletion_requests` row, the two imports and the
    // export leave a run row that holds the site's only import/export slot.
    //
    // `revenue_backfill` is the exception and its absence is a decision, not a
    // gap (ADR-0033, D4): a credential pins nothing. A dead backfill leaves a
    // credential whose failure paths already wrote a status and a customer-safe
    // `last_error`, the webhook path keeps working, and the reconcile sweep
    // picks it up on its own schedule. So the assertion is stated as a
    // *partition* rather than a blanket "every registration", which is what
    // makes adding a sixth pinning type fail here instead of passing silently.
    const withHook = DEFAULT_JOB_REGISTRATIONS.filter((r) => r.onTerminal !== undefined).map(
      (r) => r.type,
    )
    expect(withHook).toEqual([
      'site_deletion',
      'account_deletion',
      'import_prepare',
      'import_publish',
      'export_run',
    ])
    expect(
      DEFAULT_JOB_REGISTRATIONS.filter((r) => r.onTerminal === undefined).map((r) => r.type),
    ).toEqual(['revenue_backfill'])
  })
})

describe('lease guard', () => {
  const registration = (execute: Registration['execute']): Registration[] => [
    { type: 'site_deletion', execute },
  ]

  it('reports the job lost — not succeeded — when the lease was stolen mid-run', async () => {
    // The guarded UPDATE matches no row because another worker now holds the
    // job. Counting this as a success would report work as done that this run's
    // writes were refused for.
    claimed.rows = [job()]
    const context = deps()

    const result = await runJobsOnce(
      context,
      registration(() => {
        leaseHeld.value = false
        return Promise.resolve('succeeded')
      }),
    )

    expect(result).toMatchObject({ claimed: 1, succeeded: 0, lost: 1 })
    expect(context.find('job_lease_lost')).toHaveLength(1)
    expect(
      context.metrics.recorded.filter(
        (entry) =>
          entry.name === 'worker_job_completed' && entry.labels?.['status'] === 'lease_lost',
      ),
    ).toHaveLength(1)
  })

  it('reports lost rather than terminal when a stolen lease meets an exhausted job', async () => {
    claimed.rows = [job({ attempts: 100 })]
    const result = await runJobsOnce(
      deps(),
      registration(() => {
        leaseHeld.value = false
        return Promise.reject(new Error('x'))
      }),
    )
    expect(result).toMatchObject({ failedTerminal: 0, lost: 1 })
  })

  it('re-stamps the lease before the executor starts, and skips the job if it is gone', async () => {
    // One claim stamps one `lease_expires_at` across the whole page, but the page
    // runs serially: by the time the second job is reached the first may have
    // taken longer than the TTL, and another worker will have legitimately taken
    // it. Starting its executor anyway puts two workers in the same phases.
    claimed.rows = [job({ id: 'a' }), job({ id: 'b', subjectId: 'site-b' })]
    const seen: string[] = []
    const context = deps()

    const result = await runJobsOnce(
      context,
      registration((executed) => {
        seen.push(executed.job.id)
        // The first job overran; the lease is now somebody else's.
        leaseHeld.value = false
        return Promise.resolve('succeeded')
      }),
    )

    // The second job's executor was never invoked at all.
    expect(seen).toEqual(['a'])
    expect(result).toMatchObject({ claimed: 2, succeeded: 0, lost: 2, failedTerminal: 0 })
    // No failure was recorded against it — a stolen lease is not the job's fault.
    expect(failedRetryable).toEqual([])
    expect(completed).toEqual([])
    expect(context.find('job_lease_lost')).toHaveLength(2)
  })

  it('hands the executor lease controls bound to this worker', async () => {
    claimed.rows = [job()]
    await runJobsOnce(
      deps(),
      registration(async (context) => {
        expect(await context.extendLease()).toBe(true)
        expect(await context.updatePhase('fence_drain')).toBe(true)
        return 'succeeded'
      }),
    )

    // Two extends: the runner's own pre-execution one, then the executor's.
    expect(extended).toEqual([
      { jobId: 'job-1', claimedBy: 'w-1' },
      { jobId: 'job-1', claimedBy: 'w-1' },
    ])
    expect(phased).toEqual([{ jobId: 'job-1', claimedBy: 'w-1', phase: 'fence_drain' }])
  })

  it('tells the executor its lease is gone instead of letting it write on', async () => {
    claimed.rows = [job()]
    await runJobsOnce(
      deps(),
      registration(async (context) => {
        // Stolen after this run started, so the runner's own check passed.
        leaseHeld.value = false
        expect(await context.extendLease()).toBe(false)
        return { retry: { delayMs: 1_000 } }
      }),
    )
  })
})

describe('site_deletion registration', () => {
  it('claims one deletion per tick', () => {
    const deletion = DEFAULT_JOB_REGISTRATIONS.find(
      (registration) => registration.type === 'site_deletion',
    )
    // A deletion holds a ClickHouse mutation and a finalizer lease. Ten per tick
    // would put ten concurrent mutations on one server and then execute them
    // serially anyway, since the claimed page is worked in order.
    expect(deletion?.limit).toBe(1)
  })

  it('refuses a job whose payload names no deletion request, terminally', async () => {
    // The one settlement the executor reaches without touching any store. It is
    // terminal rather than retryable because nothing will ever add the field to
    // a row that was written without it — waiting would burn a claim slot for
    // good — and it is loud, because it means a producer wrote a bad row.
    claimed.rows = [job({ payload: { reason: 'retention_expired' } })]
    const context = deps()

    const result = await runJobsOnce(context, DEFAULT_JOB_REGISTRATIONS)

    expect(result).toMatchObject({ succeeded: 0, failedTerminal: 1, retried: 0 })
    expect(completed).toEqual([
      {
        jobId: 'job-1',
        status: 'failed_terminal',
        error: 'site_deletion payload has no deletion_request_id',
      },
    ])
    // No phase written and no store touched: the refusal happens before the
    // phase machine is entered at all.
    expect(phased).toEqual([])
    expect(context.find('job_failed_terminal')).toHaveLength(1)
  })
})

describe('jobs backlog gauges', () => {
  it('publishes the backlog and zero-fills every registered type', async () => {
    backlog.rows = [
      { type: 'site_deletion', status: 'failed_retryable', count: 2, oldestAgeMs: 90 },
    ]
    const context = deps()

    await publishJobsBacklog(context, ['site_deletion', 'account_deletion'])

    const gauges = context.metrics.recorded.filter((entry) => entry.kind === 'gauge')
    expect(gauges).toContainEqual(
      expect.objectContaining({
        name: 'worker_jobs_backlog',
        value: 2,
        labels: { type: 'site_deletion', status: 'failed_retryable' },
      }),
    )
    // A type with nothing queued reports zero rather than leaving its last
    // non-zero value as the newest thing the backend saw — the same rule the
    // outbox backlog follows, and the only way "the runner stopped" is visible.
    expect(gauges).toContainEqual(
      expect.objectContaining({
        name: 'worker_jobs_backlog',
        value: 0,
        labels: { type: 'account_deletion', status: 'queued' },
      }),
    )
    expect(gauges).toContainEqual(
      expect.objectContaining({
        name: 'worker_jobs_oldest_age_ms',
        value: 0,
        labels: { type: 'site_deletion', status: 'queued' },
      }),
    )
    // …but a reported non-zero group is not then overwritten with 0.
    expect(gauges).not.toContainEqual(
      expect.objectContaining({
        name: 'worker_jobs_backlog',
        value: 0,
        labels: { type: 'site_deletion', status: 'failed_retryable' },
      }),
    )
  })
})
