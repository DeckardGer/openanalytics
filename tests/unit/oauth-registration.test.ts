import { describe, expect, it } from 'vitest'
import {
  MAX_REDIRECT_URIS,
  validateClientRegistration,
  type ClientRegistrationResult,
} from '@openanalytics/domain'

/**
 * ADR-0047's registration policy, exhausted where it lives.
 *
 * The endpoint's own test (`tests/migration/oauth-dcr.test.ts`) proves one
 * registration travels end to end; this file walks the refusal table, because
 * the policy is the boundary and a boundary is tested at its edges.
 */

const SCOPES = ['openid', 'profile', 'site:read', 'analytics:read']

function judge(body: Record<string, unknown>): ClientRegistrationResult {
  return validateClientRegistration(body, SCOPES)
}

/** A body that passes, for the tests that break one field at a time. */
function valid(): Record<string, unknown> {
  return {
    token_endpoint_auth_method: 'none',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    client_name: 'Claude',
  }
}

describe('validateClientRegistration', () => {
  it('accepts the shape an MCP host actually sends', () => {
    const result = judge(valid())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.registration.clientName).toBe('Claude')
    expect(result.registration.redirectUris).toEqual(['https://claude.ai/api/mcp/auth_callback'])
    expect(result.registration.grantTypes).toEqual(['authorization_code', 'refresh_token'])
    expect(result.registration.responseTypes).toEqual(['code'])
    expect(result.registration.scope).toBe(SCOPES.join(' '))
  })

  describe('public clients only (D2)', () => {
    it.each([
      ['client_secret_basic'],
      ['client_secret_post'],
      // Absent means RFC 7591's default, `client_secret_basic` — refused with
      // the same sentence rather than silently coerced to `none`, because a
      // client that asked for a secret and did not get one fails at its first
      // token exchange, far from the cause.
      [undefined],
    ])('refuses token_endpoint_auth_method %s', (method) => {
      const body = valid()
      if (method === undefined) delete body['token_endpoint_auth_method']
      else body['token_endpoint_auth_method'] = method
      const result = judge(body)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toBe('invalid_client_metadata')
      expect(result.description).toContain("'none'")
    })
  })

  describe('redirect URIs: https or loopback, never a wildcard (D3)', () => {
    it.each([
      ['https on any host', 'https://example.com/callback', true],
      ['https with a port and query', 'https://example.com:8443/cb?state=1', true],
      ['loopback http, IPv4', 'http://127.0.0.1:8976/callback', true],
      ['loopback http, IPv6', 'http://[::1]:33418/callback', true],
      ['loopback http, localhost', 'http://localhost:8976/callback', true],
      ['plain http on a real host', 'http://example.com/callback', false],
      // `127.0.0.1.evil.example` is a real registrable host, not a loopback.
      ['a host that merely starts with a loopback', 'http://127.0.0.1.evil.example/cb', false],
      ['a wildcard in the host', 'https://*.example.com/callback', false],
      ['a wildcard in the path', 'https://example.com/*', false],
      ['a fragment', 'https://example.com/callback#fragment', false],
      ['a custom scheme (deferred, not refused forever)', 'cursor://callback', false],
      ['a javascript scheme', 'javascript:alert(1)', false],
      ['a relative URL', '/callback', false],
    ])('%s → accepted=%s', (_name, uri, accepted) => {
      const result = judge({ ...valid(), redirect_uris: [uri] })
      expect(result.ok).toBe(accepted)
      if (!result.ok) expect(result.error).toBe('invalid_redirect_uri')
    })

    it('refuses an empty list, a non-array, and a list past the cap', () => {
      for (const uris of [[], 'https://a.example', undefined, [1234]]) {
        const body = valid()
        if (uris === undefined) delete body['redirect_uris']
        else body['redirect_uris'] = uris
        const result = judge(body)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error).toBe('invalid_redirect_uri')
      }
      const tooMany = Array.from(
        { length: MAX_REDIRECT_URIS + 1 },
        (_, i) => `https://example.com/cb/${i}`,
      )
      expect(judge({ ...valid(), redirect_uris: tooMany }).ok).toBe(false)
    })

    it('refuses a list where only one entry is bad, naming it', () => {
      const result = judge({
        ...valid(),
        redirect_uris: ['https://good.example/cb', 'http://evil.example/cb'],
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.description).toContain('evil.example')
    })
  })

  describe('grants and response types (D4)', () => {
    it('refuses the device grant — it stays first-party-only', () => {
      const result = judge({
        ...valid(),
        grant_types: ['urn:ietf:params:oauth:grant-type:device_code'],
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('invalid_client_metadata')
    })

    it.each([[['implicit']], [['client_credentials']], [[]]])(
      'refuses grant_types %j',
      (grants) => {
        expect(judge({ ...valid(), grant_types: grants }).ok).toBe(false)
      },
    )

    it('accepts authorization_code alone', () => {
      const result = judge({ ...valid(), grant_types: ['authorization_code'] })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.registration.grantTypes).toEqual(['authorization_code'])
    })

    it('refuses any response type but code', () => {
      expect(judge({ ...valid(), response_types: ['token'] }).ok).toBe(false)
      expect(judge({ ...valid(), response_types: [] }).ok).toBe(false)
    })
  })

  describe('the scope echo (D4)', () => {
    it('intersects with what the server supports, and never invents', () => {
      const result = judge({ ...valid(), scope: 'analytics:read admin:everything openid' })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.registration.scope).toBe('analytics:read openid')
    })

    it('an absent scope means the full supported set', () => {
      const result = judge(valid())
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.registration.scope).toBe(SCOPES.join(' '))
    })
  })

  describe('the client name (D8)', () => {
    it('falls back to the first redirect URI’s host', () => {
      const body = valid()
      delete body['client_name']
      const result = judge(body)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.registration.clientName).toBe('claude.ai')
    })

    it('refuses an empty or over-long name rather than storing it', () => {
      expect(judge({ ...valid(), client_name: '   ' }).ok).toBe(false)
      expect(judge({ ...valid(), client_name: 'x'.repeat(121) }).ok).toBe(false)
    })
  })

  it('keeps exactly the four presentation fields, and only as bounded strings', () => {
    const result = judge({
      ...valid(),
      client_uri: 'https://claude.ai',
      logo_uri: 'https://claude.ai/logo.png',
      software_id: 'claude-desktop',
      software_version: '1.2.3',
      contacts: ['ops@claude.ai'],
      jwks: { keys: [] },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.registration.metadata).toEqual({
      client_uri: 'https://claude.ai',
      logo_uri: 'https://claude.ai/logo.png',
      software_id: 'claude-desktop',
      software_version: '1.2.3',
    })
  })

  it('refuses a body that is not an object at all', () => {
    for (const body of [null, 'a string', 42, ['an', 'array']]) {
      const result = validateClientRegistration(body, SCOPES)
      expect(result.ok).toBe(false)
    }
  })
})
