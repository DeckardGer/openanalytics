import { EVENT_SCHEMA_VERSION, type PersistedEvent } from '@openanalytics/contracts'
import type * as PostgresModule from '@openanalytics/postgres'
import type { Database, SiteFirstEventCandidate } from '@openanalytics/postgres'
import { createRecordingMetrics } from '@openanalytics/observability'
import { createCapturedLogger } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The install-verified signal's worker half (ADR-0027).
 *
 * What is pinned here is the *cost and the failure shape*, because that is what
 * the design is about. The value's correctness lives in the statement's
 * `first_event_at IS NULL` guard and is proven against a real database in
 * `tests/migration/site-management.test.ts`; what a unit test can prove is that
 * a steady-state batch issues no query at all, that a batch whose fill fails
 * still completes, and that a failed fill is retried rather than cached as done.
 */

const marked = {
  /** Every call's candidate list, in order. */
  calls: [] as SiteFirstEventCandidate[][],
  /** Ids the next call reports as filled; defaults to every candidate. */
  fills: null as string[] | null,
  fail: null as Error | null,
}

const markSitesFirstEvent = vi.fn(
  async (_db: unknown, candidates: readonly SiteFirstEventCandidate[]) => {
    marked.calls.push([...candidates])
    if (marked.fail) throw marked.fail
    return marked.fills ?? candidates.map((candidate) => candidate.siteId)
  },
)

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    markSitesFirstEvent: (db: unknown, candidates: readonly SiteFirstEventCandidate[]) =>
      markSitesFirstEvent(db, candidates),
  }
})

const { createFirstEventFill, firstEventCandidatesFor } =
  await import('../../apps/worker/src/ingest/first-event.ts')
const { WORKER_METRICS } = await import('../../apps/worker/src/ingest/metrics.ts')

const SITE_A = '3f2a6b8c-1111-4111-8111-111111111111'
const SITE_B = '3f2a6b8c-2222-4222-8222-222222222222'

const BASE: PersistedEvent = {
  schema_version: EVENT_SCHEMA_VERSION,
  event_id: '01890000-0000-7000-8000-000000000001',
  site_id: SITE_A,
  type: 'page_view',
  name: null,
  occurred_at: '2026-07-23T10:00:00.000Z',
  received_at: '2026-07-23T10:00:01.000Z',
  accepted_at: '2026-07-23T10:00:01.500Z',
  clock_skewed: false,
  ingest_generation: 3,
  billing_user_id: '9c1d2e3f-2222-4222-8222-222222222222',
  billing_assignment_version: 2,
  usage_window_start: '2026-07-01T00:00:00.000Z',
  usage_window_id: null,
  billing_grace: false,
  billable: true,
  test_mode: false,
  rule_id: null,
  rule_version: null,
  anonymous_id: 'anon-1',
  session_id: null,
  user_id: null,
  page: { url: 'https://shop.example.com/p', path: '/p', title: 'P' },
  source: {
    referrer_domain: null,
    referrer_path: null,
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_content: null,
    utm_term: null,
  },
  properties: {},
  context: {
    sdk: 'web',
    sdk_version: '1.0.0',
    device_type: 'desktop',
    browser: 'chrome',
    os: 'macos',
    country: 'AZ',
    city: 'Baku',
  },
}

const event = (overrides: Partial<PersistedEvent>): PersistedEvent => ({ ...BASE, ...overrides })

const deps = () => {
  const captured = createCapturedLogger()
  return {
    ctx: { db: {} as Database, logger: captured.logger, metrics: createRecordingMetrics() },
    captured,
  }
}

beforeEach(() => {
  marked.calls = []
  marked.fills = null
  marked.fail = null
  markSitesFirstEvent.mockClear()
})

describe('candidates folded out of a batch', () => {
  it('takes the earliest occurred_at per site, once', () => {
    const candidates = firstEventCandidatesFor(
      [
        event({ occurred_at: '2026-07-23T10:00:05.000Z' }),
        event({ occurred_at: '2026-07-23T10:00:01.000Z' }),
        event({ site_id: SITE_B, occurred_at: '2026-07-23T10:00:09.000Z' }),
      ],
      new Set(),
    )

    expect(candidates).toEqual([
      { siteId: SITE_A, occurredAt: new Date('2026-07-23T10:00:01.000Z') },
      { siteId: SITE_B, occurredAt: new Date('2026-07-23T10:00:09.000Z') },
    ])
  })

  it('omits a site already known filled', () => {
    // The cache is applied during the fold rather than after it, so a batch of a
    // thousand events for a known site produces nothing to write.
    const candidates = firstEventCandidatesFor(
      [event({}), event({ site_id: SITE_B })],
      new Set([SITE_A]),
    )

    expect(candidates.map((candidate) => candidate.siteId)).toEqual([SITE_B])
  })

  it('produces nothing for an empty batch', () => {
    expect(firstEventCandidatesFor([], new Set())).toEqual([])
  })
})

describe('the batch-level fill', () => {
  it('writes the first batch and skips every batch after it', async () => {
    const { ctx } = deps()
    const fill = createFirstEventFill()

    expect(await fill.record(ctx, [event({ occurred_at: '2026-07-23T10:00:00.000Z' })])).toBe(1)
    expect(marked.calls).toEqual([
      [{ siteId: SITE_A, occurredAt: new Date('2026-07-23T10:00:00.000Z') }],
    ])

    // Second batch, same site: the cache means there is nothing to ask about, so
    // no statement is issued at all. This is the steady state — the whole reason
    // the cache exists.
    expect(await fill.record(ctx, [event({ occurred_at: '2026-07-23T11:00:00.000Z' })])).toBe(0)
    expect(markSitesFirstEvent).toHaveBeenCalledTimes(1)
  })

  it('caches a site the statement found already filled, not just one it set', async () => {
    // Another worker (or an earlier process) won the race, so the UPDATE matched
    // nothing. The site is still known non-NULL afterwards, and asking again
    // would be a no-op query forever.
    const { ctx } = deps()
    const fill = createFirstEventFill()
    marked.fills = []

    expect(await fill.record(ctx, [event({})])).toBe(0)
    expect(fill.knownFilled.has(SITE_A)).toBe(true)

    await fill.record(ctx, [event({})])
    expect(markSitesFirstEvent).toHaveBeenCalledTimes(1)
  })

  it('counts and logs each site the first time, and never again', async () => {
    const { ctx, captured } = deps()
    const fill = createFirstEventFill()

    await fill.record(ctx, [event({}), event({ site_id: SITE_B })])
    await fill.record(ctx, [event({}), event({ site_id: SITE_B })])

    expect(ctx.metrics.countOf(WORKER_METRICS.siteFirstEvent)).toBe(2)
    expect(captured.find('site_first_event_recorded')).toHaveLength(2)
  })

  it('never fails the batch, and retries the site on the next one', async () => {
    const { ctx, captured } = deps()
    const fill = createFirstEventFill()
    marked.fail = new Error('postgres is unwell')

    // The batch's rows are already durable in ClickHouse when this runs, so a
    // rejection here would re-run an insert to fix an onboarding checkmark.
    await expect(fill.record(ctx, [event({})])).resolves.toBe(0)
    expect(captured.find('site_first_event_unwritten')).toHaveLength(1)
    expect(captured.find('site_first_event_unwritten')[0]?.['retryable']).toBe(true)

    // Not cached on failure: the signal is late, never lost.
    expect(fill.knownFilled.has(SITE_A)).toBe(false)
    marked.fail = null
    expect(await fill.record(ctx, [event({})])).toBe(1)
    expect(markSitesFirstEvent).toHaveBeenCalledTimes(2)
  })

  it('issues no statement for a batch with no events', async () => {
    const { ctx } = deps()
    const fill = createFirstEventFill()

    expect(await fill.record(ctx, [])).toBe(0)
    expect(markSitesFirstEvent).not.toHaveBeenCalled()
  })

  it('keeps its cache per instance, which is what "per process" means', () => {
    // Two fills share no state: the cache is one process's memory of what it has
    // already asked, and nothing outside the process may depend on it.
    const first = createFirstEventFill()
    const second = createFirstEventFill()

    expect(first.knownFilled).not.toBe(second.knownFilled)
    expect(second.knownFilled.size).toBe(0)
  })
})
