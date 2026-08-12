import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * The versioned credential keyring (ADR-0033, D3).
 *
 * The first encryption-at-rest primitive in the repository. Every other
 * `node:crypto` use here is hashing, HMAC, Ed25519 or CSPRNG; nothing symmetric
 * existed, so this is built rather than reused, and snapshot 02 §25 requires the
 * key to be its own secret rather than a derivation of an auth secret.
 *
 * It lives in `packages/integrations` because it needs node's crypto module and
 * `packages/domain` stays pure. It is deliberately **not** revenue-specific: the
 * AAD is a caller-supplied string, so M14's WordPress credentials and any future
 * import provider with an API key bind their own row identity through the same
 * primitive.
 *
 * Three properties, each of which is a decision:
 *
 * - **Versioned.** The stored value carries the key version that produced it, so
 *   rotation is "add `k2`, flip `active`" — new writes use the new key while
 *   every old row still decrypts. A key version becomes removable once no row
 *   references it, which is answerable with a `SELECT` because the version is a
 *   plaintext column beside the ciphertext.
 * - **AAD-bound.** The additional authenticated data ties a ciphertext to the
 *   row it belongs to (`revenue_credential:{credential_id}:{site_id}`). Copying
 *   a ciphertext onto another row makes it undecryptable rather than making one
 *   site's credential work for another.
 * - **Fail-typed, never thrown-through.** `decrypt` returns an outcome. A
 *   tampered or truncated ciphertext is an adversarial input, not an exception:
 *   the caller has to decide what to do about it (flip the credential
 *   `degraded`, alert), and a thrown error would reach the HTTP error middleware
 *   as an anonymous `500`.
 */

export const CREDENTIAL_KEY_BYTES = 32
/** 96 bits — the nonce size AES-GCM is specified and fastest for. */
export const CREDENTIAL_NONCE_BYTES = 12
export const CREDENTIAL_TAG_BYTES = 16

/**
 * The shape a key version may take.
 *
 * No dot, because the stored value is dot-separated and the version is its first
 * field. A version containing a separator would make the stored format
 * ambiguous, and the failure would surface as "unknown key version" on a row
 * that was written perfectly well.
 */
const KEY_VERSION_PATTERN = /^[A-Za-z0-9_-]{1,32}$/u
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u

export type CredentialKeyringFailure =
  | 'malformed_json'
  | 'not_an_object'
  | 'missing_active'
  | 'missing_keys'
  | 'invalid_key_version'
  | 'invalid_key_material'
  | 'unknown_active_key'

export class CredentialKeyringError extends Error {
  readonly reason: CredentialKeyringFailure

  constructor(reason: CredentialKeyringFailure, message: string) {
    super(message)
    this.name = 'CredentialKeyringError'
    this.reason = reason
  }
}

export type CredentialDecryptFailure =
  /** Not three dot-separated fields, or a field that is not valid base64 of the
   * right length. A value this shape never came out of `encrypt`. */
  | 'malformed'
  /** The version is well-formed and is not in this build's ring — the operator
   * removed a key that rows still reference. Recoverable by putting it back. */
  | 'unknown_key_version'
  /** GCM rejected the tag: the ciphertext, the nonce or the AAD is not what was
   * written. Not recoverable, and the only one of the three that means somebody
   * changed something. */
  | 'authentication_failed'

export type CredentialDecryptOutcome =
  | { readonly ok: true; readonly plaintext: string }
  | { readonly ok: false; readonly reason: CredentialDecryptFailure }

export interface EncryptedCredential {
  /** `{key_version}.{base64(nonce)}.{base64(ciphertext||tag)}` */
  readonly stored: string
  /** The version that produced it, recorded on the row beside the ciphertext so
   * a rotation sweep can find every row still on an old key. */
  readonly keyVersion: string
}

export interface CredentialVault {
  /** The version new writes use. Reads accept every version in the ring. */
  readonly activeKeyVersion: string
  /** Every version this build can decrypt, active first. */
  readonly keyVersions: readonly string[]
  encrypt(plaintext: string, aad: string): EncryptedCredential
  decrypt(stored: string, aad: string): CredentialDecryptOutcome
}

function decodeKey(version: string, encoded: unknown): Buffer {
  if (typeof encoded !== 'string' || encoded.length === 0 || !BASE64_PATTERN.test(encoded)) {
    throw new CredentialKeyringError(
      'invalid_key_material',
      `key "${version}" is not base64-encoded material`,
    )
  }
  const key = Buffer.from(encoded, 'base64')
  if (key.byteLength !== CREDENTIAL_KEY_BYTES) {
    // Length is checked rather than trusted: `Buffer.from(x, 'base64')` silently
    // drops characters it cannot read, so a truncated secret would otherwise
    // become a short key and AES-256 would refuse it far away from here.
    throw new CredentialKeyringError(
      'invalid_key_material',
      `key "${version}" must decode to exactly ${String(CREDENTIAL_KEY_BYTES)} bytes`,
    )
  }
  return key
}

interface ParsedKeyring {
  readonly active: string
  readonly keys: ReadonlyMap<string, Buffer>
}

/**
 * Parse `OA_CREDENTIAL_KEYRING`.
 *
 * Every failure is typed and none of them names key material: the messages are
 * read by an operator from a startup log, and a log line is the last place a
 * secret should be able to reach (AGENTS.md).
 */
export function parseCredentialKeyring(raw: string): ParsedKeyring {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new CredentialKeyringError('malformed_json', 'the keyring is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CredentialKeyringError('not_an_object', 'the keyring must be a JSON object')
  }

  const record = parsed as Record<string, unknown>
  const active = record['active']
  if (typeof active !== 'string' || active.length === 0) {
    throw new CredentialKeyringError('missing_active', 'the keyring has no "active" key version')
  }
  if (!KEY_VERSION_PATTERN.test(active)) {
    throw new CredentialKeyringError(
      'invalid_key_version',
      'a key version must match [A-Za-z0-9_-]{1,32}',
    )
  }

  const rawKeys = record['keys']
  if (typeof rawKeys !== 'object' || rawKeys === null || Array.isArray(rawKeys)) {
    throw new CredentialKeyringError('missing_keys', 'the keyring has no "keys" object')
  }

  const keys = new Map<string, Buffer>()
  for (const [version, encoded] of Object.entries(rawKeys as Record<string, unknown>)) {
    if (!KEY_VERSION_PATTERN.test(version)) {
      throw new CredentialKeyringError(
        'invalid_key_version',
        'a key version must match [A-Za-z0-9_-]{1,32}',
      )
    }
    keys.set(version, decodeKey(version, encoded))
  }

  if (keys.size === 0) {
    throw new CredentialKeyringError('missing_keys', 'the keyring holds no keys')
  }
  if (!keys.has(active)) {
    // Fail-closed rather than falling back to "some key": a ring whose active
    // version is absent would encrypt under an arbitrary key, and which one
    // would depend on object key order.
    throw new CredentialKeyringError(
      'unknown_active_key',
      'the active key version is not present in "keys"',
    )
  }

  return { active, keys }
}

/**
 * Build a vault from the raw `OA_CREDENTIAL_KEYRING` value.
 *
 * Throws `CredentialKeyringError` on a malformed ring — the caller's contract is
 * the billing precedent (ADR-0033 D3): no usable secret, no surface, one warn
 * log, rather than a service that boots and answers failures.
 */
export function createCredentialVault(raw: string): CredentialVault {
  const { active, keys } = parseCredentialKeyring(raw)
  const activeKey = keys.get(active) as Buffer

  const versions = [active, ...[...keys.keys()].filter((version) => version !== active)]

  return {
    activeKeyVersion: active,
    keyVersions: versions,

    encrypt(plaintext, aad) {
      const nonce = randomBytes(CREDENTIAL_NONCE_BYTES)
      const cipher = createCipheriv('aes-256-gcm', activeKey, nonce)
      cipher.setAAD(Buffer.from(aad, 'utf8'))
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      // Tag appended to the ciphertext rather than given a fourth field: the two
      // are always written and read together, and one fewer field is one fewer
      // way for a stored value to be half-valid.
      const payload = Buffer.concat([body, cipher.getAuthTag()])
      return {
        stored: `${active}.${nonce.toString('base64')}.${payload.toString('base64')}`,
        keyVersion: active,
      }
    },

    decrypt(stored, aad) {
      const parts = stored.split('.')
      if (parts.length !== 3) return { ok: false, reason: 'malformed' }
      const [version, encodedNonce, encodedPayload] = parts as [string, string, string]

      if (!KEY_VERSION_PATTERN.test(version)) return { ok: false, reason: 'malformed' }
      if (!BASE64_PATTERN.test(encodedNonce) || !BASE64_PATTERN.test(encodedPayload)) {
        return { ok: false, reason: 'malformed' }
      }

      const nonce = Buffer.from(encodedNonce, 'base64')
      const payload = Buffer.from(encodedPayload, 'base64')
      if (nonce.byteLength !== CREDENTIAL_NONCE_BYTES) return { ok: false, reason: 'malformed' }
      if (payload.byteLength <= CREDENTIAL_TAG_BYTES) return { ok: false, reason: 'malformed' }

      // Checked after the shape, so an operator reading the reason learns "the
      // value is fine, this build cannot read it" rather than "the value is
      // broken" — two different remedies.
      const key = keys.get(version)
      if (!key) return { ok: false, reason: 'unknown_key_version' }

      const body = payload.subarray(0, payload.byteLength - CREDENTIAL_TAG_BYTES)
      const tag = payload.subarray(payload.byteLength - CREDENTIAL_TAG_BYTES)

      try {
        const decipher = createDecipheriv('aes-256-gcm', key, nonce)
        decipher.setAAD(Buffer.from(aad, 'utf8'))
        decipher.setAuthTag(tag)
        const plaintext = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
        return { ok: true, plaintext }
      } catch {
        // A wrong AAD, a flipped ciphertext bit and a wrong key are one answer
        // here on purpose: GCM cannot tell them apart, and inventing a
        // distinction would be a guess in an audit trail.
        return { ok: false, reason: 'authentication_failed' }
      }
    },
  }
}

/**
 * The display tail of a secret, for the read surface that never returns it.
 *
 * Four characters, and only when the secret is long enough that four characters
 * are a tail rather than most of it. A short value yields `''`, which reads as
 * "nothing to show" instead of leaking a whole credential into a column named
 * `last4`.
 */
export function credentialLast4(secret: string): string {
  return secret.length > 8 ? secret.slice(-4) : ''
}
