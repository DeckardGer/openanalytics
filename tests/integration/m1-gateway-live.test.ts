import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { signRequest } from '@openanalytics/auth'

/**
 * Milestone 1 gate, gateway half (docs snapshot 04, Milestone 1 items 3-4).
 *
 * These run against the DEPLOYED gateway, not an in-process app, because the
 * thing under test is the whole Vercel-shaped hop: TLS termination at the Fly
 * proxy, the signature surviving real HTTP header handling, and the gateway
 * reaching private ClickHouse over 6PN. An in-process test proves the
 * middleware; only this proves the topology D-208 describes.
 *
 * Skipped unless the environment is supplied, so CI without infrastructure
 * stays green — the same pattern the migration tests use.
 */

const GATEWAY_URL = process.env['M1_GATEWAY_URL']
const SIGNING_KEY = process.env['M1_SIGNING_PRIVATE_KEY']
const KEY_ID = process.env['M1_SIGNING_KEY_ID'] ?? 'm1-poc-1'
const AUDIENCE = process.env['M1_GATEWAY_AUDIENCE'] ?? 'openanalytics-query-gateway'

const describeIfLive = GATEWAY_URL && SIGNING_KEY ? describe : describe.skip

describeIfLive('M1 gate — signed gateway requests against the deployed service', () => {
  const url = `${GATEWAY_URL as string}/v1/query`
  const privateKeyPem = SIGNING_KEY as string

  const roundtrip = JSON.stringify({ operation: 'health.clickhouse_roundtrip', params: {} })

  const sign = (overrides: Partial<Parameters<typeof signRequest>[0]> = {}) =>
    signRequest({
      privateKeyPem,
      keyId: KEY_ID,
      audience: AUDIENCE,
      method: 'POST',
      url,
      body: roundtrip,
      nonce: randomUUID(),
      issuedAt: new Date(),
      lifetimeMs: 30_000,
      ...overrides,
    })

  const post = async (headers: Record<string, string>, body: string) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body,
    })
    return { status: response.status, json: (await response.json()) as unknown }
  }

  const reasonOf = (json: unknown): unknown =>
    (json as { error?: { details?: { reason?: unknown } } }).error?.details?.reason

  it('accepts a correctly signed request and reaches private ClickHouse', async () => {
    const { status, json } = await post(sign(), roundtrip)
    expect(status).toBe(200)
    // Proves the gateway actually reached ClickHouse over 6PN rather than
    // answering from its own process.
    expect(JSON.stringify(json)).toContain('ok')
  })

  it('rejects a replayed nonce', async () => {
    const headers = sign()

    const first = await post(headers, roundtrip)
    expect(first.status).toBe(200)

    const second = await post(headers, roundtrip)
    expect(second.status).toBe(401)
    expect(reasonOf(second.json)).toBe('REPLAYED')
  })

  it('rejects an expired signature', async () => {
    const { status, json } = await post(
      sign({ issuedAt: new Date(Date.now() - 600_000), lifetimeMs: 30_000 }),
      roundtrip,
    )
    expect(status).toBe(401)
    expect(reasonOf(json)).toBe('EXPIRED')
  })

  it('rejects a wrong audience', async () => {
    const { status, json } = await post(sign({ audience: 'some-other-service' }), roundtrip)
    expect(status).toBe(401)
    expect(reasonOf(json)).toBe('WRONG_AUDIENCE')
  })

  it('rejects a tampered body', async () => {
    // Signed for one body, sent with another. The body hash is bound into the
    // canonical string precisely so this cannot pass.
    const tampered = JSON.stringify({
      operation: 'health.clickhouse_roundtrip',
      params: { injected: true },
    })
    const { status, json } = await post(sign(), tampered)
    expect(status).toBe(401)
    expect(reasonOf(json)).toBe('BODY_MISMATCH')
  })

  it('rejects a forged signature', async () => {
    const headers = sign()
    const forged = {
      ...headers,
      'x-oa-signature': Buffer.from('not-a-signature').toString('base64'),
    }
    const { status, json } = await post(forged, roundtrip)
    expect(status).toBe(401)
    expect(reasonOf(json)).toBe('BAD_SIGNATURE')
  })

  it('rejects an unsigned request outright', async () => {
    const { status, json } = await post({}, roundtrip)
    expect(status).toBe(401)
    expect(reasonOf(json)).toBe('MISSING_SIGNATURE')
  })

  it('rejects an operation id that is not on the allowlist', async () => {
    const body = JSON.stringify({ operation: 'analytics.drop_everything', params: {} })
    const { status } = await post(sign({ body }), body)
    expect(status).toBe(400)
  })

  it('rejects raw SQL submitted as an operation id', async () => {
    const body = JSON.stringify({ operation: 'SELECT 1 FROM system.tables', params: {} })
    const { status } = await post(sign({ body }), body)
    expect(status).toBe(400)
  })

  it('rejects a body over the size cap', async () => {
    const big = JSON.stringify({
      operation: 'health.clickhouse_roundtrip',
      params: { pad: 'x'.repeat(70_000) },
    })
    const { status } = await post(sign({ body: big }), big)
    expect(status).toBe(413)
  })
})
