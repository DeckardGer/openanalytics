import {
  EPOCH_IMPORT_CUTOVER,
  NIL_IMPORT_RUN_ID,
  classifyImportedRange,
  importQueryParams,
  mergeImportedRows,
  resolveAnalyticsSources,
  spansOneProviderDay,
  zonedDateStart,
  type ImportPointer,
  type ImportedSurface,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'
import { AnalyticsService } from '../../apps/api/src/analytics/service.ts'
import { importParamsFor } from '../../apps/api/src/analytics/resolve.ts'
import type { AnalyticsGateway, GatewayResult } from '../../apps/api/src/gateway-client.ts'

/**
 * Reading a published import (ADR-0032, D2b/D4/D5).
 *
 * Three acceptance criteria are pinned here and none is provable anywhere else:
 *
 * - **"event-level and aggregate-only never mix as exact."** Every response whose
 *   `data_sources` includes `imported` must carry `estimated` or
 *   `provider_defined`; `exact` is reserved for a range answered entirely from
 *   this system's own event pipeline.
 * - **A range with no imported days is byte-identical to CP2.** One gateway call,
 *   the live rows in the live order, `["live"]` / `exact`.
 * - **The api and the SQL agree about where the cutover is.** The boundary is
 *   rendered in the request's timezone on both sides, so a range the api calls
 *   fully imported cannot contain a live row. The service tests below pin the
 *   *caller wiring*, not just the pure rule — a rule test that feeds its own
 *   inputs cannot catch a caller that computes them wrongly.
 */

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const NOW = new Date('2026-07-23T14:40:00.000Z')
const POINTER: ImportPointer = {
  runId: '9f0f6f2e-6b32-4f0b-9e0a-6d1f0f6c2b41',
  cutoverDate: '2026-06-01',
}

/** Entirely before the cutover. */
const IMPORTED_RANGE = { from: '2026-04-01T00:00:00.000Z', to: '2026-05-01T00:00:00.000Z' }
/** Entirely after it. */
const LIVE_RANGE = { from: '2026-06-10T00:00:00.000Z', to: '2026-06-20T00:00:00.000Z' }
/** Straddling it. */
const BLENDED_RANGE = { from: '2026-05-20T00:00:00.000Z', to: '2026-06-10T00:00:00.000Z' }

/** -04:00 in June: the zone that made the UTC-boundary defect visible. */
const NY = 'America/New_York'

function sources(input: {
  ranges: readonly { from: string; to: string }[]
  pointer?: ImportPointer | null
  timezone?: string
  surface?: ImportedSurface
  providerDefined?: boolean
}) {
  return resolveAnalyticsSources({
    ranges: input.ranges,
    pointer: input.pointer === undefined ? POINTER : input.pointer,
    timezone: input.timezone ?? 'UTC',
    surface: input.surface ?? 'imported',
    providerDefinedWhenFullyImported: input.providerDefined ?? true,
  })
}

describe('where the cutover is', () => {
  it('is the cutover date’s start in the request’s zone, not UTC midnight', () => {
    // The identity the whole partition rests on: this is `toDateTime(date, tz)`
    // in TypeScript, and the SQL computes the same instant.
    expect(new Date(zonedDateStart('2026-06-01', 'UTC')).toISOString()).toBe(
      '2026-06-01T00:00:00.000Z',
    )
    expect(new Date(zonedDateStart('2026-06-01', NY)).toISOString()).toBe(
      '2026-06-01T04:00:00.000Z',
    )
    expect(new Date(zonedDateStart('2026-06-01', 'Asia/Tokyo')).toISOString()).toBe(
      '2026-05-31T15:00:00.000Z',
    )
  })

  it('classifies the three cases', () => {
    expect(classifyImportedRange(LIVE_RANGE, POINTER, 'UTC')).toBe('live_only')
    expect(classifyImportedRange(IMPORTED_RANGE, POINTER, 'UTC')).toBe('imported_only')
    expect(classifyImportedRange(BLENDED_RANGE, POINTER, 'UTC')).toBe('blended')
  })

  it('moves with the viewer’s zone, exactly as the SQL boundary does', () => {
    // A range ending two hours after UTC midnight on the cutover straddles the
    // boundary in UTC and is entirely imported for a viewer four hours west,
    // whose live branch does not open until 04:00Z. Classifying in UTC would
    // assert `provider_defined` over numbers that are partly ours.
    const seam = { from: '2026-05-01T00:00:00.000Z', to: '2026-06-01T02:00:00.000Z' }
    expect(classifyImportedRange(seam, POINTER, 'UTC')).toBe('blended')
    expect(classifyImportedRange(seam, POINTER, NY)).toBe('imported_only')
  })

  it('is live-only for a site with no published import', () => {
    expect(classifyImportedRange(IMPORTED_RANGE, null, 'UTC')).toBe('live_only')
  })
})

describe('one provider day', () => {
  it('recognises exactly one local calendar day', () => {
    expect(
      spansOneProviderDay(
        { from: '2026-04-01T00:00:00.000Z', to: '2026-04-02T00:00:00.000Z' },
        'UTC',
      ),
    ).toBe(true)
    expect(
      spansOneProviderDay(
        { from: '2026-04-01T00:00:00.000Z', to: '2026-04-03T00:00:00.000Z' },
        'UTC',
      ),
    ).toBe(false)
    // The same instants are two local days for a viewer four hours west, and the
    // local day is one for the window that actually is one.
    expect(
      spansOneProviderDay({ from: '2026-04-01T00:00:00.000Z', to: '2026-04-02T00:00:00.000Z' }, NY),
    ).toBe(false)
    expect(
      spansOneProviderDay({ from: '2026-04-01T04:00:00.000Z', to: '2026-04-02T04:00:00.000Z' }, NY),
    ).toBe(true)
  })
})

describe('the bound values', () => {
  it('expresses "no import" as values, never as omission', () => {
    // A missing parameter would be a read with no cutover partition; a nil run
    // and an epoch cutover are a read whose imported branch matches nothing.
    expect(importQueryParams(null)).toEqual({
      import_run_id: NIL_IMPORT_RUN_ID,
      import_cutover: EPOCH_IMPORT_CUTOVER,
    })
    expect(importQueryParams(POINTER)).toEqual({
      import_run_id: POINTER.runId,
      import_cutover: '2026-06-01',
    })
  })

  it('sends the run id only to operations that read a staged row', () => {
    expect(importParamsFor('analytics.timeseries_day', POINTER)).toEqual({
      import_run_id: POINTER.runId,
      import_cutover: '2026-06-01',
    })
    // A live breakdown, and the sub-day charts, need the boundary and nothing
    // else — their statements have no imported table for a run id to filter.
    expect(importParamsFor('analytics.pages_day', POINTER)).toEqual({
      import_cutover: '2026-06-01',
    })
    expect(importParamsFor('analytics.timeseries_hour', POINTER)).toEqual({
      import_cutover: '2026-06-01',
    })
    expect(importParamsFor('analytics.performance_day', POINTER)).toEqual({})
  })
})

describe('the accuracy rule (D5)', () => {
  it('answers exactly as CP2 did for a live-only range', () => {
    expect(sources({ ranges: [LIVE_RANGE] })).toEqual({
      dataSources: ['live'],
      accuracy: 'exact',
    })
    expect(sources({ ranges: [IMPORTED_RANGE], pointer: null })).toEqual({
      dataSources: ['live'],
      accuracy: 'exact',
    })
  })

  it('calls a fully imported, unmodified read provider_defined', () => {
    expect(sources({ ranges: [IMPORTED_RANGE], providerDefined: true })).toEqual({
      dataSources: ['imported'],
      accuracy: 'provider_defined',
    })
  })

  it('calls a fully imported but aggregated read estimated', () => {
    expect(sources({ ranges: [IMPORTED_RANGE], providerDefined: false })).toEqual({
      dataSources: ['imported'],
      accuracy: 'estimated',
    })
  })

  it('calls a blended range estimated and names both sources', () => {
    expect(sources({ ranges: [BLENDED_RANGE] })).toEqual({
      dataSources: ['live', 'imported'],
      accuracy: 'estimated',
    })
  })

  it('reports the union of sources and the worst accuracy across a comparison', () => {
    expect(sources({ ranges: [LIVE_RANGE, IMPORTED_RANGE] })).toEqual({
      dataSources: ['live', 'imported'],
      accuracy: 'provider_defined',
    })
    expect(sources({ ranges: [LIVE_RANGE, BLENDED_RANGE] })).toEqual({
      dataSources: ['live', 'imported'],
      accuracy: 'estimated',
    })
  })

  it('leaves an untouched surface exact', () => {
    // Web vitals, sessions, funnels: no cutover filter, so their numbers are
    // complete and `exact` is the honest answer.
    expect(sources({ ranges: [IMPORTED_RANGE], surface: 'live' })).toEqual({
      dataSources: ['live'],
      accuracy: 'exact',
    })
  })

  it('calls a partitioned live-only surface estimated over an imported range', () => {
    // The minute and hour charts: they apply the cutover but cannot fill the
    // other side of it, so they answer a knowable *subset* of the window asked
    // for. `['live']` because no staged row was read; `estimated` because the
    // window that answered is not the window requested.
    expect(sources({ ranges: [IMPORTED_RANGE], surface: 'partitioned_live' })).toEqual({
      dataSources: ['live'],
      accuracy: 'estimated',
    })
    expect(sources({ ranges: [BLENDED_RANGE], surface: 'partitioned_live' })).toEqual({
      dataSources: ['live'],
      accuracy: 'estimated',
    })
    // A range entirely after the cutover is answered whole.
    expect(sources({ ranges: [LIVE_RANGE], surface: 'partitioned_live' })).toEqual({
      dataSources: ['live'],
      accuracy: 'exact',
    })
  })

  it('ACCEPTANCE: event-level and aggregate-only never mix as exact', () => {
    // Exhaustive over every combination the rule can produce: if `imported` is in
    // the list, `exact` is unreachable.
    const surfaces: ImportedSurface[] = ['imported', 'partitioned_live', 'live']
    const ranges = [LIVE_RANGE, IMPORTED_RANGE, BLENDED_RANGE]
    for (const surface of surfaces) {
      for (const providerDefined of [true, false]) {
        for (const primary of ranges) {
          for (const comparison of [null, ...ranges]) {
            const verdict = sources({
              ranges: comparison === null ? [primary] : [primary, comparison],
              surface,
              providerDefined,
            })
            if (verdict.dataSources.includes('imported')) {
              expect(verdict.accuracy).not.toBe('exact')
            }
            if (verdict.accuracy === 'provider_defined') {
              expect(surface).toBe('imported')
              expect(providerDefined).toBe(true)
            }
          }
        }
      }
    }
  })
})

describe('merging two top-N lists', () => {
  interface Row {
    key: string
    views: number
  }
  const options = {
    keyOf: (row: Row) => row.key,
    add: (a: Row, b: Row) => ({ ...a, views: a.views + b.views }),
    rank: (row: Row) => row.views,
    limit: 3,
  }

  it('returns the live array untouched when there is nothing imported', () => {
    // Identity, not equality: this is the byte-identical guarantee, and it is an
    // early return so no later change to the sort can quietly break it.
    const live: Row[] = [
      { key: 'b', views: 1 },
      { key: 'a', views: 9 },
    ]
    expect(mergeImportedRows(live, [], options)).toBe(live)
  })

  it('sums equal keys, re-sorts and re-cuts', () => {
    const merged = mergeImportedRows(
      [
        { key: 'a', views: 10 },
        { key: 'b', views: 8 },
      ],
      [
        { key: 'b', views: 20 },
        { key: 'c', views: 15 },
        { key: 'd', views: 1 },
      ],
      options,
    )
    expect(merged).toEqual([
      { key: 'b', views: 28 },
      { key: 'c', views: 15 },
      { key: 'a', views: 10 },
    ])
  })

  it('breaks ties on the key so the order does not depend on which list came first', () => {
    const merged = mergeImportedRows([{ key: 'z', views: 5 }], [{ key: 'a', views: 5 }], {
      ...options,
      limit: 2,
    })
    expect(merged.map((row) => row.key)).toEqual(['a', 'z'])
  })
})

// --- The service ------------------------------------------------------------

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

const FRESH = [{ watermark: '2026-07-23 14:35:00.000', buckets: '42' }]
const EMPTY: Responder = (operation) => (operation === 'analytics.freshness' ? FRESH : [])

describe('the api merge', () => {
  const pagesRequest = {
    siteId: SITE,
    timezone: 'UTC',
    limit: 100,
    importPointer: POINTER,
  }

  it('runs one operation and returns the live rows untouched for a live-only range', async () => {
    const { service, gateway } = serviceWith((operation) => {
      if (operation === 'analytics.freshness') return FRESH
      return [
        { page_path: '/b', views: '3', visitors: '2' },
        { page_path: '/a', views: '1', visitors: '1' },
      ]
    })

    const result = await service.pages({ ...pagesRequest, ...LIVE_RANGE })

    expect(gateway.calls.map((call) => call.operation).sort()).toEqual([
      'analytics.freshness',
      'analytics.pages_hour',
    ])
    expect(result.items).toEqual([
      { page_path: '/b', views: 3, visitors: 2 },
      { page_path: '/a', views: 1, visitors: 1 },
    ])
    expect(result.meta.data_sources).toEqual(['live'])
    expect(result.meta.accuracy).toBe('exact')
    const pages = gateway.calls.find((call) => call.operation === 'analytics.pages_hour')
    // The cutover rides along — D4's other half — and for a live-only range it
    // changes nothing. The limit is exactly what was asked for: no merge, no
    // deeper read.
    expect(pages?.params['import_cutover']).toBe('2026-06-01')
    expect(pages?.params['import_run_id']).toBeUndefined()
    expect(pages?.params['limit']).toBe(100)
    expect(pages?.params['timezone']).toBe('UTC')
  })

  it('reads each side twice as deep when it has to merge', async () => {
    // Two independently ranked top-N lists cannot be merged exactly. Doubling
    // moves the miss bound to "rank > 2 × limit on *both* sides"; fetching
    // everything is the only exact answer and is unbounded.
    const { service, gateway } = serviceWith(EMPTY)

    await service.pages({ ...pagesRequest, limit: 100, ...BLENDED_RANGE })
    for (const id of ['analytics.pages_hour', 'analytics.imported_pages']) {
      expect(gateway.calls.find((call) => call.operation === id)?.params['limit'], id).toBe(200)
    }

    // Capped at the gateway's own ceiling rather than asking for something it
    // would refuse outright.
    const deep = serviceWith(EMPTY)
    await deep.service.pages({ ...pagesRequest, limit: 400, ...BLENDED_RANGE })
    expect(
      deep.gateway.calls.find((call) => call.operation === 'analytics.imported_pages')?.params[
        'limit'
      ],
    ).toBe(500)
  })

  it('sums equal page paths across the seam and re-ranks', async () => {
    const { service, gateway } = serviceWith((operation) => {
      if (operation === 'analytics.freshness') return FRESH
      if (operation === 'analytics.imported_pages') {
        return [
          { page_path: '/pricing', views: '100', visitors: '40' },
          { page_path: '/blog', views: '50', visitors: '20' },
        ]
      }
      return [
        { page_path: '/', views: '60', visitors: '30' },
        { page_path: '/pricing', views: '10', visitors: '5' },
      ]
    })

    const result = await service.pages({ ...pagesRequest, ...BLENDED_RANGE })

    expect(result.items).toEqual([
      { page_path: '/pricing', views: 110, visitors: 45 },
      { page_path: '/', views: 60, visitors: 30 },
      { page_path: '/blog', views: 50, visitors: 20 },
    ])
    expect(result.meta.data_sources).toEqual(['live', 'imported'])
    expect(result.meta.accuracy).toBe('estimated')
    const imported = gateway.calls.find((call) => call.operation === 'analytics.imported_pages')
    expect(imported?.params['import_run_id']).toBe(POINTER.runId)
    expect(imported?.params['import_cutover']).toBe('2026-06-01')
    expect(imported?.params['timezone']).toBe('UTC')
  })

  it('sums correctly when one side arrives quoted and the other does not', async () => {
    // ClickHouse serializes a 64-bit integer as a JSON string or a JSON number
    // depending on `output_format_json_quote_64bit_integers` — a server profile
    // setting, and one that can differ between the deployment a suite runs
    // against and the one production uses. The two branches of a merged list are
    // separate queries, so nothing structurally forbids them arriving in
    // different forms, and `'10' + 100` is `'10100'`: a page with ten thousand
    // views at the top of the table and no error anywhere.
    //
    // The mappers coerce with `num()` before the merge ever sees a row. This is
    // the test that says so, with the two sides deliberately mismatched.
    const { service } = serviceWith((operation) => {
      if (operation === 'analytics.freshness') return FRESH
      if (operation === 'analytics.imported_pages') {
        // Numbers, as an unquoted profile returns them.
        return [{ page_path: '/pricing', views: 100, visitors: 40 }]
      }
      // Strings, as the default quoted profile returns them.
      return [{ page_path: '/pricing', views: '10', visitors: '5' }]
    })

    const result = await service.pages({ ...pagesRequest, ...BLENDED_RANGE })

    expect(result.items).toEqual([{ page_path: '/pricing', views: 110, visitors: 45 }])
    expect(typeof result.items[0]?.views).toBe('number')
  })

  it('lands imported countries on the unresolved-city row and invents no city', async () => {
    const { service } = serviceWith((operation) => {
      if (operation === 'analytics.freshness') return FRESH
      if (operation === 'analytics.imported_geography') {
        return [{ country: 'GB', views: '80', visitors: '30' }]
      }
      return [
        { country: 'GB', city: 'London', views: '20', visitors: '10' },
        { country: 'GB', city: '', views: '5', visitors: '3' },
      ]
    })

    const result = await service.geography({ ...pagesRequest, ...BLENDED_RANGE })

    expect(result.items).toEqual([
      // The import's country total joined the live row whose city was never
      // resolved — the live token for "unknown city" is the empty string, not a
      // placeholder this merge invented.
      { country: 'GB', city: '', views: 85, visitors: 33 },
      { country: 'GB', city: 'London', views: 20, visitors: 10 },
    ])
  })

  it('merges an imported custom event onto the live one of the same name', async () => {
    const { service } = serviceWith((operation) => {
      if (operation === 'analytics.freshness') return FRESH
      if (operation === 'analytics.imported_custom_events') {
        return [{ event_name: 'Signup', events: '40', visitors: '30' }]
      }
      if (operation.startsWith('analytics.custom_event_samples')) {
        // The decoration read (ADR-0038, D5) answers nothing for this range, so
        // the three fields below stay null through the merge.
        return []
      }
      return [
        {
          event_name: 'Signup',
          event_type: 'custom_event',
          events: '5',
          visitors: '4',
          billable_events: '5',
        },
      ]
    })

    const result = await service.customEvents({ ...pagesRequest, ...BLENDED_RANGE })

    expect(result.items).toEqual([
      // One row, not two: the imported side is typed `custom_event` so it lands
      // on the live event rather than beside it with a blank type. And the
      // billable count moved by nothing — import data is not billable (D10).
      {
        event_name: 'Signup',
        event_type: 'custom_event',
        events: 45,
        visitors: 34,
        billable_events: 5,
        // Null from the service: the dashboard labels are attached by the route,
        // which is the only layer holding a Postgres handle (ADR-0034, D7).
        display_name: null,
        display_template: null,
        // An imported row carries no event to sample, and this range's live
        // half had no sample row either (ADR-0038, D5/D6).
        last_seen_at: null,
        sample_page_path: null,
        sample_properties: null,
      },
    ])
  })

  it('merges imported device classes onto live rows in the live vocabulary', async () => {
    // The live classifier emits `desktop`, never `Desktop` — so the adapter's
    // translation is what makes these one row instead of two, and the live half
    // of this fixture uses values the live side can actually produce.
    const { service, gateway } = serviceWith((operation) => {
      if (operation === 'analytics.freshness') return FRESH
      if (operation === 'analytics.imported_devices') {
        return [{ device_type: 'desktop', views: '70', visitors: '30' }]
      }
      return [
        { device_type: 'desktop', browser: 'chrome', os: 'windows', views: '10', visitors: '5' },
        { device_type: 'desktop', browser: 'unknown', os: 'unknown', views: '4', visitors: '2' },
      ]
    })

    const result = await service.devices({ ...pagesRequest, ...BLENDED_RANGE })

    // Adding the imported browsers and OS lists into the joint tuple would count
    // the same visits three times and give every row two invented blanks.
    const operations = gateway.calls.map((call) => call.operation)
    expect(operations).toContain('analytics.imported_devices')
    expect(operations).not.toContain('analytics.imported_browsers')
    expect(operations).not.toContain('analytics.imported_os')
    expect(result.items).toEqual([
      // The import carries no browser or OS, so it lands on the live `unknown`
      // row — the live token for "could not tell" — rather than on a third value.
      { device_type: 'desktop', browser: 'unknown', os: 'unknown', views: 74, visitors: 32 },
      { device_type: 'desktop', browser: 'chrome', os: 'windows', views: 10, visitors: 5 },
    ])
  })

  it('never reads an imported branch for web vitals', async () => {
    const { service, gateway } = serviceWith((operation) => {
      if (operation === 'analytics.freshness') return FRESH
      return [{ metric: 'LCP', device_type: 'desktop', samples: '10', value_sum: '20' }]
    })

    const result = await service.performance({ ...pagesRequest, ...IMPORTED_RANGE })

    const vitals = gateway.calls.find((call) => call.operation === 'analytics.performance_hour')
    expect(vitals?.params['import_cutover']).toBeUndefined()
    expect(result.meta.data_sources).toEqual(['live'])
    expect(result.meta.accuracy).toBe('exact')
  })

  it('calls a single-provider-day breakdown provider_defined', async () => {
    // The caller's own wiring, which a rule test fed its own inputs cannot catch:
    // a breakdown over one provider day returns that day's rows unmodified; over
    // two it sums dailies, which is ours.
    const { service } = serviceWith(EMPTY)
    const oneDay = await service.pages({
      ...pagesRequest,
      from: '2026-04-01T00:00:00.000Z',
      to: '2026-04-02T00:00:00.000Z',
    })
    expect(oneDay.meta.accuracy).toBe('provider_defined')

    const twoDays = await service.pages({
      ...pagesRequest,
      from: '2026-04-01T00:00:00.000Z',
      to: '2026-04-03T00:00:00.000Z',
    })
    expect(twoDays.meta.accuracy).toBe('estimated')
  })
})

describe('the timeseries and overview union', () => {
  const base = { siteId: SITE, timezone: 'UTC', compare: false, importPointer: POINTER }

  it('binds the run, the cutover and the zone on the day chart', async () => {
    const { service, gateway } = serviceWith((operation) => {
      if (operation === 'analytics.freshness') return FRESH
      return [{ bucket: '2026-04-02 00:00:00', events: '5', pageviews: '5', visitors: '3' }]
    })

    const result = await service.timeseries({ ...base, ...IMPORTED_RANGE, resolution: 'day' })

    const chart = gateway.calls.find((call) => call.operation.startsWith('analytics.timeseries'))
    expect(chart?.operation).toBe('analytics.timeseries_day_utc')
    expect(chart?.params['import_run_id']).toBe(POINTER.runId)
    expect(chart?.params['import_cutover']).toBe('2026-06-01')
    expect(result.meta.data_sources).toEqual(['imported'])
    // One bucket per provider day: every number is that day's row unmodified.
    expect(result.meta.accuracy).toBe('provider_defined')
  })

  it('never calls a week over imported days provider_defined', async () => {
    const { service } = serviceWith(EMPTY)
    const result = await service.timeseries({ ...base, ...IMPORTED_RANGE, resolution: 'week' })
    expect(result.meta.accuracy).toBe('estimated')
    expect(result.meta.data_sources).toEqual(['imported'])
  })

  it('partitions the minute and hour charts and calls them estimated', async () => {
    const { service, gateway } = serviceWith(EMPTY)

    const result = await service.timeseries({
      ...base,
      from: '2026-04-01T00:00:00.000Z',
      to: '2026-04-01T06:00:00.000Z',
      resolution: 'minute',
    })

    const chart = gateway.calls.find((call) => call.operation.startsWith('analytics.timeseries'))
    expect(chart?.operation).toBe('analytics.timeseries_minute')
    // The cutover but no run: there is nothing sub-day to read.
    expect(chart?.params['import_cutover']).toBe('2026-06-01')
    expect(chart?.params['import_run_id']).toBeUndefined()
    // A knowable subset of the window asked for.
    expect(result.meta.data_sources).toEqual(['live'])
    expect(result.meta.accuracy).toBe('estimated')
  })

  it('leaves a live-only minute chart exact', async () => {
    const { service } = serviceWith(EMPTY)
    const result = await service.timeseries({
      ...base,
      from: '2026-06-10T00:00:00.000Z',
      to: '2026-06-10T06:00:00.000Z',
      resolution: 'minute',
    })
    expect(result.meta.data_sources).toEqual(['live'])
    expect(result.meta.accuracy).toBe('exact')
  })

  it('calls a one-day range total provider_defined and a longer one estimated', async () => {
    const { service } = serviceWith((operation) => {
      if (operation === 'analytics.freshness') return FRESH
      return [{ events: '10', pageviews: '10', visitors: '4', billable_events: '0' }]
    })

    // One provider day: the total *is* that day's row.
    const oneDay = await service.overview({
      ...base,
      from: '2026-04-01T00:00:00.000Z',
      to: '2026-04-02T00:00:00.000Z',
    })
    expect(oneDay.meta.accuracy).toBe('provider_defined')

    // A month sums dailies the provider refuses to add — including the visitor
    // count. The number is then ours, not theirs.
    const month = await service.overview({ ...base, ...IMPORTED_RANGE })
    expect(month.meta.data_sources).toEqual(['imported'])
    expect(month.meta.accuracy).toBe('estimated')
  })

  it('binds the zone on the range totals so the card matches its own chart', async () => {
    const { service, gateway } = serviceWith((operation) => {
      if (operation === 'analytics.freshness') return FRESH
      return [{ events: '1', pageviews: '1', visitors: '1', billable_events: '0' }]
    })
    await service.overview({ ...base, timezone: NY, ...IMPORTED_RANGE })
    const totals = gateway.calls.find((call) => call.operation.startsWith('analytics.overview'))
    expect(totals?.params['timezone']).toBe(NY)
  })
})

describe('freshness for a site whose history is only imported', () => {
  const noBuckets: Responder = (operation) =>
    operation === 'analytics.freshness' ? [{ watermark: null, buckets: '0' }] : []

  it('answers ok rather than no_data', async () => {
    // The primary migration case is "import first, install the tracker second".
    // Without this the dashboard paints every panel with an empty state while
    // the data sits right there (D5).
    const { service } = serviceWith(noBuckets)

    const result = await service.overview({
      siteId: SITE,
      timezone: 'UTC',
      compare: false,
      importPointer: POINTER,
      ...IMPORTED_RANGE,
    })

    expect(result.meta.freshness.state).toBe('ok')
    // Null, because the watermark is a statement about live ingest and there has
    // been none.
    expect(result.meta.freshness.watermark).toBeNull()
    expect(result.meta.data_sources).toEqual(['imported'])
  })

  it('still answers no_data when the requested range is entirely live', async () => {
    // The override is only honest where the import is being read. A range after
    // the cutover that comes back empty *is* empty, and answering `ok` because
    // the site imported something a year ago would replace one wrong empty state
    // with a wrong healthy one.
    const { service } = serviceWith(noBuckets)

    const result = await service.overview({
      siteId: SITE,
      timezone: 'UTC',
      compare: false,
      importPointer: POINTER,
      ...LIVE_RANGE,
    })

    expect(result.meta.freshness.state).toBe('no_data')
  })

  it('keeps the live-only verdict on a surface the import cannot answer', async () => {
    // Web vitals over an imported range: no staged web vitals exist, so `no_data`
    // is the truth and `ok` would be a claim about data that is not there.
    const { service } = serviceWith(noBuckets)

    const result = await service.performance({
      siteId: SITE,
      timezone: 'UTC',
      limit: 100,
      importPointer: POINTER,
      ...IMPORTED_RANGE,
    })

    expect(result.meta.freshness.state).toBe('no_data')
  })

  it('still answers no_data for a site with neither', async () => {
    const { service } = serviceWith(noBuckets)

    const result = await service.overview({
      siteId: SITE,
      timezone: 'UTC',
      compare: false,
      ...LIVE_RANGE,
    })

    expect(result.meta.freshness.state).toBe('no_data')
    expect(result.meta.data_sources).toEqual(['live'])
  })
})
