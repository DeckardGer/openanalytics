/**
 * Log redaction.
 *
 * Docs snapshot 02 §26 and 04 §2: structured logs must never carry credentials,
 * auth tokens, raw email/IP or arbitrary event properties. Redaction is applied
 * centrally rather than trusted to each call site, because the failure mode of a
 * missed call site is a permanent PII leak in log storage.
 */

export const REDACTED = '[redacted]'

/** Key names whose value is dropped regardless of nesting depth. */
const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /pass(word|phrase)/i,
  /secret/i,
  /token/i,
  /^authorization$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /api[-_]?key/i,
  /private[-_]?key/i,
  /signature/i,
  /credential/i,
  /^email$/i,
  /^ip$/i,
  /ip[-_]?address/i,
  /^x-forwarded-for$/i,
  /^x-real-ip$/i,
  /client[-_]?secret/i,
  /webhook[-_]?secret/i,
  /^properties$/i,
  /^raw[-_]?body$/i,
  // Write-only ingest identifier (docs snapshot 01 §3.2). Not a read
  // credential, but a leaked one still forges events; logs carry `site_id`.
  /tracking[-_]?key/i,
]

/**
 * Values that carry a credential regardless of the key they arrive under.
 *
 * Key-name redaction only helps when the secret is a field. It is not, in the
 * case this exists for: a thrown error's `message`/`stack` is a free-form string
 * a driver composed, and `connect ECONNREFUSED redis://user:pass@host:6379`
 * would otherwise reach log storage in full. Scrubbing runs before truncation,
 * so a secret can never be half-cut and half-published.
 */
const SECRET_VALUE_PATTERNS: readonly (readonly [RegExp, string])[] = [
  // URL userinfo — `scheme://user:pass@host`. The host stays: it is the useful
  // half of a connection error. `[^\s/@]+` cannot cross a path separator, so
  // `https://example.com/a@b` is left alone.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${REDACTED}@`],
  // Provider tokens with stable prefixes: Stripe secret keys (`sk_`), Stripe
  // webhook secrets (`whsec_`), Resend API keys (`re_`).
  [/\b(?:sk|whsec|re)_[A-Za-z0-9_-]{8,}/gi, REDACTED],
  // `Authorization: Bearer …` echoed into an error or a request dump.
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`],
  // Key-bearing query parameters in URL-shaped text — `?key=`, `&tracking_key=`,
  // `&api_key=`. The tracker config GET carries the write-only tracking key this
  // way (ADR-0008 addendum), and a logged request path must not republish it.
  [/([?&](?:[a-z0-9-]+[_-])?key=)[^&\s"']+/gi, `$1${REDACTED}`],
  // Any JWT-shaped triple; the payload segment is base64, not encryption.
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+/g, REDACTED],
]

/** Replaces credential-shaped substrings in free-form text. */
export function scrubSecrets(value: string): string {
  let out = value
  for (const [pattern, replacement] of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, replacement)
  }
  return out
}

/** Nesting depth beyond which values are collapsed instead of walked. */
const MAX_DEPTH = 6
/** Per-string cap; long strings in logs are almost always accidental payloads. */
const MAX_STRING_LENGTH = 512
/** Array element cap. */
const MAX_ARRAY_LENGTH = 50

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key))
}

function truncate(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) return value
  return `${value.slice(0, MAX_STRING_LENGTH)}…[${value.length - MAX_STRING_LENGTH} more chars]`
}

/** Scrub first, then truncate: a cut secret is still a leaked prefix. */
function safeString(value: string): string {
  return truncate(scrubSecrets(value))
}

/**
 * Returns a structurally similar value with sensitive keys removed, deep
 * structures collapsed and long strings truncated. Never throws: a logger that
 * throws while formatting turns an observable error into an invisible one.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value

  const type = typeof value
  if (type === 'string') return safeString(value as string)
  if (type === 'number' || type === 'boolean' || type === 'bigint') return value
  if (type === 'function' || type === 'symbol') return `[${type}]`

  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) {
    return {
      name: value.name,
      message: safeString(value.message),
      stack: value.stack ? safeString(value.stack) : undefined,
    }
  }

  if (depth >= MAX_DEPTH) return '[max depth]'

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_LENGTH).map((item) => redact(item, depth + 1))
    if (value.length > MAX_ARRAY_LENGTH) {
      items.push(`[${value.length - MAX_ARRAY_LENGTH} more items]`)
    }
    return items
  }

  if (type === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redact(entry, depth + 1)
    }
    return out
  }

  return `[${type}]`
}
