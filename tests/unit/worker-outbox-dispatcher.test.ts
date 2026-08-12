import type { Database, OutboxBacklogRow } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { createRecordingMetrics } from '@openanalytics/observability'
import { createCapturedLogger } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The generic outbox dispatcher and the product handlers M10 made real.
 *
 * Two things are pinned here. The **loop's contract**, unchanged since
 * ADR-0021: the right topic is claimed, a handler that throws fails only its own
 * row, and the backlog is published as a gauge for every registered topic —
 * including a zero for one that has just been drained, which is the value that
 * tells "nothing left to deliver" apart from "nothing is consuming this topic at
 * all".
 *
 * And the **handler bodies**: the ownership handler bumps the site epoch only
 * when the cutover blocked the site, and the two deletion topics settle. The
 * `billing.subscription` and `notification.rapid_burn` handlers were pinned here
 * too until the open-core split; both are in
 * `tests/unit/cloud/worker-outbox-dispatcher.test.ts` now.
 */

const claimed = { rows: [] as { id: string; payload: unknown }[] }
const backlog = { rows: [] as OutboxBacklogRow[] }

const enqueued: { topic: string; idempotencyKey: string; payload: unknown }[] = []

const claimDueOutbox = vi.fn(
  async (_db: unknown, _params: { topic: string; limit: number }) => claimed.rows,
)
const markOutboxDelivered = vi.fn(async (_db: unknown, _id: string) => {})
const markOutboxFailed = vi.fn(async (_db: unknown, _id: string, _reason: string) => {})
const readOutboxBacklog = vi.fn(async (_db: unknown) => backlog.rows)
const enqueueOutbox = vi.fn(
  async (_db: unknown, input: { topic: string; idempotencyKey: string; payload: unknown }) => {
    enqueued.push(input)
    return { enqueued: true, id: 'outbox-1' }
  },
)

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    claimDueOutbox: (db: unknown, params: { topic: string; limit: number }) =>
      claimDueOutbox(db, params),
    markOutboxDelivered: (db: unknown, id: string) => markOutboxDelivered(db, id),
    markOutboxFailed: (db: unknown, id: string, reason: string) => markOutboxFailed(db, id, reason),
    readOutboxBacklog: (db: unknown) => readOutboxBacklog(db),
    enqueueOutbox: (
      db: unknown,
      input: { topic: string; idempotencyKey: string; payload: unknown },
    ) => enqueueOutbox(db, input),
  }
})

const { DEFAULT_OUTBOX_TOPICS, drainOutboxTopic, publishOutboxBacklog } =
  await import('../../apps/worker/src/outbox-dispatcher.ts')

const db = {} as Database

const POLICY = { productName: 'Open Analytics' } as const

/** Records every epoch bump, so a test can assert exactly which sites were cut. */
function recordingCache() {
  const bumps: { siteId: string; subject: string }[] = []
  return {
    bumps,
    bumpEpochAndPublishDisconnect: (input: { siteId: string; subject: string }) => {
      bumps.push(input)
      return Promise.resolve(bumps.length)
    },
  }
}

const deps = (realtimeCache?: ReturnType<typeof recordingCache>) => {
  const { logger, find } = createCapturedLogger()
  return {
    db,
    logger,
    find,
    metrics: createRecordingMetrics(),
    policy: POLICY,
    ...(realtimeCache === undefined ? {} : { realtimeCache }),
  }
}

const registrationFor = (topic: string) => {
  const found = DEFAULT_OUTBOX_TOPICS.find((registration) => registration.topic === topic)
  if (!found) throw new Error(`no registration for ${topic}`)
  return found
}

beforeEach(() => {
  claimed.rows = []
  backlog.rows = []
  enqueued.length = 0
  claimDueOutbox.mockClear()
  markOutboxDelivered.mockClear()
  markOutboxFailed.mockClear()
  readOutboxBacklog.mockClear()
  enqueueOutbox.mockClear()
})

describe('outbox dispatcher', () => {
  it('registers every topic that would otherwise accumulate unread', () => {
    expect(DEFAULT_OUTBOX_TOPICS.map((registration) => registration.topic)).toEqual([
      'site.ownership_changed',
      // Observe-only until the email milestone (ADR-0030, D4 follow-up). The
      // registration exists from CP3 so the row is drained rather than piling up
      // behind a topic nobody consumes.
      'site.deletion_completed',
      // Likewise from CP4 (ADR-0030, D8): the "your account and its data are
      // gone" mail is the email milestone's, and an unconsumed topic is a table
      // that grows forever.
      'account.deletion_completed',
      // `billing.subscription` and `notification.rapid_burn` were in this list
      // until the open-core split. They are registered by the surface that writes
      // them (`apps/worker/src/cloud/outbox.ts`), and what this pins is the set a
      // build with no such surface drains.
    ])
  })

  it('claims its own topic and settles the rows it handled', async () => {
    claimed.rows = [
      { id: 'row-1', payload: { userId: 'u1', entitlementState: 'active', planTier: 'starter' } },
    ]
    const handled: unknown[] = []
    const result = await drainOutboxTopic(deps(), {
      topic: 'billing.subscription',
      handle: (payload) => {
        handled.push(payload)
        return Promise.resolve()
      },
    })

    expect(claimDueOutbox).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ topic: 'billing.subscription' }),
    )
    expect(handled).toHaveLength(1)
    expect(markOutboxDelivered).toHaveBeenCalledWith(db, 'row-1')
    expect(result).toEqual({ claimed: 1, delivered: 1, failed: 0 })
  })

  it('fails only the row whose handler threw, and keeps going', async () => {
    claimed.rows = [
      { id: 'row-1', payload: {} },
      { id: 'row-2', payload: {} },
      { id: 'row-3', payload: {} },
    ]
    let seen = 0
    const result = await drainOutboxTopic(deps(), {
      topic: 'notification.rapid_burn',
      handle: () => {
        seen += 1
        return seen === 1 ? Promise.reject(new Error('handler exploded')) : Promise.resolve()
      },
    })

    // One rejection, and the two rows behind it were still delivered.
    expect(result.claimed).toBe(3)
    expect(result.failed).toBe(1)
    expect(result.delivered).toBe(2)
    expect(markOutboxFailed).toHaveBeenCalledWith(db, 'row-1', 'handler exploded')
  })

  it('publishes the backlog as gauges, and a zero for a drained topic', async () => {
    backlog.rows = [
      { topic: 'email.send', status: 'pending', count: 4, oldestAgeMs: 90_000 },
      { topic: 'billing.subscription', status: 'dead', count: 1, oldestAgeMs: 3_600_000 },
    ]
    const context = deps()
    await publishOutboxBacklog(context, ['billing.subscription', 'notification.rapid_burn'])

    const gauges = context.metrics.recorded.filter((entry) => entry.kind === 'gauge')
    expect(gauges).toContainEqual(
      expect.objectContaining({
        name: 'worker_outbox_backlog',
        value: 4,
        labels: { topic: 'email.send', status: 'pending' },
      }),
    )
    expect(gauges).toContainEqual(
      expect.objectContaining({
        name: 'worker_outbox_oldest_age_ms',
        value: 3_600_000,
        labels: { topic: 'billing.subscription', status: 'dead' },
      }),
    )
    // A registered topic with nothing in the table reports zero rather than
    // leaving its last non-zero value as the newest thing the backend saw.
    expect(gauges).toContainEqual(
      expect.objectContaining({
        name: 'worker_outbox_backlog',
        value: 0,
        labels: { topic: 'notification.rapid_burn', status: 'pending' },
      }),
    )
    // …but a status that was reported non-zero is not then overwritten with 0.
    expect(gauges).not.toContainEqual(
      expect.objectContaining({
        name: 'worker_outbox_backlog',
        value: 0,
        labels: { topic: 'billing.subscription', status: 'dead' },
      }),
    )
  })

  it('zero-fills the topics drained by their own loops, so healthy reads as zero', async () => {
    // The M18 defect. `email.send` is drained by `startEmailDrain`, which
    // publishes no gauge of its own, so `worker_outbox_backlog{topic="email.send"}`
    // existed only while rows did — and "no dead email" was indistinguishable
    // from "the drain and its gauge are not running at all". The dead-letter
    // alert had to be armed with noDataState: OK to compensate, which is the
    // same as saying it could not fire on the case it exists for.
    backlog.rows = []
    const context = deps()
    await publishOutboxBacklog(context, ['billing.subscription'])

    const gauges = context.metrics.recorded.filter((entry) => entry.kind === 'gauge')
    for (const status of ['pending', 'processing', 'dead'] as const) {
      expect(gauges).toContainEqual(
        expect.objectContaining({
          name: 'worker_outbox_backlog',
          value: 0,
          labels: { topic: 'email.send', status },
        }),
      )
    }
    // The second externally drained topic, for the identical reason.
    expect(gauges).toContainEqual(
      expect.objectContaining({
        name: 'worker_outbox_oldest_age_ms',
        value: 0,
        labels: { topic: 'realtime.access_revoked', status: 'pending' },
      }),
    )
  })

  it('does not overwrite a real email.send backlog with the zero-fill', async () => {
    // The zero-fill is a floor, not a value: a topic that reported rows in the
    // GROUP BY must keep its count, or the alert would read zero on exactly the
    // queue that is backing up.
    backlog.rows = [{ topic: 'email.send', status: 'dead', count: 2, oldestAgeMs: 60_000 }]
    const context = deps()
    await publishOutboxBacklog(context, [])

    const gauges = context.metrics.recorded.filter((entry) => entry.kind === 'gauge')
    expect(gauges).toContainEqual(
      expect.objectContaining({
        name: 'worker_outbox_backlog',
        value: 2,
        labels: { topic: 'email.send', status: 'dead' },
      }),
    )
    expect(gauges).not.toContainEqual(
      expect.objectContaining({
        name: 'worker_outbox_backlog',
        value: 0,
        labels: { topic: 'email.send', status: 'dead' },
      }),
    )
  })
})

describe('site.ownership_changed handler', () => {
  it('bumps the site epoch when the cutover blocked the site', async () => {
    claimed.rows = [
      {
        id: 'row-1',
        payload: { siteId: 'site-a', status: 'suspended', successorUserId: 'u2' },
      },
    ]
    const cache = recordingCache()

    const result = await drainOutboxTopic(deps(cache), registrationFor('site.ownership_changed'))

    expect(result).toEqual({ claimed: 1, delivered: 1, failed: 0 })
    expect(cache.bumps).toEqual([{ siteId: 'site-a', subject: 'site' }])
  })

  it('settles without bumping when the cutover left the site active', async () => {
    claimed.rows = [
      { id: 'row-1', payload: { siteId: 'site-a', status: 'active', successorUserId: 'u2' } },
    ]
    const cache = recordingCache()

    const result = await drainOutboxTopic(deps(cache), registrationFor('site.ownership_changed'))

    expect(result).toEqual({ claimed: 1, delivered: 1, failed: 0 })
    expect(cache.bumps).toEqual([])
  })
})
