import { createHmac } from 'node:crypto'
import { utcCalendarDate } from './event-time.ts'

/**
 * Cookieless anonymous identity (docs snapshot 05, D-102; 02 §10).
 *
 * The default privacy mode derives a site-scoped, daily-rotating HMAC from the
 * request's IP, a normalized user-agent class, the site id, the validated
 * `occurred_at`'s UTC calendar date and a key version — and then the raw IP is
 * gone. It is never stored, never logged, never queued.
 *
 * Two properties this file exists to guarantee:
 *
 * - **Site scope.** The same browser at two different Open Analytics customers
 *   must not produce the same id. The site id is an HMAC input, not a prefix.
 * - **No raw IP escapes.** Every function here returns a structure with no IP
 *   field at any depth, so a caller cannot accidentally carry one forward. The
 *   IP is an argument and a local variable, nothing else.
 *
 * The rotation day is the **UTC** calendar date. A site's timezone groups
 * dashboards only (D-102); letting it choose the identity bucket would split one
 * visitor in two at local midnight and make cross-site correlation possible via
 * timezone choice.
 */

/**
 * Version of the identity derivation itself. It is an HMAC input, so a future
 * change to the inputs or their order produces a different, non-colliding id
 * rather than silently merging two schemes.
 */
export const IDENTITY_DERIVATION_VERSION = 1

export interface IdentityKey {
  readonly keyVersion: number
  readonly secret: string
}

/**
 * Coarse user-agent class.
 *
 * Deliberately coarse: it is an identity input, and a precise UA string would
 * make the hash a fingerprint. Browser and OS *families* only, no versions, so
 * a Chrome update does not split one visitor's day in two. This performs no bot
 * classification: that is a separate, versioned ruleset (`bot-ruleset.ts`,
 * G-005), because identity and abuse filtering answer different questions and a
 * ruleset change must not silently re-bucket every visitor's hash.
 */
export interface UserAgentClass {
  readonly deviceType: 'desktop' | 'mobile' | 'tablet' | 'unknown'
  readonly browser: string
  readonly os: string
}

const BROWSER_RULES: readonly (readonly [RegExp, string])[] = [
  [/\bedg(e|a|ios)?\//i, 'edge'],
  [/\b(opr|opera)\//i, 'opera'],
  [/\bsamsungbrowser\//i, 'samsung'],
  [/\bfirefox\/|\bfxios\//i, 'firefox'],
  [/\bchrome\/|\bcrios\//i, 'chrome'],
  [/\bsafari\//i, 'safari'],
]

const OS_RULES: readonly (readonly [RegExp, string])[] = [
  [/\bwindows nt\b/i, 'windows'],
  [/\b(iphone|ipad|ipod|ios)\b/i, 'ios'],
  [/\bmac os x\b|\bmacintosh\b/i, 'macos'],
  [/\bandroid\b/i, 'android'],
  [/\bcros\b/i, 'chromeos'],
  [/\blinux\b|\bx11\b/i, 'linux'],
]

function matchFirst(rules: readonly (readonly [RegExp, string])[], value: string): string {
  for (const [pattern, name] of rules) {
    if (pattern.test(value)) return name
  }
  return 'unknown'
}

export function normalizeUserAgentClass(userAgent: string | null | undefined): UserAgentClass {
  if (!userAgent || userAgent.trim() === '') {
    return { deviceType: 'unknown', browser: 'unknown', os: 'unknown' }
  }

  const value = userAgent.slice(0, 512)
  const os = matchFirst(OS_RULES, value)
  const browser = matchFirst(BROWSER_RULES, value)

  let deviceType: UserAgentClass['deviceType'] = 'desktop'
  if (
    /\b(ipad|tablet)\b/i.test(value) ||
    (/\bandroid\b/i.test(value) && !/\bmobile\b/i.test(value))
  )
    deviceType = 'tablet'
  else if (/\b(mobile|iphone|ipod|android)\b/i.test(value)) deviceType = 'mobile'
  else if (os === 'unknown' && browser === 'unknown') deviceType = 'unknown'

  return { deviceType, browser, os }
}

/** Stable string form of the class, used as one HMAC input. */
export function userAgentClassKey(userAgentClass: UserAgentClass): string {
  return `${userAgentClass.deviceType}|${userAgentClass.browser}|${userAgentClass.os}`
}

/**
 * Textual IP normalization so trivially different spellings of one address do
 * not become two visitors. Nothing here is stored; the value exists only long
 * enough to be hashed.
 */
function normalizeIp(ip: string): string {
  const trimmed = ip.trim().toLowerCase()
  const withoutBrackets = trimmed.startsWith('[') ? trimmed.slice(1, trimmed.indexOf(']')) : trimmed
  const withoutZone = withoutBrackets.split('%')[0] ?? withoutBrackets
  // An IPv4-mapped IPv6 address is the same client as its IPv4 form.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(withoutZone)
  return mapped?.[1] ?? withoutZone
}

export interface AnonymousIdentity {
  /** Site-scoped, UTC-daily rotating HMAC. */
  readonly anonymousId: string
  readonly keyVersion: number
  /** The UTC calendar date this identity is valid for. */
  readonly utcDate: string
  readonly userAgentClass: UserAgentClass
  readonly derivationVersion: number
}

/**
 * Derive the anonymous id for one event, then forget the IP.
 *
 * `occurredAt` must already have passed the D-016 time rules: the rotation
 * bucket is the *validated* timestamp's UTC date, so a clamped future event
 * lands in the day the server accepted it rather than one the visitor invented.
 */
export function anonymousIdentityFor(input: {
  ip: string
  userAgent: string | null | undefined
  siteId: string
  occurredAt: Date | string
  key: IdentityKey
}): AnonymousIdentity {
  const userAgentClass = normalizeUserAgentClass(input.userAgent)
  const utcDate = utcCalendarDate(input.occurredAt)

  const material = [
    String(IDENTITY_DERIVATION_VERSION),
    String(input.key.keyVersion),
    input.siteId,
    utcDate,
    userAgentClassKey(userAgentClass),
    normalizeIp(input.ip),
  ].join('\n')

  const anonymousId = createHmac('sha256', input.key.secret).update(material).digest('hex')

  return {
    anonymousId,
    keyVersion: input.key.keyVersion,
    utcDate,
    userAgentClass,
    derivationVersion: IDENTITY_DERIVATION_VERSION,
  }
}

/**
 * The UTC dates key material must still cover at a given moment.
 *
 * Offline events are accepted up to 24 hours late (D-016), so at any instant two
 * calendar days are in play. Dropping yesterday's key material would silently
 * change the identity of every late event.
 */
export function utcDatesInAcceptanceWindow(acceptedAt: Date | string): readonly [string, string] {
  const accepted = acceptedAt instanceof Date ? acceptedAt : new Date(acceptedAt)
  const previous = new Date(accepted.getTime() - 24 * 60 * 60 * 1000)
  return [utcCalendarDate(previous), utcCalendarDate(accepted)]
}

/**
 * Every identity a lookup should consider during a key rotation — one per live
 * key version. Old material is recognized rather than silently becoming a new
 * visitor, the same rule the trial identity uses (D-021).
 */
export function anonymousIdentityCandidates(input: {
  ip: string
  userAgent: string | null | undefined
  siteId: string
  occurredAt: Date | string
  keys: readonly IdentityKey[]
}): AnonymousIdentity[] {
  return input.keys.map((key) =>
    anonymousIdentityFor({
      ip: input.ip,
      userAgent: input.userAgent,
      siteId: input.siteId,
      occurredAt: input.occurredAt,
      key,
    }),
  )
}

/**
 * Site-scoped HMAC of a customer-supplied external user id (02 §10).
 *
 * `identify()` values are the customer's own ids and must not be raw PII; they
 * are hashed before storage regardless, so a customer that sends an email
 * address anyway does not put one in our analytics store. Unlike the anonymous
 * id this does not rotate daily — it is a stable identity the customer already
 * has.
 */
export function externalUserIdHash(input: {
  siteId: string
  externalUserId: string
  key: IdentityKey
}): { readonly userId: string; readonly keyVersion: number } {
  const material = [
    String(IDENTITY_DERIVATION_VERSION),
    'external_user',
    input.siteId,
    input.externalUserId.trim(),
  ].join('\n')

  return {
    userId: createHmac('sha256', input.key.secret).update(material).digest('hex'),
    keyVersion: input.key.keyVersion,
  }
}

/**
 * Site-scoped HMAC of a **payment-provider customer id** (ADR-0033, D5/D6).
 *
 * Deliberately a *different pseudonym* from `externalUserIdHash`, under its own
 * purpose tag, and the separation is the decision rather than an implementation
 * detail:
 *
 * - `externalUserIdHash` is the `identify()` derivation. Its whole purpose is to
 *   be **joinable** — the value it produces is what `events_raw.user_id` holds,
 *   which is how a Stripe customer's `client_reference_id` finds that visitor's
 *   journey (D6 signal 2).
 * - This one must **not** be joinable. A provider customer id (`cus_…`) is not
 *   something the site ever gave `identify()`, so a hash of it under the same
 *   tag would produce a value that looks like a `user_id`, sits in the same
 *   column family, and matches nothing — an identifier that invites a join it
 *   can never satisfy. Worse, if a site *did* happen to use the provider
 *   customer id as its `identify()` value, a shared tag would silently merge two
 *   populations that were never meant to be one.
 *
 * What it is for is grouping a site's own transactions by payer — "this customer
 * has bought four times" — without linking a payer to a browsing identity. That
 * is exactly the strength D-102 allows and no more.
 *
 * Non-rotating, like `externalUserIdHash` and unlike the anonymous id: a
 * customer relationship is stable by nature, and a daily-rotating payer
 * pseudonym would make "four purchases by one customer" unanswerable across a
 * midnight.
 */
export function revenueCustomerHash(input: {
  siteId: string
  customerId: string
  key: IdentityKey
}): { readonly customerHash: string; readonly keyVersion: number } {
  const material = [
    String(IDENTITY_DERIVATION_VERSION),
    'revenue_customer',
    input.siteId,
    input.customerId.trim(),
  ].join('\n')

  return {
    customerHash: createHmac('sha256', input.key.secret).update(material).digest('hex'),
    keyVersion: input.key.keyVersion,
  }
}

/**
 * Site-scoped HMAC of the tracker's `client_session_id` hint (02 §10).
 *
 * The canonical analytics session is rebuilt server-side by the sessionizer; this
 * only keeps the client's grouping hint from being a cross-site identifier.
 */
export function clientSessionHash(input: {
  siteId: string
  clientSessionId: string
  key: IdentityKey
}): string {
  const material = [
    String(IDENTITY_DERIVATION_VERSION),
    'client_session',
    input.siteId,
    input.clientSessionId,
  ].join('\n')

  return createHmac('sha256', input.key.secret).update(material).digest('hex')
}

/**
 * Everything derived from a request's network identity, in one structure with no
 * place to put an IP.
 *
 * This is the boundary the collector calls: the raw IP enters as an argument and
 * does not come back out, so no downstream structure — event, log field or queue
 * payload — can carry one by accident. Geo is resolved by the caller from the
 * same IP before it is discarded; only the coarse result travels on.
 */
export interface VisitorContext {
  readonly anonymousId: string
  readonly identityKeyVersion: number
  readonly identityUtcDate: string
  readonly deviceType: UserAgentClass['deviceType']
  readonly browser: string
  readonly os: string
  readonly country: string | null
  readonly city: string | null
}

export function deriveVisitorContext(input: {
  ip: string
  userAgent: string | null | undefined
  siteId: string
  occurredAt: Date | string
  key: IdentityKey
  geo?: { country?: string | null; city?: string | null }
}): VisitorContext {
  const identity = anonymousIdentityFor({
    ip: input.ip,
    userAgent: input.userAgent,
    siteId: input.siteId,
    occurredAt: input.occurredAt,
    key: input.key,
  })

  return {
    anonymousId: identity.anonymousId,
    identityKeyVersion: identity.keyVersion,
    identityUtcDate: identity.utcDate,
    deviceType: identity.userAgentClass.deviceType,
    browser: identity.userAgentClass.browser,
    os: identity.userAgentClass.os,
    country: input.geo?.country ?? null,
    city: input.geo?.city ?? null,
  }
}
