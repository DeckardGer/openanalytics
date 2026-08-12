import { canonicalReferrerHost, resolveReferrer } from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * ADR-0028. Two rules, proven at the layer that writes the grouping key.
 *
 * The bug this file exists for was reported by a customer on 2026-07-28: the
 * site's own domain appeared in its Sources report and on its realtime feed,
 * because a browser sends `document.referrer` on internal navigation and no
 * layer compared it against the site's own hosts. The second half — that
 * `www.google.com` and `google.com/search/abc` are one source — is what makes
 * the report readable once the first half stops polluting it.
 */

const SITE = { siteDomains: ['example.org'] as const }

describe('canonicalReferrerHost', () => {
  it('lowercases, strips `www.`, the port and a trailing dot', () => {
    expect(canonicalReferrerHost('WWW.Google.COM')).toBe('google.com')
    expect(canonicalReferrerHost('example.com:8443')).toBe('example.com')
    expect(canonicalReferrerHost('example.com.')).toBe('example.com')
    expect(canonicalReferrerHost('  Example.com  ')).toBe('example.com')
  })

  it('strips one leading `www.` and never a prefix that merely looks like one', () => {
    // `wwwexample.com` is a different site, and `www.www.example.com` is a real
    // host whose second label is not decoration.
    expect(canonicalReferrerHost('wwwexample.com')).toBe('wwwexample.com')
    expect(canonicalReferrerHost('www.www.example.com')).toBe('www.example.com')
  })

  it('leaves other subdomains alone', () => {
    // The subdomain policy of ADR-0028: only `www.` is a spelling of the parent
    // host. `blog.example.org` may be a separate property with its own traffic.
    expect(canonicalReferrerHost('blog.example.org')).toBe('blog.example.org')
    expect(canonicalReferrerHost('m.example.com')).toBe('m.example.com')
  })

  it('keeps an IPv6 literal whole while still dropping its port', () => {
    expect(canonicalReferrerHost('[2001:db8::1]:8080')).toBe('[2001:db8::1]')
    expect(canonicalReferrerHost('[2001:db8::1]')).toBe('[2001:db8::1]')
  })

  it('reduces nothing to the empty string rather than to a guess', () => {
    expect(canonicalReferrerHost('')).toBe('')
    expect(canonicalReferrerHost('   ')).toBe('')
    expect(canonicalReferrerHost('[unterminated')).toBe('')
  })
})

describe('resolveReferrer — the grouping key', () => {
  it('reduces the spellings of one search engine to one domain', () => {
    const bare = resolveReferrer('https://google.com/', SITE)
    const wwwed = resolveReferrer('https://www.google.com/', SITE)
    const deep = resolveReferrer('https://google.com/search/abc?q=analytics#top', SITE)

    expect(bare.domain).toBe('google.com')
    expect(wwwed.domain).toBe('google.com')
    expect(deep.domain).toBe('google.com')
    // One source, one row in `sources_1h` — the property the rollup cannot
    // recover later, because it groups before any reader sees a row.
    expect(new Set([bare.domain, wwwed.domain, deep.domain]).size).toBe(1)
  })

  it('drops the port from the key and keeps the path for drill-down', () => {
    const resolved = resolveReferrer('https://news.example.com:8443/item?id=1', SITE)

    expect(resolved.domain).toBe('news.example.com')
    expect(resolved.path).toBe('/item')
  })

  it('answers NULL for an absent, unparseable or non-http referrer', () => {
    for (const raw of ['', null, undefined, 'not a url', 'javascript:alert(1)', 'file:///etc']) {
      const resolved = resolveReferrer(raw, SITE)
      expect(resolved.domain).toBeNull()
      expect(resolved.path).toBeNull()
      // Unusable is not self: only a referrer that *resolved* to this site is.
      expect(resolved.isSelf).toBe(false)
    }
  })
})

describe('resolveReferrer — self-referral is not a source', () => {
  it('nulls a referrer matching a configured domain, in any spelling', () => {
    // The report bug verbatim: an internal navigation on the site itself.
    for (const raw of [
      'https://example.org/dashboard',
      'https://www.example.org/dashboard',
      'https://WWW.EXAMPLE.ORG/Dashboard',
      'https://example.org:443/dashboard',
    ]) {
      const resolved = resolveReferrer(raw, SITE)
      expect(resolved.isSelf).toBe(true)
      expect(resolved.domain).toBeNull()
      // The path goes with it: an internal path is not source drill-down.
      expect(resolved.path).toBeNull()
    }
  })

  it('matches a `www.`-only registration against the bare host too', () => {
    // Only `www.example.org` is registered; `example.org` is the same site and both
    // sides of the comparison are stripped, so neither spelling leaks through.
    const site = { siteDomains: ['www.example.org'] }
    expect(resolveReferrer('https://example.org/x', site).isSelf).toBe(true)
    expect(resolveReferrer('https://www.example.org/x', site).isSelf).toBe(true)
  })

  it('treats a subdomain as a different site (exact match only)', () => {
    // ADR-0028's subdomain policy. `blog.example.org` may be a separate property,
    // and a link from it to the app is a real acquisition source.
    const resolved = resolveReferrer('https://blog.example.org/post', SITE)
    expect(resolved.isSelf).toBe(false)
    expect(resolved.domain).toBe('blog.example.org')

    // And the reverse direction, from the perspective of the blog's own site.
    const blog = resolveReferrer('https://example.org/', { siteDomains: ['blog.example.org'] })
    expect(blog.isSelf).toBe(false)
    expect(blog.domain).toBe('example.org')
  })

  it('never mistakes a lookalike domain for the site itself', () => {
    // The `isOriginAllowed` suffix trap, re-proven here: matching is exact after
    // `www.`-stripping, so nobody's traffic disappears into Direct because they
    // registered a name that ends the same way.
    expect(resolveReferrer('https://notexample.org/', SITE).domain).toBe('notexample.org')
    expect(resolveReferrer('https://example.org.evil.test/', SITE).domain).toBe(
      'example.org.evil.test',
    )
  })

  it('uses the event page host when no allowlist is configured', () => {
    // An empty allowlist is unconfigured, not a deny (see `isOriginAllowed`), so
    // most sites reach here with no domains at all. The page the event happened
    // on is where the tracker is installed, so its host is the site's own.
    const site = { siteDomains: [], pageUrl: 'https://www.example.org/pricing' }
    expect(resolveReferrer('https://example.org/features', site).isSelf).toBe(true)
    expect(resolveReferrer('https://www.example.org/features', site).isSelf).toBe(true)
    expect(resolveReferrer('https://google.com/', site).domain).toBe('google.com')
  })

  it('ignores a page URL that is absent or unparseable', () => {
    for (const pageUrl of [undefined, null, '', 'not a url']) {
      const resolved = resolveReferrer('https://google.com/', { siteDomains: [], pageUrl })
      expect(resolved.domain).toBe('google.com')
    }
  })
})
