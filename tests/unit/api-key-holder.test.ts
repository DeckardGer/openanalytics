import {
  API_KEY_HOLDERS,
  DEFAULT_API_KEY_HOLDER,
  apiKeyHolderFrom,
  isApiKeyHolder,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * Who holds a key's secret (docs snapshot 02 §19, ADR-0043 D8).
 *
 * This value decides whether a credential survives its holder's departure from
 * a site, so every reading of it here is a reading of "revoke" or "keep alive".
 * The two directions are not symmetric: keeping the wrong key alive leaves a
 * departed person reading a customer's analytics, and revoking the wrong one
 * takes a working installation down. The default and the fallbacks below all
 * lean the same way, and each test says which way that is.
 */

describe('apiKeyHolderFrom', () => {
  it('defaults a private key to the holder that revokes', () => {
    // The direction rule, ADR-0042 D3's applied to a different column: a
    // credential must not survive an eviction because a milestone shipped.
    expect(DEFAULT_API_KEY_HOLDER).toBe('user')
    expect(apiKeyHolderFrom('private_read', null)).toBe('user')
    expect(apiKeyHolderFrom('private_read', undefined)).toBe('user')
  })

  it('returns a stored private-key holder as written', () => {
    expect(apiKeyHolderFrom('private_read', 'user')).toBe('user')
    expect(apiKeyHolderFrom('private_read', 'site')).toBe('site')
  })

  it('reads an unrecognized holder as the person, not the site', () => {
    // A row this build cannot interpret must not keep a credential alive on the
    // strength of a value it does not understand. Falling back to `site` would
    // do exactly that.
    expect(apiKeyHolderFrom('private_read', 'machine')).toBe('user')
    expect(apiKeyHolderFrom('private_read', '')).toBe('user')
  })

  it('calls a tracking key the site’s whatever the column says', () => {
    // The deploy window for migration 0044: an older api build inserts a
    // tracking key under the column default (`user`), and revoking a site's
    // public tracker token when a member leaves would stop every browser on
    // that site from posting events. `account-deletion.ts` has excluded
    // tracking keys since M10; this is that exclusion, moved into one function.
    expect(apiKeyHolderFrom('tracking_write', 'user')).toBe('site')
    expect(apiKeyHolderFrom('tracking_write', null)).toBe('site')
    expect(apiKeyHolderFrom('tracking_write', 'site')).toBe('site')
  })
})

describe('the holder vocabulary', () => {
  it('has exactly two values, and the CHECK in migration 0044 pins the same two', () => {
    expect([...API_KEY_HOLDERS]).toEqual(['user', 'site'])
  })

  it('accepts only those two strings', () => {
    expect(isApiKeyHolder('user')).toBe(true)
    expect(isApiKeyHolder('site')).toBe(true)
    expect(isApiKeyHolder('User')).toBe(false)
    expect(isApiKeyHolder(null)).toBe(false)
    expect(isApiKeyHolder(undefined)).toBe(false)
  })
})
