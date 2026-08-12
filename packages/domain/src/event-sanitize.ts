import { EVENT_LIMITS, type EventProperties } from '@openanalytics/contracts'

/**
 * URL, property and text sanitization for stored analytics data.
 *
 * Docs snapshot 02 §11 and §25: the tracker must not send a raw URL, and the
 * server must not trust that it did not. Fragments and sensitive query keys are
 * removed on both sides — the browser rule is a courtesy to the visitor, the
 * server rule is the one that holds.
 *
 * This is deliberately separate from `@openanalytics/observability`'s log
 * scrubbing. That one protects log storage from credentials; this one decides
 * what is allowed to become durable analytics data, and its default is stricter:
 * a value that merely *looks* like an email, a phone number or a token is
 * redacted even under a harmless key.
 *
 * What counts as sensitive is a default here, not a final privacy policy — G-008
 * closes the privacy defaults before launch, and the per-site
 * `redact_query_keys` from tracker config extends this list at runtime.
 */

/** Query keys whose value never becomes analytics data. */
export const DEFAULT_REDACTED_QUERY_KEYS: readonly string[] = [
  'access_token',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'card',
  'code',
  'confirm',
  'confirmation',
  'credential',
  'cvv',
  'e_mail',
  'email',
  'iban',
  'id_token',
  'invite',
  'invitation',
  'jwt',
  'key',
  'mail',
  'otp',
  'passwd',
  'password',
  'phone',
  'pwd',
  'refresh_token',
  'reset',
  'reset_token',
  'secret',
  'session',
  'sessionid',
  'sid',
  'sig',
  'signature',
  'ssn',
  'state',
  'tel',
  'token',
  'unsubscribe',
]

/** Attribution parameters the server reads; never dropped by the default rule. */
export const ATTRIBUTION_QUERY_KEYS: readonly string[] = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'gclid',
  'fbclid',
  'msclkid',
  'ref',
]

export const PII_REDACTED = '[redacted]'

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]{2,}/g

/**
 * Phone numbers, card numbers and national ids: a run of at least nine actual
 * digits, allowing the usual separators. The digits are counted rather than
 * matched by length, so `2026-07-20` — eight digits and a date — survives.
 */
const DIGIT_RUN_CANDIDATE = /\d[\d\s().+-]{6,}\d/g

function redactDigitRuns(value: string): string {
  return value.replace(DIGIT_RUN_CANDIDATE, (match) =>
    match.replace(/\D/g, '').length >= 9 ? PII_REDACTED : match,
  )
}
/**
 * Values that are a known secret by SHAPE, not by length.
 *
 * These are the rules that survive every exemption below, because they identify
 * a credential rather than merely something long. `rk_` is Stripe's restricted
 * key -- the exact secret M12 asks a customer to paste into the connect form,
 * and therefore the exact one somebody will eventually paste into the wrong box.
 * `Bearer ...` is here because it is the one credential shape that carries a
 * space, which makes it invisible to the opaque-token rule below.
 */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk|whsec|re|ghp|xox[baprs])_[A-Za-z0-9_-]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
]

/** A long, mixed-alphabet run with no spaces — the shape of an opaque token. */
function looksLikeOpaqueToken(value: string): boolean {
  if (value.length < 24 || /\s/.test(value)) return false
  const hasDigit = /\d/.test(value)
  const hasAlpha = /[A-Za-z]/.test(value)
  return hasDigit && hasAlpha && /^[A-Za-z0-9._~+/=-]+$/.test(value)
}

/**
 * The property keys whose whole purpose is to carry an opaque provider id, and
 * which are therefore exempt from the GENERIC opaque-token rule above.
 *
 * One key, and it is not a convenience. `order_id` is the documented property of
 * the `conversion` event (event catalog, "Revenue matching"; ADR-0033 D6 signal
 * 1): the customer fires `oa.conversion('purchase', { order_id })` on their
 * success page with a Stripe Checkout Session, PaymentIntent or charge id, and
 * the attribution matcher joins that value against the revenue fact. **Every
 * real Stripe id trips `looksLikeOpaqueToken`** -- `pi_...` is 27 characters,
 * `ch_...` 27, `cs_test_...` 38, all mixed alphanumerics with no spaces -- so
 * the generic rule stored `[redacted]` and the documented recipe could never
 * match anything. It was found in production rather than in CI, because every
 * fixture used a short synthetic id, which is exactly the length the rule
 * ignores.
 *
 * The exemption is as narrow as it can be made:
 *
 * - **one key**, matched case-insensitively, with nothing inferred from a
 *   substring -- `internal_order_id` is not exempt, because the convention this
 *   serves names one property and a fuzzy match would quietly widen it;
 * - **the explicit rules still run.** A value that is a known secret by shape
 *   (`sk_`/`rk_`/`whsec_`/a JWT/a `Bearer` header), an email address, or a long
 *   digit run is redacted under this key exactly as under any other. What is
 *   lifted is only "this is long and mixed-case, so it might be a token";
 * - **bounded length.** Above `OPAQUE_ID_MAX_LENGTH` the generic rule applies
 *   again. A provider id is tens of characters, and a thousand-character value
 *   under this key is not an order id -- the exemption must not be a hole
 *   somebody can post a document through.
 *
 * It also re-aligns the two halves of the pipeline: the tracker's own
 * client-side `redactText` has never had an opaque-token rule, so until now the
 * browser sent the real id and the collector destroyed it on arrival.
 */
const OPAQUE_ID_PROPERTY_KEYS: readonly string[] = ['order_id']

/** The longest value the `order_id` exemption covers. */
export const OPAQUE_ID_MAX_LENGTH = 128

/** Whether this property key carries an opaque provider id by convention. */
export function isOpaqueIdPropertyKey(key: string): boolean {
  return OPAQUE_ID_PROPERTY_KEYS.includes(key.trim().toLowerCase())
}

export interface RedactOptions {
  /**
   * Skip the generic opaque-token rule, keeping every explicit rule.
   *
   * Two callers, both structural rather than a free choice: `sanitizeProperties`
   * for a key in `OPAQUE_ID_PROPERTY_KEYS` (the exemption is a property of the
   * KEY, and a flag that travelled with the value alone would let any caller
   * switch the rule off), and `sanitizeInteraction` for a CSS selector — whose
   * dot-joined utility-class chains (`div.px-4.py-2.text-sm`) are exactly the
   * long, spaceless, mixed-alphabet shape the generic rule matches.
   */
  readonly allowOpaqueId?: boolean
}

/**
 * Redact PII- and credential-shaped substrings from a value that is about to be
 * stored. Conservative by design: a false positive costs one blurred dimension
 * value, a false negative is a permanent privacy incident.
 */
export function redactSensitiveText(value: string, options: RedactOptions = {}): string {
  if (options.allowOpaqueId !== true && looksLikeOpaqueToken(value)) return PII_REDACTED

  let out = value.replace(EMAIL_PATTERN, PII_REDACTED)
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, PII_REDACTED)
  return redactDigitRuns(out)
}

export function containsSensitiveText(value: string): boolean {
  return redactSensitiveText(value) !== value
}

function isRedactedQueryKey(key: string, extra: readonly string[]): boolean {
  const normalized = key.trim().toLowerCase()
  if (ATTRIBUTION_QUERY_KEYS.includes(normalized)) return false
  if (DEFAULT_REDACTED_QUERY_KEYS.includes(normalized)) return true
  if (extra.some((entry) => entry.trim().toLowerCase() === normalized)) return true
  // Compound names like `user_email`, `auth-token`, `csrfToken`.
  return /(pass(word|wd)?|secret|token|auth|session|email|phone|credential|signature)/i.test(
    normalized,
  )
}

export interface SanitizedUrl {
  /** The URL as it may be stored: no fragment, no credentials, filtered query. */
  readonly url: string
  readonly host: string
  readonly path: string
  readonly query: Readonly<Record<string, string>>
  /** Query keys removed, for a degradation counter — never their values. */
  readonly droppedQueryKeys: readonly string[]
}

/**
 * Sanitize a page URL.
 *
 * Removes the fragment outright (it is client state and routinely carries reset
 * tokens), removes any userinfo, drops sensitive query keys and redacts values
 * that look like PII even under an innocuous key. Returns `null` for anything
 * that is not a parseable http(s) URL — an unparseable URL is a validation
 * failure, not a value to store as-is.
 */
export function sanitizeUrl(
  rawUrl: string,
  options: { redactQueryKeys?: readonly string[] } = {},
): SanitizedUrl | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null

  parsed.hash = ''
  parsed.username = ''
  parsed.password = ''

  const extra = options.redactQueryKeys ?? []
  const droppedQueryKeys: string[] = []
  const query: Record<string, string> = {}

  const kept = new URLSearchParams()
  for (const [key, value] of [...parsed.searchParams.entries()]) {
    if (isRedactedQueryKey(key, extra)) {
      droppedQueryKeys.push(key)
      continue
    }
    const redacted = redactSensitiveText(value).slice(0, EVENT_LIMITS.propertyValueMaxLength)
    kept.append(key, redacted)
    query[key] = redacted
  }

  parsed.search = kept.toString() === '' ? '' : `?${kept.toString()}`

  return {
    url: parsed.toString().slice(0, EVENT_LIMITS.urlMaxLength),
    host: parsed.host,
    path: parsed.pathname.slice(0, EVENT_LIMITS.urlMaxLength),
    query,
    droppedQueryKeys,
  }
}

// A referrer is *not* split here. It has one more rule than a URL does — the
// site's own hosts are not a source — so the whole of it lives in `referrer.ts`
// (ADR-0028), which builds on `sanitizeUrl` above. Two functions that both
// answered "what is the referrer domain" is exactly how a grouping key drifts.

export interface AttributionFields {
  readonly utm_source: string | null
  readonly utm_medium: string | null
  readonly utm_campaign: string | null
  readonly utm_content: string | null
  readonly utm_term: string | null
}

/**
 * Attribution comes from the URL the server sanitized, never from a client-set
 * field: a request cannot state `source` at all (contract), so a forged campaign
 * has nowhere to enter.
 */
export function attributionFrom(sanitized: SanitizedUrl | null): AttributionFields {
  const value = (key: string): string | null => {
    const found = sanitized?.query[key]
    return found === undefined || found === '' ? null : found.slice(0, 128)
  }

  return {
    utm_source: value('utm_source'),
    utm_medium: value('utm_medium'),
    utm_campaign: value('utm_campaign'),
    utm_content: value('utm_content'),
    utm_term: value('utm_term'),
  }
}

export interface SanitizedProperties {
  readonly properties: EventProperties
  /** Keys removed by name or count. Values are never reported. */
  readonly dropped: readonly string[]
}

/**
 * Sanitize caller-defined properties.
 *
 * Keys that name a secret are dropped whole; string values are PII-redacted and
 * truncated; the map is capped at the contract's key count. Order is the
 * caller's insertion order, so the same input always yields the same output.
 */
export function sanitizeProperties(
  properties: Readonly<Record<string, unknown>>,
  options: { redactQueryKeys?: readonly string[] } = {},
): SanitizedProperties {
  const out: Record<string, string | number | boolean | null> = {}
  const dropped: string[] = []
  const extra = options.redactQueryKeys ?? []

  for (const [key, value] of Object.entries(properties)) {
    if (Object.keys(out).length >= EVENT_LIMITS.maxPropertiesPerEvent) {
      dropped.push(key)
      continue
    }
    if (isRedactedQueryKey(key, extra) || key.toLowerCase().startsWith('oa_')) {
      dropped.push(key)
      continue
    }

    if (typeof value === 'string') {
      // The KEY decides, not the value. `order_id` exists to carry an opaque
      // provider id, and the generic "long and mixed-case" rule destroys every
      // real one. Every explicit rule still runs on it, and the exemption stops
      // at OPAQUE_ID_MAX_LENGTH.
      const allowOpaqueId = isOpaqueIdPropertyKey(key) && value.length <= OPAQUE_ID_MAX_LENGTH
      out[key] = redactSensitiveText(value, { allowOpaqueId }).slice(
        0,
        EVENT_LIMITS.propertyValueMaxLength,
      )
      continue
    }
    if (typeof value === 'boolean' || value === null) {
      out[key] = value
      continue
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value
      continue
    }

    // Objects, arrays, functions and non-finite numbers have no analytics
    // column; dropping is the contract's answer, not coercion to a string.
    dropped.push(key)
  }

  return { properties: out, dropped }
}

/**
 * Sanitize element text captured with a heatmap `interaction` signal.
 *
 * Collapses whitespace, redacts PII and truncates to the contract limit. The
 * value of an input is never captured anywhere in the system, so there is no
 * function here that could sanitize one (G-008 scope, 02 §8).
 */
export function sanitizeElementText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return redactSensitiveText(collapsed).slice(0, EVENT_LIMITS.elementTextMaxLength)
}

/**
 * Sanitize a whole heatmap `interaction` payload server-side (G-008, ADR-0057
 * D6).
 *
 * The tracker redacts text and selector before sending; this is the pass that
 * does not trust it. Without it, a modified tracker — or any client posting
 * `type: 'interaction'` with a valid write key — could put arbitrary text into
 * `oa_text` and `oa_selector`, bounded only by the contract's length limits.
 *
 * The selector skips only the generic opaque-token rule (see `RedactOptions`):
 * every explicit rule — email, digit runs, credential shapes — still runs on
 * it. Redaction substitutes rather than removes, so a contract-valid non-empty
 * selector stays non-empty. Text that sanitizes to nothing is dropped, which is
 * the contract's own answer for an absent optional field.
 */
export function sanitizeInteraction<
  T extends { readonly selector: string; readonly text?: string | undefined },
>(payload: T): T {
  const selector = redactSensitiveText(payload.selector, { allowOpaqueId: true }).slice(
    0,
    EVENT_LIMITS.selectorMaxLength,
  )

  if (payload.text === undefined) return { ...payload, selector }

  const text = sanitizeElementText(payload.text)
  if (text !== '') return { ...payload, selector, text }

  const withoutText: Record<string, unknown> = { ...payload, selector }
  delete withoutText['text']
  return withoutText as T
}
