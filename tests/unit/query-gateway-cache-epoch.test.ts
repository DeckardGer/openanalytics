import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { signRequest } from '@openanalytics/auth'
import { EPOCH_IMPORT_CUTOVER, loadServiceEnv, NIL_IMPORT_RUN_ID } from '@openanalytics/domain'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../apps/query-gateway/src/app.ts'
import type {
  ClickHouseQuery,
  ClickHouseQueryResult,
  ClickHouseReader,
} from '../../apps/query-gateway/src/clickhouse.ts'
import { InMemoryNonceStore } from '../../apps/query-gateway/src/nonce-store.ts'
import { queryRequestSchema } from '../../apps/query-gateway/src/operations.ts'
import { QueryCache } from '../../apps/query-gateway/src/query-cache.ts'

/**
 * The gateway's `cache_epoch` (ADR-0030, decision 6).
 *
 * The query cache is an in-process LRU with no delete API, and building one
 * would only ever reach the instance that got the call. So the api passes the
 * site's `config_version` — which every lifecycle transition bumps — and the
 * gateway mixes it into the cache key. Entries computed under the previous
 * version become unreachable garbage the LRU evicts: no channel, no TTL change,
 * and the closure holds even for a caller that forgets the middleware.
 *
 * Proven here: two epochs are two cache entries, the field is optional (the
 * mandated deploy order is gateway-before-api, so a new gateway must accept a
 * body from an old api that never sends it), and it never reaches SQL.
 */

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUBLIC_KEY_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const AUDIENCE = 'query-gateway:test'
const KEY_ID = 'oa-query-2026-07'
const GATEWAY_ORIGIN = 'https://gateway.test'
const QUERY_PATH = '/v1/query'
const SIGNED_AT = new Date('2026-07-28T12:00:00.000Z')

const OPERATION = 'analytics.overview_hour'
const PARAMS = {
  site_id: '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77',
  from: '2026-07-01T00:00:00.000Z',
  to: '2026-07-21T00:00:00.000Z',
  // The range totals gained the import partition in M11 CP3 (ADR-0032, D2b).
  // These are the values a site with no published import binds — the epoch
  // cutover and the nil run, which is a value rather than an omission.
  import_run_id: NIL_IMPORT_RUN_ID,
  import_cutover: EPOCH_IMPORT_CUTOVER,
  // The cutover boundary is rendered in the request's zone, so every
  // import-aware operation binds one (ADR-0032, D4).
  timezone: 'UTC',
}

/** Answers a different number every call, so a cache hit is unmistakable. */
class CountingReader implements ClickHouseReader {
  readonly calls: ClickHouseQuery[] = []
  #next = 1

  query(input: ClickHouseQuery): Promise<ClickHouseQueryResult> {
    this.calls.push(input)
    const visitors = this.#next
    this.#next += 1
    return Promise.resolve({ rows: [{ visitors }] })
  }
}

interface QueryResponse {
  rows: { visitors: number }[]
  meta: { cached: boolean }
}

function buildApp() {
  const captured = createCapturedLogger()
  const reader = new CountingReader()

  const app = createApp({
    service: createServiceMetadata({
      name: 'query-gateway',
      version: '1.0.0-test',
      environment: 'test',
    }),
    logger: captured.logger,
    env: loadServiceEnv(
      'query-gateway',
      testEnv({
        QUERY_SIGNING_PUBLIC_KEY: PUBLIC_KEY_PEM,
        QUERY_SIGNING_KEY_ID: KEY_ID,
        QUERY_GATEWAY_AUDIENCE: AUDIENCE,
      }),
    ),
    reader,
    nonceStore: new InMemoryNonceStore({ now: () => SIGNED_AT.getTime() }),
    cache: new QueryCache({ maxEntries: 50, ttlMs: 60_000, now: () => SIGNED_AT.getTime() }),
    now: () => SIGNED_AT,
  })

  const post = async (body: unknown): Promise<QueryResponse> => {
    const signedBody = JSON.stringify(body)
    const headers = signRequest({
      privateKeyPem: PRIVATE_KEY_PEM,
      keyId: KEY_ID,
      audience: AUDIENCE,
      method: 'POST',
      url: `${GATEWAY_ORIGIN}${QUERY_PATH}`,
      body: signedBody,
      nonce: randomUUID(),
      issuedAt: SIGNED_AT,
      lifetimeMs: 30_000,
    })
    const res = await app.request(`${GATEWAY_ORIGIN}${QUERY_PATH}`, {
      method: 'POST',
      body: signedBody,
      headers: { 'content-type': 'application/json', ...headers },
    })
    expect(res.status).toBe(200)
    return (await res.json()) as QueryResponse
  }

  return { post, reader }
}

describe('queryRequestSchema — cache_epoch', () => {
  it('accepts the field as an optional non-negative integer', () => {
    expect(queryRequestSchema.safeParse({ operation: 'x', cache_epoch: 0 }).success).toBe(true)
    expect(queryRequestSchema.safeParse({ operation: 'x', cache_epoch: 12 }).success).toBe(true)
    // Absent behaves exactly as every caller behaved before the field existed —
    // which is what makes gateway-before-api a valid deploy order.
    expect(queryRequestSchema.safeParse({ operation: 'x' }).success).toBe(true)
  })

  it('refuses a negative or fractional epoch rather than coercing it', () => {
    expect(queryRequestSchema.safeParse({ operation: 'x', cache_epoch: -1 }).success).toBe(false)
    expect(queryRequestSchema.safeParse({ operation: 'x', cache_epoch: 1.5 }).success).toBe(false)
  })

  it('still rejects an unknown top-level field — the schema stays strict', () => {
    expect(queryRequestSchema.safeParse({ operation: 'x', nonsense: 1 }).success).toBe(false)
  })
})

describe('gateway cache key — cache_epoch', () => {
  it('serves the second identical request from cache when the epoch is unchanged', async () => {
    const h = buildApp()
    const first = await h.post({ operation: OPERATION, params: PARAMS, cache_epoch: 4 })
    const second = await h.post({ operation: OPERATION, params: PARAMS, cache_epoch: 4 })

    expect(first.meta.cached).toBe(false)
    expect(second.meta.cached).toBe(true)
    expect(second.rows[0]?.visitors).toBe(first.rows[0]?.visitors)
    expect(h.reader.calls).toHaveLength(1)
  })

  it('misses when the epoch moves, so a blocked site never reads its pre-block answer', async () => {
    const h = buildApp()
    const before = await h.post({ operation: OPERATION, params: PARAMS, cache_epoch: 4 })
    // The lifecycle transition bumped `sites.config_version`.
    const after = await h.post({ operation: OPERATION, params: PARAMS, cache_epoch: 5 })

    expect(after.meta.cached).toBe(false)
    expect(after.rows[0]?.visitors).not.toBe(before.rows[0]?.visitors)
    expect(h.reader.calls).toHaveLength(2)
  })

  it('treats an absent epoch as generation 0, distinct from an explicit 1', async () => {
    const h = buildApp()
    await h.post({ operation: OPERATION, params: PARAMS })
    const explicit = await h.post({ operation: OPERATION, params: PARAMS, cache_epoch: 1 })

    expect(explicit.meta.cached).toBe(false)
    expect(h.reader.calls).toHaveLength(2)
  })

  it('never binds the epoch into the query parameters', async () => {
    // It is a cache input and nothing else: it must not reach SQL, and the
    // operation's own parameter schema never sees it.
    const h = buildApp()
    await h.post({ operation: OPERATION, params: PARAMS, cache_epoch: 9 })

    expect(h.reader.calls).toHaveLength(1)
    expect(Object.keys(h.reader.calls[0]!.parameters)).not.toContain('cache_epoch')
  })
})
