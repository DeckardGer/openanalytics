import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { loadServiceEnv } from '@openanalytics/domain'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { signRequest } from '@openanalytics/auth'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../apps/query-gateway/src/app.ts'
import type {
  ClickHouseQuery,
  ClickHouseQueryResult,
  ClickHouseReader,
} from '../../apps/query-gateway/src/clickhouse.ts'
import { InMemoryNonceStore } from '../../apps/query-gateway/src/nonce-store.ts'

/**
 * Milestone 1 gate, docs snapshot 04 Milestone 1 item 4: the timeout and
 * gateway-outage cases.
 *
 * The property under test in both is the same one, and it is the legacy failure
 * this whole architecture is built against: a dependency that is slow or dead
 * must produce an explicit, retryable error — never a confident empty success.
 * Legacy answered 200 for events it had not stored and showed provider outages
 * as "0 revenue" (docs snapshot 01 §4.3, §12.3).
 *
 * Split by what each half can actually prove:
 *
 * - The deadline runs in-process against a reader that never resolves. A real
 *   timeout cannot be provoked through the deployed gateway, because no
 *   allowlisted operation is slow — which is by design, and not something to
 *   weaken by adding a `sleep()` operation to the allowlist.
 * - The outage runs against the deployed gateway with ClickHouse genuinely
 *   stopped, because "what happens when the dependency is gone" is exactly the
 *   question a fake reader cannot answer.
 */

// ---------------------------------------------------------------------------
// Deadline — in-process, deterministic.
// ---------------------------------------------------------------------------

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUBLIC_KEY_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const AUDIENCE = 'query-gateway:test'
const KEY_ID = 'oa-query-2026-07'
const ORIGIN = 'https://gateway.test'

/** Never resolves on its own; settles only when the request deadline aborts it. */
class HangingReader implements ClickHouseReader {
  aborted = false
  calls = 0

  query(input: ClickHouseQuery): Promise<ClickHouseQueryResult> {
    this.calls += 1
    return new Promise((_resolve, reject) => {
      input.signal.addEventListener('abort', () => {
        this.aborted = true
        // Mirrors what a real aborted fetch throws, which is what the route
        // inspects to tell a timeout from a dead upstream.
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })
  }
}

describe('M1 gate — the gateway enforces its own deadline', () => {
  const TIMEOUT_MS = 400

  const build = (reader: ClickHouseReader) => {
    const captured = createCapturedLogger()
    const app = createApp({
      service: createServiceMetadata({ name: 'query-gateway', environment: 'test' }),
      logger: captured.logger,
      env: loadServiceEnv(
        'query-gateway',
        testEnv({
          QUERY_SIGNING_PUBLIC_KEY: PUBLIC_KEY_PEM,
          QUERY_SIGNING_KEY_ID: KEY_ID,
          QUERY_GATEWAY_AUDIENCE: AUDIENCE,
          // The deployed value is 15000 (below ClickHouse's 30s
          // max_execution_time, so the gateway always gives up first). The
          // behaviour is identical at 400ms and the suite stays fast.
          QUERY_TIMEOUT_MS: String(TIMEOUT_MS),
        }),
      ),
      reader,
      nonceStore: new InMemoryNonceStore(),
    })
    return { app, captured }
  }

  const call = async (app: ReturnType<typeof build>['app']) => {
    const body = JSON.stringify({ operation: 'health.clickhouse_roundtrip', params: {} })
    const headers = signRequest({
      privateKeyPem: PRIVATE_KEY_PEM,
      keyId: KEY_ID,
      audience: AUDIENCE,
      method: 'POST',
      url: `${ORIGIN}/v1/query`,
      body,
      nonce: randomUUID(),
      issuedAt: new Date(),
      lifetimeMs: 30_000,
    })
    return app.request(`${ORIGIN}/v1/query`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body,
    })
  }

  it('answers 504 rather than hanging, and never fabricates a result', async () => {
    const reader = new HangingReader()
    const { app } = build(reader)

    const startedAt = performance.now()
    const response = await call(app)
    const elapsed = performance.now() - startedAt

    expect(response.status).toBe(504)

    const payload = (await response.json()) as { error?: { code?: string }; rows?: unknown }
    expect(payload.error?.code).toBe('SERVICE_UNAVAILABLE')
    // The point of the gate item: no empty-but-successful answer.
    expect(payload.rows).toBeUndefined()

    // Bounded by the deadline, not by the reader — which never resolves.
    expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS - 50)
    expect(elapsed).toBeLessThan(TIMEOUT_MS + 2_000)
  })

  it('aborts the upstream query instead of abandoning it', async () => {
    // A `Promise.race` would answer the caller on time while the query kept
    // running server-side, turning every timeout into permanent extra load on
    // an already-slow ClickHouse.
    const reader = new HangingReader()
    const { app } = build(reader)

    await call(app)

    expect(reader.calls).toBe(1)
    expect(reader.aborted).toBe(true)
  })

  it('logs the timeout as retryable so it is distinguishable from a bad request', async () => {
    const reader = new HangingReader()
    const { app, captured } = build(reader)

    await call(app)

    const failures = captured.find('query_failed')
    expect(failures).toHaveLength(1)
    expect(failures[0]?.['timed_out']).toBe(true)
    expect(failures[0]?.['retryable']).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Outage — against the deployed gateway, with ClickHouse actually stopped.
// ---------------------------------------------------------------------------

const GATEWAY_URL = process.env['M1_GATEWAY_URL']
const SIGNING_KEY = process.env['M1_SIGNING_PRIVATE_KEY']
const FLYCTL = process.env['FLYCTL']
const CH_APP = process.env['M1_FLY_APP_CLICKHOUSE']
const LIVE_KEY_ID = process.env['M1_SIGNING_KEY_ID'] ?? 'm1-poc-1'
const LIVE_AUDIENCE = process.env['M1_GATEWAY_AUDIENCE'] ?? 'openanalytics-query-gateway'

// Opt-in beyond the usual live guard: this one stops a machine, so it must not
// run as a side effect of an ordinary integration run.
const OUTAGE_ENABLED = process.env['M1_OUTAGE_TEST'] === 'yes'
const describeIfOutage =
  OUTAGE_ENABLED && GATEWAY_URL && SIGNING_KEY && FLYCTL && CH_APP ? describe : describe.skip

describeIfOutage('M1 gate — ClickHouse outage produces an error, not a false success', () => {
  const url = `${GATEWAY_URL as string}/v1/query`
  const body = JSON.stringify({ operation: 'health.clickhouse_roundtrip', params: {} })
  let machineId = ''

  const fly = (...args: string[]): string =>
    execFileSync(FLYCTL as string, args, { encoding: 'utf8', env: process.env }).trim()

  const signedCall = async () => {
    const headers = signRequest({
      privateKeyPem: SIGNING_KEY as string,
      keyId: LIVE_KEY_ID,
      audience: LIVE_AUDIENCE,
      method: 'POST',
      url,
      body,
      nonce: randomUUID(),
      issuedAt: new Date(),
      lifetimeMs: 30_000,
    })
    const startedAt = performance.now()
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body,
    })
    const payload = (await response.json().catch(() => null)) as {
      error?: { code?: string }
      rows?: unknown
    } | null
    return { status: response.status, payload, elapsed: performance.now() - startedAt }
  }

  const waitForHealthyQuery = async (attempts: number): Promise<boolean> => {
    for (let i = 0; i < attempts; i++) {
      const { status } = await signedCall()
      if (status === 200) return true
      await new Promise((r) => setTimeout(r, 3_000))
    }
    return false
  }

  beforeAll(async () => {
    const machines = JSON.parse(fly('machines', 'list', '--app', CH_APP as string, '--json')) as {
      id: string
      state: string
    }[]
    machineId = machines[0]?.id ?? ''
    expect(machineId).not.toBe('')

    // Establish the baseline before breaking anything: if this is already
    // failing, the outage assertions below would prove nothing.
    const healthy = await signedCall()
    expect(healthy.status).toBe(200)

    fly('machine', 'stop', machineId, '--app', CH_APP as string)
    // Give the proxy a moment to stop routing to the stopped machine.
    await new Promise((r) => setTimeout(r, 5_000))
  }, 180_000)

  afterAll(async () => {
    // Always restore, including when an assertion above failed.
    if (machineId) {
      fly('machine', 'start', machineId, '--app', CH_APP as string)
      await waitForHealthyQuery(30)
    }
  }, 300_000)

  it('returns an explicit retryable error rather than an empty 200', async () => {
    const { status, payload } = await signedCall()

    expect(status).not.toBe(200)
    // 503 when the connection is refused outright, 504 when it hangs until the
    // gateway's own deadline fires. Both are correct and which one occurs
    // depends on how the private network treats a stopped machine; what the
    // gate requires is that it is neither a success nor a hang.
    expect([503, 504]).toContain(status)
    expect(payload?.error?.code).toBe('SERVICE_UNAVAILABLE')
    expect(payload?.rows).toBeUndefined()
  }, 60_000)

  it('bounds the failure by the gateway deadline instead of hanging', async () => {
    const { elapsed } = await signedCall()

    // The deployed timeout is 15s; allow headroom for TLS and the proxy hop.
    expect(elapsed).toBeLessThan(25_000)
  }, 60_000)

  it('keeps the gateway itself healthy while its dependency is down', async () => {
    // A dead dependency must not take the service with it — otherwise a
    // ClickHouse restart would also drop every health check and any future
    // load balancer would pull a gateway that is perfectly able to serve
    // errors and recover.
    const response = await fetch(`${GATEWAY_URL as string}/health`)
    expect(response.status).toBe(200)
  }, 30_000)

  it('recovers once ClickHouse is back', async () => {
    fly('machine', 'start', machineId, '--app', CH_APP as string)
    const recovered = await waitForHealthyQuery(30)
    expect(recovered).toBe(true)
  }, 300_000)
})
