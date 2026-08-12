import {
  EVENT_SCHEMA_VERSION,
  persistedEventSchema,
  type PersistedEvent,
} from '@openanalytics/contracts'
import {
  MAX_PROPERTIES_BYTES,
  OA_PROPERTY_PREFIX,
  foldServerPayload,
  serializeProperties,
  toClickHouseDateTime64,
  toEventsRawRow,
} from '@openanalytics/clickhouse'
import { describe, expect, it } from 'vitest'

/**
 * Envelope to `events_raw` row (docs snapshot 02 §8, §15; migration 0001).
 *
 * The mapping has to be *total*. An envelope field with no destination is data a
 * customer sent, the collector accepted and answered `202` for, and the worker
 * then discarded — the legacy failure shape in a new place. The
 * `web_vital`/`engagement`/`interaction` payloads are the ones at risk, because
 * they are separate envelope fields rather than properties and `events_raw` has
 * one bounded properties column.
 */

const BASE: PersistedEvent = {
  schema_version: EVENT_SCHEMA_VERSION,
  event_id: '01890000-0000-7000-8000-000000000001',
  site_id: '3f2a6b8c-1111-4111-8111-111111111111',
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

const event = (overrides: Partial<PersistedEvent>): PersistedEvent =>
  persistedEventSchema.parse({ ...BASE, ...overrides })

describe('timestamps', () => {
  it('renders a DateTime64 literal ClickHouse can parse', () => {
    // A `Z`-suffixed ISO string is not a value the column parses, and a rejected
    // timestamp fails the whole insert rather than one field.
    expect(toClickHouseDateTime64('2026-07-23T10:00:00.000Z')).toBe('2026-07-23 10:00:00.000')
  })

  it('normalises an offset-bearing instant to UTC', () => {
    expect(toClickHouseDateTime64('2026-07-23T12:00:00.000+02:00')).toBe('2026-07-23 10:00:00.000')
  })

  it('refuses an unparseable instant rather than writing a wrong time', () => {
    expect(() => toClickHouseDateTime64('not a time')).toThrow(RangeError)
  })
})

describe('folding the envelope payloads into properties', () => {
  it('carries a web vital into the row', () => {
    const row = toEventsRawRow(
      event({
        type: 'web_vital',
        web_vital: { metric: 'LCP', value: 1234.5, rating: 'good', navigation_type: 'navigate' },
      }),
      { batchId: 'b1_x' },
    )

    expect(JSON.parse(row.properties)).toMatchObject({
      oa_metric: 'LCP',
      oa_value: 1234.5,
      oa_rating: 'good',
      oa_navigation_type: 'navigate',
    })
  })

  it('carries an interaction payload in full', () => {
    // The heatmap signal is high-volume and never billable, which makes it
    // exactly the payload most likely to be dropped without anyone noticing.
    const row = toEventsRawRow(
      event({
        type: 'interaction',
        billable: false,
        test_mode: false,
        rule_id: null,
        rule_version: null,
        interaction: {
          x_percent: 42.5,
          y_percent: 10,
          viewport_class: 'desktop',
          viewport_width: 1440,
          selector: 'main > button.buy',
          text: 'Buy now',
        },
      }),
      { batchId: 'b1_x' },
    )

    expect(JSON.parse(row.properties)).toMatchObject({
      oa_x_percent: 42.5,
      oa_y_percent: 10,
      oa_viewport_class: 'desktop',
      oa_viewport_width: 1440,
      oa_selector: 'main > button.buy',
      oa_text: 'Buy now',
    })
  })

  it('carries an engagement measurement', () => {
    const row = toEventsRawRow(
      event({
        type: 'engagement',
        billable: false,
        test_mode: false,
        rule_id: null,
        rule_version: null,
        engagement: { active_ms: 4_000, visible_ms: 9_000 },
      }),
      { batchId: 'b1_x' },
    )

    expect(JSON.parse(row.properties)).toMatchObject({
      oa_active_ms: 4_000,
      oa_visible_ms: 9_000,
    })
  })

  it('leaves an event with no typed payload untouched', () => {
    const row = toEventsRawRow(event({ properties: { plan: 'pro' } }), { batchId: 'b1_x' })
    expect(JSON.parse(row.properties)).toEqual({ plan: 'pro' })
  })

  it('keeps client properties alongside the folded server keys', () => {
    const folded = foldServerPayload(
      event({
        type: 'web_vital',
        properties: { page_kind: 'product' },
        web_vital: { metric: 'CLS', value: 0.02 },
      }),
    )

    expect(folded['page_kind']).toBe('product')
    expect(folded['oa_metric']).toBe('CLS')
  })

  it('cannot be shadowed by a client property, because the prefix is reserved', () => {
    // `propertyKeySchema` rejects any client key starting with `oa_`, so a
    // customer cannot send one — which is what makes reading these back as
    // server-written values honest.
    expect(() =>
      event({
        type: 'web_vital',
        properties: { oa_metric: 'forged' },
        web_vital: { metric: 'INP', value: 5 },
      }),
    ).toThrow()
  })

  it('writes an absent optional as an empty string rather than null', () => {
    // The MV extracts with JSONExtractString and filters on `!= ''`; a JSON null
    // and a missing key both extract to '' anyway, so this keeps the row's shape
    // uniform for anything reading it directly.
    const folded = foldServerPayload(
      event({ type: 'web_vital', web_vital: { metric: 'TTFB', value: 90 } }),
    )
    expect(folded['oa_rating']).toBe('')
    expect(folded['oa_navigation_type']).toBe('')
  })

  it('never truncates a contract-valid properties bag', () => {
    // The M4 contract caps properties at 32 keys of 40 characters with 256-byte
    // values, so the largest legitimate bag is roughly 10 KB. The backstop must
    // sit above that, or it would silently discard properties a customer is
    // entitled to send.
    const largestLegal = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`k${index}`.padEnd(40, 'a'), 'x'.repeat(256)]),
    )
    const serialized = serializeProperties(event({ properties: largestLegal }))

    expect(serialized.length).toBeLessThanOrEqual(MAX_PROPERTIES_BYTES)
    expect(Object.keys(JSON.parse(serialized) as object)).toHaveLength(32)
  })

  it('drops the client half rather than the row when properties overflow', () => {
    // Unreachable from a validated envelope — the contract cap above is well
    // under the backstop — so the state is constructed directly. The branch
    // exists for a future envelope field, and an untested backstop is a guess.
    const oversized: PersistedEvent = {
      ...BASE,
      type: 'web_vital',
      properties: { blob: 'x'.repeat(MAX_PROPERTIES_BYTES * 2) },
      web_vital: { metric: 'FCP', value: 1 },
    }
    const serialized = serializeProperties(oversized)

    expect(serialized.length).toBeLessThanOrEqual(MAX_PROPERTIES_BYTES)
    const parsed = JSON.parse(serialized) as Record<string, unknown>
    // The measurement survives; the oversized client bag is what is lost.
    expect(parsed['oa_metric']).toBe('FCP')
    expect(Object.keys(parsed).every((key) => key.startsWith(OA_PROPERTY_PREFIX))).toBe(true)
  })
})

describe('row mapping', () => {
  it('maps every scalar the envelope states', () => {
    const row = toEventsRawRow(
      event({
        type: 'custom_event',
        name: 'signup',
        session_id: 'sess-1',
        user_id: 'user-hash',
        clock_skewed: true,
        billing_grace: true,
        source: {
          referrer_domain: 'google.com',
          referrer_path: '/search',
          utm_source: 'newsletter',
          utm_medium: 'email',
          utm_campaign: 'july',
          utm_content: 'hero',
          utm_term: 'analytics',
        },
      }),
      { batchId: 'b1_abc' },
    )

    expect(row).toMatchObject({
      schema_version: EVENT_SCHEMA_VERSION,
      site_id: BASE.site_id,
      event_id: BASE.event_id,
      batch_id: 'b1_abc',
      type: 'custom_event',
      name: 'signup',
      origin: 'live',
      clock_skewed: 1,
      billing_grace: 1,
      billable: 1,
      ingest_generation: 3,
      billing_assignment_version: 2,
      session_id: 'sess-1',
      user_id: 'user-hash',
      page_url: 'https://shop.example.com/p',
      page_path: '/p',
      page_title: 'P',
      referrer_domain: 'google.com',
      utm_campaign: 'july',
      device_type: 'desktop',
      country: 'AZ',
    })
  })

  it('turns every nullable envelope field into an empty string', () => {
    const row = toEventsRawRow(event({ page: null }), { batchId: 'b1_x' })

    expect(row.name).toBe('')
    expect(row.session_id).toBe('')
    expect(row.user_id).toBe('')
    expect(row.page_url).toBe('')
    expect(row.page_path).toBe('')
    expect(row.page_title).toBe('')
    expect(row.referrer_domain).toBe('')
  })

  it('carries the batch token onto every row', () => {
    // The reconciliation job compares raw billable counts against the ledger per
    // batch, and this column is the join key it uses.
    expect(toEventsRawRow(event({}), { batchId: 'b1_token' }).batch_id).toBe('b1_token')
  })

  it('defaults the source origin to live and lets another path name itself', () => {
    expect(toEventsRawRow(event({}), { batchId: 'b' }).origin).toBe('live')
    expect(toEventsRawRow(event({}), { batchId: 'b', origin: 'import' }).origin).toBe('import')
  })

  it('has no column that could carry an address', () => {
    // Docs snapshot 02 §15 and D-102. Asserted on the mapping as well as on the
    // schema, so a future column cannot reintroduce one on this side either.
    const row = toEventsRawRow(event({}), { batchId: 'b' }) as unknown as Record<string, unknown>
    expect(Object.keys(row).filter((key) => /(^|_)(ip|ip_address|remote_addr)$/.test(key))).toEqual(
      [],
    )
  })
})
