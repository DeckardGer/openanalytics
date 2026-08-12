import { generateKeyPairSync } from 'node:crypto'
import { ApiError } from '@openanalytics/contracts'
import { EPOCH_IMPORT_CUTOVER, loadServiceEnv, NIL_IMPORT_RUN_ID } from '@openanalytics/domain'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { describe, expect, it } from 'vitest'
import { createApp as createGatewayApp } from '../../apps/query-gateway/src/app.ts'
import type {
  ClickHouseQuery,
  ClickHouseQueryResult,
  ClickHouseReader,
} from '../../apps/query-gateway/src/clickhouse.ts'
import { InMemoryNonceStore } from '../../apps/query-gateway/src/nonce-store.ts'
import { HttpAnalyticsGateway } from '../../apps/api/src/gateway-client.ts'

/**
 * Milestone 7 item 5: the API's signed service client and the gateway's
 * verification are two halves of one scheme, and a signer that drifts from its
 * verifier is the way this breaks. This proves the halves agree by pointing the
 * real `HttpAnalyticsGateway` at a real query-gateway app through a fetch shim —
 * the same signature the API mints in production is verified by the same
 * middleware, with no shared code between signer and verifier beyond
 * `@openanalytics/auth`.
 */

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUBLIC_KEY_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const AUDIENCE = 'query-gateway:test'
const KEY_ID = 'oa-query-2026-07'
const GATEWAY_URL = 'https://gateway.test'

class RecordingReader implements ClickHouseReader {
  readonly calls: ClickHouseQuery[] = []
  query(input: ClickHouseQuery): Promise<ClickHouseQueryResult> {
    this.calls.push(input)
    return Promise.resolve({ rows: [{ events: 42, pageviews: 30, visitors: 12 }] })
  }
}

function buildGateway() {
  const reader = new RecordingReader()
  const app = createGatewayApp({
    service: createServiceMetadata({ name: 'query-gateway', version: 't', environment: 'test' }),
    logger: createCapturedLogger().logger,
    env: loadServiceEnv(
      'query-gateway',
      testEnv({
        QUERY_SIGNING_PUBLIC_KEY: PUBLIC_KEY_PEM,
        QUERY_SIGNING_KEY_ID: KEY_ID,
        QUERY_GATEWAY_AUDIENCE: AUDIENCE,
      }),
    ),
    reader,
    nonceStore: new InMemoryNonceStore(),
    cache: null,
  })
  // Route the client's fetch straight into the app instance.
  const fetchShim: typeof globalThis.fetch = (input, init) =>
    Promise.resolve(app.request(input as string, init as RequestInit))
  return { app, reader, fetchShim }
}

function clientFor(fetchImpl: typeof globalThis.fetch) {
  return new HttpAnalyticsGateway({
    gatewayUrl: GATEWAY_URL,
    privateKeyPem: PRIVATE_KEY_PEM,
    keyId: KEY_ID,
    audience: AUDIENCE,
    signatureLifetimeMs: 30_000,
    timeoutMs: 5_000,
    fetch: fetchImpl,
  })
}

describe('HttpAnalyticsGateway (D-208 signing half)', () => {
  it('signs a request the real gateway accepts, and passes rows and meta through', async () => {
    const { reader, fetchShim } = buildGateway()
    const client = clientFor(fetchShim)

    const result = await client.query('analytics.overview_hour', {
      site_id: '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77',
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-21T00:00:00.000Z',
      import_run_id: NIL_IMPORT_RUN_ID,
      import_cutover: EPOCH_IMPORT_CUTOVER,
      timezone: 'UTC',
    })

    expect(result.operation).toBe('analytics.overview_hour')
    expect(result.rows).toEqual([{ events: 42, pageviews: 30, visitors: 12 }])
    expect(result.meta.cached).toBe(false)
    // The typed params reached ClickHouse as bound values via the gateway.
    expect(reader.calls).toHaveLength(1)
  })

  it('turns an unreachable gateway into a typed error, never empty rows', async () => {
    const dead: typeof globalThis.fetch = () => Promise.reject(new Error('ECONNREFUSED'))
    const client = clientFor(dead)

    await expect(
      client.query('analytics.overview_hour', {
        site_id: '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77',
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-21T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })

  it('preserves a gateway validation fault instead of laundering it to 503', async () => {
    const { fetchShim } = buildGateway()
    const client = clientFor(fetchShim)

    // A UUID the operation schema rejects: the gateway answers VALIDATION_FAILED.
    const error = await client
      .query('analytics.overview_hour', {
        site_id: 'not-a-uuid',
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-21T00:00:00.000Z',
      })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('VALIDATION_FAILED')
  })
})
