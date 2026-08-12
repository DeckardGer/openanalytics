import type { Auth, SiteRole } from '@openanalytics/auth'
import { loadServiceEnv } from '@openanalytics/domain'
import type { ObjectStorage } from '@openanalytics/integrations'
import { createServiceMetadata } from '@openanalytics/observability'
import type { Database, ImportRunRow } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Publish and rollback at the HTTP boundary (ADR-0032, D3/D4).
 *
 * The transactions themselves are database facts and have their own live
 * Postgres suite (`tests/migration/import-publish.test.ts`). What lives only at
 * the route is the decision it makes on the customer's behalf — **the cutover**
 * — and the conversation it has when it refuses:
 *
 * - the default comes from `summary.proposed_cutover_date`, which staging
 *   computed as `min(first live day, max imported date + 1)`;
 * - a supplied value is clamped to `first live day + 1`, because a later cutover
 *   hides live data the site already has behind imported numbers — a wrong
 *   dashboard, not a choice;
 * - a site with no live events has **no** clamp at all, which is the primary
 *   migration case and would otherwise be the one that breaks;
 * - publishing a run that staged nothing is refused rather than made a silent
 *   no-op, because the pointer would name a run with no rows.
 *
 * The two idempotent-replay branches matter for the same reason `complete`'s
 * does: a lost response must not become an error the customer cannot get past.
 */

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const RUN = '9a1d0b3c-0000-4000-8000-00000000abcd'
const PREVIOUS = '9a1d0b3c-0000-4000-8000-00000000bcde'
const OWNER = 'u-owner'
const VIEWER = 'u-viewer'

const memberships = new Map<string, { role: SiteRole; isBillingOwner: boolean }>([
  [OWNER, { role: 'owner', isBillingOwner: true }],
  [VIEWER, { role: 'viewer', isBillingOwner: false }],
])

const world = {
  storedRun: null as ImportRunRow | null,
  firstEventAt: null as Date | null,
  transitionMoves: true,
  rollback: { ok: true, restoredRunId: PREVIOUS } as
    | { ok: true; restoredRunId: string | null }
    | { ok: false; conflict: 'not_published' | 'site_unavailable' | 'generation_erased' },
}

const calls = {
  transitions: [] as { to: string; cutoverDate?: string }[],
  jobs: [] as { type: string; idempotencyKey: string }[],
  rollbacks: [] as string[],
}

function run(overrides: Partial<ImportRunRow> = {}): ImportRunRow {
  return {
    id: RUN,
    siteId: SITE,
    provider: 'plausible',
    state: 'ready_for_review',
    summary: {
      reports: { metrics: { rows: 10, chunks: 1 } },
      date_range: { from: '2024-01-01', to: '2024-03-31' },
      warnings: [],
      proposed_cutover_date: '2024-04-01',
      total_rows: 10,
    },
    cutoverDate: null,
    stagingChunkBytes: 8_388_608,
    stagingProgress: { metrics: 1 },
    supersededRunId: null,
    sweptAt: null,
    errorCode: null,
    createdAt: new Date('2026-07-29T00:00:00.000Z'),
    updatedAt: new Date('2026-07-29T00:00:00.000Z'),
    finishedAt: null,
    ...overrides,
  }
}

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    getMembership: async (_db: unknown, params: { siteId: string; userId: string }) =>
      memberships.get(params.userId) ?? null,
    readImportRun: async () => world.storedRun,
    readImportUpload: async () => null,
    readJobStatusByIdempotencyKey: async () => null,
    readSiteImportContext: async () => ({
      firstEventAt: world.firstEventAt,
      publishedImportRunId: null,
      status: 'active' as const,
    }),
    transitionImportRun: async (_db: unknown, input: { to: string; cutoverDate?: string }) => {
      calls.transitions.push(input)
      return world.transitionMoves
    },
    enqueueJob: async (_db: unknown, input: { type: string; idempotencyKey: string }) => {
      calls.jobs.push(input)
      return { enqueued: true, id: 'job-1' }
    },
    rollbackImportRun: async (_db: unknown, input: { importRunId: string }) => {
      calls.rollbacks.push(input.importRunId)
      return world.rollback
    },
  }
})

const { createApp } = await import('../../apps/api/src/app.ts')

const auth = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const id = headers.get('x-test-user')
      if (id === null) return null
      return {
        user: {
          id,
          email: `${id}@example.test`,
          emailVerified: true,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        session: { createdAt: new Date() },
      }
    },
  },
  handler: async () => new Response(null),
} as unknown as Auth

const db = {
  transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => await fn(db),
} as unknown as Database

const { logger } = createCapturedLogger()
const app = createApp({
  service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
  logger,
  env: loadServiceEnv('api', testEnv()),
  auth,
  db,
  objectStorage: {} as unknown as ObjectStorage,
})

const call = (
  method: string,
  path: string,
  user: string | null,
  body?: unknown,
): Promise<Response> =>
  Promise.resolve(
    app.fetch(
      new Request(`http://api.test${path}`, {
        method,
        headers: {
          ...(user === null ? {} : { 'x-test-user': user }),
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    ),
  )

const publish = (user: string | null, body?: unknown) =>
  call('POST', `/v1/sites/${SITE}/imports/${RUN}/publish`, user, body)
const rollback = (user: string | null) =>
  call('POST', `/v1/sites/${SITE}/imports/${RUN}/rollback`, user)

const errorCode = async (res: Response): Promise<string> =>
  ((await res.json()) as { error: { code: string } }).error.code

beforeEach(() => {
  world.storedRun = run()
  world.firstEventAt = null
  world.transitionMoves = true
  world.rollback = { ok: true, restoredRunId: PREVIOUS }
  calls.transitions = []
  calls.jobs = []
  calls.rollbacks = []
})

describe('POST .../imports/{run_id}/publish', () => {
  it('needs the site:settings capability', async () => {
    expect((await publish(null)).status).toBe(401)
    expect((await publish(VIEWER)).status).toBe(403)
  })

  it('publishes with the proposed cutover when the body is absent', async () => {
    // `POST` with no body at all is the ordinary call — "publish this with the
    // cutover you proposed" — and requiring `{}` would make the common case the
    // awkward one.
    const res = await publish(OWNER)

    expect(res.status).toBe(202)
    expect(calls.transitions).toMatchObject([{ to: 'publishing', cutoverDate: '2024-04-01' }])
    expect(calls.jobs).toEqual([
      {
        type: 'import_publish',
        subjectId: SITE,
        idempotencyKey: `import_publish:${RUN}`,
        payload: { import_run_id: RUN },
      },
    ])
  })

  it('accepts a chosen cutover inside the clamp', async () => {
    world.firstEventAt = new Date('2024-05-10T12:00:00.000Z')
    const res = await publish(OWNER, { cutover_date: '2024-05-11' })

    expect(res.status).toBe(202)
    expect(calls.transitions).toMatchObject([{ to: 'publishing', cutoverDate: '2024-05-11' }])
  })

  it('refuses an EXPLICIT cutover past the day after the first live event', async () => {
    // A later cutover would hide live data the site already has behind imported
    // numbers. A choice is refused rather than rewritten.
    world.firstEventAt = new Date('2024-05-10T12:00:00.000Z')
    const res = await publish(OWNER, { cutover_date: '2024-05-12' })

    expect(res.status).toBe(400)
    expect(await errorCode(res)).toBe('VALIDATION_FAILED')
    expect(calls.transitions).toEqual([])
  })

  it('clamps — never 400s — when the proposal itself is past the limit', async () => {
    // The staged proposal can go out of range on its own: it is computed at
    // staging time, and a first live event arriving between staging and review
    // moves the clamp underneath it. Refusing here would tell a customer who
    // sent no `cutover_date` that their `cutover_date` is invalid.
    world.storedRun = run({
      summary: {
        reports: { metrics: { rows: 10, chunks: 1 } },
        date_range: { from: '2024-01-01', to: '2024-06-30' },
        warnings: [],
        proposed_cutover_date: '2024-07-01',
        total_rows: 10,
      },
    })
    world.firstEventAt = new Date('2024-05-10T12:00:00.000Z')

    const res = await publish(OWNER)

    expect(res.status).toBe(202)
    expect(calls.transitions).toMatchObject([{ to: 'publishing', cutoverDate: '2024-05-11' }])
  })

  it('applies no clamp at all to a site that has never had an event', async () => {
    // The primary migration case: import first, install the tracker second.
    world.firstEventAt = null
    const res = await publish(OWNER, { cutover_date: '2030-01-01' })
    expect(res.status).toBe(202)
  })

  it('refuses a cutover that is not a calendar date', async () => {
    expect((await publish(OWNER, { cutover_date: '2024-02-31' })).status).toBe(400)
    expect((await publish(OWNER, { cutover_date: 'yesterday' })).status).toBe(400)
    expect(calls.transitions).toEqual([])
  })

  it('refuses to publish a run that staged nothing', async () => {
    world.storedRun = run({
      summary: {
        reports: {},
        date_range: null,
        warnings: [],
        proposed_cutover_date: null,
        total_rows: 0,
      },
    })
    const res = await publish(OWNER)

    expect(res.status).toBe(422)
    expect(await errorCode(res)).toBe('IMPORT_FAILED')
  })

  it('refuses a run that is not awaiting review', async () => {
    world.storedRun = run({ state: 'processing' })
    const res = await publish(OWNER)

    expect(res.status).toBe(409)
    expect(await errorCode(res)).toBe('IMPORT_IN_PROGRESS')
  })

  it('replays 202 for a run that is already publishing or published', async () => {
    for (const state of ['publishing', 'published'] as const) {
      world.storedRun = run({ state, cutoverDate: '2024-04-01' })
      const res = await publish(OWNER)
      expect(res.status, state).toBe(202)
    }
    // No second transition and no second job: the recovery for a lost response
    // must not re-run the operation.
    expect(calls.transitions).toEqual([])
    expect(calls.jobs).toEqual([])
  })

  it('answers 409 when the run moved between the read and the write', async () => {
    world.transitionMoves = false
    const res = await publish(OWNER)

    expect(res.status).toBe(409)
    // The job is enqueued inside the transaction, so a refused transition
    // enqueues nothing — a run that never reached `publishing` must not have a
    // publish job waiting for it.
    expect(calls.jobs).toEqual([])
  })

  it('404s for a run that does not belong to this site', async () => {
    world.storedRun = null
    expect((await publish(OWNER)).status).toBe(404)
  })
})

describe('POST .../imports/{run_id}/rollback', () => {
  it('needs the site:settings capability', async () => {
    expect((await rollback(null)).status).toBe(401)
    expect((await rollback(VIEWER)).status).toBe(403)
  })

  it('rolls back the published run and answers 200', async () => {
    world.storedRun = run({ state: 'published', cutoverDate: '2024-04-01' })
    const res = await rollback(OWNER)

    expect(res.status).toBe(200)
    expect(calls.rollbacks).toEqual([RUN])
  })

  it('is valid for a first import with no predecessor', async () => {
    // The pointer goes to null and the site returns to having no imported
    // history, which is exactly where it was before the import.
    world.storedRun = run({ state: 'published' })
    world.rollback = { ok: true, restoredRunId: null }
    expect((await rollback(OWNER)).status).toBe(200)
  })

  it('refuses a run that is not the published one', async () => {
    world.storedRun = run({ state: 'superseded' })
    world.rollback = { ok: false, conflict: 'not_published' }
    const res = await rollback(OWNER)

    expect(res.status).toBe(409)
    expect(await errorCode(res)).toBe('IMPORT_IN_PROGRESS')
  })

  it('replays 200 for a run that is already rolled back', async () => {
    world.storedRun = run({ state: 'rolled_back' })
    const res = await rollback(OWNER)

    expect(res.status).toBe(200)
    expect(calls.rollbacks).toEqual([])
  })

  it('answers IMPORT_ROLLBACK_UNAVAILABLE when the generation was already erased', async () => {
    // Cleanup keeps exactly one rollback generation (D3), so once a third import
    // is published — or the backstop reaches the predecessor — there is nothing
    // to restore. Deliberately its own code: a client told `IMPORT_IN_PROGRESS`
    // would look at the phase, find it perfectly normal, and have nothing to act
    // on. Nothing changes; the published run stays published.
    world.storedRun = run({ state: 'published', cutoverDate: '2024-04-01' })
    world.rollback = { ok: false, conflict: 'generation_erased' }
    const res = await rollback(OWNER)

    expect(res.status).toBe(409)
    expect(await errorCode(res)).toBe('IMPORT_ROLLBACK_UNAVAILABLE')
  })

  it('reads a deleting site as a site that is not there', async () => {
    world.storedRun = run({ state: 'published' })
    world.rollback = { ok: false, conflict: 'site_unavailable' }
    const res = await rollback(OWNER)

    expect(res.status).toBe(404)
    expect(await errorCode(res)).toBe('SITE_NOT_FOUND')
  })
})
