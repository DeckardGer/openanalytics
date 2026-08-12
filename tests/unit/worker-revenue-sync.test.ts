import { randomBytes } from 'node:crypto'
import {
  createRevenueAdapterRegistry,
  revenueCredentialAad,
  type RevenueListOutcome,
  type RevenueNormalizedObject,
  type RevenueObservation,
  type RevenueSyncResource,
} from '@openanalytics/domain'
import { createCredentialVault } from '@openanalytics/integrations'
import type * as PostgresModule from '@openanalytics/postgres'
import type { Database, DueRevenueCredential, RevenueCredentialRow } from '@openanalytics/postgres'
import { NOOP_METRICS } from '@openanalytics/observability'
import { createCapturedLogger } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeRevenueAdapter } from '../support/revenue-fixtures.ts'

/**
 * The worker's revenue layer (ADR-0033, D4): the shared walk, the reconcile
 * sweep and the backfill executor.
 *
 * These three carry the guarantees that are *not* visible in the pure decision
 * or in the SQL, and every one of them is a behaviour a reviewer would otherwise
 * have to take on trust:
 *
 * - **A walk resumes.** The cursor persisted after each page is adopted by the
 *   next call under the same window, so a crash mid-backfill continues rather
 *   than restarting. The `resources.ts` doc-comment claims a test drives this
 *   with a two-day window and two-object pages; this is that test.
 * - **Freshness is earned.** `last_synced_at` moves only on a walk that reached
 *   the end of every resource — not on a failure, and not on a partial run that
 *   merely ran out of page budget.
 * - **A rejected key stops being retried.** `unauthorized` is terminal for the
 *   backfill and excluded from the sweep, and only a rotation or a completed
 *   walk clears it.
 *
 * The Postgres layer is stubbed with an in-memory store rather than mocked
 * per-call: what these tests assert is *sequences* — which page followed which
 * cursor, what state a failure left behind — and a store makes those readable,
 * while the SQL semantics it stands in for (conflict handling, the `FOR UPDATE`
 * decision, cursor upserts) have their own embedded-PG suite.
 */

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const CREDENTIAL = '7c9e2f10-0000-4000-8000-0000000c0ffe'
const API_KEY = 'rk_test_restricted_abcdef1234'

const vault = createCredentialVault(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
)
const aad = revenueCredentialAad({ credentialId: CREDENTIAL, siteId: SITE })

// --- The in-memory Postgres double -------------------------------------------

interface SyncStateRow {
  credentialId: string
  siteId: string
  resource: RevenueSyncResource
  cursor: string | null
  windowStart: Date | null
  windowEnd: Date | null
  completedAt: Date | null
  updatedAt: Date
}

const store = {
  syncState: new Map<string, SyncStateRow>(),
  heads: new Map<string, { snapshotAt: Date; payloadHash: string; version: number }>(),
  ledger: new Map<string, { id: string; status: string }>(),
  credentialUpdates: [] as Record<string, unknown>[],
  due: [] as DueRevenueCredential[],
  credential: null as RevenueCredentialRow | null,
}

const key = (credentialId: string, resource: string): string => `${credentialId}:${resource}`

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  // The real pure decision, so this double cannot disagree with the rule the
  // repository actually applies. Imported inside the factory because `vi.mock`
  // is hoisted above the file's own imports.
  const { decideRevenueObject } = await import('@openanalytics/domain')
  return {
    ...actual,
    readRevenueSyncState: async (
      _db: unknown,
      input: { credentialId: string; resource: RevenueSyncResource },
    ) => store.syncState.get(key(input.credentialId, input.resource)) ?? null,
    saveRevenueSyncState: async (_db: unknown, input: SyncStateRow) => {
      store.syncState.set(key(input.credentialId, input.resource), {
        ...input,
        updatedAt: new Date(),
      })
    },
    recordRevenueProviderEvent: async (
      _db: unknown,
      input: { providerEventId: string; siteId: string },
    ) => {
      const id = `${input.siteId}:${input.providerEventId}`
      const existing = store.ledger.get(id)
      if (existing) return { id: existing.id, firstSeen: false, status: existing.status }
      store.ledger.set(id, { id, status: 'received' })
      return { id, firstSeen: true, status: 'received' }
    },
    markRevenueProviderEvent: async (_db: unknown, input: { id: string; status: string }) => {
      const row = store.ledger.get(input.id)
      if (row) row.status = input.status
    },
    applyRevenueObservation: async (
      _db: unknown,
      input: {
        siteId: string
        provider: string
        observation: RevenueObservation
        payloadHash: string
        force?: boolean
      },
    ) => {
      const headKey = `${input.siteId}:${input.provider}:${input.observation.objectId}`
      const stored = store.heads.get(headKey) ?? null
      const decision = decideRevenueObject(
        stored,
        { snapshotAt: input.observation.snapshotAt, payloadHash: input.payloadHash },
        input.force === true ? { force: true } : {},
      )
      if (decision.action === 'apply') {
        store.heads.set(headKey, {
          snapshotAt: input.observation.snapshotAt,
          payloadHash: input.payloadHash,
          version: decision.version,
        })
      }
      return { decision, objectRowId: headKey }
    },
    listRevenueCredentialsDueForSync: async () => store.due,
    updateRevenueCredentialState: async (_db: unknown, input: Record<string, unknown>) => {
      store.credentialUpdates.push(input)
    },
    readRevenueCredential: async () => store.credential,
  }
})

const { syncRevenueResource, syncAllRevenueResources } =
  await import('../../apps/worker/src/revenue/sync.ts')
const { reconcileRevenueOnce, resetRevenueBackoffs } =
  await import('../../apps/worker/src/revenue/reconcile.ts')
const { executeRevenueBackfill } = await import('../../apps/worker/src/jobs/revenue-backfill.ts')

const db = {} as Database

// --- Fixtures ----------------------------------------------------------------

function normalized(overrides: Partial<RevenueNormalizedObject> = {}): RevenueNormalizedObject {
  return {
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
  } as RevenueNormalizedObject
}

function observation(objectId: string, minute: number): RevenueObservation {
  return {
    objectId,
    objectKind: 'charge',
    snapshotAt: new Date(Date.UTC(2026, 6, 30, 0, minute)),
    normalized: normalized({ order_id: objectId }),
  }
}

/**
 * An adapter that serves a fixed list of objects in two-object pages, honouring
 * `starting_after` exactly as Stripe does.
 *
 * Real paging semantics rather than "return whatever the test says next": the
 * resume assertion is only worth anything if the second call has to *use* the
 * stored cursor to land on the right page.
 */
function pagedAdapter(objects: readonly string[], pageSize = 2) {
  const calls: { resource: string; cursor: string | null }[] = []
  const adapter = fakeRevenueAdapter({
    listObjects: async (_key, resource, options): Promise<RevenueListOutcome> => {
      calls.push({ resource, cursor: options.cursor })
      await Promise.resolve()
      const rows = resource === 'charges' ? objects : []
      const from = options.cursor === null ? 0 : rows.indexOf(options.cursor) + 1
      const slice = rows.slice(from, from + pageSize)
      return {
        ok: true,
        page: {
          observations: slice.map((id, index) => observation(id, from + index)),
          nextCursor: from + pageSize < rows.length ? (slice.at(-1) ?? null) : null,
          hasMore: from + pageSize < rows.length,
        },
      }
    },
  })
  return { adapter, calls }
}

const WINDOW_START = new Date(Date.UTC(2026, 6, 29))
const WINDOW_END = new Date(Date.UTC(2026, 6, 31))

function syncDeps() {
  const { logger } = createCapturedLogger()
  return {
    db,
    logger,
    metrics: NOOP_METRICS,
  }
}

function target() {
  return { credentialId: CREDENTIAL, siteId: SITE, provider: 'stripe', apiKey: API_KEY }
}

beforeEach(() => {
  store.syncState.clear()
  store.heads.clear()
  store.ledger.clear()
  store.credentialUpdates.length = 0
  store.due = []
  store.credential = null
  resetRevenueBackoffs()
})

// --- The resumable walk ------------------------------------------------------

describe('syncRevenueResource — resume', () => {
  it('stops at the page budget and resumes from the persisted cursor', async () => {
    // Six objects, two per page, two pages of budget: the first call reads four
    // and stops, the second call must pick up at the third page rather than the
    // first. This is the assertion the whole cursor design exists for.
    const { adapter, calls } = pagedAdapter(['ch_1', 'ch_2', 'ch_3', 'ch_4', 'ch_5', 'ch_6'])
    const input = {
      target: target(),
      adapter,
      mode: 'backfill' as const,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      pageSize: 2,
      maxPages: 2,
    }

    const first = await syncRevenueResource(syncDeps(), 'charges', input)
    expect(first.ok && first.completed).toBe(false)
    expect(first.counts.pages).toBe(2)
    expect(first.counts.applied).toBe(4)
    expect(store.syncState.get(key(CREDENTIAL, 'charges'))?.cursor).toBe('ch_4')

    const second = await syncRevenueResource(syncDeps(), 'charges', input)
    expect(second.ok && second.completed).toBe(true)
    expect(second.counts.applied).toBe(2)
    // The resumed call sent the stored cursor rather than starting over: three
    // pages in total, the third one opening at `ch_4`.
    expect(calls.map((call) => call.cursor)).toEqual([null, 'ch_2', 'ch_4'])
    // Six objects, six heads: no object was read twice and none was skipped.
    expect(store.heads.size).toBe(6)
  })

  it('re-reads harmlessly when the cursor write is lost (crash between the two)', async () => {
    // The one crash ordering that matters: applies are durable, the cursor is
    // not. The re-walk re-observes objects already in the head, where the
    // three-way rule skips every one of them.
    const { adapter } = pagedAdapter(['ch_1', 'ch_2', 'ch_3', 'ch_4'])
    const input = {
      target: target(),
      adapter,
      mode: 'backfill' as const,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      pageSize: 2,
      maxPages: 1,
    }

    await syncRevenueResource(syncDeps(), 'charges', input)
    expect(store.heads.size).toBe(2)
    // Simulate the lost cursor write.
    store.syncState.delete(key(CREDENTIAL, 'charges'))

    const again = await syncRevenueResource(syncDeps(), 'charges', input)
    expect(again.ok).toBe(true)
    // Re-read, and every one of them skipped — no version was bumped.
    expect(again.counts.applied).toBe(0)
    expect(again.counts.skipped).toBe(2)
    expect([...store.heads.values()].every((head) => head.version === 1)).toBe(true)
  })

  it('discards a cursor taken under a different window', async () => {
    // A provider cursor is a position inside a filtered sequence; resuming it
    // under different bounds would page through something it never described.
    const { adapter, calls } = pagedAdapter(['ch_1', 'ch_2', 'ch_3', 'ch_4'])
    const base = {
      target: target(),
      adapter,
      mode: 'reconcile' as const,
      pageSize: 2,
      maxPages: 1,
    }
    await syncRevenueResource(syncDeps(), 'charges', {
      ...base,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    })
    await syncRevenueResource(syncDeps(), 'charges', {
      ...base,
      windowStart: WINDOW_START,
      windowEnd: new Date(WINDOW_END.getTime() + 1),
    })
    expect(calls.map((call) => call.cursor)).toEqual([null, null])
  })

  it('short-circuits a resource already completed under this window', async () => {
    const { adapter, calls } = pagedAdapter(['ch_1'])
    const input = {
      target: target(),
      adapter,
      mode: 'reconcile' as const,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      pageSize: 2,
      maxPages: 3,
    }
    const first = await syncRevenueResource(syncDeps(), 'charges', input)
    expect(first.ok && first.completed).toBe(true)
    const again = await syncRevenueResource(syncDeps(), 'charges', input)
    expect(again.ok && again.completed).toBe(true)
    expect(again.counts.pages).toBe(0)
    // One provider request in total: the second call asked nothing.
    expect(calls).toHaveLength(1)
  })

  it('drops a cursor the provider refuses instead of degrading the credential', async () => {
    // N1: a stale `starting_after` is a request problem, not a key problem.
    let served = 0
    const adapter = fakeRevenueAdapter({
      listObjects: async (_key, _resource, options): Promise<RevenueListOutcome> => {
        await Promise.resolve()
        served += 1
        if (options.cursor !== null) {
          return { ok: false, reason: 'invalid_cursor', detail: 'stripe responded 400' }
        }
        return {
          ok: true,
          page: { observations: [observation('ch_1', 0)], nextCursor: null, hasMore: false },
        }
      },
    })
    store.syncState.set(key(CREDENTIAL, 'charges'), {
      credentialId: CREDENTIAL,
      siteId: SITE,
      resource: 'charges',
      cursor: 'ch_gone',
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      completedAt: null,
      updatedAt: new Date(),
    })

    const outcome = await syncRevenueResource(syncDeps(), 'charges', {
      target: target(),
      adapter,
      mode: 'reconcile',
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      pageSize: 2,
      maxPages: 3,
    })

    expect(outcome.ok).toBe(true)
    expect(outcome.counts.cursorsReset).toBe(1)
    expect(served).toBe(2)
    expect(store.heads.size).toBe(1)
  })
})

describe('syncAllRevenueResources — one shared page budget', () => {
  it('spends the budget across resources rather than per resource', async () => {
    // S1: a per-resource bound would have made the effective ceiling 3 × maxPages,
    // which is exactly the number a lease is *not* sized against.
    const { adapter, calls } = pagedAdapter(['ch_1', 'ch_2', 'ch_3', 'ch_4', 'ch_5', 'ch_6'])
    const outcome = await syncAllRevenueResources(syncDeps(), {
      target: target(),
      adapter,
      mode: 'backfill',
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      pageSize: 2,
      maxPages: 2,
    })
    expect(outcome.counts.pages).toBe(2)
    // Charges consumed the whole budget, so refunds and disputes were never
    // asked — and the call reports itself incomplete rather than complete.
    expect(calls.map((call) => call.resource)).toEqual(['charges', 'charges'])
    expect(outcome.ok && outcome.completed).toBe(false)
  })

  it('reports completed only when every resource reached its end', async () => {
    const { adapter } = pagedAdapter(['ch_1'])
    const outcome = await syncAllRevenueResources(syncDeps(), {
      target: target(),
      adapter,
      mode: 'reconcile',
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      pageSize: 2,
      maxPages: 9,
    })
    expect(outcome.ok && outcome.completed).toBe(true)
  })

  it('stops at the first failing resource rather than spending budget on the rest', async () => {
    const adapter = fakeRevenueAdapter({
      listObjects: async (): Promise<RevenueListOutcome> => {
        await Promise.resolve()
        return { ok: false, reason: 'unauthorized', detail: 'stripe responded 403' }
      },
    })
    const outcome = await syncAllRevenueResources(syncDeps(), {
      target: target(),
      adapter,
      mode: 'backfill',
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      pageSize: 2,
      maxPages: 9,
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'unauthorized' })
  })
})

// --- The reconcile sweep -----------------------------------------------------

function due(overrides: Partial<DueRevenueCredential> = {}): DueRevenueCredential {
  const id = overrides.id ?? CREDENTIAL
  const siteId = overrides.siteId ?? SITE
  return {
    id,
    siteId,
    provider: 'stripe',
    // Encrypted under this row's OWN aad. Reusing one ciphertext across ids
    // would make every credential but the first fail to decrypt — which is the
    // AAD binding working correctly, and would silently turn a sweep test into a
    // decryption-failure test.
    encryptedApiKey: vault.encrypt(API_KEY, revenueCredentialAad({ credentialId: id, siteId }))
      .stored,
    keyVersion: 'k1',
    status: 'active',
    lastError: null,
    lastSyncedAt: new Date(Date.UTC(2026, 6, 30)),
    ...overrides,
  }
}

function reconcileDeps(adapter: ReturnType<typeof fakeRevenueAdapter>, stopped?: () => boolean) {
  const captured = createCapturedLogger()
  return {
    deps: {
      db,
      logger: captured.logger,
      metrics: NOOP_METRICS,
      revenue: {
        vault,
        adapters: createRevenueAdapterRegistry([adapter]),
        policy: { backfillDays: 90, pageSize: 2, reconcileWindowHours: 48 },
      },
      staleMinutes: 15,
      batchSize: 10,
      ...(stopped ? { stopped } : {}),
    },
    captured,
  }
}

const NOW = new Date(Date.UTC(2026, 6, 31, 12, 7, 30))

describe('reconcileRevenueOnce — freshness', () => {
  it('stamps last_synced_at on a completed sweep', async () => {
    store.due = [due()]
    const { adapter } = pagedAdapter(['ch_1'])
    const result = await reconcileRevenueOnce(reconcileDeps(adapter).deps, NOW)
    expect(result).toMatchObject({ discovered: 1, synced: 1, partial: 0, failed: 0 })
    expect(store.credentialUpdates[0]).toMatchObject({ credentialId: CREDENTIAL })
    expect(store.credentialUpdates[0]?.['lastSyncedAt']).toBeInstanceOf(Date)
  })

  it('does NOT stamp last_synced_at when the page budget ran out', async () => {
    // B1's first half. An account with more objects in the window than one tick
    // can read is routinely `ok` with `completed: false`; stamping there would
    // report a credential as current while objects beyond the budget had never
    // been read.
    store.due = [due()]
    const { adapter } = pagedAdapter(Array.from({ length: 40 }, (_, i) => `ch_${String(i)}`))
    const result = await reconcileRevenueOnce(reconcileDeps(adapter).deps, NOW)
    expect(result).toMatchObject({ synced: 0, partial: 1, failed: 0 })
    expect(store.credentialUpdates).toHaveLength(0)
  })

  it('walks deeper on each tick because the window is quantized', async () => {
    // B1's second half. A window ending at `now` would change every tick, the
    // cursor would be discarded every time, and objects past the first budget
    // would be re-read forever and never reached.
    store.due = [due()]
    const { adapter, calls } = pagedAdapter(Array.from({ length: 40 }, (_, i) => `ch_${String(i)}`))
    const deps = reconcileDeps(adapter).deps
    // Two ticks inside the same 15-minute quantum.
    await reconcileRevenueOnce(deps, new Date(Date.UTC(2026, 6, 31, 12, 1)))
    const afterFirst = store.syncState.get(key(CREDENTIAL, 'charges'))?.cursor
    await reconcileRevenueOnce(deps, new Date(Date.UTC(2026, 6, 31, 12, 9)))
    const afterSecond = store.syncState.get(key(CREDENTIAL, 'charges'))?.cursor

    expect(afterFirst).not.toBeNull()
    expect(afterSecond).not.toBe(afterFirst)
    // The second tick continued from the first tick's cursor instead of null.
    expect(calls[6]?.cursor).toBe(afterFirst)
  })

  it('leaves last_synced_at untouched on a failure and degrades with a category', async () => {
    store.due = [due()]
    const adapter = fakeRevenueAdapter({
      listObjects: async (): Promise<RevenueListOutcome> => {
        await Promise.resolve()
        return { ok: false, reason: 'unavailable', detail: 'stripe responded 503' }
      },
    })
    const result = await reconcileRevenueOnce(reconcileDeps(adapter).deps, NOW)
    expect(result).toMatchObject({ failed: 1, synced: 0 })
    expect(store.credentialUpdates[0]).toMatchObject({
      status: 'degraded',
      lastError: 'provider_unavailable',
    })
    expect(store.credentialUpdates[0]).not.toHaveProperty('lastSyncedAt')
  })
})

describe('reconcileRevenueOnce — recovery and backoff', () => {
  it('flips degraded → active only on a completed sweep', async () => {
    store.due = [due({ status: 'degraded', lastError: 'provider_unavailable' })]
    const { adapter } = pagedAdapter(['ch_1'])
    const result = await reconcileRevenueOnce(reconcileDeps(adapter).deps, NOW)
    expect(result.recovered).toBe(1)
    expect(store.credentialUpdates[0]).toMatchObject({ status: 'active', lastError: null })
  })

  it('does not recover a credential on a partial sweep', async () => {
    store.due = [due({ status: 'degraded', lastError: 'provider_unavailable' })]
    const { adapter } = pagedAdapter(Array.from({ length: 40 }, (_, i) => `ch_${String(i)}`))
    const result = await reconcileRevenueOnce(reconcileDeps(adapter).deps, NOW)
    expect(result).toMatchObject({ partial: 1, recovered: 0 })
    expect(store.credentialUpdates).toHaveLength(0)
  })

  it('never clears an `unauthorized` error it did not diagnose', async () => {
    // B2's state rule. Discovery normally excludes such a row entirely; the
    // guard is restated in the loop so the two cannot drift apart.
    store.due = [due({ status: 'degraded', lastError: 'unauthorized' })]
    const { adapter } = pagedAdapter(['ch_1'])
    const result = await reconcileRevenueOnce(reconcileDeps(adapter).deps, NOW)
    expect(result.recovered).toBe(0)
    expect(store.credentialUpdates[0]).not.toHaveProperty('status')
    expect(store.credentialUpdates[0]?.['lastSyncedAt']).toBeInstanceOf(Date)
  })

  it('honours Retry-After instead of retrying on the next beat', async () => {
    // S4/N2: a 60-second loop against a rate-limited account is a hammer.
    store.due = [due()]
    let attempts = 0
    const adapter = fakeRevenueAdapter({
      listObjects: async (): Promise<RevenueListOutcome> => {
        await Promise.resolve()
        attempts += 1
        return {
          ok: false,
          reason: 'unavailable',
          detail: 'stripe responded 429',
          retryAfterMs: 600_000,
        }
      },
    })
    const deps = reconcileDeps(adapter).deps
    await reconcileRevenueOnce(deps, NOW)
    expect(attempts).toBe(1)

    // A tick one minute later must not touch the provider again.
    const skipped = await reconcileRevenueOnce(deps, new Date(NOW.getTime() + 60_000))
    expect(skipped.skipped).toBe(1)
    expect(attempts).toBe(1)

    // …and once the window the provider asked for has passed, it does.
    const resumed = await reconcileRevenueOnce(deps, new Date(NOW.getTime() + 700_000))
    expect(resumed.skipped).toBe(0)
    expect(attempts).toBe(2)
  })

  it('stops between credentials when the loop is shutting down', async () => {
    // S3: a SIGTERM during a provider outage must not hold the shutdown for a
    // whole batch of 30-second timeouts ahead of `jobs.stop()`.
    store.due = [due({ id: 'c-1' }), due({ id: 'c-2' }), due({ id: 'c-3' })]
    const { adapter, calls } = pagedAdapter(['ch_1'])
    let seen = 0
    const result = await reconcileRevenueOnce(
      reconcileDeps(adapter, () => {
        seen += 1
        // Stop from the second credential onwards.
        return seen > 1
      }).deps,
      NOW,
    )
    expect(result.skipped).toBe(2)
    expect(calls.filter((call) => call.resource === 'charges')).toHaveLength(1)
  })
})

// --- The backfill executor ---------------------------------------------------

function credentialRow(overrides: Partial<RevenueCredentialRow> = {}): RevenueCredentialRow {
  return {
    id: CREDENTIAL,
    siteId: SITE,
    provider: 'stripe',
    encryptedApiKey: vault.encrypt(API_KEY, aad).stored,
    encryptedWebhookSecret: vault.encrypt('whsec', aad).stored,
    keyVersion: 'k1',
    apiKeyLast4: '1234',
    webhookToken: 'tok',
    status: 'active',
    createdByUserId: 'u-owner',
    connectedAt: new Date(Date.UTC(2026, 6, 31)),
    lastVerifiedAt: new Date(Date.UTC(2026, 6, 31)),
    lastSyncedAt: null,
    lastWebhookAt: null,
    lastError: null,
    disabledAt: null,
    backfillGeneration: 0,
    createdAt: new Date(Date.UTC(2026, 6, 31)),
    updatedAt: new Date(Date.UTC(2026, 6, 31)),
    ...overrides,
  }
}

function jobContext(
  adapter: ReturnType<typeof fakeRevenueAdapter>,
  payload: Record<string, unknown> = {},
) {
  const captured = createCapturedLogger()
  const phases: string[] = []
  return {
    context: {
      job: {
        id: 'job-1',
        type: 'revenue_backfill',
        subjectId: CREDENTIAL,
        payload: { site_id: SITE, provider: 'stripe', generation: 0, ...payload },
        attempts: 1,
      },
      db,
      logger: captured.logger,
      metrics: NOOP_METRICS,
      resources: {
        revenue: {
          vault,
          adapters: createRevenueAdapterRegistry([adapter]),
          policy: { backfillDays: 90, pageSize: 2, reconcileWindowHours: 48 },
        },
      },
      extendLease: async () => await Promise.resolve(true),
      updatePhase: async (phase: string) => {
        phases.push(phase)
        return await Promise.resolve(true)
      },
    },
    phases,
    captured,
  }
}

describe('executeRevenueBackfill', () => {
  it('completes, stamps freshness and clears a degraded badge', async () => {
    store.credential = credentialRow({ status: 'degraded', lastError: 'unauthorized' })
    const { adapter } = pagedAdapter(['ch_1'])
    const { context } = jobContext(adapter)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outcome = await executeRevenueBackfill(context as any)
    expect(outcome).toBe('succeeded')
    // A completed walk read every page of all three resources with THIS key —
    // strictly stronger than the connect probe — so it may clear `unauthorized`.
    expect(store.credentialUpdates[0]).toMatchObject({ status: 'active', lastError: null })
    expect(store.credentialUpdates[0]?.['lastSyncedAt']).toBeInstanceOf(Date)
  })

  it('returns a non-counting retry while pages remain', async () => {
    store.credential = credentialRow()
    const { adapter } = pagedAdapter(Array.from({ length: 200 }, (_, i) => `ch_${String(i)}`))
    const { context } = jobContext(adapter)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outcome = await executeRevenueBackfill(context as any)
    expect(outcome).toMatchObject({ retry: { delayMs: expect.any(Number) } })
    expect(outcome).not.toMatchObject({ retry: { counts: true } })
    // Freshness is untouched: the walk is not finished.
    expect(store.credentialUpdates).toHaveLength(0)
  })

  it('terminals on unauthorized and leaves a state only a rotation clears', async () => {
    // B2. The partial-permission key: charges read, disputes refused.
    store.credential = credentialRow()
    const adapter = fakeRevenueAdapter({
      listObjects: async (_key, resource): Promise<RevenueListOutcome> => {
        await Promise.resolve()
        if (resource === 'disputes') {
          return { ok: false, reason: 'unauthorized', detail: 'stripe responded 403' }
        }
        return { ok: true, page: { observations: [], nextCursor: null, hasMore: false } }
      },
    })
    const { context } = jobContext(adapter)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outcome = await executeRevenueBackfill(context as any)
    expect(outcome).toMatchObject({ terminal: { reason: expect.any(String) } })
    expect(store.credentialUpdates[0]).toMatchObject({
      status: 'degraded',
      lastError: 'unauthorized',
    })
    expect(store.credentialUpdates[0]).not.toHaveProperty('lastSyncedAt')
  })

  it('honours Retry-After as a job retry rather than throwing', async () => {
    store.credential = credentialRow()
    const adapter = fakeRevenueAdapter({
      listObjects: async (): Promise<RevenueListOutcome> => {
        await Promise.resolve()
        return {
          ok: false,
          reason: 'unavailable',
          detail: 'stripe responded 429',
          retryAfterMs: 17_000,
        }
      },
    })
    const { context } = jobContext(adapter)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outcome = await executeRevenueBackfill(context as any)
    expect(outcome).toMatchObject({ retry: { delayMs: 17_000 } })
  })

  it('throws an unavailable outcome so the runner backs off', async () => {
    store.credential = credentialRow()
    const adapter = fakeRevenueAdapter({
      listObjects: async (): Promise<RevenueListOutcome> => {
        await Promise.resolve()
        return { ok: false, reason: 'unavailable', detail: 'stripe responded 503' }
      },
    })
    const { context } = jobContext(adapter)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(executeRevenueBackfill(context as any)).rejects.toThrow(/unavailable/u)
    // The credential is untouched: an outage is not a bad credential.
    expect(store.credentialUpdates).toHaveLength(0)
  })

  it('finishes quietly when its generation has been superseded', async () => {
    // A rotation bumped the counter and enqueued a fresh walk; this old job must
    // not race the new one over the same cursors.
    store.credential = credentialRow({ backfillGeneration: 3 })
    const { adapter, calls } = pagedAdapter(['ch_1'])
    const { context } = jobContext(adapter, { generation: 1 })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outcome = await executeRevenueBackfill(context as any)
    expect(outcome).toBe('succeeded')
    expect(calls).toHaveLength(0)
    expect(store.credentialUpdates).toHaveLength(0)
  })

  it('waits, counting, when the keyring is not configured', async () => {
    store.credential = credentialRow()
    const { adapter } = pagedAdapter(['ch_1'])
    const { context } = jobContext(adapter)
    const withoutRevenue = { ...context, resources: {} }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outcome = await executeRevenueBackfill(withoutRevenue as any)
    // Counting, because a missing keyring does not appear on its own and an
    // immortal job would hold the credential's only backfill slot.
    expect(outcome).toMatchObject({ retry: { counts: true } })
  })
})
