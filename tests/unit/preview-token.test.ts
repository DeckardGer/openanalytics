import { generateKeyPairSync } from 'node:crypto'
import {
  PREVIEW_TOKEN_SCHEME,
  PREVIEW_TOKEN_TTL_SECONDS,
  signPreviewToken,
  signRealtimeToken,
  verifyPreviewToken,
} from '@openanalytics/auth'
import { describe, expect, it } from 'vitest'

/**
 * The rule-preview token (ADR-0034, D6).
 *
 * It is the one credential that lets a browser be served a site's *unpublished*
 * rules, so the properties worth asserting are the ones that stop it being
 * anything else: it cannot be forged without the private key, it cannot be
 * stretched past its 15 minutes by its issuer, and a token minted for another
 * audience cannot be replayed as one of these.
 */

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

const SITE = '019fbcac-0000-7000-8000-000000000001'
const DEFINITION = '019fbcac-0000-7000-8000-000000000002'
const NOW = new Date('2026-08-01T12:00:00.000Z')

function mint(overrides: Partial<Parameters<typeof signPreviewToken>[0]> = {}) {
  const keys = keyPair()
  const token = signPreviewToken({
    privateKeyPem: keys.privateKeyPem,
    siteId: SITE,
    definitionId: DEFINITION,
    version: 3,
    subject: 'u-owner',
    issuedAt: NOW,
    jti: '019fbcac-0000-7000-8000-00000000000f',
    ...overrides,
  })
  return { token, keys }
}

describe('preview token', () => {
  it('round-trips the claims the collector needs', () => {
    const { token, keys } = mint()
    const result = verifyPreviewToken(token, { verifyKey: keys.publicKeyPem, now: NOW })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.claims).toMatchObject({
      v: 1,
      aud: 'tracker-preview',
      site_id: SITE,
      definition_id: DEFINITION,
      version: 3,
    })
    expect(result.claims.exp - result.claims.iat).toBe(PREVIEW_TOKEN_TTL_SECONDS)
  })

  it('names its scheme first, so an older verifier cannot accept a future one', () => {
    const { token } = mint()
    expect(token.startsWith(`${PREVIEW_TOKEN_SCHEME}.`)).toBe(true)
    expect(token.split('.')).toHaveLength(3)
  })

  it('refuses a token signed by a different key', () => {
    const { token } = mint()
    const other = keyPair()
    expect(verifyPreviewToken(token, { verifyKey: other.publicKeyPem, now: NOW })).toEqual({
      ok: false,
      reason: 'bad_signature',
    })
  })

  it('refuses a tampered payload — the version cannot be edited in flight', () => {
    const { token, keys } = mint()
    const [scheme, payload, signature] = token.split('.') as [string, string, string]
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    claims.version = 99
    const forged = [
      scheme,
      Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url'),
      signature,
    ].join('.')

    expect(verifyPreviewToken(forged, { verifyKey: keys.publicKeyPem, now: NOW })).toEqual({
      ok: false,
      reason: 'bad_signature',
    })
  })

  it('expires, and is not yet valid before its issue time', () => {
    const { token, keys } = mint()
    const after = new Date(NOW.getTime() + (PREVIEW_TOKEN_TTL_SECONDS + 1) * 1000)
    expect(verifyPreviewToken(token, { verifyKey: keys.publicKeyPem, now: after })).toEqual({
      ok: false,
      reason: 'expired',
    })

    const wayBefore = new Date(NOW.getTime() - 120_000)
    expect(verifyPreviewToken(token, { verifyKey: keys.publicKeyPem, now: wayBefore })).toEqual({
      ok: false,
      reason: 'not_yet_valid',
    })
  })

  it('tolerates a little clock skew between the api and the collector', () => {
    const { token, keys } = mint()
    const slightlyBefore = new Date(NOW.getTime() - 20_000)
    expect(
      verifyPreviewToken(token, { verifyKey: keys.publicKeyPem, now: slightlyBefore }).ok,
    ).toBe(true)
  })

  it('refuses a fat lifetime even when the signature is genuine', () => {
    const { token, keys } = mint({ ttlSeconds: PREVIEW_TOKEN_TTL_SECONDS * 10 })
    expect(verifyPreviewToken(token, { verifyKey: keys.publicKeyPem, now: NOW })).toEqual({
      ok: false,
      reason: 'ttl_exceeded',
    })
  })

  it('cannot be substituted by a realtime token, even one signed with the same key', () => {
    const keys = keyPair()
    const realtime = signRealtimeToken({
      privateKeyPem: keys.privateKeyPem,
      siteId: SITE,
      subject: 'u-owner',
      scope: 'private',
      epoch: 0,
      siteEpoch: 0,
      issuedAt: NOW,
      ttlSeconds: 60,
      jti: '019fbcac-0000-7000-8000-00000000000e',
    })

    // The scheme tag differs, so it does not even reach the audience check —
    // which is the point of putting the tag first.
    expect(verifyPreviewToken(realtime, { verifyKey: keys.publicKeyPem, now: NOW })).toEqual({
      ok: false,
      reason: 'malformed',
    })
  })

  it('is total on hostile input: a reason, never a throw', () => {
    const keys = keyPair()
    const verify = (token: unknown) =>
      verifyPreviewToken(token as string, { verifyKey: keys.publicKeyPem, now: NOW })

    for (const bad of ['', 'nonsense', 'a.b', 'a.b.c.d', `${PREVIEW_TOKEN_SCHEME}.!!!.!!!`]) {
      expect(verify(bad).ok).toBe(false)
    }
    expect(verify(undefined).ok).toBe(false)
    expect(verify(42).ok).toBe(false)
    // A well-formed envelope whose signature is the right length but wrong.
    const fake = [
      PREVIEW_TOKEN_SCHEME,
      Buffer.from('{"v":1}', 'utf8').toString('base64url'),
      Buffer.alloc(64).toString('base64url'),
    ].join('.')
    expect(verify(fake)).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('throws only for a misconfigured verify key, which is an operator error', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const { token } = mint()
    expect(() =>
      verifyPreviewToken(token, {
        verifyKey: rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        now: NOW,
      }),
    ).toThrow(/must be ed25519/u)
  })
})
