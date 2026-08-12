import { createPrivateKey, generateKeyPairSync, randomUUID, sign as edSign } from 'node:crypto'
import {
  REALTIME_TOKEN_IAT_SKEW_SECONDS,
  REALTIME_TOKEN_SCHEME,
  signRealtimeToken,
  verifyRealtimeToken,
  type SignRealtimeTokenInput,
} from '@openanalytics/auth'
import { describe, expect, it } from 'vitest'

/**
 * The realtime token codec (docs snapshot 05, D-213).
 *
 * Every rejection here is a security boundary: a token that verified when it
 * should not would keep a removed member connected, let a fatter-than-allowed
 * lifetime outlive the epoch bump that revoked it, or admit a forged credential
 * the gateway exists to reject. The verifier returns a typed reason and never
 * throws, so each case asserts the exact reason.
 */

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const VERIFY_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const SIGNING_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

// A second, unrelated key, to prove a valid signature from the wrong signer is
// rejected as `bad_signature` rather than accepted.
const OTHER_SIGNING_KEY = generateKeyPairSync('ed25519')
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString()

const NOW = new Date('2026-07-24T12:00:00.000Z')
const MAX_TTL = 60

const sign = (overrides: Partial<SignRealtimeTokenInput> = {}): string =>
  signRealtimeToken({
    privateKeyPem: SIGNING_KEY,
    siteId: 'site_1',
    subject: 'user_1',
    scope: 'private',
    epoch: 3,
    siteEpoch: 0,
    issuedAt: NOW,
    ttlSeconds: 60,
    jti: randomUUID(),
    ...overrides,
  })

const verify = (token: string, now: Date = NOW) =>
  verifyRealtimeToken(token, { verifyKey: VERIFY_KEY, now, maxTtlSeconds: MAX_TTL })

describe('realtime token roundtrip', () => {
  it('signs and verifies, returning the claims for the gateway to compare', () => {
    const jti = randomUUID()
    const result = verify(sign({ jti, epoch: 7, subject: 'user_9', scope: 'private' }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.claims).toMatchObject({
      v: 1,
      aud: 'realtime',
      site_id: 'site_1',
      subject: 'user_9',
      scope: 'private',
      epoch: 7,
      jti,
    })
    // exp is exactly ttl seconds past iat.
    expect(result.claims.exp - result.claims.iat).toBe(60)
  })

  it('round-trips site_epoch beside the subject epoch (ADR-0030 D5)', () => {
    const result = verify(sign({ epoch: 7, siteEpoch: 4 }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Two independent anchors on one token: the subject's and the site's.
    expect(result.claims.epoch).toBe(7)
    expect(result.claims.site_epoch).toBe(4)
  })

  it('reads a legacy token with no site_epoch claim as 0, not as malformed', () => {
    // A token minted before the claim existed is still in flight for up to its
    // 60-second lifetime across a deploy. Rejecting it would log a signature
    // failure for a correctly signed credential; reading the missing claim as 0
    // means the first site-level bump cuts it, which is the safe direction.
    const iat = Math.floor(NOW.getTime() / 1000)
    const claims = {
      v: 1,
      aud: 'realtime',
      site_id: 'site_1',
      subject: 'user_1',
      scope: 'private',
      epoch: 3,
      iat,
      exp: iat + 60,
      jti: randomUUID(),
    }
    const bytes = Buffer.from(JSON.stringify(claims), 'utf8')
    const signature = edSign(null, bytes, createPrivateKey(SIGNING_KEY))
    const token = [
      REALTIME_TOKEN_SCHEME,
      bytes.toString('base64url'),
      signature.toString('base64url'),
    ].join('.')

    const result = verify(token)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.claims.site_epoch).toBe(0)
  })

  it('rejects a token whose site_epoch is not a non-negative integer', () => {
    const iat = Math.floor(NOW.getTime() / 1000)
    const claims = {
      v: 1,
      aud: 'realtime',
      site_id: 'site_1',
      subject: 'user_1',
      scope: 'private',
      epoch: 3,
      site_epoch: -1,
      iat,
      exp: iat + 60,
      jti: randomUUID(),
    }
    const bytes = Buffer.from(JSON.stringify(claims), 'utf8')
    const signature = edSign(null, bytes, createPrivateKey(SIGNING_KEY))
    const token = [
      REALTIME_TOKEN_SCHEME,
      bytes.toString('base64url'),
      signature.toString('base64url'),
    ].join('.')

    const result = verify(token)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('malformed')
  })

  it('carries the scheme tag as the first token', () => {
    expect(sign().startsWith(`${REALTIME_TOKEN_SCHEME}.`)).toBe(true)
    expect(sign().split('.')).toHaveLength(3)
  })

  it('accepts a public-scope token with the literal public subject', () => {
    const result = verify(sign({ subject: 'public', scope: 'public' }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.claims.scope).toBe('public')
  })
})

describe('realtime token rejection reasons', () => {
  it('rejects a structurally malformed token', () => {
    expect(verify('not-a-token')).toEqual({ ok: false, reason: 'malformed' })
    expect(verify('')).toEqual({ ok: false, reason: 'malformed' })
    expect(verify('OA1-RT1.only-two')).toEqual({ ok: false, reason: 'malformed' })
    // Wrong scheme tag, right shape.
    expect(verify('OA9-XX9.aaaa.bbbb')).toEqual({ ok: false, reason: 'malformed' })
  })

  it('rejects a token signed by the wrong key', () => {
    const forged = sign({ privateKeyPem: OTHER_SIGNING_KEY })
    expect(verify(forged)).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('rejects a tampered payload (flip a byte in the claims)', () => {
    const token = sign()
    const [scheme, payload, signature] = token.split('.') as [string, string, string]
    // Decode, change the site, re-encode without re-signing: valid JSON, wrong
    // signature. This is exactly the attack the signature exists to stop.
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    claims.site_id = 'site_evil'
    const tamperedPayload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
    const tampered = [scheme, tamperedPayload, signature].join('.')

    expect(verify(tampered)).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('rejects a tampered signature (flip a byte in the sig)', () => {
    const token = sign()
    const [scheme, payload, signature] = token.split('.') as [string, string, string]
    const sigBytes = Buffer.from(signature, 'base64url')
    sigBytes[0] = sigBytes[0]! ^ 0xff
    const tampered = [scheme, payload, sigBytes.toString('base64url')].join('.')

    expect(verify(tampered)).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('rejects an expired token', () => {
    const token = sign({ ttlSeconds: 30 })
    // 31 seconds later the 30s token is past exp.
    const later = new Date(NOW.getTime() + 31_000)
    expect(verify(token, later)).toEqual({ ok: false, reason: 'expired' })
  })

  it('rejects a token issued too far in the future', () => {
    const future = new Date(NOW.getTime() + (REALTIME_TOKEN_IAT_SKEW_SECONDS + 5) * 1000)
    const token = sign({ issuedAt: future })
    expect(verify(token)).toEqual({ ok: false, reason: 'not_yet_valid' })
  })

  it('tolerates issued-at inside the skew window', () => {
    const slightlyAhead = new Date(NOW.getTime() + (REALTIME_TOKEN_IAT_SKEW_SECONDS - 5) * 1000)
    expect(verify(sign({ issuedAt: slightlyAhead })).ok).toBe(true)
  })

  it('rejects a token whose lifetime exceeds the 60-second ceiling', () => {
    // Correctly signed, but a fatter lifetime than the ceiling allows. D-213: the
    // ceiling is what keeps a revoked member from outliving the epoch bump, so a
    // longer-lived token is invalid even though its signature is genuine.
    const token = sign({ ttlSeconds: 61 })
    expect(verify(token)).toEqual({ ok: false, reason: 'ttl_exceeded' })
    // Exactly at the ceiling is allowed.
    expect(verify(sign({ ttlSeconds: 60 })).ok).toBe(true)
  })

  it('rejects a token whose audience is not realtime', () => {
    // A token with a non-realtime aud cannot be forged through the signer (it
    // hardcodes aud), so this is proven by hand-building a signed payload with a
    // different aud and confirming the verifier refuses it.
    const claims = {
      v: 1,
      aud: 'analytics',
      site_id: 'site_1',
      subject: 'user_1',
      scope: 'private',
      epoch: 1,
      iat: Math.floor(NOW.getTime() / 1000),
      exp: Math.floor(NOW.getTime() / 1000) + 60,
      jti: randomUUID(),
    }
    const bytes = Buffer.from(JSON.stringify(claims), 'utf8')
    const sig = edSign(null, bytes, createPrivateKey(SIGNING_KEY))
    const token = ['OA1-RT1', bytes.toString('base64url'), sig.toString('base64url')].join('.')

    expect(verify(token)).toEqual({ ok: false, reason: 'wrong_audience' })
  })
})
