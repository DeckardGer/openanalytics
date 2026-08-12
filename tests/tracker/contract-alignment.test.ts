import {
  EVENT_LIMITS,
  EVENT_SCHEMA_VERSION,
  HISTORICAL_EVENT_TYPES,
  eventBatchSchema,
  heartbeatRequestSchema,
} from '@openanalytics/contracts'
import { LIMITS, TRACKER_SCHEMA_VERSION } from '../../apps/tracker/src/index.ts'
import { beforeEach, describe, expect, it } from 'vitest'
import { createHarness, resetBrowser } from './harness.ts'

/**
 * The tracker bundle carries no dependency, so it restates the contract's
 * constants instead of importing them (boundary rule 5). This file is the reason
 * that copy is safe: it fails the moment a value drifts, and it validates real
 * tracker output against the real schemas rather than against a description of
 * them.
 */

beforeEach(() => {
  resetBrowser()
})

describe('tracker constants match the contract', () => {
  it('uses the same schema version', () => {
    expect(TRACKER_SCHEMA_VERSION).toBe(EVENT_SCHEMA_VERSION)
  })

  it.each([
    'eventNameMaxLength',
    'propertyKeyMaxLength',
    'propertyValueMaxLength',
    'maxPropertiesPerEvent',
    'urlMaxLength',
    'referrerMaxLength',
    'pageTitleMaxLength',
    'selectorMaxLength',
    'elementTextMaxLength',
    'externalUserIdMaxLength',
    'clientSessionIdMaxLength',
    'actionIdMaxLength',
    'maxEventsPerBatch',
    'maxBatchBytes',
  ] as const)('mirrors EVENT_LIMITS.%s', (key) => {
    expect(LIMITS[key]).toBe(EVENT_LIMITS[key])
  })
})

describe('tracker output validates against the contract', () => {
  it('produces a batch the collector would accept', () => {
    const harness = createHarness()

    harness.tracker.track('signup_started', { plan: 'growth' })
    harness.tracker.conversion('purchase', { order_id: 'o_123', value: 49, currency: 'USD' })
    harness.tracker.identify('customer-internal-id')
    harness.runTimers()

    expect(harness.batches().length).toBeGreaterThan(0)
    for (const batch of harness.batches()) {
      const parsed = eventBatchSchema.safeParse(batch.body)
      expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true)
    }
    harness.stop()
  })

  it('produces a valid heartbeat on the realtime contract', () => {
    const harness = createHarness()
    harness.fireHeartbeatInterval()

    const heartbeat = harness.heartbeats()[0]
    const parsed = heartbeatRequestSchema.safeParse(heartbeat?.body)
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true)
    harness.stop()
  })

  it('produces valid engagement, vital and interaction events', () => {
    const harness = createHarness()
    document.body.innerHTML = '<button class="cta">Buy now</button>'

    harness.advance(2_000)
    document
      .querySelector('button')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 40, clientY: 90 }))
    window.dispatchEvent(new Event('pagehide'))

    const types = new Set(harness.events().map((event) => event['type']))
    expect(types.has('interaction')).toBe(true)
    expect(types.has('engagement')).toBe(true)

    for (const batch of harness.sent.filter((request) => request.url.endsWith('/v1/events'))) {
      expect(eventBatchSchema.safeParse(batch.body).success).toBe(true)
    }
    harness.stop()
  })

  it('only ever emits historical event types into the batch', () => {
    // The client half of "a heartbeat cannot enter the historical batch": the
    // tracker has no code path that puts one there.
    const harness = createHarness()
    harness.fireHeartbeatInterval()
    harness.tracker.track('anything')
    harness.runTimers()

    for (const event of harness.events()) {
      expect(HISTORICAL_EVENT_TYPES).toContain(event['type'])
    }
    harness.stop()
  })

  it('never puts a server-owned field on the wire', () => {
    // Milestone 4 acceptance: the client cannot set the billing user, plan,
    // usage window, geo or `billable`. Strict schemas make it a parse failure;
    // this asserts the tracker does not even try.
    const harness = createHarness()
    harness.tracker.track('checkout')
    harness.runTimers()

    for (const event of harness.events()) {
      for (const field of [
        'site_id',
        'billing_user_id',
        'billing_assignment_version',
        'usage_window_id',
        'billable',
        'accepted_at',
        'received_at',
        'clock_skewed',
        'ingest_generation',
        'anonymous_id',
        'source',
      ]) {
        expect(Object.keys(event)).not.toContain(field)
      }
    }
    harness.stop()
  })
})
