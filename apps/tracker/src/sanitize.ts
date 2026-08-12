import { LIMITS } from './constants.ts'

/**
 * Client-side sanitization.
 *
 * Docs snapshot 02 §11: the tracker must not send the raw URL — the fragment
 * and sensitive query keys are removed before the value leaves the browser. The
 * server applies the same rules again (`@openanalytics/domain`), because the
 * rule that actually holds is the server's; this side exists so the data is
 * never transmitted at all.
 *
 * Kept small and allocation-light: this runs on every pageview of a customer's
 * site.
 */

export const REDACTED = '[redacted]'

/**
 * Query keys stripped by default. Shorter than the server's list on purpose:
 * this is the fast local pass, the authoritative catalogue lives in the domain
 * package, and per-site keys arrive through tracker config.
 */
export const DEFAULT_REDACT_QUERY_KEYS: readonly string[] = [
  'access_token',
  'api_key',
  'apikey',
  'auth',
  'code',
  'email',
  'id_token',
  'invite',
  'jwt',
  'key',
  'otp',
  'password',
  'phone',
  'pwd',
  'reset',
  'secret',
  'session',
  'sid',
  'signature',
  'state',
  'token',
]

const SENSITIVE_KEY_PATTERN = /(pass(word|wd)?|secret|token|auth|session|email|phone|credential)/i
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]{2,}/g
const DIGIT_RUN_PATTERN = /\d[\d\s().+-]{6,}\d/g

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max)
}

/** Redact values that look like an email address, a phone/card number or a token. */
export function redactText(value: string): string {
  return value
    .replace(EMAIL_PATTERN, REDACTED)
    .replace(DIGIT_RUN_PATTERN, (match) =>
      match.replace(/\D/g, '').length >= 9 ? REDACTED : match,
    )
}

const REGEX_ESCAPE_PATTERN = /[.*+?^${}()|[\]\\]/g

/**
 * Redact the VALUE of any sensitive query key appearing as `key=value` inside
 * free text. Clicked-element text and selectors can quote a URL — a link whose
 * visible text is its own href, an author id carrying `?token=` — and the
 * site's configured `redact_query_keys` must hold there too, not only on
 * `page.url` (G-008, ADR-0057 D7).
 */
export function redactQueryKeyValues(value: string, extraKeys: readonly string[] = []): string {
  if (value.indexOf('=') === -1) return value

  const keys = DEFAULT_REDACT_QUERY_KEYS.concat(
    extraKeys.map((key) => key.toLowerCase()).filter((key) => key !== ''),
  )
  const escaped = keys.map((key) => key.replace(REGEX_ESCAPE_PATTERN, '\\$&'))
  const pattern = new RegExp(`\\b(${escaped.join('|')})=[^&#\\s]*`, 'gi')
  return value.replace(pattern, `$1=${REDACTED}`)
}

function isRedactedKey(key: string, extra: readonly string[]): boolean {
  const normalized = key.toLowerCase()
  if (DEFAULT_REDACT_QUERY_KEYS.indexOf(normalized) !== -1) return true
  if (extra.indexOf(normalized) !== -1) return true
  return SENSITIVE_KEY_PATTERN.test(normalized)
}

/**
 * Strip the fragment, any embedded credentials and sensitive query keys.
 *
 * The fragment goes unconditionally: it is client state, no analytics report
 * reads it, and password-reset and magic-link flows routinely put a token there.
 */
export function sanitizeUrl(rawUrl: string, redactQueryKeys: readonly string[] = []): string {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return ''
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''

  parsed.hash = ''
  parsed.username = ''
  parsed.password = ''

  const kept = new URLSearchParams()
  parsed.searchParams.forEach((value, key) => {
    if (isRedactedKey(key, redactQueryKeys)) return
    kept.append(key, truncate(redactText(value), LIMITS.propertyValueMaxLength))
  })

  const search = kept.toString()
  parsed.search = search === '' ? '' : `?${search}`

  return truncate(parsed.toString(), LIMITS.urlMaxLength)
}

/** The document referrer, sanitized the same way; empty when absent or internal-only. */
export function sanitizeReferrer(
  referrer: string,
  redactQueryKeys: readonly string[] = [],
): string {
  if (referrer === '') return ''
  return truncate(sanitizeUrl(referrer, redactQueryKeys), LIMITS.referrerMaxLength)
}

export type PropertyValue = string | number | boolean | null

/**
 * Enforce the contract's property rules locally: scalar values only, reserved
 * prefix rejected, keys and values bounded, PII-shaped values redacted. A value
 * the server would reject is dropped here so one bad property cannot fail a
 * whole batch.
 */
export function sanitizeProperties(
  properties: Readonly<Record<string, unknown>> | undefined,
  redactQueryKeys: readonly string[] = [],
): Record<string, PropertyValue> | undefined {
  if (!properties) return undefined

  const out: Record<string, PropertyValue> = {}
  let count = 0

  for (const key of Object.keys(properties)) {
    if (count >= LIMITS.maxPropertiesPerEvent) break
    if (key.length === 0 || key.length > LIMITS.propertyKeyMaxLength) continue
    if (key.toLowerCase().indexOf('oa_') === 0) continue
    if (!/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(key)) continue
    if (isRedactedKey(key, redactQueryKeys)) continue

    const value = properties[key]

    if (typeof value === 'string') {
      out[key] = truncate(redactText(value), LIMITS.propertyValueMaxLength)
      count += 1
    } else if (typeof value === 'boolean' || value === null) {
      out[key] = value
      count += 1
    } else if (typeof value === 'number' && isFinite(value)) {
      out[key] = value
      count += 1
    }
    // Objects, arrays and non-finite numbers have no analytics column; they are
    // dropped rather than stringified into something the server cannot type.
  }

  return count === 0 ? undefined : out
}

/** Event names must match the contract's pattern; an invalid name is not sent. */
export function isValidEventName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= LIMITS.eventNameMaxLength &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(name)
  )
}
