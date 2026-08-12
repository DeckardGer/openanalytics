import { ApiError } from '@openanalytics/contracts'
import { Hono } from 'hono'
import type { SignedRequestVariables } from './auth.ts'
import type { ClickHouseReader } from './clickhouse.ts'
import { withTimeout } from './limits.ts'
import { findOperation, queryRequestSchema } from './operations.ts'
import { queryCacheKey, type QueryCache } from './query-cache.ts'

/**
 * `POST /v1/query` — the entire read surface of the gateway.
 *
 * The body has already been read and its signature verified by the time this
 * runs, so the handler's job is: parse, resolve the operation ID against the
 * allowlist, bind typed parameters, serve from the bounded cache when it can,
 * else execute under a deadline with ClickHouse-side cost guards.
 */

export interface QueryRouteDeps {
  readonly reader: ClickHouseReader
  readonly timeoutMs: number
  /** ClickHouse-side cost guards attached to every executed read. */
  readonly clickhouseSettings: Readonly<Record<string, string | number>>
  /** Omitted only in tests that assert on the uncached path. */
  readonly cache?: QueryCache
  /** TTL for a `cacheProfile: 'finalized'` operation; falls back to the cache
   * default when unset. The long band for provably-finalized session ranges. */
  readonly finalizedCacheTtlMs?: number
}

function parseBody(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody) as unknown
  } catch {
    throw new ApiError('VALIDATION_FAILED', 'Request body is not valid JSON')
  }
}

export function createQueryRoute(
  deps: QueryRouteDeps,
): Hono<{ Variables: SignedRequestVariables }> {
  const route = new Hono<{ Variables: SignedRequestVariables }>()

  route.post('/query', async (c) => {
    const parsed = queryRequestSchema.safeParse(parseBody(c.get('rawBody')))
    if (!parsed.success) {
      throw new ApiError('VALIDATION_FAILED', 'Query request is malformed', {
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.') || '(root)',
            message: issue.message,
          })),
        },
      })
    }

    // Allowlist resolution happens before anything else touches the network:
    // an unknown ID must never become a connection attempt, let alone a query
    // (docs snapshot 05, D-208).
    const operation = findOperation(parsed.data.operation)
    if (operation === undefined) {
      throw new ApiError('VALIDATION_FAILED', 'Unknown operation', {
        details: { operation: parsed.data.operation, reason: 'UNKNOWN_OPERATION' },
      })
    }

    const parameters = operation.bindParams(parsed.data.params)
    const logger = c.get('logger')
    const startedAt = performance.now()

    // Cache lookup happens after binding, so the key is built from validated,
    // canonical parameters (site_id among them — the cache never mixes sites).
    // The caller's cache generation prefixes the key (ADR-0030, decision 6), so
    // a site whose `config_version` moved cannot read an entry computed under the
    // previous one. Absent behaves as 0, which is what every caller sent before
    // the field existed.
    const cacheKey =
      deps.cache && operation.cacheable
        ? `${parsed.data.cache_epoch ?? 0}\u0000${queryCacheKey(operation.id, parameters)}`
        : undefined
    if (cacheKey !== undefined && deps.cache) {
      const hit = deps.cache.get(cacheKey)
      if (hit !== undefined) {
        logger.info('query_served', {
          operation: operation.id,
          row_count: hit.rows.length,
          truncated: hit.truncated,
          cached: true,
          duration_ms: 0,
        })
        return c.json({
          operation: operation.id,
          rows: hit.rows,
          meta: {
            row_count: hit.rows.length,
            truncated: hit.truncated,
            elapsed_ms: 0,
            cached: true,
          },
        })
      }
    }

    let result
    try {
      result = await withTimeout(deps.timeoutMs, (signal) =>
        deps.reader.query({
          sql: operation.sql,
          parameters,
          signal,
          queryId: c.get('requestId'),
          settings: deps.clickhouseSettings,
        }),
      )
    } catch (error) {
      if (error instanceof ApiError) throw error
      // A timeout and a dead ClickHouse are both "try again later" to the
      // caller; the distinguishing detail belongs in the log, keyed by
      // request_id, not in the response.
      const timedOut = error instanceof Error && error.name === 'AbortError'
      logger.error('query_failed', {
        code: 'SERVICE_UNAVAILABLE',
        operation: operation.id,
        timed_out: timedOut,
        retryable: true,
        err: error,
      })
      throw new ApiError('SERVICE_UNAVAILABLE', 'Analytics query could not be completed', {
        status: timedOut ? 504 : 503,
        details: { operation: operation.id },
      })
    }

    const elapsedMs = Math.round(performance.now() - startedAt)
    const truncated = result.rows.length > operation.maxRows
    const rows = truncated ? result.rows.slice(0, operation.maxRows) : result.rows

    if (cacheKey !== undefined && deps.cache) {
      // A finalized-range operation earns the long TTL; everything else gets the
      // cache's short default (ADR-0011's finalized-range refinement).
      const ttlMs = operation.cacheProfile === 'finalized' ? deps.finalizedCacheTtlMs : undefined
      deps.cache.set(cacheKey, { rows, truncated }, ttlMs)
    }

    logger.info('query_served', {
      operation: operation.id,
      row_count: rows.length,
      truncated,
      cached: false,
      duration_ms: elapsedMs,
    })

    return c.json({
      operation: operation.id,
      rows,
      meta: {
        row_count: rows.length,
        // Surfaced rather than silently applied: a caller must be able to tell a
        // complete answer from a capped one (AGENTS.md, interpretable emptiness).
        truncated,
        elapsed_ms: elapsedMs,
        cached: false,
      },
    })
  })

  return route
}
