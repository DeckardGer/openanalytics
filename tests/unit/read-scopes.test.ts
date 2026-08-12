import {
  KEY_SCOPES,
  MINIMUM_READ_SCOPE,
  READ_SCOPES,
  hasReadScope,
  isKeyEligibleScope,
  isReadScope,
  keyScopeRefusal,
  readScopesFrom,
  readScopesFromGrant,
  readScopesToGrant,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * The read vocabulary (ADR-0042 D3; ADR-0043 D4 and D5).
 *
 * One dictionary serves two credential kinds, so the assertions here fall into
 * two families that must not be confused: what the *strings* are, and which
 * credential may hold which. The second family is the one that has a security
 * consequence — a key that could hold `realtime:read` would need a revocation
 * mechanism that does not exist for it.
 */

describe('the vocabulary', () => {
  it('is four strings, and M14 s two are unchanged and still first', () => {
    // A whole-list comparison, not an alternation match. The alternation is the
    // hole ADR-0043's implementation notes record: a green test that pinned
    // nothing because a third value slipped past `user|site`.
    expect([...READ_SCOPES]).toEqual([
      'site:read',
      'analytics:read',
      'realtime:read',
      'revenue:read',
    ])
    expect(MINIMUM_READ_SCOPE).toBe('site:read')
  })

  it('accepts only those four strings', () => {
    for (const scope of READ_SCOPES) expect(isReadScope(scope)).toBe(true)
    expect(isReadScope('analytics.read')).toBe(false)
    expect(isReadScope('Analytics:read')).toBe(false)
    expect(isReadScope(null)).toBe(false)
    expect(isReadScope(undefined)).toBe(false)
  })
})

describe('readScopesFrom', () => {
  it('reads a NULL grant as the minimum, never as everything', () => {
    expect(readScopesFrom(null)).toEqual(['site:read'])
    expect(readScopesFrom(undefined)).toEqual(['site:read'])
  })

  it('folds the minimum into a grant that omits it', () => {
    // A key granted `analytics:read` alone could not read the site context its
    // own numbers belong to.
    expect(readScopesFrom(['analytics:read'])).toEqual(['site:read', 'analytics:read'])
  })

  it('drops a string this build cannot name rather than failing the read', () => {
    expect(readScopesFrom(['site:read', 'widgets:read'])).toEqual(['site:read'])
    // Only unknowns: still the minimum, so the endpoint the credential was
    // minted for keeps working.
    expect(readScopesFrom(['widgets:read'])).toEqual(['site:read'])
  })

  it('carries the two new scopes through, so they are not silently dropped', () => {
    // The failure this pins: if `realtime:read` were absent from READ_SCOPES,
    // `readScopesFrom` would drop it as unknown and every realtime request from
    // a token that legitimately holds it would answer 403 — a grant that reads
    // as a typo.
    expect(readScopesFrom(['realtime:read', 'revenue:read'])).toEqual([
      'site:read',
      'realtime:read',
      'revenue:read',
    ])
  })
})

describe('the OAuth grant string', () => {
  it('round-trips through the space-delimited form RFC 6749 uses', () => {
    const scopes = readScopesFrom(['analytics:read', 'realtime:read'])
    expect(readScopesFromGrant(readScopesToGrant(scopes))).toEqual(scopes)
  })

  it('drops the OIDC scopes Better Auth requires, keeping the read ones', () => {
    // `openid`/`profile`/`email`/`offline_access` authorize the identity claim,
    // not the analytics. They must not become read authorization by travelling
    // in the same string.
    expect(readScopesFromGrant('openid profile email offline_access analytics:read')).toEqual([
      'site:read',
      'analytics:read',
    ])
  })

  it('reads an absent or empty grant as the minimum', () => {
    expect(readScopesFromGrant(null)).toEqual(['site:read'])
    expect(readScopesFromGrant('')).toEqual(['site:read'])
    expect(readScopesFromGrant('   ')).toEqual(['site:read'])
  })

  it('accepts a comma-delimited grant, which some clients send', () => {
    expect(readScopesFromGrant('site:read,analytics:read')).toEqual(['site:read', 'analytics:read'])
  })
})

describe('which credential may hold which scope (ADR-0043 D5)', () => {
  it('lets a key hold exactly the two M14 scopes', () => {
    expect([...KEY_SCOPES]).toEqual(['site:read', 'analytics:read'])
  })

  it('closes realtime and revenue to keys, and the closure partitions the vocabulary', () => {
    // Asserted as a partition rather than as a second literal list: a fifth read
    // scope added without a row in D5's table fails here, because it is neither
    // key-eligible nor one of the two named exclusions.
    expect(READ_SCOPES.filter((scope) => !isKeyEligibleScope(scope))).toEqual([
      'realtime:read',
      'revenue:read',
    ])
    expect(READ_SCOPES.filter(isKeyEligibleScope)).toEqual([...KEY_SCOPES])
  })

  it('states the reason, not only the rule, in each refusal', () => {
    // The recovery is a different credential kind, and a refusal that does not
    // say so sends an integrator looking for a plan or a setting.
    expect(keyScopeRefusal('realtime:read')).toContain('OAuth token')
    expect(keyScopeRefusal('realtime:read')).toContain('site, not a person')
    expect(keyScopeRefusal('revenue:read')).toContain('OAuth token')
    expect(keyScopeRefusal('revenue:read')).toContain('owner-only')
  })
})

describe('hasReadScope', () => {
  it('does not imply one scope from another', () => {
    // Notably `analytics:read` does not imply `revenue:read`: they are different
    // permissions over the same site, and ADR-0036 CP7 keeps revenue owner-only.
    expect(hasReadScope(['site:read', 'analytics:read'], 'revenue:read')).toBe(false)
    expect(hasReadScope(['site:read', 'analytics:read'], 'analytics:read')).toBe(true)
    expect(hasReadScope(['site:read'], 'analytics:read')).toBe(false)
  })
})
