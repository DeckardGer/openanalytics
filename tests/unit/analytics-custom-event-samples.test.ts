import { describe, expect, it } from 'vitest'
import { AnalyticsService } from '../../apps/api/src/analytics/service.ts'
import type { AnalyticsGateway, GatewayResult } from '../../apps/api/src/gateway-client.ts'

/**
 * What a custom-events row says beyond a count (ADR-0038, D5/D6/D7).
 *
 * The three fields are a *decoration*, and everything worth pinning about a
 * decoration is about the seam: which operation is asked, with which parameters,
 * how its rows are joined onto the report's, and — the half that matters most —
 * what a row says when there is nothing to join. `null` is a shipped answer
 * here, not a failure mode: nothing backfills a materialized view, so every
 * range that ends before ClickHouse migration 0021 answers it honestly.
 */

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const NOW = new Date('2026-07-23T14:40:00.000Z')
const HOUR_RANGE = { from: '2026-07-23T00:00:00.000Z', to: '2026-07-23T12:00:00.000Z' }
/** Long enough that the resolver routes the day rollup. */
const DAY_RANGE = { from: '2026-04-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' }

const FRESH = [{ watermark: '2026-07-23 14:35:00.000', buckets: '42' }]

type Responder = (operation: string, params: Record<string, unknown>) => unknown[]

class FakeGateway implements AnalyticsGateway {
  readonly calls: { operation: string; params: Record<string, unknown> }[] = []
  readonly #responder: Responder
  constructor(responder: Responder) {
    this.#responder = responder
  }
  query<TRow = Record<string, unknown>>(
    operation: string,
    params: Record<string, unknown>,
  ): Promise<GatewayResult<TRow>> {
    this.calls.push({ operation, params })
    const rows = this.#responder(operation, params) as readonly TRow[]
    return Promise.resolve({
      operation,
      rows,
      meta: { row_count: rows.length, truncated: false, elapsed_ms: 1, cached: false },
    })
  }
}

function serviceWith(responder: Responder) {
  const gateway = new FakeGateway(responder)
  return { gateway, service: new AnalyticsService(gateway, { now: () => NOW }) }
}

const REQUEST = { siteId: SITE, timezone: 'UTC', limit: 50, importPointer: null }

/** One live custom-event row, in the rollup's own string-typed shape. */
const LIVE = [
  {
    event_name: 'signup',
    event_type: 'custom_event',
    events: '12',
    billable_events: '12',
    visitors: '9',
  },
  {
    event_name: 'newsletter_joined',
    event_type: 'custom_event',
    events: '3',
    billable_events: '3',
    visitors: '3',
  },
]

function respond(samples: unknown[]): Responder {
  return (operation) => {
    if (operation === 'analytics.freshness') return FRESH
    if (operation.startsWith('analytics.custom_event_samples')) return samples
    return LIVE
  }
}

describe('the custom-events sample decoration', () => {
  it('joins the sample onto its row by name and type, and parses the properties', async () => {
    const { service, gateway } = serviceWith(
      respond([
        {
          event_name: 'signup',
          event_type: 'custom_event',
          events: '12',
          last_seen_at: '2026-07-23 11:58:04.221',
          sample_page_path: '/pricing',
          // Stored as JSON *text*, which is what the column holds.
          sample_properties: '{"section":"hero","plan":"pro"}',
        },
      ]),
    )

    const result = await service.customEvents({ ...REQUEST, ...HOUR_RANGE })

    expect(gateway.calls.map((call) => call.operation).sort()).toEqual([
      'analytics.custom_event_samples_hour',
      'analytics.custom_events_hour',
      'analytics.freshness',
    ])
    expect(result.items[0]).toEqual({
      event_name: 'signup',
      event_type: 'custom_event',
      events: 12,
      billable_events: 12,
      visitors: 9,
      display_name: null,
      display_template: null,
      // Rendered as an instant, from the stored ClickHouse datetime.
      last_seen_at: '2026-07-23T11:58:04.221Z',
      sample_page_path: '/pricing',
      sample_properties: { section: 'hero', plan: 'pro' },
    })
    // The name with no sample keeps the three nulls it was mapped with.
    expect(result.items[1]).toMatchObject({
      event_name: 'newsletter_joined',
      last_seen_at: null,
      sample_page_path: null,
      sample_properties: null,
    })
  })

  it('does not join a sample whose type differs, because the row key is both', async () => {
    // `signup` as a conversion and `signup` as a custom event are two rows in
    // every custom-events surface. A sample keyed on the name alone would put
    // one row's last event on the other's.
    const { service } = serviceWith(
      respond([
        {
          event_name: 'signup',
          event_type: 'conversion',
          events: '12',
          last_seen_at: '2026-07-23 11:58:04.221',
          sample_page_path: '/pricing',
          sample_properties: '{}',
        },
      ]),
    )

    const result = await service.customEvents({ ...REQUEST, ...HOUR_RANGE })

    expect(result.items[0]).toMatchObject({
      event_name: 'signup',
      event_type: 'custom_event',
      last_seen_at: null,
      sample_page_path: null,
      sample_properties: null,
    })
  })

  it('distinguishes an event that fired with no properties from one with nothing to say', async () => {
    const { service } = serviceWith(
      respond([
        {
          event_name: 'signup',
          event_type: 'custom_event',
          events: '12',
          last_seen_at: '2026-07-23 11:58:04.221',
          // A custom event fired outside any page context: no path, and the
          // empty string would render as a link to the site root.
          sample_page_path: '',
          sample_properties: '{}',
        },
      ]),
    )

    const result = await service.customEvents({ ...REQUEST, ...HOUR_RANGE })

    expect(result.items[0]).toMatchObject({
      last_seen_at: '2026-07-23T11:58:04.221Z',
      sample_page_path: null,
      // `{}` and `null` are different facts and the contract says so.
      sample_properties: {},
    })
  })

  it('answers null for a properties bag it cannot read, without failing the read', async () => {
    const { service } = serviceWith(
      respond([
        {
          event_name: 'signup',
          event_type: 'custom_event',
          events: '12',
          last_seen_at: '2026-07-23 11:58:04.221',
          sample_page_path: '/x',
          // Neither of these is producible by the collector; both are what a
          // truncated or migrated column could look like one day.
          sample_properties: '["not","an","object"]',
        },
      ]),
    )

    const result = await service.customEvents({ ...REQUEST, ...HOUR_RANGE })

    expect(result.items[0]).toMatchObject({
      last_seen_at: '2026-07-23T11:58:04.221Z',
      sample_properties: null,
    })
  })

  it('binds the site, the effective range and a deepened limit — and no zone, no cutover', async () => {
    // Every parameter schema is a `strictObject`, so a zone or an import
    // parameter bound here would be rejected exactly as loudly as a missing one.
    // The limit is the report's merge depth: a decoration covering fewer names
    // than the list it decorates renders as a null on a row that has data.
    const { service, gateway } = serviceWith(respond([]))

    await service.customEvents({ ...REQUEST, ...HOUR_RANGE })

    const call = gateway.calls.find(
      (entry) => entry.operation === 'analytics.custom_event_samples_hour',
    )
    expect(call?.params).toEqual({
      site_id: SITE,
      from: HOUR_RANGE.from,
      to: HOUR_RANGE.to,
      limit: 100,
    })
  })

  it('reads the day tables when the range routes the day rollup', async () => {
    const { service, gateway } = serviceWith(respond([]))

    await service.customEvents({ ...REQUEST, ...DAY_RANGE })

    expect(gateway.calls.map((call) => call.operation)).toContain(
      'analytics.custom_event_samples_day',
    )
    // The counts and their decoration always come from the same grain: two
    // grains would let a row's count and its "last seen" describe different
    // windows.
    expect(gateway.calls.map((call) => call.operation)).toContain('analytics.custom_events_day')
  })
})
