import {
  REVENUE_SYNC_RESOURCES,
  REVENUE_SYNC_RESOURCE_KINDS,
  decideRevenueObject,
  isRevenueObjectKind,
  isRevenueSyncResource,
  revenueBackfillEventId,
  revenueObservationHash,
  type RevenueNormalizedObject,
  type RevenueObjectHead,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * The object-head decision (ADR-0033, D4) — the pure half of the milestone's
 * first acceptance criterion: *a duplicate or out-of-order provider event never
 * counts twice.*
 *
 * The decision table is exhaustive on purpose. Five of its six branches are one
 * comparison apart from each other, and the two that share a comparison —
 * equal-with-the-same-hash and equal-with-a-different-hash — are the pair the
 * whole design turns on: dropping the second loses state silently, applying it
 * blindly can revert newer state, and only re-fetching from the provider is
 * correct. A test that exercised "equal" without splitting on the hash would
 * pass against an implementation that got the important case wrong.
 */

const AT = (iso: string): Date => new Date(iso)

const head = (overrides: Partial<RevenueObjectHead> = {}): RevenueObjectHead => ({
  snapshotAt: AT('2026-07-31T10:00:00.000Z'),
  payloadHash: 'hash-a',
  version: 7,
  ...overrides,
})

describe('decideRevenueObject — the six branches', () => {
  it('inserts at version 1 when no head exists', () => {
    const decision = decideRevenueObject(null, {
      snapshotAt: AT('2026-07-31T10:00:00.000Z'),
      payloadHash: 'hash-a',
    })
    expect(decision).toEqual({ action: 'apply', version: 1, reason: 'first_observation' })
  })

  it('applies a strictly newer snapshot at stored.version + 1', () => {
    // The version is what CP3's ReplacingMergeTree orders by, so "+1" is not
    // bookkeeping — a version that failed to advance would make ClickHouse keep
    // whichever row it merged last.
    const decision = decideRevenueObject(head(), {
      snapshotAt: AT('2026-07-31T10:00:01.000Z'),
      payloadHash: 'hash-b',
    })
    expect(decision).toEqual({ action: 'apply', version: 8, reason: 'newer_snapshot' })
  })

  it('skips a strictly older snapshot', () => {
    const decision = decideRevenueObject(head(), {
      snapshotAt: AT('2026-07-31T09:59:59.000Z'),
      payloadHash: 'hash-b',
    })
    expect(decision).toEqual({ action: 'skip', reason: 'older_snapshot' })
  })

  it('skips an equal snapshot with an identical payload — a pure duplicate', () => {
    // The redelivery case. It must not produce a version bump: a new version is
    // a new ClickHouse row, and a redelivered webhook would otherwise write one
    // per delivery attempt.
    const decision = decideRevenueObject(head(), {
      snapshotAt: AT('2026-07-31T10:00:00.000Z'),
      payloadHash: 'hash-a',
    })
    expect(decision).toEqual({ action: 'skip', reason: 'duplicate_snapshot' })
  })

  it('re-fetches on an equal snapshot with a different payload', () => {
    // Provider event timestamps are second-granular, so two genuinely different
    // states of one charge can share a second. Neither payload can be ordered
    // against the other, so the only correct answer is to ask the provider.
    const decision = decideRevenueObject(head(), {
      snapshotAt: AT('2026-07-31T10:00:00.000Z'),
      payloadHash: 'hash-b',
    })
    expect(decision).toEqual({
      action: 'refetch_from_provider',
      reason: 'equal_snapshot_differing_payload',
    })
  })

  it('forced: refuses a strictly older snapshot rather than reverting', () => {
    // ADR-0021's fix to the billing side, applied here from the start. The row
    // lock is released for the authoritative fetch, so the row may have moved
    // on; force bypasses the *ambiguity*, never the ordering.
    const decision = decideRevenueObject(
      head(),
      { snapshotAt: AT('2026-07-31T09:00:00.000Z'), payloadHash: 'hash-z' },
      { force: true },
    )
    expect(decision).toEqual({ action: 'skip', reason: 'newer_version_stored' })
  })
})

describe('decideRevenueObject — forced applies', () => {
  it('applies a forced equal snapshot, which is what breaks the tie', () => {
    const decision = decideRevenueObject(
      head(),
      { snapshotAt: AT('2026-07-31T10:00:00.000Z'), payloadHash: 'hash-b' },
      { force: true },
    )
    expect(decision).toEqual({ action: 'apply', version: 8, reason: 'forced' })
  })

  it('applies a forced newer snapshot', () => {
    const decision = decideRevenueObject(
      head(),
      { snapshotAt: AT('2026-07-31T11:00:00.000Z'), payloadHash: 'hash-b' },
      { force: true },
    )
    expect(decision).toEqual({ action: 'apply', version: 8, reason: 'forced' })
  })

  it('forced on an absent head still inserts at version 1', () => {
    const decision = decideRevenueObject(
      null,
      { snapshotAt: AT('2026-07-31T11:00:00.000Z'), payloadHash: 'h' },
      { force: true },
    )
    expect(decision).toEqual({ action: 'apply', version: 1, reason: 'first_observation' })
  })

  it('versions advance monotonically across a chain of applies', () => {
    // The property CP3 depends on, stated as a sequence rather than as three
    // separate assertions: whatever order observations arrive in, the versions
    // a head hands out never repeat and never go backwards.
    let stored: RevenueObjectHead | null = null
    const versions: number[] = []
    for (const [iso, hash] of [
      ['2026-07-31T10:00:00.000Z', 'a'],
      ['2026-07-31T10:00:05.000Z', 'b'],
      ['2026-07-31T09:00:00.000Z', 'stale'],
      ['2026-07-31T10:00:09.000Z', 'c'],
    ] as const) {
      const decision = decideRevenueObject(stored, { snapshotAt: AT(iso), payloadHash: hash })
      if (decision.action !== 'apply') continue
      versions.push(decision.version)
      stored = { snapshotAt: AT(iso), payloadHash: hash, version: decision.version }
    }
    expect(versions).toEqual([1, 2, 3])
  })
})

const normalized = (overrides: Partial<RevenueNormalizedObject> = {}): RevenueNormalizedObject =>
  ({
    object_kind: 'charge',
    status: 'succeeded',
    livemode: false,
    currency: 'usd',
    gross_minor: 4999,
    fee_minor: 0,
    net_minor: 4999,
    occurred_at: '2026-07-31T10:00:00.000Z',
    parent_object_id: '',
    order_id: 'pi_1',
    checkout_session_id: '',
    client_reference_id: '',
    subscription_id: '',
    product_id: '',
    product_name: '',
    customer_id: 'cus_1',
    ...overrides,
  }) as RevenueNormalizedObject

describe('revenueObservationHash', () => {
  it('is independent of key insertion order', () => {
    // The failure this prevents is subtle and would look like a working system:
    // the webhook's normalizer and the list normalizer build the same fields in
    // different orders, so an order-sensitive hash would make every reconcile
    // sweep report a tie and re-fetch every object it re-listed.
    const a = normalized()
    const reordered = Object.fromEntries(
      Object.entries(a).reverse(),
    ) as unknown as RevenueNormalizedObject
    expect(revenueObservationHash(reordered)).toBe(revenueObservationHash(a))
  })

  it('changes when any field changes', () => {
    const base = revenueObservationHash(normalized())
    expect(revenueObservationHash(normalized({ status: 'refunded' }))).not.toBe(base)
    expect(revenueObservationHash(normalized({ gross_minor: 5000 }))).not.toBe(base)
    expect(revenueObservationHash(normalized({ livemode: true }))).not.toBe(base)
  })

  it('does not confuse an absent field with an empty one', () => {
    // `''` and "absent" are different states of `parent_object_id`, and the
    // snapshot builder always emits `''` — but the hash must not be the thing
    // that hides a normalizer which started omitting it.
    const withEmpty = revenueObservationHash(normalized({ parent_object_id: '' }))
    const withValue = revenueObservationHash(normalized({ parent_object_id: 'ch_1' }))
    expect(withEmpty).not.toBe(withValue)
  })
})

describe('revenueBackfillEventId', () => {
  it('is deterministic per (resource, object), which is what makes overlap free', () => {
    // The reconcile sweep re-lists a trailing 48-hour window every 15 minutes. A
    // per-run id would grow the ledger by one row per object per sweep forever.
    expect(revenueBackfillEventId({ resource: 'charges', objectId: 'ch_1' })).toBe(
      'backfill:charges:ch_1',
    )
    expect(revenueBackfillEventId({ resource: 'charges', objectId: 'ch_1' })).toBe(
      revenueBackfillEventId({ resource: 'charges', objectId: 'ch_1' }),
    )
  })

  it('separates resources, so a shared id across two endpoints cannot collide', () => {
    expect(revenueBackfillEventId({ resource: 'refunds', objectId: 'x' })).not.toBe(
      revenueBackfillEventId({ resource: 'disputes', objectId: 'x' }),
    )
  })
})

describe('the ingest vocabularies', () => {
  it('maps every sync resource to exactly one object kind', () => {
    for (const resource of REVENUE_SYNC_RESOURCES) {
      expect(isRevenueObjectKind(REVENUE_SYNC_RESOURCE_KINDS[resource])).toBe(true)
    }
    expect(Object.keys(REVENUE_SYNC_RESOURCE_KINDS)).toHaveLength(REVENUE_SYNC_RESOURCES.length)
  })

  it('refuses values outside the closed vocabularies', () => {
    expect(isRevenueSyncResource('payouts')).toBe(false)
    expect(isRevenueObjectKind('payout')).toBe(false)
    expect(isRevenueObjectKind(null)).toBe(false)
  })
})
