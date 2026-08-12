import { randomBytes } from 'node:crypto'
import {
  CREDENTIAL_KEY_BYTES,
  CredentialKeyringError,
  createCredentialVault,
  credentialLast4,
  parseCredentialKeyring,
} from '@openanalytics/integrations'
import { describe, expect, it } from 'vitest'

/**
 * The credential keyring (ADR-0033, D3).
 *
 * The repository's first encryption-at-rest primitive, so this suite is the only
 * place its guarantees are stated. Four of them are load-bearing and each has a
 * failure behind it that would otherwise be silent:
 *
 * - a ciphertext is bound to its row through the AAD, so lifting one onto
 *   another credential makes it undecryptable rather than making one site's
 *   provider key work for another;
 * - a tampered ciphertext fails rather than decrypting to something;
 * - **rotation works**: `active` governs new writes only, and every version in
 *   the ring still reads. Getting this backwards would make a key flip lock the
 *   installation out of every credential it had already stored;
 * - a malformed ring is refused at parse time, which is what makes the api's
 *   fail-closed mount possible at all.
 */

const KEY_A = 'A'.repeat(43) + '=' // 32 bytes of 0x00 once decoded is fine too;
const key = (): string => randomBytes(CREDENTIAL_KEY_BYTES).toString('base64')

const ring = (active: string, keys: Record<string, string>): string =>
  JSON.stringify({ active, keys })

const AAD = 'revenue_credential:cred-1:site-1'
const OTHER_AAD = 'revenue_credential:cred-2:site-1'

describe('credential keyring parsing', () => {
  it('accepts a well-formed ring and reports its versions, active first', () => {
    const vault = createCredentialVault(ring('k2', { k1: key(), k2: key() }))
    expect(vault.activeKeyVersion).toBe('k2')
    expect(vault.keyVersions[0]).toBe('k2')
    expect([...vault.keyVersions].sort()).toEqual(['k1', 'k2'])
  })

  it.each([
    ['not JSON at all', 'not-json', 'malformed_json'],
    ['a JSON array', '[]', 'not_an_object'],
    ['a ring with no active version', JSON.stringify({ keys: { k1: KEY_A } }), 'missing_active'],
    ['a ring with no keys object', JSON.stringify({ active: 'k1' }), 'missing_keys'],
    ['a ring with an empty keys object', ring('k1', {}), 'missing_keys'],
  ])('refuses %s', (_label, raw, reason) => {
    // Typed, because the caller logs the reason and mounts nothing. An untyped
    // throw here would surface as a generic startup failure.
    expect(() => parseCredentialKeyring(raw)).toThrowError(
      expect.objectContaining({ name: 'CredentialKeyringError', reason }),
    )
  })

  it('refuses a key that is not exactly 32 bytes', () => {
    // `Buffer.from(x, 'base64')` silently drops what it cannot read, so a
    // truncated secret would become a short key and AES-256 would refuse it far
    // away from the misconfiguration that caused it.
    const short = randomBytes(16).toString('base64')
    expect(() => createCredentialVault(ring('k1', { k1: short }))).toThrowError(
      expect.objectContaining({ reason: 'invalid_key_material' }),
    )
    const long = randomBytes(64).toString('base64')
    expect(() => createCredentialVault(ring('k1', { k1: long }))).toThrowError(
      expect.objectContaining({ reason: 'invalid_key_material' }),
    )
  })

  it('refuses a ring whose active version is not among its keys', () => {
    // Fail-closed rather than falling back to "some key": which one would depend
    // on object key order.
    expect(() => createCredentialVault(ring('k9', { k1: key() }))).toThrowError(
      expect.objectContaining({ reason: 'unknown_active_key' }),
    )
  })

  it('refuses a key version containing the stored format separator', () => {
    // The stored value is `{version}.{nonce}.{payload}`; a version with a dot
    // would make it ambiguous, and the failure would surface as "unknown key
    // version" on a row that was written perfectly well.
    expect(() => createCredentialVault(ring('k.1', { 'k.1': key() }))).toThrowError(
      expect.objectContaining({ reason: 'invalid_key_version' }),
    )
    expect(() => createCredentialVault(ring('k1', { 'k.2': key(), k1: key() }))).toThrowError(
      expect.objectContaining({ reason: 'invalid_key_version' }),
    )
  })

  it('is a CredentialKeyringError, so the api can branch on it and warn', () => {
    let caught: unknown
    try {
      parseCredentialKeyring('{')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CredentialKeyringError)
  })
})

describe('encrypt / decrypt', () => {
  it('round-trips a secret under the active key', () => {
    const vault = createCredentialVault(ring('k1', { k1: key() }))
    const encrypted = vault.encrypt('rk_test_restricted_key', AAD)

    expect(encrypted.keyVersion).toBe('k1')
    // The stored form is exactly the three declared fields.
    expect(encrypted.stored.split('.')).toHaveLength(3)
    expect(encrypted.stored.startsWith('k1.')).toBe(true)
    // The plaintext must not be recoverable by looking at it.
    expect(encrypted.stored).not.toContain('rk_test_restricted_key')

    expect(vault.decrypt(encrypted.stored, AAD)).toEqual({
      ok: true,
      plaintext: 'rk_test_restricted_key',
    })
  })

  it('never produces the same ciphertext twice for the same plaintext', () => {
    // A fresh 96-bit nonce per write. Deterministic ciphertext would leak that
    // two sites pasted the same key.
    const vault = createCredentialVault(ring('k1', { k1: key() }))
    const first = vault.encrypt('same-secret', AAD)
    const second = vault.encrypt('same-secret', AAD)
    expect(first.stored).not.toBe(second.stored)
    expect(vault.decrypt(second.stored, AAD)).toEqual({ ok: true, plaintext: 'same-secret' })
  })

  it('refuses a ciphertext presented under a different AAD', () => {
    // The whole point of the binding: a row's ciphertext copied onto another row
    // is undecryptable, rather than making one credential work as another.
    const vault = createCredentialVault(ring('k1', { k1: key() }))
    const encrypted = vault.encrypt('rk_test_x', AAD)
    expect(vault.decrypt(encrypted.stored, OTHER_AAD)).toEqual({
      ok: false,
      reason: 'authentication_failed',
    })
  })

  it('refuses a tampered ciphertext', () => {
    const vault = createCredentialVault(ring('k1', { k1: key() }))
    const [version, nonce, payload] = vault.encrypt('rk_test_x', AAD).stored.split('.') as [
      string,
      string,
      string,
    ]

    // Flip one base64 character of the body. GCM's tag is what catches it; a
    // cipher without authentication would decrypt this to garbage and the caller
    // would send that garbage to a provider.
    const flipped = payload.startsWith('A') ? `B${payload.slice(1)}` : `A${payload.slice(1)}`
    expect(vault.decrypt(`${version}.${nonce}.${flipped}`, AAD)).toEqual({
      ok: false,
      reason: 'authentication_failed',
    })

    // A replaced nonce is the same class of failure.
    const otherNonce = randomBytes(12).toString('base64')
    expect(vault.decrypt(`${version}.${otherNonce}.${payload}`, AAD)).toEqual({
      ok: false,
      reason: 'authentication_failed',
    })
  })

  it('refuses a key version the ring does not hold, distinctly from tampering', () => {
    // Two different remedies: put the key back, versus investigate. Collapsing
    // them would make an operator chase the wrong one.
    const written = createCredentialVault(ring('k1', { k1: key() })).encrypt('rk_test_x', AAD)
    const other = createCredentialVault(ring('k2', { k2: key() }))
    expect(other.decrypt(written.stored, AAD)).toEqual({
      ok: false,
      reason: 'unknown_key_version',
    })
  })

  it.each([
    ['no separators', 'notacredential'],
    ['two fields only', 'k1.AAAAAAAAAAAAAAAA'],
    ['four fields', 'k1.AAAA.BBBB.CCCC'],
    ['a non-base64 nonce', 'k1.***.QUJDRA=='],
    ['a short nonce', `k1.${Buffer.alloc(4).toString('base64')}.${'A'.repeat(44)}`],
    ['a payload with no room for a tag', `k1.${Buffer.alloc(12).toString('base64')}.QUJD`],
  ])('reports %s as malformed rather than as a failure to authenticate', (_label, stored) => {
    const vault = createCredentialVault(ring('k1', { k1: key() }))
    expect(vault.decrypt(stored, AAD)).toEqual({ ok: false, reason: 'malformed' })
  })
})

describe('rotation', () => {
  it('reads every version in the ring and writes only under the active one', () => {
    // ADR-0033 D3's rotation path, and the property that makes a key flip safe:
    // `active` governs new writes; decrypt accepts anything in `keys`. Backwards,
    // adding k2 would lock the installation out of every credential it already
    // held.
    const k1 = key()
    const k2 = key()

    const before = createCredentialVault(ring('k1', { k1 }))
    const legacy = before.encrypt('old-secret', AAD)
    expect(legacy.keyVersion).toBe('k1')

    const after = createCredentialVault(ring('k2', { k1, k2 }))
    expect(after.activeKeyVersion).toBe('k2')

    // The old row still reads...
    expect(after.decrypt(legacy.stored, AAD)).toEqual({ ok: true, plaintext: 'old-secret' })

    // ...and a new write moves to k2, which is what makes "no row references k1"
    // eventually true and the old key removable.
    const fresh = after.encrypt('new-secret', AAD)
    expect(fresh.keyVersion).toBe('k2')
    expect(fresh.stored.startsWith('k2.')).toBe(true)
    expect(after.decrypt(fresh.stored, AAD)).toEqual({ ok: true, plaintext: 'new-secret' })

    // And the pre-rotation build cannot read the post-rotation row, which is why
    // the rotation runbook adds the key everywhere before flipping `active`.
    expect(before.decrypt(fresh.stored, AAD)).toEqual({
      ok: false,
      reason: 'unknown_key_version',
    })
  })
})

describe('credentialLast4', () => {
  it('shows a tail only when four characters are a tail', () => {
    expect(credentialLast4('rk_test_abcdef1234')).toBe('1234')
    // A short value yields nothing rather than most of itself: a column named
    // `last4` must never become a place a whole credential can be read from.
    expect(credentialLast4('short')).toBe('')
    expect(credentialLast4('')).toBe('')
  })
})
