import { randomBytes } from 'node:crypto'
import {
  createRevenueAdapterRegistry,
  revenueCredentialAad,
  type RevenueObservation,
} from '@openanalytics/domain'
import { createCredentialVault } from '@openanalytics/integrations'
import type { Database, RevenueCredentialRow } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { signStripeWebhook } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeRevenueAdapter, stripeCharge, stripeEvent } from '../support/revenue-fixtures.ts'
import type { RevenueWebhookDeps } from '../../apps/api/src/http/revenue-webhook.ts'

/**
 * The revenue webhook door (ADR-0033, D4).
 *
 * The repository and the pure decision have their own suites; what lives only
 * here is the **order of the checks**, which is the security model:
 *
 * - an unknown token and a token belonging to another provider are both 404,
 *   and deliberately indistinguishable;
 * - the body cap is applied before anything parses — the parser is the first
 *   thing on this path an unauthenticated caller can make do unbounded work;
 * - an invalid signature writes **nothing**: no ledger row, no credential
 *   timestamp, no object head. That is the line between an authenticated body
 *   and an anonymous one;
 * - a disabled credential is acked with 200 and ledgered, so a disconnected site
 *   does not accumulate provider-side retry storms;
 * - a redelivery of an already-`processed` event short-circuits;
 * - a failed tie-break re-fetch answers 5xx and leaves the ledger `received`,
 *   because an acknowledged event is never redelivered and its state would be
 *   lost for good (the M3 production lesson, 2026-07-26).
 */

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const CREDENTIAL = '7c9e2f10-0000-4000-8000-0000000c0ffe'
const TOKEN = 'tok_opaque_abcdef'
const WEBHOOK_SECRET = 'whsec_test_credential_secret'
const API_KEY = 'rk_test_restricted_abcdef1234'

const vault = createCredentialVault(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
)
const aad = revenueCredentialAad({ credentialId: CREDENTIAL, siteId: SITE })

function credential(overrides: Partial<RevenueCredentialRow> = {}): RevenueCredentialRow {
  return {
    id: CREDENTIAL,
    siteId: SITE,
    provider: 'stripe',
    encryptedApiKey: vault.encrypt(API_KEY, aad).stored,
    encryptedWebhookSecret: vault.encrypt(WEBHOOK_SECRET, aad).stored,
    keyVersion: 'k1',
    apiKeyLast4: '1234',
    webhookToken: TOKEN,
    status: 'active',
    createdByUserId: 'u-owner',
    connectedAt: new Date('2026-07-31T00:00:00.000Z'),
    lastVerifiedAt: new Date('2026-07-31T00:00:00.000Z'),
    lastSyncedAt: null,
    lastWebhookAt: null,
    lastError: null,
    disabledAt: null,
    backfillGeneration: 0,
    createdAt: new Date('2026-07-31T00:00:00.000Z'),
    updatedAt: new Date('2026-07-31T00:00:00.000Z'),
    ...overrides,
  }
}

/** What the repository answers and what it was asked, per test. */
const world = {
  credential: null as RevenueCredentialRow | null,
  ledgerFirstSeen: true,
  ledgerStatus: 'received' as 'received' | 'processed' | 'ignored' | 'failed',
  decision: 'apply' as 'apply' | 'skip' | 'refetch_from_provider',
}

const calls = {
  ledgerInserts: [] as Record<string, unknown>[],
  ledgerSettlements: [] as Record<string, unknown>[],
  applies: [] as Record<string, unknown>[],
  credentialUpdates: [] as Record<string, unknown>[],
  fetches: [] as string[],
  disabledNotes: [] as Record<string, unknown>[],
}

/** Never dereferenced: every repository call is stubbed below. */
const db = {} as Database

function deps(overrides: Partial<RevenueWebhookDeps> = {}): RevenueWebhookDeps {
  return {
    db,
    vault,
    adapters: createRevenueAdapterRegistry([
      fakeRevenueAdapter({
        verifyWebhook: ({ rawBody, signatureHeader, signingSecret }) => {
          // The real verifier's contract, reduced to what the route depends on:
          // a signature is valid only under THIS credential's secret. (The
          // verifier itself is exercised against the real HMAC in
          // `stripe-revenue-normalize.test.ts`.)
          const expected = signStripeWebhook({ payload: rawBody, secret: signingSecret })
          const digest = expected.split('v1=')[1]
          if (digest === undefined || signatureHeader === undefined) {
            return { ok: false, reason: 'malformed_header' }
          }
          return signatureHeader.endsWith(digest)
            ? { ok: true }
            : { ok: false, reason: 'no_matching_signature' }
        },
        normalizeEvent: (parsed) => {
          const event = parsed as Record<string, unknown>
          const type = String(event['type'])
          if (type === 'payout.paid') {
            return {
              ok: true,
              event: {
                eventId: String(event['id']),
                eventType: type,
                eventAt: new Date(1_000_000),
                observations: [],
                ignored: 'unhandled_event_type',
              },
            }
          }
          return {
            ok: true,
            event: {
              eventId: String(event['id']),
              eventType: type,
              eventAt: new Date(1_000_000),
              observations: [observation()],
            },
          }
        },
        fetchObject: async (secretKey, _kind, objectId) => {
          calls.fetches.push(secretKey)
          await Promise.resolve()
          if (world.decision === 'refetch_from_provider' && objectId === 'ch_unreachable') {
            return { ok: false, reason: 'unavailable', detail: 'stripe responded 503' }
          }
          return { ok: true, observation: observation() }
        },
      }),
    ]),
    ...overrides,
  }
}

function observation(): RevenueObservation {
  return {
    objectId: world.decision === 'refetch_from_provider' ? 'ch_unreachable' : 'ch_test_1',
    objectKind: 'charge',
    snapshotAt: new Date(1_000_000),
    normalized: {
      object_kind: 'charge',
      status: 'succeeded',
      livemode: false,
      currency: 'usd',
      gross_minor: 4999,
      fee_minor: 0,
      // A webhook payload cannot expand the balance transaction, so a fee is
      // unknown on this path rather than zero.
      fee_currency: '',
      net_minor: 4999,
      occurred_at: '2026-07-31T10:00:00.000Z',
      parent_object_id: '',
      order_id: 'pi_test_1',
      checkout_session_id: '',
      client_reference_id: '',
      subscription_id: '',
      product_id: '',
      product_name: '',
      customer_id: 'cus_test_1',
    },
  }
}

/**
 * The repository, stubbed at the module boundary the route imports.
 *
 * `"nothing was written"` is the assertion three of these tests rest on, and it
 * is far more legible as an empty array than as a `SELECT count(*)`. The
 * Postgres semantics these stand in for — conflict handling, the `FOR UPDATE`
 * decision, cursor upserts — have their own embedded-PG suite.
 */
vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    readRevenueCredentialByWebhookToken: async (_db: unknown, token: string) =>
      world.credential !== null && world.credential.webhookToken === token
        ? world.credential
        : null,
    recordRevenueProviderEvent: async (_db: unknown, input: Record<string, unknown>) => {
      calls.ledgerInserts.push(input)
      return { id: 'ledger-1', firstSeen: world.ledgerFirstSeen, status: world.ledgerStatus }
    },
    markRevenueProviderEvent: async (_db: unknown, input: Record<string, unknown>) => {
      calls.ledgerSettlements.push(input)
    },
    noteDisabledRevenueDelivery: async (_db: unknown, input: Record<string, unknown>) => {
      calls.disabledNotes.push(input)
      return { deliveries: calls.disabledNotes.length }
    },
    applyRevenueObservation: async (_db: unknown, input: Record<string, unknown>) => {
      calls.applies.push(input)
      if (input['force'] === true) {
        return { decision: { action: 'apply', version: 2, reason: 'forced' }, objectRowId: 'o1' }
      }
      if (world.decision === 'apply') {
        return {
          decision: { action: 'apply', version: 1, reason: 'first_observation' },
          objectRowId: 'o1',
        }
      }
      if (world.decision === 'skip') {
        return { decision: { action: 'skip', reason: 'duplicate_snapshot' }, objectRowId: 'o1' }
      }
      return {
        decision: { action: 'refetch_from_provider', reason: 'equal_snapshot_differing_payload' },
        objectRowId: 'o1',
      }
    },
    updateRevenueCredentialState: async (_db: unknown, input: Record<string, unknown>) => {
      calls.credentialUpdates.push(input)
    },
  }
})

const { processRevenueWebhook, REVENUE_WEBHOOK_MAX_BODY_BYTES } =
  await import('../../apps/api/src/http/revenue-webhook.ts')

const BODY = JSON.stringify(stripeEvent('charge.succeeded', stripeCharge()))
const signed = (body: string, secret = WEBHOOK_SECRET): string =>
  signStripeWebhook({ payload: body, secret })

beforeEach(() => {
  world.credential = credential()
  world.ledgerFirstSeen = true
  world.ledgerStatus = 'received'
  world.decision = 'apply'
  calls.ledgerInserts.length = 0
  calls.ledgerSettlements.length = 0
  calls.applies.length = 0
  calls.credentialUpdates.length = 0
  calls.fetches.length = 0
  calls.disabledNotes.length = 0
})

describe('processRevenueWebhook — resolution', () => {
  it('404s an unknown token', async () => {
    world.credential = null
    const result = await processRevenueWebhook(deps(), {
      provider: 'stripe',
      webhookToken: 'nope',
      rawBody: BODY,
      signatureHeader: signed(BODY),
    })
    expect(result).toEqual({ status: 'not_found' })
    expect(calls.ledgerInserts).toHaveLength(0)
  })

  it('404s a token posted to the wrong provider path', async () => {
    const result = await processRevenueWebhook(deps(), {
      provider: 'paddle',
      webhookToken: TOKEN,
      rawBody: BODY,
      signatureHeader: signed(BODY),
    })
    expect(result).toEqual({ status: 'not_found' })
  })

  it('refuses an oversized body before touching the database', async () => {
    const huge = 'x'.repeat(REVENUE_WEBHOOK_MAX_BODY_BYTES + 1)
    const result = await processRevenueWebhook(deps(), {
      provider: 'stripe',
      webhookToken: TOKEN,
      rawBody: huge,
      signatureHeader: signed(huge),
    })
    expect(result).toEqual({ status: 'too_large' })
    expect(calls.ledgerInserts).toHaveLength(0)
  })
})

describe('processRevenueWebhook — signature', () => {
  it('400s a body signed with another site’s secret, and writes nothing', async () => {
    const result = await processRevenueWebhook(deps(), {
      provider: 'stripe',
      webhookToken: TOKEN,
      rawBody: BODY,
      signatureHeader: signed(BODY, 'whsec_some_other_site'),
    })
    expect(result.status).toBe('invalid_signature')
    // The assertion this whole test exists for.
    expect(calls.ledgerInserts).toHaveLength(0)
    expect(calls.applies).toHaveLength(0)
    expect(calls.credentialUpdates).toHaveLength(0)
  })

  it('400s a missing signature header', async () => {
    const result = await processRevenueWebhook(deps(), {
      provider: 'stripe',
      webhookToken: TOKEN,
      rawBody: BODY,
      signatureHeader: undefined,
    })
    expect(result.status).toBe('invalid_signature')
    expect(calls.ledgerInserts).toHaveLength(0)
  })
})

describe('processRevenueWebhook — disabled credential', () => {
  it('acks with 200 and ledgers `ignored` without verifying anything', async () => {
    // A disconnect erased both ciphertexts, so there is no secret left to verify
    // against. 200 is what stops Stripe disabling the customer's endpoint and
    // emailing them about it.
    world.credential = credential({
      status: 'disabled',
      encryptedApiKey: null,
      encryptedWebhookSecret: null,
    })
    const result = await processRevenueWebhook(deps(), {
      provider: 'stripe',
      webhookToken: TOKEN,
      rawBody: BODY,
      signatureHeader: undefined,
    })
    expect(result).toMatchObject({ status: 'ok', ledger: 'ignored', reason: 'credential_disabled' })
    expect(calls.disabledNotes).toHaveLength(1)
    // The ordinary ledger is untouched: nothing about an unverified body may
    // reach the table that records *processed* deliveries.
    expect(calls.ledgerInserts).toHaveLength(0)
  })

  it('writes through the bounded per-credential note, whatever the body', async () => {
    // The write amplification an unauthenticated caller can cause. Keying the
    // row on a payload hash would let one byte of variation add a row; keying it
    // on the credential means N distinct bodies produce N counter increments on
    // one row, which `noteDisabledRevenueDelivery` enforces in SQL.
    world.credential = credential({
      status: 'disabled',
      encryptedApiKey: null,
      encryptedWebhookSecret: null,
    })
    for (const suffix of ['a', 'b', 'c']) {
      await processRevenueWebhook(deps(), {
        provider: 'stripe',
        webhookToken: TOKEN,
        rawBody: `${BODY}${suffix}`,
        signatureHeader: undefined,
      })
    }
    expect(calls.disabledNotes).toHaveLength(3)
    // Same credential every time — the uniqueness key the SQL upserts on.
    expect(new Set(calls.disabledNotes.map((note) => note['credentialId']))).toEqual(
      new Set([CREDENTIAL]),
    )
  })

  it('does not move `last_webhook_at` — a disconnected connection is not alive', async () => {
    world.credential = credential({
      status: 'disabled',
      encryptedApiKey: null,
      encryptedWebhookSecret: null,
    })
    await processRevenueWebhook(deps(), {
      provider: 'stripe',
      webhookToken: TOKEN,
      rawBody: BODY,
      signatureHeader: undefined,
    })
    expect(calls.credentialUpdates).toHaveLength(0)
  })
})

describe('processRevenueWebhook — the happy path and its ledger', () => {
  it('records the delivery, applies the observation and settles `processed`', async () => {
    const result = await processRevenueWebhook(deps(), {
      provider: 'stripe',
      webhookToken: TOKEN,
      rawBody: BODY,
      signatureHeader: signed(BODY),
    })
    expect(result).toEqual({ status: 'ok', ledger: 'processed' })
    expect(calls.ledgerInserts[0]).toMatchObject({ siteId: SITE, source: 'webhook' })
    expect(calls.applies).toHaveLength(1)
    expect(calls.ledgerSettlements[0]).toMatchObject({ status: 'processed' })
    expect(calls.credentialUpdates[0]).toMatchObject({ credentialId: CREDENTIAL, siteId: SITE })
  })

  it('short-circuits a redelivery of an already-processed event', async () => {
    world.ledgerFirstSeen = false
    world.ledgerStatus = 'processed'
    const result = await processRevenueWebhook(deps(), {
      provider: 'stripe',
      webhookToken: TOKEN,
      rawBody: BODY,
      signatureHeader: signed(BODY),
    })
    expect(result).toEqual({ status: 'ok', ledger: 'short_circuit' })
    // The point of the short-circuit: no second apply, so no second version and
    // no second ClickHouse row for one delivery.
    expect(calls.applies).toHaveLength(0)
  })

  it('reprocesses a row a crash left `received`', async () => {
    // The apply layer is idempotent, so redoing the work is safe — and refusing
    // to would leave a delivery permanently unapplied with no way back.
    world.ledgerFirstSeen = false
    world.ledgerStatus = 'received'
    const result = await processRevenueWebhook(deps(), {
      provider: 'stripe',
      webhookToken: TOKEN,
      rawBody: BODY,
      signatureHeader: signed(BODY),
    })
    expect(result).toEqual({ status: 'ok', ledger: 'processed' })
    expect(calls.applies).toHaveLength(1)
  })

  it('ledgers an unconsumed event type as `ignored`, never as an error', async () => {
    const body = JSON.stringify(stripeEvent('payout.paid', { id: 'po_1' }))
    const result = await processRevenueWebhook(deps(), {
      provider: 'stripe',
      webhookToken: TOKEN,
      rawBody: body,
      signatureHeader: signed(body),
    })
    expect(result).toMatchObject({ status: 'ok', ledger: 'ignored' })
    expect(calls.ledgerSettlements[0]).toMatchObject({ status: 'ignored' })
    expect(calls.applies).toHaveLength(0)
  })

  it('flips a degraded credential back to active on a processed delivery', async () => {
    // Degraded means "the last attempt failed". A signed delivery we verified,
    // normalized and applied is evidence that it works.
    world.credential = credential({ status: 'degraded', lastError: 'unauthorized' })
    await processRevenueWebhook(deps(), {
      provider: 'stripe',
      webhookToken: TOKEN,
      rawBody: BODY,
      signatureHeader: signed(BODY),
    })
    expect(calls.credentialUpdates[0]).toMatchObject({ status: 'active', lastError: null })
  })

  it('never moves `last_synced_at` — a webhook is not a sync', async () => {
    // Conflating them would fabricate freshness for a credential whose API key
    // has been revoked but whose endpoint still delivers.
    await processRevenueWebhook(deps(), {
      provider: 'stripe',
      webhookToken: TOKEN,
      rawBody: BODY,
      signatureHeader: signed(BODY),
    })
    expect(calls.credentialUpdates[0]).not.toHaveProperty('lastSyncedAt')
  })
})

describe('processRevenueWebhook — the tie-break', () => {
  it('re-fetches with the decrypted API key and force-applies the answer', async () => {
    world.decision = 'refetch_from_provider'
    // The fetch stub only fails for `ch_unreachable`; give it a reachable id.
    const reachable = deps({
      adapters: createRevenueAdapterRegistry([
        fakeRevenueAdapter({
          verifyWebhook: () => ({ ok: true }),
          normalizeEvent: (parsed) => ({
            ok: true,
            event: {
              eventId: String((parsed as Record<string, unknown>)['id']),
              eventType: 'charge.updated',
              eventAt: new Date(1_000_000),
              observations: [observation()],
            },
          }),
          fetchObject: async (secretKey) => {
            calls.fetches.push(secretKey)
            await Promise.resolve()
            return { ok: true, observation: observation() }
          },
        }),
      ]),
    })

    const result = await processRevenueWebhook(reachable, {
      provider: 'stripe',
      webhookToken: TOKEN,
      rawBody: BODY,
      signatureHeader: signed(BODY),
    })
    expect(result).toEqual({ status: 'ok', ledger: 'processed' })
    // The plaintext key, decrypted with the row's own AAD, reached the provider
    // — and only on this path, which is why it is decrypted lazily.
    expect(calls.fetches).toEqual([API_KEY])
    expect(calls.applies[1]).toMatchObject({ force: true })
    expect(calls.ledgerSettlements[0]?.['result']).toMatchObject({ refetched: 1 })
  })

  it('answers 5xx and leaves the ledger `received` when the re-fetch fails', async () => {
    // The M3 lesson: an acknowledged event is never redelivered, so answering
    // 200 here would lose the state the tie was about, permanently.
    world.decision = 'refetch_from_provider'
    const result = await processRevenueWebhook(deps(), {
      provider: 'stripe',
      webhookToken: TOKEN,
      rawBody: BODY,
      signatureHeader: signed(BODY),
    })
    expect(result).toMatchObject({ status: 'error' })
    expect(calls.ledgerSettlements).toHaveLength(0)
  })
})

describe('processRevenueWebhook — no signing secret set yet (CP6)', () => {
  /**
   * The ordinary state between step one and step two of connecting: the API key
   * is stored and working, and the customer has not yet created the provider
   * endpoint whose signing secret they would paste back.
   */
  const noSecret = () => credential({ encryptedWebhookSecret: null })

  it('answers exactly like a bad signature — 400, and nothing written', async () => {
    world.credential = noSecret()
    const result = await processRevenueWebhook(deps(), {
      provider: 'stripe',
      webhookToken: TOKEN,
      rawBody: BODY,
      signatureHeader: signed(BODY),
    })
    expect(result.status).toBe('invalid_signature')
    // The ledger is a record of deliveries the provider SIGNED. An anonymous
    // body must not be able to write rows into it.
    expect(calls.ledgerInserts).toHaveLength(0)
    expect(calls.applies).toHaveLength(0)
    expect(calls.credentialUpdates).toHaveLength(0)
  })

  it('is indistinguishable from a wrong secret, so it is no oracle', async () => {
    // Anyone who guesses or learns a webhook token reaches this line
    // unauthenticated. A distinguishable answer would tell them which sites have
    // a signing secret configured — i.e. which token is worth forging bodies
    // against and which is worth merely flooding.
    world.credential = noSecret()
    const unset = await processRevenueWebhook(deps(), {
      provider: 'stripe',
      webhookToken: TOKEN,
      rawBody: BODY,
      signatureHeader: signed(BODY),
    })

    world.credential = credential()
    const wrong = await processRevenueWebhook(deps(), {
      provider: 'stripe',
      webhookToken: TOKEN,
      rawBody: BODY,
      signatureHeader: signed(BODY, 'whsec_some_other_site'),
    })

    expect(unset.status).toBe(wrong.status)
    expect(unset.status).toBe('invalid_signature')
  })

  it('is NOT the undecryptable path — that one is ours and stays a 5xx', async () => {
    // Absent is the customer mid-flow and is final; unreadable is our keyring
    // and is retryable. Collapsing them would either make a normal connect state
    // page an operator, or make a lost key look like a client error.
    world.credential = noSecret()
    const absent = await processRevenueWebhook(deps(), {
      provider: 'stripe',
      webhookToken: TOKEN,
      rawBody: BODY,
      signatureHeader: signed(BODY),
    })
    world.credential = credential({ encryptedWebhookSecret: 'k9.AAAA.BBBB' })
    const unreadable = await processRevenueWebhook(deps(), {
      provider: 'stripe',
      webhookToken: TOKEN,
      rawBody: BODY,
      signatureHeader: signed(BODY),
    })
    expect(absent.status).toBe('invalid_signature')
    expect(unreadable.status).toBe('error')
  })

  it('accepts the very same delivery once the secret is set — the two-step flow, end to end', async () => {
    // Step one: no secret, the provider's delivery bounces.
    world.credential = noSecret()
    const before = await processRevenueWebhook(deps(), {
      provider: 'stripe',
      webhookToken: TOKEN,
      rawBody: BODY,
      signatureHeader: signed(BODY),
    })
    expect(before.status).toBe('invalid_signature')
    expect(calls.ledgerInserts).toHaveLength(0)

    // Step two: the customer pastes the signing secret, which `PATCH` stores as
    // a ciphertext under the row-bound AAD — exactly what the fixture builds.
    world.credential = credential()
    const after = await processRevenueWebhook(deps(), {
      provider: 'stripe',
      webhookToken: TOKEN,
      rawBody: BODY,
      signatureHeader: signed(BODY),
    })
    expect(after).toMatchObject({ status: 'ok', ledger: 'processed' })
    expect(calls.ledgerInserts).toHaveLength(1)
    expect(calls.applies).toHaveLength(1)
  })
})

describe('processRevenueWebhook — undecryptable secret', () => {
  it('answers 5xx and does NOT flip the credential degraded', async () => {
    // This path is reachable by anyone who learns a token. The reconcile loop —
    // reachable only by the clock — is the single writer of `degraded`.
    world.credential = credential({ encryptedWebhookSecret: 'k9.AAAA.BBBB' })
    const result = await processRevenueWebhook(deps(), {
      provider: 'stripe',
      webhookToken: TOKEN,
      rawBody: BODY,
      signatureHeader: signed(BODY),
    })
    expect(result).toMatchObject({ status: 'error', reason: 'credential_undecryptable' })
    expect(calls.credentialUpdates).toHaveLength(0)
  })
})
