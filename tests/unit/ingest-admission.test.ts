import {
  decideIngestAdmission,
  isOriginAllowed,
  type SiteIngestConfig,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * Whether a site may ingest at all (docs snapshot 02 §7.1 item 11; 05 D-012,
 * D-013, D-210).
 *
 * A pure verdict on purpose. It is asked on every batch and every heartbeat, it
 * decides whether a queue write happens, and both of its wrong answers are
 * expensive: accepting for a blocked site means storing and eventually billing
 * traffic nobody is paying for, and refusing a funded site silently deletes a
 * customer's analytics.
 */

const NOW = new Date('2026-07-23T12:00:00.000Z')
const HOUR = 60 * 60 * 1000

const config = (overrides: Partial<SiteIngestConfig> = {}): SiteIngestConfig => ({
  siteId: '00000000-0000-7000-8000-000000000001',
  status: 'active',
  ingestGeneration: 1,
  configVersion: 1,
  billingUserId: '00000000-0000-7000-8000-0000000000ff',
  billingAssignmentVersion: 1,
  keyExpiresAt: null,
  allowedDomains: [],
  ...overrides,
})

describe('ingest admission', () => {
  it('admits an active site', () => {
    const decision = decideIngestAdmission({ config: config(), now: NOW })
    expect(decision.admitted).toBe(true)
    expect(decision.admitted && decision.mode).toBe('entitled')
  })

  /**
   * A `suspended` site with no registered opinion about *why*.
   *
   * The default, and the direction it has to fail in: nothing in the product sets
   * `suspended`, but the state exists and an operator can, so the gate refuses —
   * and it refuses as `SITE_NOT_FOUND`, telling an unauthenticated caller nothing
   * about the site it just addressed. The two grace-window branches that used to
   * be here are `tests/unit/cloud/ingest-admission.test.ts`: they read
   * `first_entitled_at` and `ingest_grace_until`, columns the product schema does
   * not have.
   */
  it('refuses a suspended site, and says nothing about why', () => {
    const decision = decideIngestAdmission({ config: config({ status: 'suspended' }), now: NOW })
    expect(decision.admitted).toBe(false)
    expect(decision.admitted === false && decision.code).toBe('SITE_NOT_FOUND')
    expect(decision.admitted === false && decision.reason).toBe('site_suspended')
  })

  it('hands a suspended site to a registered verdict when there is one', () => {
    // The `onSuspended` hook, which is how a deployment with its own account of a
    // suspension — and its own grace window — answers instead.
    const decision = decideIngestAdmission({
      config: config({ status: 'suspended' }),
      now: NOW,
      onSuspended: () => ({ admitted: true, mode: 'grace' }),
    })
    expect(decision.admitted).toBe(true)
    expect(decision.admitted && decision.mode).toBe('grace')
  })

  describe('D-210 — deletion fencing', () => {
    it.each(['deleting', 'deleted'] as const)('refuses a %s site', (status) => {
      const decision = decideIngestAdmission({ config: config({ status }), now: NOW })

      expect(decision.admitted).toBe(false)
      // Not SUBSCRIPTION_REQUIRED: this is not a billing state, and the answer
      // must not tell an unauthenticated caller that the site once existed.
      expect(decision.admitted === false && decision.code).toBe('SITE_NOT_FOUND')
    })
  })

  describe('an expired key never fails open', () => {
    it('refuses once the tracking key has expired', () => {
      // Docs snapshot 02 §7.2: a short-TTL config cache is allowed while
      // Postgres is unavailable, but "an expired or revoked key is never
      // accepted fail-open" — a cached entry must not outlive the key it
      // was resolved from.
      const decision = decideIngestAdmission({
        config: config({ keyExpiresAt: new Date(NOW.getTime() - 1) }),
        now: NOW,
      })

      expect(decision.admitted).toBe(false)
      expect(decision.admitted === false && decision.code).toBe('SITE_NOT_FOUND')
      expect(decision.admitted === false && decision.reason).toBe('key_expired')
    })

    it('admits a key that has not expired yet', () => {
      const decision = decideIngestAdmission({
        config: config({ keyExpiresAt: new Date(NOW.getTime() + HOUR) }),
        now: NOW,
      })
      expect(decision.admitted).toBe(true)
    })

    it('checks the key before the site status, so an expired key never reports a billing state', () => {
      const decision = decideIngestAdmission({
        config: config({
          status: 'suspended',
          keyExpiresAt: new Date(NOW.getTime() - 1),
        }),
        now: NOW,
      })
      expect(decision.admitted === false && decision.reason).toBe('key_expired')
    })
  })

  it('is deterministic: the same inputs always decide the same way', () => {
    const input = { config: config({ status: 'suspended' as const }), now: NOW }
    expect(decideIngestAdmission(input)).toEqual(decideIngestAdmission(input))
  })
})

describe('origin allowlist', () => {
  it('allows any origin when a site has configured no domains', () => {
    // A site that has not set a domain list is not opting out of analytics; the
    // allowlist is a customer-configured control, not a default deny.
    expect(isOriginAllowed('https://shop.example.com', [])).toBe(true)
    expect(isOriginAllowed(null, [])).toBe(true)
  })

  it('matches a configured domain and its subdomains', () => {
    const domains = ['example.com']
    expect(isOriginAllowed('https://example.com', domains)).toBe(true)
    expect(isOriginAllowed('https://shop.example.com', domains)).toBe(true)
    expect(isOriginAllowed('https://deep.shop.example.com', domains)).toBe(true)
  })

  it('does not match a domain that merely ends with the configured one', () => {
    // notexample.com is a different registrable domain. Suffix matching without
    // a dot boundary would let anyone ingest into a site by registering one.
    expect(isOriginAllowed('https://notexample.com', ['example.com'])).toBe(false)
    expect(isOriginAllowed('https://example.com.evil.test', ['example.com'])).toBe(false)
  })

  it('ignores scheme, port and case', () => {
    expect(isOriginAllowed('http://EXAMPLE.com:8080', ['example.com'])).toBe(true)
    expect(isOriginAllowed('https://shop.example.com', ['Shop.Example.COM'])).toBe(true)
  })

  it('refuses an origin when the site has an allowlist and the origin is absent', () => {
    // A configured allowlist is a deny for everything outside it, including a
    // request that sends no Origin at all — that is the shape a script hitting
    // the endpoint directly has.
    expect(isOriginAllowed(null, ['example.com'])).toBe(false)
    expect(isOriginAllowed('null', ['example.com'])).toBe(false)
  })

  it('refuses an unparseable origin rather than guessing', () => {
    expect(isOriginAllowed('not a url', ['example.com'])).toBe(false)
  })
})
