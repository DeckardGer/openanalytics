import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { errorEnvelopeSchema } from '@openanalytics/contracts'
import { EPOCH_IMPORT_CUTOVER, loadServiceEnv, NIL_IMPORT_RUN_ID } from '@openanalytics/domain'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../apps/query-gateway/src/app.ts'
import type {
  ClickHouseQuery,
  ClickHouseQueryResult,
  ClickHouseReader,
} from '../../apps/query-gateway/src/clickhouse.ts'
import { InMemoryNonceStore } from '../../apps/query-gateway/src/nonce-store.ts'
import { SIGNATURE_HEADERS, signRequest } from '@openanalytics/auth'

/**
 * Milestone 1 gate, docs snapshot 04: "the signed gateway request passes the
 * tamper/replay tests and no query outside the allowlist is possible."
 *
 * The whole matrix runs in-process against a real app instance with a fake
 * ClickHouse reader. Two things follow from that choice: the middleware order
 * (which is where an auth bypass would actually come from) is under test, and no
 * test in this file can reach a live cluster even by accident.
 */

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUBLIC_KEY_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const AUDIENCE = 'query-gateway:test'
const KEY_ID = 'oa-query-2026-07'
const GATEWAY_ORIGIN = 'https://gateway.test'
const QUERY_PATH = '/v1/query'

const SIGNED_AT = new Date('2026-07-21T12:00:00.000Z')

/** Records every call so a test can assert ClickHouse was never contacted. */
class RecordingReader implements ClickHouseReader {
  readonly calls: ClickHouseQuery[] = []

  query(input: ClickHouseQuery): Promise<ClickHouseQueryResult> {
    this.calls.push(input)
    return Promise.resolve({
      rows: [{ site_id: '00000000-0000-4000-8000-000000000000', ok: 1 }],
    })
  }
}

function buildApp(overrides: Record<string, string | undefined> = {}) {
  const captured = createCapturedLogger()
  const reader = new RecordingReader()
  const nonceStore = new InMemoryNonceStore({ now: () => SIGNED_AT.getTime() })

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
        ...overrides,
      }),
    ),
    reader,
    nonceStore,
    // This suite is about the auth boundary, not caching; keep every request on
    // the execution path so `reader.calls` reflects intent exactly.
    cache: null,
    now: () => SIGNED_AT,
  })

  return { app, captured, reader }
}

interface RequestOverrides {
  readonly audience?: string
  readonly issuedAt?: Date
  readonly lifetimeMs?: number
  readonly nonce?: string
  readonly path?: string
  /** Body sent on the wire, when it must differ from the body that was signed. */
  readonly sentBody?: string
  readonly headerOverrides?: Record<string, string>
}

function signedRequest(body: unknown, overrides: RequestOverrides = {}) {
  const signedBody = JSON.stringify(body)
  const path = overrides.path ?? QUERY_PATH

  const headers = signRequest({
    privateKeyPem: PRIVATE_KEY_PEM,
    keyId: KEY_ID,
    audience: overrides.audience ?? AUDIENCE,
    method: 'POST',
    url: `${GATEWAY_ORIGIN}${path}`,
    body: signedBody,
    nonce: overrides.nonce ?? randomUUID(),
    issuedAt: overrides.issuedAt ?? SIGNED_AT,
    lifetimeMs: overrides.lifetimeMs ?? 30_000,
  })

  return {
    path,
    init: {
      method: 'POST',
      body: overrides.sentBody ?? signedBody,
      headers: {
        'content-type': 'application/json',
        ...headers,
        ...overrides.headerOverrides,
      },
    },
  }
}

const VALID_BODY = {
  operation: 'analytics.overview_hour',
  params: {
    site_id: '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77',
    from: '2026-07-01T00:00:00.000Z',
    to: '2026-07-21T00:00:00.000Z',
    // The range totals gained the import partition in M11 CP3 (ADR-0032, D2b);
    // these are the values a site with no published import binds.
    import_run_id: NIL_IMPORT_RUN_ID,
    import_cutover: EPOCH_IMPORT_CUTOVER,
    timezone: 'UTC',
  },
}

async function failureOf(response: Response): Promise<string | undefined> {
  const body = errorEnvelopeSchema.parse(await response.json())
  const reason = body.error.details['reason']
  return typeof reason === 'string' ? reason : undefined
}

describe('query gateway signed service auth (D-208)', () => {
  let harness: ReturnType<typeof buildApp>

  beforeEach(() => {
    harness = buildApp()
  })

  it('accepts a correctly signed request and executes the operation', async () => {
    const { path, init } = signedRequest(VALID_BODY)
    const response = await harness.app.request(`${GATEWAY_ORIGIN}${path}`, init)

    expect(response.status).toBe(200)
    const body = (await response.json()) as { operation: string; meta: { row_count: number } }
    expect(body.operation).toBe('analytics.overview_hour')
    expect(body.meta.row_count).toBe(1)

    // The typed parameters reached ClickHouse as bound values, and the statement
    // text carries placeholders rather than any of them. Instants are bound in
    // the DateTime64 form the operation converts them to.
    const [call] = harness.reader.calls
    expect(call?.parameters).toEqual({
      site_id: VALID_BODY.params.site_id,
      from: '2026-07-01 00:00:00.000',
      to: '2026-07-21 00:00:00.000',
      // The import partition rides along on the range totals (ADR-0032, D2b).
      // Bound as values even with nothing published, so no request shape exists
      // in which the cutover filter is quietly not applied — and the zone comes
      // with them, because the boundary is rendered in it.
      tz: 'UTC',
      import_run_id: NIL_IMPORT_RUN_ID,
      import_cutover: EPOCH_IMPORT_CUTOVER,
    })
    expect(call?.sql).toContain('{site_id:UUID}')
    expect(call?.sql).not.toContain(VALID_BODY.params.site_id)
    // Cost guards ride along on every executed read.
    expect(call?.settings?.['max_execution_time']).toBeDefined()
  })

  it('rejects a request with no signature at all', async () => {
    const response = await harness.app.request(`${GATEWAY_ORIGIN}${QUERY_PATH}`, {
      method: 'POST',
      body: JSON.stringify(VALID_BODY),
      headers: { 'content-type': 'application/json' },
    })

    expect(response.status).toBe(401)
    expect(await failureOf(response)).toBe('MISSING_SIGNATURE')
    expect(harness.reader.calls).toHaveLength(0)
  })

  it('rejects a signature that is present but incomplete', async () => {
    const { path, init } = signedRequest(VALID_BODY)
    const headers = { ...init.headers } as Record<string, string>
    delete headers[SIGNATURE_HEADERS.nonce]

    const response = await harness.app.request(`${GATEWAY_ORIGIN}${path}`, { ...init, headers })

    expect(response.status).toBe(401)
    expect(await failureOf(response)).toBe('MALFORMED_SIGNATURE')
  })

  it('rejects a forged signature', async () => {
    const forged = generateKeyPairSync('ed25519')
    const body = JSON.stringify(VALID_BODY)
    const headers = signRequest({
      privateKeyPem: forged.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      keyId: KEY_ID,
      audience: AUDIENCE,
      method: 'POST',
      url: `${GATEWAY_ORIGIN}${QUERY_PATH}`,
      body,
      nonce: randomUUID(),
      issuedAt: SIGNED_AT,
      lifetimeMs: 30_000,
    })

    const response = await harness.app.request(`${GATEWAY_ORIGIN}${QUERY_PATH}`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', ...headers },
    })

    expect(response.status).toBe(401)
    expect(await failureOf(response)).toBe('BAD_SIGNATURE')
    expect(harness.reader.calls).toHaveLength(0)
  })

  it('rejects a signature that has expired', async () => {
    const { path, init } = signedRequest(VALID_BODY, {
      issuedAt: new Date(SIGNED_AT.getTime() - 60_000),
      lifetimeMs: 30_000,
    })

    const response = await harness.app.request(`${GATEWAY_ORIGIN}${path}`, init)

    expect(response.status).toBe(401)
    expect(await failureOf(response)).toBe('EXPIRED')
  })

  it('rejects a validity window longer than the configured ceiling', async () => {
    // D-208 calls the credential short-lived, so the *verifier* enforces the
    // window; a caller cannot mint itself an hour of validity.
    const { path, init } = signedRequest(VALID_BODY, { lifetimeMs: 3_600_000 })
    const response = await harness.app.request(`${GATEWAY_ORIGIN}${path}`, init)

    expect(response.status).toBe(401)
    expect(await failureOf(response)).toBe('MALFORMED_SIGNATURE')
  })

  it('rejects a signature minted for another audience', async () => {
    const { path, init } = signedRequest(VALID_BODY, { audience: 'query-gateway:staging' })
    const response = await harness.app.request(`${GATEWAY_ORIGIN}${path}`, init)

    expect(response.status).toBe(401)
    expect(await failureOf(response)).toBe('WRONG_AUDIENCE')
  })

  it('rejects a body tampered with after signing', async () => {
    const tampered = JSON.stringify({
      ...VALID_BODY,
      params: { ...VALID_BODY.params, site_id: '11111111-1111-4111-8111-111111111111' },
    })
    const { path, init } = signedRequest(VALID_BODY, { sentBody: tampered })

    const response = await harness.app.request(`${GATEWAY_ORIGIN}${path}`, init)

    expect(response.status).toBe(401)
    expect(await failureOf(response)).toBe('BODY_MISMATCH')
    expect(harness.reader.calls).toHaveLength(0)
  })

  it('rejects a signature replayed inside its validity window', async () => {
    const { path, init } = signedRequest(VALID_BODY, { nonce: 'nonce-replay-1' })

    const first = await harness.app.request(`${GATEWAY_ORIGIN}${path}`, init)
    expect(first.status).toBe(200)

    const second = await harness.app.request(`${GATEWAY_ORIGIN}${path}`, init)
    expect(second.status).toBe(401)
    expect(await failureOf(second)).toBe('REPLAYED')
    expect(harness.reader.calls).toHaveLength(1)
  })

  it('binds the signature to the request path', async () => {
    // Signed for /v1/query, replayed at a different target: the canonical string
    // no longer reconstructs, so verification fails.
    const { init } = signedRequest(VALID_BODY, { path: '/v1/query?tenant=other' })
    const response = await harness.app.request(`${GATEWAY_ORIGIN}${QUERY_PATH}`, init)

    expect(response.status).toBe(401)
    expect(await failureOf(response)).toBe('BAD_SIGNATURE')
  })

  it('does not expose the query route when no verification key is configured', async () => {
    // An unauthenticatable query endpoint would be an open read surface onto
    // private ClickHouse; not mounting it is the only safe default.
    const disabled = buildApp({ QUERY_SIGNING_PUBLIC_KEY: undefined })
    const { path, init } = signedRequest(VALID_BODY)
    const response = await disabled.app.request(`${GATEWAY_ORIGIN}${path}`, init)

    expect(response.status).toBe(404)
  })
})

describe('query gateway operation allowlist', () => {
  it('rejects an unknown operation ID before contacting ClickHouse', async () => {
    const harness = buildApp()
    const { path, init } = signedRequest({ operation: 'analytics.drop_everything', params: {} })
    const response = await harness.app.request(`${GATEWAY_ORIGIN}${path}`, init)

    expect(response.status).toBe(400)
    const body = errorEnvelopeSchema.parse(await response.json())
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.details['reason']).toBe('UNKNOWN_OPERATION')
    expect(harness.reader.calls).toHaveLength(0)
  })

  it('rejects an operation whose parameters fail their schema', async () => {
    const harness = buildApp()
    const { path, init } = signedRequest({
      operation: 'analytics.overview_hour',
      params: { site_id: 'not-a-uuid', from: '2026-07-01T00:00:00.000Z', to: 'yesterday' },
    })
    const response = await harness.app.request(`${GATEWAY_ORIGIN}${path}`, init)

    expect(response.status).toBe(400)
    expect(harness.reader.calls).toHaveLength(0)
  })

  it('rejects an over-sized request body before verifying anything', async () => {
    const harness = buildApp({ QUERY_MAX_BODY_BYTES: '1024' })
    const { path, init } = signedRequest({
      operation: 'analytics.overview_hour',
      params: { ...VALID_BODY.params, padding: 'x'.repeat(2_048) },
    })
    const response = await harness.app.request(`${GATEWAY_ORIGIN}${path}`, init)

    expect(response.status).toBe(413)
    const body = errorEnvelopeSchema.parse(await response.json())
    expect(body.error.details['limit_bytes']).toBe(1024)
    expect(harness.reader.calls).toHaveLength(0)
  })
})
