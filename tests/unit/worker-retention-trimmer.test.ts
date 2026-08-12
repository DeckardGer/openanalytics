import type * as PostgresModule from '@openanalytics/postgres'
import type { Database } from '@openanalytics/postgres'
import { loadPolicy } from '@openanalytics/domain'
import { createRecordingMetrics } from '@openanalytics/observability'
import { createCapturedLogger } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'

/**
 * The retention trimmer's idempotency-ledger duty (ADR-0019 known gap 4, closed
 * by the amendment dated 2026-08-06).
 *
 * What the ledger's own Postgres suite (`tests/migration/idempotency.test.ts`)
 * proves is that the sweep deletes the right rows when given the right two
 * instants. What it cannot see is whether anything ever calls it, or with
 * which instants — and an unwired sweeper is precisely the shape ADR-0019's
 * gap had for two months. So this file asserts the wiring: that the hourly trim
 * calls the sweep at all, that the two cutoffs are the *policy's* horizons
 * rather than a pair of numbers retyped here, and that the ledger is swept on a
 * tick where the event queue had nothing to do.
 *
 * The queue half is stubbed to empty on purpose. It has its own live suite
 * (`tests/integration/m6-worker-live.test.ts`), and stubbing it is what makes
 * the last assertion meaningful: the management API fills this table on days
 * the event stream is idle, so a sweep nested inside the queue's own
 * `trimmed > 0` guard would never run for the customer who only ever creates
 * sites.
 */

const world = {
  swept: [] as { completedBefore: Date; claimedBefore: Date; limit: number }[],
  removed: 0,
  readCostSweeps: 0,
  readCostRemoved: 0,
  deviceCodeSweeps: 0,
  deviceCodesRemoved: 0,
  assistantUsageSweeps: 0,
  assistantUsageRemoved: 0,
}

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    deleteManifestsCompletedBefore: async () => 0,
    sweepIdempotencyKeys: async (
      _db: unknown,
      input: { completedBefore: Date; claimedBefore: Date; limit: number },
    ) => {
      world.swept.push(input)
      return world.removed
    },
    // The read-cost ledger's sweep joined this trimmer at M16 (ADR-0043 D7).
    // Stubbed rather than exercised: its horizon is fixed inside its own
    // statement and its behaviour is proven against a real database, so what
    // this file cares about is only that the trimmer calls it on every tick.
    sweepReadCostLedger: async () => {
      world.readCostSweeps += 1
      return world.readCostRemoved
    },
    sweepExpiredDeviceCodes: async () => {
      world.deviceCodeSweeps += 1
      return world.deviceCodesRemoved
    },
    // The assistant ledger's sweep joined this trimmer at M17 (ADR-0046 D5),
    // and is stubbed for the reason the read-cost one is: its 48-hour horizon
    // is fixed inside its own statement and proven against a real database, so
    // what this file cares about is that the trimmer calls it on every tick.
    sweepAssistantUsageLedger: async () => {
      world.assistantUsageSweeps += 1
      return world.assistantUsageRemoved
    },
  }
})

const { runRetentionTrim } = await import('../../apps/worker/src/ingest/trimmer.ts')

const NOW = new Date('2026-08-06T12:00:00.000Z')
const HOUR = 60 * 60 * 1000

function deps(overrides: Record<string, unknown> = {}) {
  const { logger, find } = createCapturedLogger()
  return {
    find,
    input: {
      db: {} as Database,
      logger,
      metrics: createRecordingMetrics(),
      policy: loadPolicy({}),
      now: () => NOW,
      // The queue is quiet: this tick has no stream entries to retire.
      maintenance: { trimAcked: async () => ({ trimmed: 0, minId: '0-0' }) },
      ...overrides,
    } as unknown as Parameters<typeof runRetentionTrim>[0],
  }
}

describe('retention trimmer — idempotency ledger', () => {
  beforeEach(() => {
    world.swept = []
    world.removed = 0
    world.readCostSweeps = 0
    world.readCostRemoved = 0
    world.deviceCodeSweeps = 0
    world.deviceCodesRemoved = 0
    world.assistantUsageSweeps = 0
    world.assistantUsageRemoved = 0
  })

  it('sweeps abandoned device authorizations too', async () => {
    // The token exchange deletes a code whenever it is polled, so this only ever
    // finds the flows that never ended — a CLI killed mid-login, a link nobody
    // opened. Found in production: one such row after the M16 deploy, with
    // nothing that would ever remove it.
    const { input, find } = deps()
    world.deviceCodesRemoved = 4
    const result = await runRetentionTrim(input)
    expect(world.deviceCodeSweeps).toBe(1)
    expect(result.deviceCodesSwept).toBe(4)
    const [line] = find('ingest_retention_trimmed')
    expect(line?.['device_codes_swept']).toBe(4)
  })

  it('sweeps the read-cost ledger on every tick, beside the other two', async () => {
    // ADR-0043 D7. Unconditional and outside the `trimmed > 0` guard, for the
    // reason the idempotency sweep is: the ledger fills from the read surface,
    // which is busy on days the event queue is idle.
    const { input } = deps()
    await runRetentionTrim(input)
    expect(world.readCostSweeps).toBe(1)
  })

  it('reports what the read-cost sweep removed', async () => {
    // A sweep nobody can see in the logs is one nobody can confirm ran in
    // production — the same reason the idempotency sweep reports its own count.
    const { input, find } = deps()
    world.readCostRemoved = 7
    const result = await runRetentionTrim(input)
    expect(result.readCostBucketsSwept).toBe(7)
    const [line] = find('ingest_retention_trimmed')
    expect(line?.['read_cost_buckets_swept']).toBe(7)
  })

  it('sweeps the assistant ledger on the same tick, and reports it', async () => {
    // ADR-0046 D5. The same schedule and the same argument as the read-cost
    // sweep beside it: hourly buckets that expire on wall-clock age, retired by
    // the one process that already wakes up hourly. Unwired, a user's question
    // counts would accumulate forever behind a window that only reads a day of
    // them — the shape ADR-0019's gap had for two months.
    const { input, find } = deps()
    world.assistantUsageRemoved = 5
    const result = await runRetentionTrim(input)
    expect(world.assistantUsageSweeps).toBe(1)
    expect(result.assistantUsageBucketsSwept).toBe(5)
    const [line] = find('ingest_retention_trimmed')
    expect(line?.['assistant_usage_buckets_swept']).toBe(5)
  })

  it('sweeps the ledger with the policy horizons, not a retyped pair of numbers', async () => {
    const policy = loadPolicy({})
    await runRetentionTrim(deps().input)

    expect(world.swept).toHaveLength(1)
    const [call] = world.swept
    expect(call?.completedBefore).toEqual(
      new Date(NOW.getTime() - policy.IDEMPOTENCY_KEY_RETENTION_HOURS * HOUR),
    )
    expect(call?.claimedBefore).toEqual(
      new Date(NOW.getTime() - policy.IDEMPOTENCY_CLAIM_MAX_AGE_HOURS * HOUR),
    )
  })

  it('follows the policy when the horizons are configured away from their defaults', async () => {
    // The point of reading them from `deps.policy`: an operator who widens the
    // replay horizon must move the sweep with it. A hard-coded 24 h passes the
    // test above and fails this one.
    const policy = loadPolicy({
      IDEMPOTENCY_KEY_RETENTION_HOURS: '72',
      IDEMPOTENCY_CLAIM_MAX_AGE_HOURS: '6',
    })
    await runRetentionTrim(deps({ policy }).input)

    const [call] = world.swept
    expect(call?.completedBefore).toEqual(new Date(NOW.getTime() - 72 * HOUR))
    expect(call?.claimedBefore).toEqual(new Date(NOW.getTime() - 6 * HOUR))
  })

  it('sweeps on a tick where the event queue trimmed nothing', async () => {
    world.removed = 3
    const { input, find } = deps()
    const result = await runRetentionTrim(input)

    expect(result.streamTrimmed).toBe(0)
    expect(result.manifestsRemoved).toBe(0)
    expect(result.idempotencyKeysSwept).toBe(3)
    // And it is reported: a sweep nobody can see in the logs is one nobody can
    // confirm ran in production.
    const [line] = find('ingest_retention_trimmed')
    expect(line?.['idempotency_keys_swept']).toBe(3)
  })

  it('stays quiet when there was nothing to retire anywhere', async () => {
    const { input, find } = deps()
    await runRetentionTrim(input)
    expect(find('ingest_retention_trimmed')).toHaveLength(0)
  })
})
