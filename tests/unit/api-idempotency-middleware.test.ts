import { loadServiceEnv } from '@openanalytics/domain'
import type { Auth } from '@openanalytics/auth'
import type { Database } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalRequestHash } from '../../apps/api/src/http/idempotency.ts'

/**
 * The `Idempotency-Key` middleware wired into the real `POST /v1/sites` route,
 * with the ledger replaced by an in-memory stand-in.
 *
 * The ledger's own concurrency semantics are proven against a real Postgres in
 * `tests/migration/idempotency.test.ts`; what is proven here is the HTTP half,
 * which that suite cannot see: that the body is still readable by the handler
 * after the middleware has hashed it, that a replay is byte-identical to the
 * original, that a refusal releases the claim, and that each outcome maps onto
 * the status the contract documents.
 */

interface LedgerRow {
  requestHash: string
  responseStatus: number | null
  responseBody: Record<string, unknown> | null
}

const ledger = new Map<string, LedgerRow>()
const handlerCalls = { createSite: 0 }

const rowKey = (ref: { userId: string; scope: string; key: string }): string =>
  `${ref.userId}|${ref.scope}|${ref.key}`

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    claimIdempotencyKey: async (_db: unknown, input: PostgresModule.ClaimIdempotencyKeyInput) => {
      const existing = ledger.get(rowKey(input))
      if (!existing) {
        ledger.set(rowKey(input), {
          requestHash: input.requestHash,
          responseStatus: null,
          responseBody: null,
        })
        return { status: 'claimed' as const }
      }
      if (existing.requestHash !== input.requestHash) return { status: 'conflict' as const }
      if (existing.responseStatus === null) return { status: 'in_progress' as const }
      return {
        status: 'replay' as const,
        responseStatus: existing.responseStatus,
        responseBody: existing.responseBody,
      }
    },
    completeIdempotencyKey: async (
      _db: unknown,
      input: PostgresModule.CompleteIdempotencyKeyInput,
    ) => {
      const row = ledger.get(rowKey(input))
      if (row) {
        row.responseStatus = input.responseStatus
        row.responseBody = input.responseBody ?? null
      }
    },
    releaseIdempotencyKey: async (_db: unknown, ref: PostgresModule.IdempotencyKeyRef) => {
      ledger.delete(rowKey(ref))
    },
    createSite: async (
      _db: unknown,
      input: { slug: string; name: string; ownerUserId: string },
    ) => {
      handlerCalls.createSite += 1
      if (input.slug === 'taken') {
        throw new actual.OwnershipError('slug_taken', 'that site slug is already taken')
      }
      return {
        siteId: `site-${input.slug}`,
        slug: input.slug,
        name: input.name,
        status: 'active' as const,
        role: 'owner' as const,
        isBillingOwner: true,
        trackingKey: { id: 'key-1', publicToken: 'oa_pub_test', keyPrefix: 'oa_pub' },
        createdAt: new Date('2026-07-01T09:30:00.000Z'),
      }
    },
  }
})

const { createApp } = await import('../../apps/api/src/app.ts')

const USER = 'user-1'
const SCOPE = 'sites.create'

const auth = {
  api: {
    getSession: async () => ({
      user: {
        id: USER,
        email: 'a@b.test',
        emailVerified: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      session: { createdAt: new Date('2026-01-01T00:00:00.000Z') },
    }),
  },
  handler: async () => new Response(null),
} as unknown as Auth

const { logger } = createCapturedLogger()
const app = createApp({
  service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
  logger,
  env: loadServiceEnv('api', testEnv()),
  auth,
  db: {} as Database,
})

const createSite = (body: unknown, key?: string) =>
  app.fetch(
    new Request('http://api.test/v1/sites', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key === undefined ? {} : { 'idempotency-key': key }),
      },
      body: JSON.stringify(body),
    }),
  )

beforeEach(() => {
  ledger.clear()
  handlerCalls.createSite = 0
})

describe('Idempotency-Key on POST /v1/sites', () => {
  it('runs the handler and writes no ledger row when the header is absent', async () => {
    const res = await createSite({ slug: 'acme', name: 'Acme' })
    expect(res.status).toBe(201)
    expect(handlerCalls.createSite).toBe(1)
    // Sending a key is the client opting in; an endpoint that stored a row for
    // every request would accumulate state nobody asked for.
    expect(ledger.size).toBe(0)
  })

  it('replays the first response verbatim, however the retry ordered its fields', async () => {
    const first = await createSite({ slug: 'acme', name: 'Acme' }, 'k-1')
    expect(first.status).toBe(201)
    const firstBody = await first.json()

    const second = await createSite({ name: 'Acme', slug: 'acme' }, 'k-1')
    expect(second.status).toBe(201)
    expect(await second.json()).toEqual(firstBody)
    // The point of the ledger: the site was created once.
    expect(handlerCalls.createSite).toBe(1)
  })

  it('leaves the body readable by the handler after hashing it', async () => {
    // The middleware consumes the request body to fingerprint it; if that were
    // not cached, the handler would see an empty body and refuse every keyed
    // create with VALIDATION_FAILED.
    const res = await createSite({ slug: 'readable', name: 'Readable' }, 'k-body')
    expect(res.status).toBe(201)
    expect((await res.json()) as { slug: string }).toMatchObject({ slug: 'readable' })
  })

  it('refuses the same key with a different payload (409)', async () => {
    expect((await createSite({ slug: 'acme', name: 'Acme' }, 'k-2')).status).toBe(201)

    const res = await createSite({ slug: 'other', name: 'Other' }, 'k-2')
    expect(res.status).toBe(409)
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    })
    expect(handlerCalls.createSite).toBe(1)
  })

  it('refuses while the first request is still in flight, naming the reason', async () => {
    // A claim with no stored response is a concurrent request that has not
    // finished; there is nothing to replay and rerunning would create a second
    // site, so the deterministic answer is "retry once it settles".
    const body = { slug: 'acme', name: 'Acme' }
    ledger.set(rowKey({ userId: USER, scope: SCOPE, key: 'k-3' }), {
      requestHash: canonicalRequestHash({ method: 'POST', path: '/v1/sites', body }),
      responseStatus: null,
      responseBody: null,
    })

    const res = await createSite(body, 'k-3')
    expect(res.status).toBe(409)
    expect(
      (await res.json()) as { error: { code: string; details: { reason: string } } },
    ).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT', details: { reason: 'in_progress' } } })
    expect(handlerCalls.createSite).toBe(0)
  })

  it('releases the key when the request was refused, so the caller can retry with it', async () => {
    // Any refusal will do, and a taken slug is the product's own: the two
    // commercial ones this used to exercise are raised only by the gate a hosted
    // deployment registers on `createSite`.
    const refused = await createSite({ slug: 'taken', name: 'Acme' }, 'k-4')
    expect(refused.status).toBe(400)
    expect(ledger.size).toBe(0)

    // Same key, corrected payload: accepted rather than reported as a conflict.
    const retried = await createSite({ slug: 'acme', name: 'Acme' }, 'k-4')
    expect(retried.status).toBe(201)
  })

  it('rejects a key outside 1..255 characters instead of ignoring it', async () => {
    const res = await createSite({ slug: 'acme', name: 'Acme' }, 'k'.repeat(256))
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    })
    expect(handlerCalls.createSite).toBe(0)
    expect(ledger.size).toBe(0)
  })
})
