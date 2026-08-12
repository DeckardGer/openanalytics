import {
  CAPABILITIES,
  SITE_DOMAIN_MAX_COUNT,
  SITE_NAME_MAX_LENGTH,
  SITE_SLUG_PATTERN,
  capabilitiesForRole,
  isSiteSlug,
  normalizeSiteDomain,
  normalizeSiteDomainSet,
  normalizeSiteName,
  roleHasCapability,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * The pure identity rules a site create/settings write applies.
 *
 * These exist to keep "configured but matches nothing" out of the origin
 * allowlist: `site_domains` is compared against a request `Origin` as a bare
 * host, so a stored URL, port or wildcard would refuse the customer's traffic
 * with nothing to read anywhere.
 */

describe('site slug', () => {
  it('uses the one canonical pattern the contract and the database already carry', () => {
    // A second, subtly different pattern is the failure this guards against.
    expect(SITE_SLUG_PATTERN.source).toBe('^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$')
  })

  it('accepts a lowercase slug with internal hyphens and digits', () => {
    expect(isSiteSlug('acme-metrics')).toBe(true)
    expect(isSiteSlug('a')).toBe(true)
    expect(isSiteSlug('shop2')).toBe(true)
    expect(isSiteSlug('a-b-c-1')).toBe(true)
  })

  it('rejects a leading or trailing hyphen', () => {
    expect(isSiteSlug('-acme')).toBe(false)
    expect(isSiteSlug('acme-')).toBe(false)
    expect(isSiteSlug('-')).toBe(false)
  })

  it('rejects uppercase, underscores, dots and spaces', () => {
    expect(isSiteSlug('Acme')).toBe(false)
    expect(isSiteSlug('acme_metrics')).toBe(false)
    expect(isSiteSlug('acme.metrics')).toBe(false)
    expect(isSiteSlug('acme metrics')).toBe(false)
  })

  it('rejects an empty slug and one longer than 63 characters', () => {
    expect(isSiteSlug('')).toBe(false)
    expect(isSiteSlug('a'.repeat(63))).toBe(true)
    expect(isSiteSlug('a'.repeat(64))).toBe(false)
  })

  it('rejects a non-string without throwing', () => {
    expect(isSiteSlug(undefined)).toBe(false)
    expect(isSiteSlug(42)).toBe(false)
    expect(isSiteSlug(['acme'])).toBe(false)
  })
})

describe('site name', () => {
  it('trims surrounding whitespace rather than refusing a pasted name', () => {
    expect(normalizeSiteName('  Acme Metrics  ')).toBe('Acme Metrics')
  })

  it('treats an empty or whitespace-only name as absent', () => {
    expect(normalizeSiteName('')).toBeNull()
    expect(normalizeSiteName('   ')).toBeNull()
  })

  it('accepts exactly the maximum length and refuses one character more', () => {
    expect(normalizeSiteName('n'.repeat(SITE_NAME_MAX_LENGTH))).toHaveLength(SITE_NAME_MAX_LENGTH)
    expect(normalizeSiteName('n'.repeat(SITE_NAME_MAX_LENGTH + 1))).toBeNull()
  })

  it('measures the length after trimming, not before', () => {
    expect(normalizeSiteName(` ${'n'.repeat(SITE_NAME_MAX_LENGTH)} `)).toHaveLength(
      SITE_NAME_MAX_LENGTH,
    )
  })

  it('refuses a non-string instead of coercing it', () => {
    expect(normalizeSiteName(undefined)).toBeNull()
    expect(normalizeSiteName(7)).toBeNull()
  })
})

describe('site domain normalization', () => {
  it('lowercases a hostname', () => {
    expect(normalizeSiteDomain('Shop.Example.COM')).toBe('shop.example.com')
  })

  it('strips exactly one trailing dot', () => {
    expect(normalizeSiteDomain('example.com.')).toBe('example.com')
    // A second trailing dot leaves an empty label, which is not a hostname.
    expect(normalizeSiteDomain('example.com..')).toBeNull()
  })

  it('trims surrounding whitespace but rejects whitespace inside', () => {
    expect(normalizeSiteDomain('  example.com  ')).toBe('example.com')
    expect(normalizeSiteDomain('exa mple.com')).toBeNull()
  })

  it('rejects a scheme', () => {
    expect(normalizeSiteDomain('https://example.com')).toBeNull()
    expect(normalizeSiteDomain('//example.com')).toBeNull()
  })

  it('rejects a port', () => {
    expect(normalizeSiteDomain('example.com:443')).toBeNull()
  })

  it('rejects a path or a query string', () => {
    expect(normalizeSiteDomain('example.com/app')).toBeNull()
    expect(normalizeSiteDomain('example.com?x=1')).toBeNull()
    expect(normalizeSiteDomain('example.com#frag')).toBeNull()
  })

  it('rejects userinfo', () => {
    expect(normalizeSiteDomain('user@example.com')).toBeNull()
  })

  it('rejects a wildcard', () => {
    // The collector's matcher already covers every subdomain under a dot
    // boundary, so a wildcard entry adds nothing and invites a bad match.
    expect(normalizeSiteDomain('*.example.com')).toBeNull()
    expect(normalizeSiteDomain('*')).toBeNull()
  })

  it('rejects an underscore', () => {
    expect(normalizeSiteDomain('my_site.example.com')).toBeNull()
  })

  it('rejects a single-label host such as localhost', () => {
    expect(normalizeSiteDomain('localhost')).toBeNull()
    expect(normalizeSiteDomain('intranet')).toBeNull()
  })

  it('rejects an empty label', () => {
    expect(normalizeSiteDomain('example..com')).toBeNull()
    expect(normalizeSiteDomain('.example.com')).toBeNull()
  })

  it('rejects a label with a leading or trailing hyphen', () => {
    expect(normalizeSiteDomain('-example.com')).toBeNull()
    expect(normalizeSiteDomain('example-.com')).toBeNull()
    expect(normalizeSiteDomain('shop.-example.com')).toBeNull()
  })

  it('accepts a 63-character label and rejects a 64-character one', () => {
    expect(normalizeSiteDomain(`${'a'.repeat(63)}.com`)).toBe(`${'a'.repeat(63)}.com`)
    expect(normalizeSiteDomain(`${'a'.repeat(64)}.com`)).toBeNull()
  })

  it('rejects a host longer than 253 characters', () => {
    const label = 'a'.repeat(63)
    // 63*4 + 3 dots = 255 characters.
    expect(normalizeSiteDomain([label, label, label, label].join('.'))).toBeNull()
  })

  it('accepts an internationalized punycode host', () => {
    expect(normalizeSiteDomain('xn--80ak6aa92e.com')).toBe('xn--80ak6aa92e.com')
  })

  it('rejects an empty string and a non-string', () => {
    expect(normalizeSiteDomain('')).toBeNull()
    expect(normalizeSiteDomain('   ')).toBeNull()
    expect(normalizeSiteDomain(null)).toBeNull()
    expect(normalizeSiteDomain(12)).toBeNull()
  })
})

describe('site domain set', () => {
  it('normalizes every entry and preserves first-seen order', () => {
    const result = normalizeSiteDomainSet(['B.example.com', 'a.example.com'])
    expect(result).toEqual({ ok: true, domains: ['b.example.com', 'a.example.com'] })
  })

  it('de-duplicates entries that normalize to the same host', () => {
    const result = normalizeSiteDomainSet(['Example.com', 'example.com.', 'EXAMPLE.COM'])
    expect(result).toEqual({ ok: true, domains: ['example.com'] })
  })

  it('accepts an empty list as "no allowlist configured"', () => {
    // The collector reads an empty allowlist as "accept any origin", so clearing
    // the set has to be expressible.
    expect(normalizeSiteDomainSet([])).toEqual({ ok: true, domains: [] })
  })

  it('names the offending entry when one is invalid', () => {
    expect(normalizeSiteDomainSet(['example.com', 'https://bad.example.com'])).toEqual({
      ok: false,
      error: 'invalid',
      index: 1,
      value: 'https://bad.example.com',
    })
  })

  it('reports a non-string entry as invalid with a null value', () => {
    expect(normalizeSiteDomainSet([42])).toEqual({
      ok: false,
      error: 'invalid',
      index: 0,
      value: null,
    })
  })

  it('accepts exactly the maximum count and refuses one more', () => {
    const at = Array.from({ length: SITE_DOMAIN_MAX_COUNT }, (_, i) => `s${i}.example.com`)
    const over = [...at, 'one-too-many.example.com']

    const ok = normalizeSiteDomainSet(at)
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.domains).toHaveLength(SITE_DOMAIN_MAX_COUNT)

    expect(normalizeSiteDomainSet(over)).toEqual({
      ok: false,
      error: 'too_many',
      count: SITE_DOMAIN_MAX_COUNT + 1,
    })
  })

  it('applies the count bound after de-duplication, not before', () => {
    // Repeating one host is one domain, not many.
    const repeated = Array.from({ length: SITE_DOMAIN_MAX_COUNT + 5 }, () => 'example.com')
    expect(normalizeSiteDomainSet(repeated)).toEqual({ ok: true, domains: ['example.com'] })
  })
})

describe('site:settings capability', () => {
  it('is part of the capability vocabulary', () => {
    expect(CAPABILITIES).toContain('site:settings')
  })

  it('is granted to owner and admin', () => {
    // Renaming a site and replacing its origin allowlist is the same class of
    // administrative act as credentials:manage, which admin already holds.
    expect(roleHasCapability('owner', 'site:settings')).toBe(true)
    expect(roleHasCapability('admin', 'site:settings')).toBe(true)
    expect(capabilitiesForRole('admin')).toContain('site:settings')
  })

  it('is denied to viewer', () => {
    expect(roleHasCapability('viewer', 'site:settings')).toBe(false)
    expect(capabilitiesForRole('viewer')).toEqual([])
  })

  it('does not widen the owner-only sensitive set', () => {
    for (const ownerOnly of ['revenue:read', 'export:raw', 'site:delete'] as const) {
      expect(roleHasCapability('admin', ownerOnly)).toBe(false)
    }
  })
})
