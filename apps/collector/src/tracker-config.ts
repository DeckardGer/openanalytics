import { ApiError, trackerConfigSchema, type TrackerConfig } from '@openanalytics/contracts'
import { verifyPreviewToken } from '@openanalytics/auth'
import { Hono } from 'hono'

/**
 * `GET /v1/tracker/config` — the tracker's own configuration (docs snapshot 02
 * §11, plan 04 Milestone 4 item 8).
 *
 * Public and cacheable: site timezone, allowed domains, query redaction rules,
 * feature flags and no-code rules. It is the one ingest-side endpoint that
 * answers a `GET`, so the write-only tracking key arrives as a query parameter —
 * a `<script>`-driven request has nowhere else to put it. That does not weaken
 * the key: this route returns configuration, never analytics data, and nothing
 * here is authorization for anything.
 *
 * Caching is `ETag` + `config_version`. A dashboard change bumps the version,
 * which changes the tag, which invalidates both the CDN copy and the tracker's
 * local one. Between changes the common answer is a bodyless `304`.
 *
 * Resolving a tracking key to a site is Milestone 5's work, so the lookup sits
 * behind a port. This app half — validation, caching semantics, error shape — is
 * complete and tested now; M5 supplies the store.
 */

export interface TrackerConfigRecord {
  readonly siteId: string
  readonly config: TrackerConfig
}

export interface TrackerConfigStore {
  /** Resolves a public tracking key. `null` when no live site matches. */
  find(trackingKey: string): Promise<TrackerConfigRecord | null>
  /**
   * Resolves the same key but serves one *unpublished* definition version's
   * rules instead of the published set (ADR-0034, D6).
   *
   * `null` when the key does not resolve, or when the token names a site other
   * than the one the key belongs to, or when that version does not exist.
   */
  findPreview?(
    trackingKey: string,
    preview: { definitionId: string; version: number; siteId: string },
  ): Promise<TrackerConfigRecord | null>
}

/**
 * Five minutes at the CDN, with a longer stale window: long enough that a busy
 * site is not re-fetching per visitor, short enough that a dashboard change is
 * live without an operator doing anything. The tracker's own cache is separate
 * and revalidates with `If-None-Match`.
 */
export const TRACKER_CONFIG_CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=3600'

export function etagFor(record: TrackerConfigRecord): string {
  return `"oa-${record.siteId}-${record.config.config_version}"`
}

export function createTrackerConfigRoutes(
  store: TrackerConfigStore | undefined,
  /** `PREVIEW_TOKEN_VERIFY_KEY`. Absent, `?preview=` is ignored entirely. */
  verifyKey?: string | undefined,
) {
  const routes = new Hono()

  routes.get('/config', async (c) => {
    const key = c.req.query('key')
    if (key === undefined || key.length < 8) {
      throw new ApiError('VALIDATION_FAILED', 'A tracking key is required.', {
        details: { reason: 'missing_tracking_key' },
      })
    }

    if (!store) {
      // Never a silent 404: an unconfigured deployment is an operator problem,
      // and the tracker must be able to tell "no such site" from "not ready".
      throw new ApiError('SERVICE_UNAVAILABLE', 'Tracker configuration is not available.', {
        details: { reason: 'store_unconfigured' },
      })
    }

    // A preview request (ADR-0034, D6). The token is the only way an
    // *unpublished* rule ever reaches a browser, so an unverifiable one is
    // served as no preview at all rather than as an unauthenticated one: the
    // request falls through to the published set below. Silently, and
    // deliberately — an expired token during a preview session should show the
    // user their live rules, not an error page on their own site.
    const previewToken = c.req.query('preview')
    if (previewToken !== undefined && previewToken !== '' && verifyKey && store.findPreview) {
      const verified = verifyPreviewToken(previewToken, { verifyKey, now: new Date() })
      if (verified.ok) {
        const preview = await store.findPreview(key, {
          definitionId: verified.claims.definition_id,
          version: verified.claims.version,
          siteId: verified.claims.site_id,
        })
        if (preview) {
          // Never cached, at any layer. A preview is a temporary override of the
          // site's real configuration, and one cached for even five minutes
          // would outlive the session it belongs to and follow a real visitor
          // around — the tracker's own localStorage copy included.
          c.header('Cache-Control', 'no-store')
          return c.json(trackerConfigSchema.parse(preview.config))
        }
      }
    }

    const record = await store.find(key)
    if (!record) {
      throw new ApiError('SITE_NOT_FOUND', 'No site matches this tracking key.')
    }

    const etag = etagFor(record)
    c.header('ETag', etag)
    c.header('Cache-Control', TRACKER_CONFIG_CACHE_CONTROL)

    if (c.req.header('If-None-Match') === etag) return c.body(null, 304)

    // Parsed on the way out: a malformed stored configuration is a server fault,
    // not something to hand a browser.
    return c.json(trackerConfigSchema.parse(record.config))
  })

  return routes
}
