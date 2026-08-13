import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  EVENT_LIMITS,
  EVENT_SCHEMA_VERSION,
  EVENT_TYPES,
  HISTORICAL_EVENT_TYPES,
  SERVER_ASSIGNED_CONTEXT_FIELDS,
  SERVER_ASSIGNED_EVENT_FIELDS,
  clientEventSchema,
  eventBatchSchema,
  heartbeatRequestSchema,
  isHistoricalEventType,
  persistedEventSchema,
  trackerConfigSchema,
} from '@openanalytics/contracts'
import { describe, expect, it } from 'vitest'

const SPEC_PATH = fileURLToPath(
  new URL('../../packages/contracts/openapi/openapi.yaml', import.meta.url),
)

const EVENT_ID = '0198c3f4-8f2a-7c31-9a1e-2b6f4d0c9e77'
const SECOND_EVENT_ID = '0198c3f4-9a1b-7d42-8b2f-3c7e5d1a0f88'

const pageView = (overrides: Record<string, unknown> = {}) => ({
  event_id: EVENT_ID,
  type: 'page_view',
  occurred_at: '2026-07-20T10:30:00.000Z',
  page: { url: 'https://example.com/pricing', title: 'Pricing' },
  ...overrides,
})

const batch = (events: unknown[], overrides: Record<string, unknown> = {}) => ({
  schema_version: EVENT_SCHEMA_VERSION,
  tracking_key: 'oa_pub_live_abcdef123456',
  sent_at: '2026-07-20T10:30:01.000Z',
  context: { sdk: 'web', sdk_version: '2.0.0' },
  events,
  ...overrides,
})

/**
 * Docs snapshot 04, Milestone 4 acceptance: a client cannot state the billing
 * user, plan, usage window, geo or the billable flag. The contract makes that
 * structural — the fields do not exist in the request schema and the objects are
 * strict — so this is a rejection test, not an "is it ignored?" test.
 */
describe('client cannot state server-owned fields', () => {
  it('accepts a well-formed batch', () => {
    expect(eventBatchSchema.safeParse(batch([pageView()])).success).toBe(true)
  })

  it.each(SERVER_ASSIGNED_EVENT_FIELDS)('rejects an event carrying %s', (field) => {
    const parsed = clientEventSchema.safeParse(pageView({ [field]: 'x' }))
    expect(parsed.success, `${field} must not be settable by a client`).toBe(false)
  })

  it.each(SERVER_ASSIGNED_CONTEXT_FIELDS)('rejects context.%s', (field) => {
    const parsed = eventBatchSchema.safeParse(
      batch([pageView()], { context: { sdk: 'web', sdk_version: '2.0.0', [field]: 'AZ' } }),
    )
    expect(parsed.success, `context.${field} is server-derived`).toBe(false)
  })

  it('rejects an unknown envelope field rather than ignoring it', () => {
    // Silent stripping would let a client believe it had set something.
    expect(eventBatchSchema.safeParse(batch([pageView()], { billable: true })).success).toBe(false)
  })

  it('describes billing fields only in the persisted envelope', () => {
    const persisted = {
      schema_version: 1,
      event_id: EVENT_ID,
      site_id: 'site_1',
      type: 'page_view',
      name: null,
      occurred_at: '2026-07-20T10:30:00.000Z',
      received_at: '2026-07-20T10:30:00.300Z',
      accepted_at: '2026-07-20T10:30:00.320Z',
      clock_skewed: false,
      ingest_generation: 7,
      billing_user_id: 'user_1',
      billing_assignment_version: 4,
      // The collector snapshots the window's deterministic key half; the worker
      // mints the row id (M5/ADR-0009, plan M6 item 12).
      usage_window_start: '2026-07-01T00:00:00.000Z',
      usage_window_id: 'win_1',
      // D-012: usage accepted under a blocked site's 24-hour grace is marked, so
      // it can be reconciled only for the user who was blocked.
      billing_grace: false,
      billable: true,
      // ADR-0034 D6/D5: both server-set. `test_mode` decides which ClickHouse
      // table the event lands in, and `rule_id` is only ever a rule the site
      // actually publishes -- the client's claim is checked, not carried.
      test_mode: false,
      rule_id: null,
      rule_version: null,
      anonymous_id: 'anon_1',
      session_id: 'sess_1',
      user_id: null,
      page: { url: 'https://example.com/pricing', path: '/pricing', title: 'Pricing' },
      source: {
        referrer_domain: 'google.com',
        referrer_path: '/',
        utm_source: 'google',
        utm_medium: 'cpc',
        utm_campaign: 'summer',
        utm_content: null,
        utm_term: null,
      },
      properties: {},
      context: {
        sdk: 'web',
        sdk_version: '2.0.0',
        device_type: 'desktop',
        browser: 'Chrome',
        os: 'Windows',
        country: 'AZ',
        city: 'Baku',
      },
    }

    expect(persistedEventSchema.safeParse(persisted).success).toBe(true)
  })
})

/**
 * Docs snapshot 02 §7.3: heartbeat is not a member of the historical contract.
 * It has its own endpoint, no `event_id` and usage weight 0 (D-101).
 */
describe('heartbeat is not a historical event', () => {
  it('is not accepted in a historical batch', () => {
    const heartbeat = {
      event_id: EVENT_ID,
      type: 'heartbeat',
      occurred_at: '2026-07-20T10:30:00.000Z',
    }

    expect(clientEventSchema.safeParse(heartbeat).success).toBe(false)
    expect(eventBatchSchema.safeParse(batch([heartbeat])).success).toBe(false)
    // Not even alongside valid events: acceptance is all-or-nothing (§7.3).
    expect(eventBatchSchema.safeParse(batch([pageView(), heartbeat])).success).toBe(false)
  })

  it('is excluded from the historical type list but exists as a canonical type', () => {
    expect(isHistoricalEventType('heartbeat')).toBe(false)
    expect(EVENT_TYPES).toContain('heartbeat')
    expect(HISTORICAL_EVENT_TYPES).not.toContain('heartbeat')
  })

  it('has no event_id on its own endpoint', () => {
    const request = {
      schema_version: EVENT_SCHEMA_VERSION,
      tracking_key: 'oa_pub_live_abcdef123456',
      sent_at: '2026-07-20T10:30:01.000Z',
      context: { sdk: 'web', sdk_version: '2.0.0' },
      client_session_id: 'cs_1',
    }

    expect(heartbeatRequestSchema.safeParse(request).success).toBe(true)
    // Nothing deduplicates a heartbeat, so accepting an id would imply a
    // durability guarantee the realtime path does not make.
    expect(heartbeatRequestSchema.safeParse({ ...request, event_id: EVENT_ID }).success).toBe(false)
    expect(heartbeatRequestSchema.safeParse({ ...request, type: 'heartbeat' }).success).toBe(false)
  })
})

describe('event identity', () => {
  it('requires a lowercase UUIDv7', () => {
    // Docs snapshot 02 §7.1: the id is minted before the first attempt so a lost
    // response can still deduplicate. A v4 id has no time prefix and is rejected
    // to keep queue and ClickHouse keys roughly ordered.
    expect(clientEventSchema.safeParse(pageView()).success).toBe(true)
    expect(
      clientEventSchema.safeParse(pageView({ event_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }))
        .success,
    ).toBe(false)
    expect(
      clientEventSchema.safeParse(pageView({ event_id: EVENT_ID.toUpperCase() })).success,
    ).toBe(false)
    const { event_id: _omitted, ...withoutId } = pageView()
    expect(clientEventSchema.safeParse(withoutId).success).toBe(false)
  })

  it('rejects a repeated id inside one batch', () => {
    const duplicated = batch([pageView(), pageView({ type: 'custom_event', name: 'signup' })])
    expect(eventBatchSchema.safeParse(duplicated).success).toBe(false)

    const distinct = batch([
      pageView(),
      pageView({
        event_id: SECOND_EVENT_ID,
        type: 'custom_event',
        name: 'signup',
        page: undefined,
      }),
    ])
    expect(eventBatchSchema.safeParse(distinct).success).toBe(true)
  })
})

describe('contract limits', () => {
  it('bounds batch rows', () => {
    const many = Array.from({ length: EVENT_LIMITS.maxEventsPerBatch + 1 }, (_, index) =>
      pageView({ event_id: `0198c3f4-8f2a-7c31-9a1e-${String(index).padStart(12, '0')}` }),
    )
    expect(eventBatchSchema.safeParse(batch(many)).success).toBe(false)
  })

  it('bounds event names, property keys, values and counts', () => {
    const custom = (overrides: Record<string, unknown>) => ({
      event_id: EVENT_ID,
      type: 'custom_event',
      occurred_at: '2026-07-20T10:30:00.000Z',
      name: 'signup_started',
      ...overrides,
    })

    expect(clientEventSchema.safeParse(custom({})).success).toBe(true)
    expect(
      clientEventSchema.safeParse(custom({ name: 'x'.repeat(EVENT_LIMITS.eventNameMaxLength + 1) }))
        .success,
    ).toBe(false)
    expect(
      clientEventSchema.safeParse(
        custom({ properties: { ['k'.repeat(EVENT_LIMITS.propertyKeyMaxLength + 1)]: 1 } }),
      ).success,
    ).toBe(false)
    expect(
      clientEventSchema.safeParse(
        custom({ properties: { plan: 'x'.repeat(EVENT_LIMITS.propertyValueMaxLength + 1) } }),
      ).success,
    ).toBe(false)

    const tooMany = Object.fromEntries(
      Array.from({ length: EVENT_LIMITS.maxPropertiesPerEvent + 1 }, (_, i) => [`k${i}`, i]),
    )
    expect(clientEventSchema.safeParse(custom({ properties: tooMany })).success).toBe(false)

    // A nested object has no stable analytics column; accepting one now would
    // make the first rollup a migration.
    expect(clientEventSchema.safeParse(custom({ properties: { nested: { a: 1 } } })).success).toBe(
      false,
    )
    // `oa_` is reserved for server-owned fields.
    expect(clientEventSchema.safeParse(custom({ properties: { oa_billable: true } })).success).toBe(
      false,
    )
  })

  it('bounds URL, referrer and title', () => {
    const long = `https://example.com/${'p'.repeat(EVENT_LIMITS.urlMaxLength)}`
    expect(clientEventSchema.safeParse(pageView({ page: { url: long } })).success).toBe(false)
    expect(clientEventSchema.safeParse(pageView({ page: { url: 'not-a-url' } })).success).toBe(
      false,
    )
    expect(
      clientEventSchema.safeParse(
        pageView({ referrer: 'r'.repeat(EVENT_LIMITS.referrerMaxLength + 1) }),
      ).success,
    ).toBe(false)
    expect(
      clientEventSchema.safeParse(
        pageView({
          page: {
            url: 'https://example.com/',
            title: 't'.repeat(EVENT_LIMITS.pageTitleMaxLength + 1),
          },
        }),
      ).success,
    ).toBe(false)
  })

  it('pins the schema version', () => {
    // An unknown version is a client the server has no rules for, not a field to
    // coerce (docs snapshot 02 §8).
    expect(eventBatchSchema.safeParse(batch([pageView()], { schema_version: 2 })).success).toBe(
      false,
    )
    expect(eventBatchSchema.safeParse(batch([pageView()], { schema_version: '1' })).success).toBe(
      false,
    )
  })
})

/**
 * F-314 / D-101: the heatmap click signal is passive, high-volume and never
 * billable. It is contract-visible from Milestone 4 so click data accumulates
 * before the UI exists.
 */
describe('interaction signal', () => {
  const interaction = (overrides: Record<string, unknown> = {}) => ({
    event_id: EVENT_ID,
    type: 'interaction',
    occurred_at: '2026-07-20T10:30:00.000Z',
    interaction: {
      x_percent: 42.5,
      y_percent: 88,
      viewport_class: 'desktop',
      viewport_width: 1440,
      selector: 'main > section#pricing > button.cta',
      ...overrides,
    },
  })

  it('carries viewport percentages, a viewport class and a selector', () => {
    expect(clientEventSchema.safeParse(interaction()).success).toBe(true)
  })

  it('keeps coordinates inside the viewport', () => {
    expect(clientEventSchema.safeParse(interaction({ x_percent: 120 })).success).toBe(false)
    expect(clientEventSchema.safeParse(interaction({ y_percent: -1 })).success).toBe(false)
  })

  it('bounds element text and has no field for an input value', () => {
    expect(
      clientEventSchema.safeParse(
        interaction({ text: 't'.repeat(EVENT_LIMITS.elementTextMaxLength + 1) }),
      ).success,
    ).toBe(false)
    // There is deliberately no `value` field anywhere in the payload: an input's
    // value is never captured, at any layer (G-008 scope).
    expect(clientEventSchema.safeParse(interaction({ value: 'user typed this' })).success).toBe(
      false,
    )
  })
})

describe('tracker config contract', () => {
  it('accepts a versioned, credential-free configuration', () => {
    const config = {
      config_version: 3,
      site_timezone: 'Asia/Baku',
      allowed_domains: ['example.com'],
      redact_query_keys: ['token', 'email'],
      interaction_sampling: 0.25,
      heartbeat_interval_seconds: 15,
      features: { web_vitals: true, engagement: true, interactions: true, heartbeat: true },
      attributed_revenue: false,
      no_code_rules: [
        {
          rule_id: 'r_1',
          name: 'cta_clicked',
          version: 1,
          trigger: 'click',
          selector: 'button.cta',
          properties: [{ key: 'button_label', source: 'text' }],
        },
      ],
    }

    expect(trackerConfigSchema.safeParse(config).success).toBe(true)
    // The M4 shape is gone, deliberately (ADR-0034): `event: 'view'` named a
    // trigger nobody had designed, and the guessed field is refused rather than
    // silently ignored, because a strict object is what makes that detectable.
    expect(
      trackerConfigSchema.safeParse({
        ...config,
        no_code_rules: [
          { rule_id: 'r_1', name: 'cta_clicked', selector: 'button.cta', event: 'click' },
        ],
      }).success,
    ).toBe(false)
    // The write-only tracking key is never echoed back into a cacheable response.
    expect(trackerConfigSchema.safeParse({ ...config, tracking_key: 'oa_pub_x' }).success).toBe(
      false,
    )
  })
})

describe('OpenAPI and runtime contract agree', () => {
  it('documents both ingest endpoints and the tracker config', async () => {
    const spec = await readFile(SPEC_PATH, 'utf8')

    expect(spec).toContain('/v1/events:')
    expect(spec).toContain('/v1/realtime/heartbeat:')
    expect(spec).toContain('/v1/tracker/config:')
  })

  it('lists every canonical event type', async () => {
    const spec = await readFile(SPEC_PATH, 'utf8')
    for (const type of EVENT_TYPES) {
      expect(spec, `openapi.yaml is missing event type ${type}`).toContain(`- ${type}`)
    }
  })

  it('publishes the same limits the runtime enforces', async () => {
    const spec = await readFile(SPEC_PATH, 'utf8')

    expect(spec).toContain(`maxItems: ${EVENT_LIMITS.maxEventsPerBatch}`)
    expect(spec).toContain(`maxProperties: ${EVENT_LIMITS.maxPropertiesPerEvent}`)
    expect(spec).toContain(`maxLength: ${EVENT_LIMITS.urlMaxLength}`)
    expect(spec).toContain(`maxLength: ${EVENT_LIMITS.eventNameMaxLength}`)
    expect(spec).toContain(`maxLength: ${EVENT_LIMITS.selectorMaxLength}`)
  })

  it('keeps heartbeat out of the historical request schema in the document too', async () => {
    const spec = await readFile(SPEC_PATH, 'utf8')
    const mapping = spec.slice(spec.indexOf('      discriminator:'), spec.indexOf('    EventName:'))

    expect(mapping).toContain('page_view:')
    expect(mapping).not.toContain('heartbeat:')
  })
})
