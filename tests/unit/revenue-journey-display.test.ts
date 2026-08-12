import {
  REVENUE_JOURNEY_DISPLAY_KINDS,
  journeySourceLabel,
  normalizeReportingCurrency,
  isEcbConvertibleCurrency,
  renderRevenueJourneyEntry,
  SUPPORTED_REPORTING_CURRENCIES,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * The journey display contract (docs snapshot 03 §11; ADR-0033, D7) and the
 * reporting-currency vocabulary (D2c). Milestone 12 Checkpoint 5.
 *
 * `display.text` is the one field a client may put on screen verbatim, so the
 * templates are pinned literally: changing one silently changes what a customer
 * reads, and it should be as hard to do by accident as changing a column name.
 */

describe('display kinds', () => {
  it('is the closed vocabulary the contract declares', () => {
    expect([...REVENUE_JOURNEY_DISPLAY_KINDS]).toEqual([
      'session_entry',
      'conversion',
      'revenue_charge',
      'revenue_refund',
      'revenue_dispute',
    ])
  })

  it('renders every kind with a non-empty text and an icon', () => {
    // Totality: there is no input for which a client receives a blank row.
    const rendered = [
      renderRevenueJourneyEntry({
        kind: 'session_entry',
        sessionId: 's1',
        occurredAt: '2026-07-20T09:00:00.000Z',
        referrerDomain: '',
        utmSource: '',
        utmMedium: '',
        utmCampaign: '',
        utmContent: '',
        utmTerm: '',
        entryPage: '',
      }),
      renderRevenueJourneyEntry({
        kind: 'conversion',
        eventId: 'e1',
        occurredAt: '2026-07-20T09:30:00.000Z',
        name: 'purchase',
        orderId: 'pi_1',
      }),
      renderRevenueJourneyEntry(moneyInput('revenue_charge', 'succeeded')),
      renderRevenueJourneyEntry(moneyInput('revenue_refund', 'succeeded')),
      renderRevenueJourneyEntry(moneyInput('revenue_dispute', 'lost')),
    ]
    expect(rendered.map((entry) => entry.display.kind)).toEqual([...REVENUE_JOURNEY_DISPLAY_KINDS])
    for (const entry of rendered) {
      expect(entry.display.text.length, entry.display.kind).toBeGreaterThan(0)
      expect(entry.display.icon, entry.display.kind).toMatch(/^[a-z0-9-]+$/)
    }
  })
})

function moneyInput(
  kind: 'revenue_charge' | 'revenue_refund' | 'revenue_dispute',
  status: string,
  conversionSource = 'ecb',
) {
  return {
    kind,
    objectId: 'ch_1',
    occurredAt: '2026-07-20T10:00:00.000Z',
    status,
    currency: 'EUR',
    amountMinor: 10_000,
    reportingCurrency: 'USD',
    reportingAmountMinor: 10_800,
    conversionSource,
  } as const
}

describe('text templates (pinned)', () => {
  it('renders a session entry with its source and landing page', () => {
    const entry = renderRevenueJourneyEntry({
      kind: 'session_entry',
      sessionId: 's-1',
      occurredAt: '2026-07-20T09:00:00.000Z',
      referrerDomain: 'google.com',
      utmSource: 'newsletter',
      utmMedium: 'email',
      utmCampaign: 'july',
      utmContent: 'hero',
      utmTerm: 'analytics',
      entryPage: '/pricing',
    })
    expect(entry.display.text).toBe('Session from newsletter, landing on /pricing')
    expect(entry.event_id).toBe('s-1')
    expect(entry.name).toBe('session_entry')
    // Every field the template consumed is also in `properties`, so a client can
    // localize its own sentence instead of using the server's.
    expect(entry.properties).toEqual({
      session_id: 's-1',
      source: 'newsletter',
      entry_page: '/pricing',
      referrer_domain: 'google.com',
      utm_source: 'newsletter',
      utm_medium: 'email',
      utm_campaign: 'july',
      utm_content: 'hero',
      utm_term: 'analytics',
    })
  })

  it('drops the landing clause when there is no entry page', () => {
    const entry = renderRevenueJourneyEntry({
      kind: 'session_entry',
      sessionId: 's-1',
      occurredAt: '2026-07-20T09:00:00.000Z',
      referrerDomain: '',
      utmSource: '',
      utmMedium: '',
      utmCampaign: '',
      utmContent: '',
      utmTerm: '',
      entryPage: '',
    })
    expect(entry.display.text).toBe('Session from direct')
  })

  it('resolves the source label utm → referrer → direct', () => {
    expect(journeySourceLabel({ utmSource: 'ads', referrerDomain: 'google.com' })).toBe('ads')
    expect(journeySourceLabel({ utmSource: '', referrerDomain: 'google.com' })).toBe('google.com')
    expect(journeySourceLabel({ utmSource: '', referrerDomain: '' })).toBe('direct')
  })

  it('renders each charge status', () => {
    const text = (status: string) =>
      renderRevenueJourneyEntry(moneyInput('revenue_charge', status)).display.text
    expect(text('succeeded')).toBe('Payment succeeded')
    expect(text('pending')).toBe('Payment is pending')
    expect(text('failed')).toBe('Payment failed')
    expect(text('refunded')).toBe('Payment was fully refunded')
    expect(text('partially_refunded')).toBe('Payment was partially refunded')
    // Readable rather than blank for a vocabulary this build has not learned.
    expect(text('requires_action')).toBe('Payment is requires_action')
  })

  it('renders each refund status', () => {
    const text = (status: string) =>
      renderRevenueJourneyEntry(moneyInput('revenue_refund', status)).display.text
    expect(text('succeeded')).toBe('Refund was issued')
    expect(text('pending')).toBe('Refund is pending')
    expect(text('failed')).toBe('Refund failed')
    expect(text('canceled')).toBe('Refund was canceled')
  })

  it('renders each dispute status', () => {
    const text = (status: string) =>
      renderRevenueJourneyEntry(moneyInput('revenue_dispute', status)).display.text
    expect(text('won')).toBe('Dispute was won')
    expect(text('lost')).toBe('Dispute was lost')
    expect(text('needs_response')).toBe('Dispute needs a response')
    expect(text('under_review')).toBe('Dispute is under review')
    expect(text('warning_needs_response')).toBe('Dispute was raised as an early warning')
  })

  it('renders a conversion', () => {
    const entry = renderRevenueJourneyEntry({
      kind: 'conversion',
      eventId: 'evt_1',
      occurredAt: '2026-07-20T09:30:00.000Z',
      name: 'purchase',
      orderId: 'pi_1',
    })
    expect(entry.display.text).toBe('Conversion “purchase” fired')
    expect(entry.properties).toEqual({ order_id: 'pi_1', event_name: 'purchase' })
  })
})

describe('what never reaches a rendered string', () => {
  it('puts no amount in the text — money stays minor units plus a currency', () => {
    const entry = renderRevenueJourneyEntry(moneyInput('revenue_charge', 'succeeded'))
    expect(entry.display.text).not.toMatch(/\d/)
    expect(entry.properties['amount_minor']).toBe(10_000)
    expect(entry.properties['currency']).toBe('EUR')
  })

  it('reports an unconverted reporting amount as null, never as zero', () => {
    // A zero is a number a client would happily add up; D2c's whole point is
    // that this one is unknown.
    const entry = renderRevenueJourneyEntry(
      moneyInput('revenue_charge', 'succeeded', 'unavailable'),
    )
    expect(entry.properties['reporting_amount_minor']).toBeNull()
    expect(entry.properties['conversion_source']).toBe('unavailable')
    // The original is intact, which is the other half of the contract.
    expect(entry.properties['amount_minor']).toBe(10_000)
  })
})

describe('reporting currency vocabulary (D2c)', () => {
  it('accepts a supported code and uppercases it', () => {
    expect(normalizeReportingCurrency('usd')).toBe('USD')
    expect(normalizeReportingCurrency(' eur ')).toBe('EUR')
  })

  it('refuses a code that matches the pattern but is not real', () => {
    // The Postgres CHECK is `^[A-Z]{3}$`, which `ZZZ` passes — and a site set to
    // it would get `conversion_source: 'unavailable'` on every transaction, an
    // empty revenue dashboard produced by a typo with no error to explain it.
    expect(normalizeReportingCurrency('ZZZ')).toBeNull()
    expect(normalizeReportingCurrency('US')).toBeNull()
    expect(normalizeReportingCurrency('US1')).toBeNull()
    expect(normalizeReportingCurrency(42)).toBeNull()
    expect(normalizeReportingCurrency(null)).toBeNull()
  })

  it('excludes the currencies the ECB stopped publishing', () => {
    // A site set to either would convert nothing. Their absence is why the list
    // is written out rather than derived from the last fetch.
    expect(isEcbConvertibleCurrency('HRK')).toBe(false)
    expect(isEcbConvertibleCurrency('RUB')).toBe(false)
  })

  it('accepts a non-ECB settlement currency and says it is not convertible', () => {
    expect(normalizeReportingCurrency('AED')).toBe('AED')
    expect(isEcbConvertibleCurrency('AED')).toBe(false)
    expect(isEcbConvertibleCurrency('USD')).toBe(true)
  })

  it('is sorted, unique and all uppercase', () => {
    expect([...SUPPORTED_REPORTING_CURRENCIES]).toEqual([...SUPPORTED_REPORTING_CURRENCIES].sort())
    expect(new Set(SUPPORTED_REPORTING_CURRENCIES).size).toBe(SUPPORTED_REPORTING_CURRENCIES.length)
    for (const code of SUPPORTED_REPORTING_CURRENCIES) expect(code).toMatch(/^[A-Z]{3}$/)
  })
})
