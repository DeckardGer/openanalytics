import {
  anonymousIdentityCandidates,
  anonymousIdentityFor,
  clientSessionHash,
  deriveVisitorContext,
  externalUserIdHash,
  normalizeUserAgentClass,
  utcDatesInAcceptanceWindow,
  type IdentityKey,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

const KEY: IdentityKey = { keyVersion: 1, secret: 'identity-secret-v1' }
const ROTATED: IdentityKey = { keyVersion: 2, secret: 'identity-secret-v2' }

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const base = {
  ip: '203.0.113.42',
  userAgent: CHROME_WINDOWS,
  siteId: 'site_alpha',
  occurredAt: '2026-07-20T10:30:00.000Z',
  key: KEY,
}

/**
 * Docs snapshot 05, D-102. The default cookieless identity is a site-scoped,
 * UTC-daily rotating HMAC over IP + normalized UA class + site + date + key
 * version, after which the raw IP is discarded.
 */
describe('anonymous identity', () => {
  it('is stable for one visitor within a UTC day', () => {
    const morning = anonymousIdentityFor(base)
    const evening = anonymousIdentityFor({ ...base, occurredAt: '2026-07-20T22:15:00.000Z' })

    expect(morning.anonymousId).toBe(evening.anonymousId)
    expect(morning.utcDate).toBe('2026-07-20')
  })

  it('rotates on the UTC calendar date, not a site timezone', () => {
    // Asia/Baku is UTC+4: 21:00Z and 01:00Z the next day are the same local
    // evening. D-102 puts them in different identity buckets anyway, because the
    // site timezone only groups dashboards.
    const before = anonymousIdentityFor({ ...base, occurredAt: '2026-07-20T21:00:00.000Z' })
    const after = anonymousIdentityFor({ ...base, occurredAt: '2026-07-21T01:00:00.000Z' })

    expect(before.anonymousId).not.toBe(after.anonymousId)
    expect(after.utcDate).toBe('2026-07-21')
  })

  it('is site-scoped: one browser is two visitors at two customers', () => {
    // Docs snapshot 02 §10: the same browser must never get the same anonymous
    // id at two different Open Analytics customers.
    const alpha = anonymousIdentityFor(base)
    const beta = anonymousIdentityFor({ ...base, siteId: 'site_beta' })

    expect(alpha.anonymousId).not.toBe(beta.anonymousId)
  })

  it('separates different IPs and different UA classes', () => {
    const reference = anonymousIdentityFor(base).anonymousId
    const otherIp = anonymousIdentityFor({ ...base, ip: '198.51.100.7' })
    const firefox = anonymousIdentityFor({
      ...base,
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
    })

    expect(otherIp.anonymousId).not.toBe(reference)
    expect(firefox.anonymousId).not.toBe(reference)
  })

  it('does not split a visitor on a browser point release', () => {
    // The UA class is coarse on purpose: a precise UA string would make the
    // hash a fingerprint, and a Chrome update would split one visitor's day.
    const updated = anonymousIdentityFor({
      ...base,
      userAgent: CHROME_WINDOWS.replace('120.0.0.0', '121.0.6167.85'),
    })

    expect(updated.anonymousId).toBe(anonymousIdentityFor(base).anonymousId)
  })

  it('treats an IPv4-mapped IPv6 address as the same client', () => {
    const mapped = anonymousIdentityFor({ ...base, ip: '::ffff:203.0.113.42' })
    expect(mapped.anonymousId).toBe(anonymousIdentityFor(base).anonymousId)
  })

  it('changes with the key version', () => {
    const rotated = anonymousIdentityFor({ ...base, key: ROTATED })

    expect(rotated.anonymousId).not.toBe(anonymousIdentityFor(base).anonymousId)
    expect(rotated.keyVersion).toBe(2)
  })

  it('offers one candidate per live key during a rotation', () => {
    const candidates = anonymousIdentityCandidates({ ...base, keys: [KEY, ROTATED] })

    expect(candidates).toHaveLength(2)
    expect(new Set(candidates.map((entry) => entry.anonymousId)).size).toBe(2)
  })

  it('keeps two UTC days of key material in play for late events', () => {
    // Offline events arrive up to 24h late (D-016), so at any instant yesterday's
    // material is still required.
    expect(utcDatesInAcceptanceWindow('2026-07-21T00:30:00.000Z')).toEqual([
      '2026-07-20',
      '2026-07-21',
    ])
  })
})

/**
 * Milestone 4 acceptance: the raw IP does not survive in an event, a log or a
 * queue payload. The IP is an argument here and nothing else — these assertions
 * scan the whole returned structure, not a named field.
 */
describe('raw IP discard boundary', () => {
  const IP = '203.0.113.42'

  it('returns no IP anywhere in the identity structure', () => {
    const identity = anonymousIdentityFor(base)
    expect(JSON.stringify(identity)).not.toContain(IP)
  })

  it('returns no IP anywhere in the visitor context the collector carries forward', () => {
    const context = deriveVisitorContext({
      ...base,
      geo: { country: 'AZ', city: 'Baku' },
    })

    const serialized = JSON.stringify(context)
    expect(serialized).not.toContain(IP)
    expect(serialized).not.toContain('203.0.113')
    // Geo survives; it is the coarse result the IP was resolved to before the
    // address was dropped.
    expect(context.country).toBe('AZ')
    expect(context.anonymousId).toHaveLength(64)
  })

  it('has no field that could hold an address', () => {
    const context = deriveVisitorContext(base)
    const keys = Object.keys(context).map((key) => key.toLowerCase())

    expect(keys.some((key) => key.includes('ip') || key.includes('address'))).toBe(false)
  })

  it('does not leak the address through an IPv6 spelling either', () => {
    const context = deriveVisitorContext({ ...base, ip: '2001:db8::1234:5678' })
    expect(JSON.stringify(context)).not.toContain('2001:db8')
  })
})

describe('user agent classification', () => {
  it.each([
    [CHROME_WINDOWS, 'desktop', 'chrome', 'windows'],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1',
      'mobile',
      'safari',
      'ios',
    ],
    [
      'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Safari/604.1',
      'tablet',
      'safari',
      'ios',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
      'desktop',
      'edge',
      'windows',
    ],
  ])('classifies %s', (userAgent, deviceType, browser, os) => {
    expect(normalizeUserAgentClass(userAgent)).toEqual({ deviceType, browser, os })
  })

  it('degrades to unknown rather than guessing', () => {
    expect(normalizeUserAgentClass(null)).toEqual({
      deviceType: 'unknown',
      browser: 'unknown',
      os: 'unknown',
    })
    expect(normalizeUserAgentClass('')).toEqual({
      deviceType: 'unknown',
      browser: 'unknown',
      os: 'unknown',
    })
  })
})

describe('customer-supplied identifiers', () => {
  it('hashes identify() values site-scoped', () => {
    // Docs snapshot 02 §10: `external_user_id` must not be raw PII, and it is
    // hashed regardless so a customer sending an email does not store one.
    const alpha = externalUserIdHash({
      siteId: 'site_alpha',
      externalUserId: 'customer@example.com',
      key: KEY,
    })
    const beta = externalUserIdHash({
      siteId: 'site_beta',
      externalUserId: 'customer@example.com',
      key: KEY,
    })

    expect(alpha.userId).not.toContain('@')
    expect(alpha.userId).not.toBe(beta.userId)
    expect(alpha.keyVersion).toBe(1)
  })

  it('does not rotate the customer identity daily', () => {
    // It is a stable identity the customer already has, not a privacy-mode
    // anonymous id, so no calendar date enters the material.
    const first = externalUserIdHash({ siteId: 'site_alpha', externalUserId: 'u_1', key: KEY })
    const second = externalUserIdHash({ siteId: 'site_alpha', externalUserId: 'u_1', key: KEY })

    expect(first.userId).toBe(second.userId)
  })

  it('hashes the client session hint site-scoped', () => {
    const alpha = clientSessionHash({ siteId: 'site_alpha', clientSessionId: 'cs_1', key: KEY })
    const beta = clientSessionHash({ siteId: 'site_beta', clientSessionId: 'cs_1', key: KEY })

    expect(alpha).not.toBe(beta)
    expect(alpha).not.toContain('cs_1')
  })
})
