/**
 * A site's own identity fields: its public slug, its display name and its origin
 * allowlist.
 *
 * These are the rules the create and settings endpoints apply before anything is
 * written, kept pure so they are provable without a database and so exactly one
 * definition exists per rule.
 *
 * Why each rule exists:
 *
 * - **Slug.** `SITE_SLUG_PATTERN` is the canonical pattern already carried by
 *   openapi.yaml's `SiteSlug` schema and by the `share_slug` CHECK in migration
 *   0016. `sites.slug` itself has only a uniqueness index (migration 0002), so
 *   without a server-side check the shape would be enforced in the contract and
 *   in one database column but not on the write path. A second, subtly different
 *   pattern would be worse than none — the constant is exported so nothing has to
 *   retype it.
 * - **Name.** A display string that reaches the dashboard, the tracker-config
 *   response and invitation emails. It is bounded so an unbounded paste cannot
 *   become a stored value the rest of the system has to carry.
 * - **Domains.** `site_domains` is the site's origin allowlist, read on every
 *   ingest request through `packages/postgres/src/repositories/ingest-config.ts`
 *   and matched against the request `Origin` by `isOriginAllowed` (docs snapshot
 *   02 §7.1 item 4). That matcher compares bare hosts, so anything that is not a
 *   bare host — a URL, a host:port, a path, a wildcard — is not a stricter
 *   allowlist entry but a dead one: it silently matches nothing and the customer
 *   sees their traffic refused with no error to read. Normalizing on write is
 *   what keeps "configured but matches nothing" from being a reachable state.
 *
 * `SITE_DOMAIN_MAX_COUNT` is an engineering bound on a per-request list and a
 * per-site row count, not a commercial limit: it is not one of the `GATE` values
 * in docs snapshot 05 and must never be presented as a plan attribute.
 */

/**
 * The canonical site-slug pattern: lowercase alphanumerics and internal hyphens,
 * 1–63 characters, never starting or ending with a hyphen.
 *
 * Mirrors openapi.yaml `SiteSlug` and the `share_slug` CHECK constraint exactly.
 */
export const SITE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** Whether a value is a well-formed site slug. */
export function isSiteSlug(value: unknown): value is string {
  return typeof value === 'string' && SITE_SLUG_PATTERN.test(value)
}

/** Longest accepted site display name, in characters, after trimming. */
export const SITE_NAME_MAX_LENGTH = 200

/**
 * The stored form of a site display name, or null when it is not usable.
 *
 * Surrounding whitespace is trimmed rather than rejected — a trailing space in a
 * pasted name is a typo, not an attack — but a name that is only whitespace is
 * empty, and an over-long one is refused instead of being silently truncated.
 */
export function normalizeSiteName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > SITE_NAME_MAX_LENGTH) return null
  return trimmed
}

/** Most origin-allowlist entries a single site may carry. Engineering bound. */
export const SITE_DOMAIN_MAX_COUNT = 10

/** Longest accepted domain, in characters, after normalization. */
export const SITE_DOMAIN_MAX_LENGTH = 253

/** Longest accepted label between two dots. */
export const SITE_DOMAIN_LABEL_MAX_LENGTH = 63

/** A single label: alphanumeric, with hyphens allowed only internally. */
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

/**
 * The stored form of one origin-allowlist entry, or null when it is not a bare
 * hostname.
 *
 * Lowercased and stripped of a single trailing dot (the fully-qualified form
 * `example.com.` and `example.com` are the same host, and only one of them can
 * ever match a browser `Origin`). Everything else is refused rather than
 * repaired: a scheme, a port, a path or query, userinfo, whitespace, a `*`
 * wildcard, an underscore, an empty or over-long label, a leading or trailing
 * hyphen, and any single-label host such as `localhost`. Guessing what
 * `https://shop.example.com/app` was meant to mean is how a wrong allowlist gets
 * stored confidently.
 */
export function normalizeSiteDomain(value: unknown): string | null {
  if (typeof value !== 'string') return null

  const trimmed = value.trim()
  // Reject internal whitespace; the trim above only forgives the edges.
  if (trimmed.length === 0 || /\s/.test(trimmed)) return null

  const lowered = trimmed.toLowerCase()
  // One trailing dot, and one only: `example.com..` leaves an empty label below.
  const host = lowered.endsWith('.') ? lowered.slice(0, -1) : lowered

  if (host.length === 0 || host.length > SITE_DOMAIN_MAX_LENGTH) return null
  // Anything outside the host alphabet — `/ : ? # @ * _ \` and the rest.
  if (!/^[a-z0-9.-]+$/.test(host)) return null

  const labels = host.split('.')
  // A bare hostname in an allowlist is a domain, so it has at least one dot;
  // `localhost` and other single-label hosts are not addressable customers.
  if (labels.length < 2) return null

  for (const label of labels) {
    if (label.length === 0 || label.length > SITE_DOMAIN_LABEL_MAX_LENGTH) return null
    if (!DOMAIN_LABEL_PATTERN.test(label)) return null
  }

  return host
}

/**
 * The result of normalizing a whole replace-set of domains.
 *
 * A discriminated union rather than a thrown error: the caller has to map the
 * failure onto a `VALIDATION_FAILED` envelope, and `index`/`value` are what let
 * it name the offending entry in `details.issues`. Domain names are site-owned
 * configuration, not PII, so echoing the rejected value back is safe.
 */
export type SiteDomainSetResult =
  | { readonly ok: true; readonly domains: readonly string[] }
  | {
      readonly ok: false
      readonly error: 'invalid'
      readonly index: number
      /** The rejected entry, or null when it was not a string at all. */
      readonly value: string | null
    }
  | { readonly ok: false; readonly error: 'too_many'; readonly count: number }

/**
 * Normalize, de-duplicate and bound a site's whole domain list.
 *
 * De-duplication happens after normalization and preserves first-seen order, so
 * `['Example.com', 'example.com.']` is one entry and the list the customer reads
 * back is the list they typed. The count bound is applied to the de-duplicated
 * result — repeating one host ten times is one domain, not ten.
 */
export function normalizeSiteDomainSet(values: readonly unknown[]): SiteDomainSetResult {
  const domains: string[] = []
  const seen = new Set<string>()

  for (let index = 0; index < values.length; index += 1) {
    const raw = values[index]
    const normalized = normalizeSiteDomain(raw)
    if (normalized === null) {
      return { ok: false, error: 'invalid', index, value: typeof raw === 'string' ? raw : null }
    }
    if (seen.has(normalized)) continue
    seen.add(normalized)
    domains.push(normalized)
  }

  if (domains.length > SITE_DOMAIN_MAX_COUNT) {
    return { ok: false, error: 'too_many', count: domains.length }
  }

  return { ok: true, domains }
}
