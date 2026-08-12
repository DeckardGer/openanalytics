import type { StoredRevenueRollupBucket } from '@openanalytics/clickhouse'
import { describe, expect, it } from 'vitest'
import {
  affectedBucketSecondsOf,
  aggregateRevenueBuckets,
  bucketSecondsOf,
  disputeMoneyEffect,
  planRevenueRollupSwap,
  type RollupFact,
} from '../../apps/worker/src/revenue/rollup-plan.ts'
import {
  REVENUE_ROLLUP_RECOMPUTE_CHUNK_DAYS,
  revenueRecomputeChunk,
  revenueRollupRange,
} from '../../apps/worker/src/revenue/rollup.ts'

/**
 * The revenue rollup's sign rules and swap semantics (ADR-0033, D2d/D7;
 * ClickHouse migration 0018). Milestone 12 Checkpoint 5.
 *
 * Every rule this file pins is one that would be invisible in production if it
 * were wrong — a rollup that double-counts a refund produces a plausible number,
 * not an error — so each has a named case rather than being folded into a
 * happy-path aggregate.
 */

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const HOUR = '2026-07-20T10:00:00.000Z'
const HOUR_MS = Date.parse(HOUR)
const HOUR_SECONDS = HOUR_MS / 1000
const DAY_SECONDS = Date.parse('2026-07-20T00:00:00.000Z') / 1000

function fact(overrides: Partial<RollupFact> = {}): RollupFact {
  return {
    objectKind: 'charge',
    status: 'succeeded',
    occurredAtMs: HOUR_MS,
    conversionSource: 'ecb',
    reportingGrossMinor: 10_000,
    reportingNetMinor: 9_500,
    ...overrides,
  }
}

function hourBucket(facts: readonly RollupFact[]) {
  const bucket = aggregateRevenueBuckets(facts, '1h').get(HOUR_SECONDS)
  expect(bucket, 'the hour bucket must exist').toBeDefined()
  return bucket!
}

describe('the sign rule (ADR-0033, D2d)', () => {
  it('adds a charge to gross, fee and net and counts it once', () => {
    const bucket = hourBucket([fact()])
    expect(bucket.chargeGrossMinor).toBe(10_000)
    // The fee is what the provider withheld: gross minus net, on the charge side.
    expect(bucket.feeMinor).toBe(500)
    expect(bucket.netMinor).toBe(9_500)
    expect(bucket.chargeCount).toBe(1)
    expect(bucket.refundCount).toBe(0)
  })

  it('subtracts a refund in the refund’s own bucket, not the charge’s', () => {
    // The charge is in the 10:00 hour, the refund two hours later. D2d: the
    // refund reduces net in ITS bucket, so a July report read in July still
    // reads the same in September.
    const buckets = aggregateRevenueBuckets(
      [
        fact(),
        fact({
          objectKind: 'refund',
          occurredAtMs: HOUR_MS + 2 * 3_600_000,
          reportingGrossMinor: 4_000,
          reportingNetMinor: 4_000,
        }),
      ],
      '1h',
    )

    const chargeHour = buckets.get(HOUR_SECONDS)!
    expect(chargeHour.chargeGrossMinor).toBe(10_000)
    expect(chargeHour.refundMinor).toBe(0)
    expect(chargeHour.netMinor).toBe(9_500)

    const refundHour = buckets.get(HOUR_SECONDS + 7_200)!
    expect(refundHour.chargeGrossMinor).toBe(0)
    expect(refundHour.refundMinor).toBe(4_000)
    expect(refundHour.netMinor).toBe(-4_000)
  })

  it('keeps a refunded charge’s FULL gross — the refund is not counted twice', () => {
    // The single most tempting mistake in this file. The charge's status moved
    // to `refunded`, which is a description of what later happened to it, not a
    // second money movement — the refund object carries the negative.
    const bucket = hourBucket([
      fact({ status: 'refunded' }),
      fact({
        objectKind: 'refund',
        reportingGrossMinor: 10_000,
        reportingNetMinor: 10_000,
      }),
    ])
    expect(bucket.chargeGrossMinor).toBe(10_000)
    expect(bucket.refundMinor).toBe(10_000)
    // Net is the charge's net minus the refund — NOT minus it twice.
    expect(bucket.netMinor).toBe(9_500 - 10_000)
    expect(bucket.chargeCount).toBe(1)
  })

  it('keeps a partially refunded charge whole too', () => {
    const bucket = hourBucket([fact({ status: 'partially_refunded' })])
    expect(bucket.chargeGrossMinor).toBe(10_000)
    expect(bucket.chargeCount).toBe(1)
  })

  it('excludes failed and canceled objects entirely, money and count', () => {
    const bucket = hourBucket([
      fact({ status: 'failed' }),
      fact({ objectKind: 'refund', status: 'canceled', reportingGrossMinor: 500 }),
      fact({ objectKind: 'refund', status: 'cancelled', reportingGrossMinor: 500 }),
    ])
    expect(bucket.chargeGrossMinor).toBe(0)
    expect(bucket.refundMinor).toBe(0)
    expect(bucket.chargeCount).toBe(0)
    expect(bucket.refundCount).toBe(0)
    // Not an unconverted remainder either: it moved no money at all.
    expect(bucket.unconvertedCount).toBe(0)
  })

  it('counts a pending charge, because the money is genuinely in flight', () => {
    const bucket = hourBucket([fact({ status: 'pending' })])
    expect(bucket.chargeCount).toBe(1)
    expect(bucket.chargeGrossMinor).toBe(10_000)
  })

  it('closes the net identity across every kind', () => {
    const bucket = hourBucket([
      fact({ reportingGrossMinor: 10_000, reportingNetMinor: 9_500 }),
      fact({ objectKind: 'refund', reportingGrossMinor: 2_000, reportingNetMinor: 1_900 }),
      fact({
        objectKind: 'dispute',
        status: 'lost',
        reportingGrossMinor: 3_000,
        reportingNetMinor: 3_000,
      }),
      fact({
        objectKind: 'dispute',
        status: 'won',
        reportingGrossMinor: 1_000,
        reportingNetMinor: 1_000,
      }),
    ])

    // net = charge_gross - refund - withdrawn + reinstated - fee, exactly.
    expect(bucket.netMinor).toBe(
      bucket.chargeGrossMinor -
        bucket.refundMinor -
        bucket.disputeWithdrawnMinor +
        bucket.disputeReinstatedMinor -
        bucket.feeMinor,
    )
  })
})

describe('the dispute lifecycle', () => {
  it('classifies provider statuses into the three money states', () => {
    expect(disputeMoneyEffect('won')).toBe('reinstated')
    expect(disputeMoneyEffect('lost')).toBe('withdrawn')
    expect(disputeMoneyEffect('needs_response')).toBe('withdrawn')
    expect(disputeMoneyEffect('under_review')).toBe('withdrawn')
    expect(disputeMoneyEffect('warning_needs_response')).toBe('none')
    expect(disputeMoneyEffect('warning_closed')).toBe('none')
    // An unknown status is conservative: understating revenue while a dispute is
    // unresolved is the safe direction, and it matches what the provider has
    // actually done to the balance.
    expect(disputeMoneyEffect('some_future_state')).toBe('withdrawn')
  })

  it('moves a won dispute through BOTH columns so the event stays visible', () => {
    const bucket = hourBucket([
      fact({
        objectKind: 'dispute',
        status: 'won',
        reportingGrossMinor: 3_000,
        reportingNetMinor: 3_000,
      }),
    ])
    expect(bucket.disputeWithdrawnMinor).toBe(3_000)
    expect(bucket.disputeReinstatedMinor).toBe(3_000)
    // Zero net effect, and the dispute is still countable and visible.
    expect(bucket.netMinor).toBe(0)
    expect(bucket.disputeCount).toBe(1)
  })

  it('counts an early-warning dispute with zero money', () => {
    const bucket = hourBucket([
      fact({ objectKind: 'dispute', status: 'warning_under_review', reportingGrossMinor: 5_000 }),
    ])
    expect(bucket.disputeCount).toBe(1)
    expect(bucket.disputeWithdrawnMinor).toBe(0)
    expect(bucket.netMinor).toBe(0)
  })
})

describe('the unconverted remainder (ADR-0033, D2c)', () => {
  it('contributes zero money and zero kind count, and increments its own counter', () => {
    const bucket = hourBucket([
      fact(),
      fact({
        conversionSource: 'unavailable',
        // CP3 writes zeros beside the flag; the flag is what makes them unknown
        // rather than nothing, and this asserts the rollup honours that even
        // when the amounts are non-zero garbage.
        reportingGrossMinor: 99_999,
        reportingNetMinor: 99_999,
      }),
    ])
    expect(bucket.chargeGrossMinor).toBe(10_000)
    expect(bucket.netMinor).toBe(9_500)
    expect(bucket.chargeCount).toBe(1)
    expect(bucket.unconvertedCount).toBe(1)
  })

  it('treats `none` (same currency, no conversion needed) as fully converted', () => {
    const bucket = hourBucket([fact({ conversionSource: 'none' })])
    expect(bucket.chargeGrossMinor).toBe(10_000)
    expect(bucket.unconvertedCount).toBe(0)
  })
})

describe('bucketing', () => {
  it('floors to the UTC hour and the UTC day', () => {
    const ms = Date.parse('2026-07-20T10:37:41.500Z')
    expect(bucketSecondsOf(ms, '1h')).toBe(HOUR_SECONDS)
    expect(bucketSecondsOf(ms, '1d')).toBe(DAY_SECONDS)
  })

  it('sums a day from the hours inside it', () => {
    const facts = [fact(), fact({ occurredAtMs: HOUR_MS + 5 * 3_600_000 })]
    const hours = aggregateRevenueBuckets(facts, '1h')
    const days = aggregateRevenueBuckets(facts, '1d')
    expect(hours.size).toBe(2)
    expect(days.size).toBe(1)
    expect(days.get(DAY_SECONDS)!.chargeGrossMinor).toBe(20_000)
  })

  it('renders the bucket start as a ClickHouse DateTime literal', () => {
    expect(hourBucket([fact()]).bucketStart).toBe('2026-07-20 10:00:00')
  })
})

describe('the swap plan (0014’s idiom)', () => {
  const computedAtMs = Date.parse('2026-07-21T00:00:00.000Z')
  /**
   * The generation the lease claim minted for this run.
   *
   * Supplied rather than derived, which is the CP5 departure from 0014.
   * `max(stored) + 1` is collision-free only while exactly one writer is awake,
   * and this job's five-minute lease is never renewed — so a pass that outlives
   * its lease and the worker that stole it would read the same stored maximum
   * and mint the same number, which is the one tie ReplacingMergeTree cannot
   * resolve.
   */
  const GENERATION = 12

  function stored(overrides: Partial<StoredRevenueRollupBucket> = {}): StoredRevenueRollupBucket {
    return {
      bucketSeconds: HOUR_SECONDS,
      bucketStart: '2026-07-20 10:00:00',
      generation: 7,
      chargeGrossMinor: 10_000,
      refundMinor: 0,
      disputeWithdrawnMinor: 0,
      disputeReinstatedMinor: 0,
      feeMinor: 500,
      netMinor: 9_500,
      chargeCount: 1,
      refundCount: 0,
      disputeCount: 0,
      unconvertedCount: 0,
      ...overrides,
    }
  }

  it('writes NOTHING when a recompute agrees with what is stored', () => {
    // The property the whole 15-minute staleness sweep rests on: it re-reads a
    // rolling month every pass, and without this an unchanged site would grow a
    // generation per bucket four times an hour, forever.
    const plan = planRevenueRollupSwap({
      siteId: SITE,
      recomputed: aggregateRevenueBuckets([fact()], '1h'),
      stored: [stored()],
      affectedBucketSeconds: [HOUR_SECONDS],
      generation: GENERATION,
      computedAtMs,
    })
    expect(plan.rows).toHaveLength(0)
    expect(plan.changed).toBe(0)
  })

  it('writes the claim’s generation, never one derived from what is stored', () => {
    const plan = planRevenueRollupSwap({
      siteId: SITE,
      recomputed: aggregateRevenueBuckets([fact(), fact()], '1h'),
      // Deliberately BELOW the run's generation, and deliberately uneven across
      // buckets: nothing about the stored rows may influence what is written.
      stored: [
        stored({ generation: 3 }),
        stored({ bucketSeconds: HOUR_SECONDS + 3_600, generation: 11 }),
      ],
      affectedBucketSeconds: [HOUR_SECONDS],
      generation: GENERATION,
      computedAtMs,
    })
    expect(plan.changed).toBe(1)
    expect(plan.generation).toBe(GENERATION)
    expect(plan.rows[0]?.generation).toBe(GENERATION)
    expect(plan.rows[0]?.charge_gross_minor).toBe(20_000)
    expect(plan.rows[0]?.computed_at).toBe('2026-07-21 00:00:00.000')
  })

  it('cannot tie with a concurrent run, because the generation is not read from storage', () => {
    // The lease-theft case. Two runs see the identical stored state; under
    // `max(stored) + 1` both would mint the same number and ReplacingMergeTree
    // would have no basis to choose. With claim-minted generations the newer run
    // always holds the higher one, so the newer answer wins outright.
    const storedState = [stored({ generation: 7 })]
    const victim = planRevenueRollupSwap({
      siteId: SITE,
      recomputed: aggregateRevenueBuckets([fact(), fact()], '1h'),
      stored: storedState,
      affectedBucketSeconds: [HOUR_SECONDS],
      generation: 8,
      computedAtMs,
    })
    const thief = planRevenueRollupSwap({
      siteId: SITE,
      recomputed: aggregateRevenueBuckets([fact(), fact(), fact()], '1h'),
      stored: storedState,
      affectedBucketSeconds: [HOUR_SECONDS],
      generation: 9,
      computedAtMs,
    })
    expect(victim.generation).not.toBe(thief.generation)
    expect(thief.generation).toBeGreaterThan(victim.generation)
  })

  it('uses the claim’s generation on a site with no stored buckets at all', () => {
    const plan = planRevenueRollupSwap({
      siteId: SITE,
      recomputed: aggregateRevenueBuckets([fact()], '1h'),
      stored: [],
      affectedBucketSeconds: [HOUR_SECONDS],
      generation: 1,
      computedAtMs,
    })
    expect(plan.generation).toBe(1)
    expect(plan.changed).toBe(1)
  })

  it('does not write a row for a bucket that was never stored and is empty', () => {
    // An empty hour must not become a row per hour forever.
    const plan = planRevenueRollupSwap({
      siteId: SITE,
      recomputed: new Map(),
      stored: [],
      affectedBucketSeconds: [HOUR_SECONDS, HOUR_SECONDS + 3_600],
      generation: GENERATION,
      computedAtMs,
    })
    expect(plan.rows).toHaveLength(0)
  })

  it('zeroes a stored bucket whose facts all became ineligible', () => {
    // A charge that became `failed` under a new version empties its bucket, and
    // nothing in the fact set names that bucket any more — which is why the
    // affected set includes the stored side.
    const plan = planRevenueRollupSwap({
      siteId: SITE,
      recomputed: aggregateRevenueBuckets([fact({ status: 'failed' })], '1h'),
      stored: [stored()],
      affectedBucketSeconds: affectedBucketSecondsOf({
        facts: [fact({ status: 'failed' })],
        stored: [stored()],
        unit: '1h',
      }),
      generation: GENERATION,
      computedAtMs,
    })
    expect(plan.changed).toBe(1)
    expect(plan.rows[0]?.charge_gross_minor).toBe(0)
    expect(plan.rows[0]?.charge_count).toBe(0)
    expect(plan.rows[0]?.generation).toBe(GENERATION)
  })

  it('emits rows in bucket order, so the dedup token is stable', () => {
    const facts = [fact({ occurredAtMs: HOUR_MS + 3_600_000 }), fact()]
    const plan = planRevenueRollupSwap({
      siteId: SITE,
      recomputed: aggregateRevenueBuckets(facts, '1h'),
      stored: [],
      // Deliberately out of order, and duplicated: the planner sorts and
      // de-duplicates, so a retry rebuilds byte-identical rows.
      affectedBucketSeconds: [HOUR_SECONDS + 3_600, HOUR_SECONDS, HOUR_SECONDS],
      generation: GENERATION,
      computedAtMs,
    })
    expect(plan.rows.map((row) => row.bucket_start)).toEqual([
      '2026-07-20 10:00:00',
      '2026-07-20 11:00:00',
    ])
  })
})

describe('a window whose ONLY change is not a charge (M12 CP7 defect 2)', () => {
  /**
   * The production symptom: a refund landed at 00:21 and `revenue_1h` kept
   * `refund_minor: 0` at generation 3 until an unrelated charge at 00:32 forced
   * a rebuild. Reproduced twice.
   *
   * The root cause was discovery — `listSitesForRevenueAttribution` was
   * charge-only, so the pass did not RUN — and it is pinned in the repository
   * suite. These cases pin the other half, which is the half that made the bug
   * hard to see: the recompute itself has always been kind-blind, so once the
   * pass runs the bucket is correct. Both halves have to hold, and a green
   * assertion here is not evidence for the other.
   */
  const stored = (
    overrides: Partial<StoredRevenueRollupBucket> = {},
  ): StoredRevenueRollupBucket => ({
    bucketSeconds: HOUR_SECONDS,
    bucketStart: '2026-07-20 10:00:00',
    generation: 3,
    chargeGrossMinor: 10_000,
    refundMinor: 0,
    disputeWithdrawnMinor: 0,
    disputeReinstatedMinor: 0,
    feeMinor: 500,
    netMinor: 9_500,
    chargeCount: 1,
    refundCount: 0,
    disputeCount: 0,
    unconvertedCount: 0,
    ...overrides,
  })

  it('rebuilds the bucket when a refund is the only new fact, and net drops', () => {
    const facts = [
      fact({ status: 'refunded' }),
      fact({
        objectKind: 'refund',
        reportingGrossMinor: 4_000,
        reportingNetMinor: 4_000,
      }),
    ]
    const plan = planRevenueRollupSwap({
      siteId: SITE,
      recomputed: aggregateRevenueBuckets(facts, '1h'),
      stored: [stored()],
      affectedBucketSeconds: affectedBucketSecondsOf({ facts, stored: [stored()], unit: '1h' }),
      generation: 4,
      computedAtMs: Date.parse('2026-07-20T11:00:00.000Z'),
    })

    expect(plan.changed).toBe(1)
    const row = plan.rows[0]
    expect(row?.refund_minor).toBe(4_000)
    // The number the dashboard was overstating.
    expect(row?.net_minor).toBe(9_500 - 4_000)
    // The charge keeps its full gross — the refund is not deducted twice.
    expect(row?.charge_gross_minor).toBe(10_000)
    expect(row?.generation).toBe(4)
  })

  it('rebuilds the bucket when a dispute CLOSES and the money is reinstated', () => {
    // A dispute is one object whose status changes, so this is a pure
    // no-new-charge event: the same head, a later version, a different status.
    const opened = [
      fact({
        objectKind: 'dispute',
        status: 'needs_response',
        reportingGrossMinor: 3_000,
        reportingNetMinor: 3_000,
      }),
    ]
    const withdrawn = aggregateRevenueBuckets(opened, '1h').get(HOUR_SECONDS)
    expect(withdrawn?.disputeWithdrawnMinor).toBe(3_000)
    expect(withdrawn?.disputeReinstatedMinor).toBe(0)
    expect(withdrawn?.netMinor).toBe(-3_000)

    const won = [
      fact({
        objectKind: 'dispute',
        status: 'won',
        reportingGrossMinor: 3_000,
        reportingNetMinor: 3_000,
      }),
    ]
    const plan = planRevenueRollupSwap({
      siteId: SITE,
      recomputed: aggregateRevenueBuckets(won, '1h'),
      stored: [
        stored({
          chargeGrossMinor: 0,
          feeMinor: 0,
          chargeCount: 0,
          disputeWithdrawnMinor: 3_000,
          disputeCount: 1,
          netMinor: -3_000,
        }),
      ],
      affectedBucketSeconds: [HOUR_SECONDS],
      generation: 4,
      computedAtMs: Date.parse('2026-07-20T11:00:00.000Z'),
    })

    expect(plan.changed).toBe(1)
    const row = plan.rows[0]
    expect(row?.dispute_reinstated_minor).toBe(3_000)
    expect(row?.dispute_withdrawn_minor).toBe(3_000)
    // The money came back: net effect zero, and the event still visible.
    expect(row?.net_minor).toBe(0)
  })
})

describe('the rollup range', () => {
  const fromMs = Date.parse('2026-06-20T13:37:00.000Z')
  const toMs = Date.parse('2026-07-21T09:15:00.000Z')

  it('snaps the horizon out to whole UTC days', () => {
    const result = revenueRollupRange({ fromMs, toMs })
    expect(new Date(result.range.loMs).toISOString()).toBe('2026-06-20T00:00:00.000Z')
    expect(new Date(result.range.hiMs).toISOString()).toBe('2026-07-22T00:00:00.000Z')
    expect(result.deferredFloorMs).toBeNull()
  })

  it('lowers the floor to a recently changed object of ANY kind', () => {
    // B3: a dispute is ONE object whose status changes, so winning it bumps only
    // the dispute head while `occurred_at` stays the day it opened. The
    // charge-only horizon cannot see that at all.
    const disputeOpened = Date.parse('2026-06-05T11:00:00.000Z')
    const result = revenueRollupRange({ fromMs, toMs, changedObjectFloorMs: disputeOpened })
    expect(new Date(result.range.loMs).toISOString()).toBe('2026-06-05T00:00:00.000Z')
    expect(result.deferredFloorMs).toBeNull()
  })

  it('ignores a changed floor already inside the horizon', () => {
    const result = revenueRollupRange({ fromMs, toMs, changedObjectFloorMs: toMs - 3_600_000 })
    expect(new Date(result.range.loMs).toISOString()).toBe('2026-06-20T00:00:00.000Z')
    expect(result.deferredFloorMs).toBeNull()
  })

  it('defers a changed floor more than one chunk below the horizon', () => {
    // A dispute opened a year ago and closed today, or a deep backfill. Reading
    // it inline would be the unbounded read the chunk walk exists to avoid, so
    // it is handed to the cursor instead — one mechanism, not two.
    const ancient = Date.parse('2025-06-01T00:00:00.000Z')
    const result = revenueRollupRange({ fromMs, toMs, changedObjectFloorMs: ancient })
    expect(new Date(result.range.loMs).toISOString()).toBe('2026-06-20T00:00:00.000Z')
    expect(new Date(result.deferredFloorMs as number).toISOString()).toBe(
      '2025-06-01T00:00:00.000Z',
    )
  })

  it('is wider than any ordinary horizon, so a normal pass never chunks', () => {
    // The relation the design rests on, asserted rather than trusted: if the
    // chunk cap were smaller than the widest ordinary range, every pass on every
    // site would start writing a recompute cursor for no reason.
    const widestOrdinaryDays = 30 /* window */ + 1 /* lateness */ + 2 /* day snapping */
    expect(REVENUE_ROLLUP_RECOMPUTE_CHUNK_DAYS).toBeGreaterThanOrEqual(widestOrdinaryDays - 2)
    const result = revenueRollupRange({ fromMs, toMs })
    expect(result.deferredFloorMs).toBeNull()
  })
})

describe('the recompute chunk walk', () => {
  const DAY = 86_400_000
  const normalFloorMs = Date.parse('2026-07-01T00:00:00.000Z')

  it('takes at most one chunk of whole days, oldest first', () => {
    const cursorMs = Date.parse('2023-01-15T07:00:00.000Z')
    const chunk = revenueRecomputeChunk({ cursorMs, normalFloorMs })
    expect(chunk).not.toBeNull()
    // Snapped down to the day it started in, never mid-day.
    expect(new Date((chunk as { range: { loMs: number } }).range.loMs).toISOString()).toBe(
      '2023-01-15T00:00:00.000Z',
    )
    expect(
      ((chunk as { range: { hiMs: number; loMs: number } }).range.hiMs -
        (chunk as { range: { hiMs: number; loMs: number } }).range.loMs) /
        DAY,
    ).toBe(REVENUE_ROLLUP_RECOMPUTE_CHUNK_DAYS)
    expect((chunk as { reachedHorizon: boolean }).reachedHorizon).toBe(false)
  })

  it('stops exactly at the ordinary floor and says so', () => {
    // The chunk and the ordinary range must stay disjoint: they share one
    // generation, so an overlap would mean writing a bucket twice in one pass.
    const cursorMs = normalFloorMs - 3 * DAY
    const chunk = revenueRecomputeChunk({ cursorMs, normalFloorMs })
    expect((chunk as { range: { hiMs: number } }).range.hiMs).toBe(normalFloorMs)
    expect((chunk as { reachedHorizon: boolean }).reachedHorizon).toBe(true)
  })

  it('is null once the cursor has caught up — the walk is over', () => {
    expect(revenueRecomputeChunk({ cursorMs: normalFloorMs, normalFloorMs })).toBeNull()
    expect(revenueRecomputeChunk({ cursorMs: normalFloorMs + DAY, normalFloorMs })).toBeNull()
  })

  it('walks a multi-year history in bounded steps', () => {
    // The memory property, expressed as a loop: no pass ever reads more than one
    // chunk, and the walk terminates.
    let cursorMs = Date.parse('2023-01-01T00:00:00.000Z')
    let passes = 0
    for (;;) {
      const chunk = revenueRecomputeChunk({ cursorMs, normalFloorMs })
      if (chunk === null) break
      expect(chunk.range.hiMs - chunk.range.loMs).toBeLessThanOrEqual(
        REVENUE_ROLLUP_RECOMPUTE_CHUNK_DAYS * DAY,
      )
      cursorMs = chunk.range.hiMs
      passes += 1
      if (chunk.reachedHorizon) break
      expect(passes).toBeLessThan(200)
    }
    // Three and a half years at a month a pass.
    expect(passes).toBeGreaterThan(30)
    expect(passes).toBeLessThan(60)
  })
})
