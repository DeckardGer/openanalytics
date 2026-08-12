import { describe, expect, it } from 'vitest'
import { ValkeyNonceStore } from '../../apps/query-gateway/src/nonce-store.ts'

/**
 * The in-memory store is only correct for a single process. Measured against
 * the deployed gateway running two machines, 7 of 10 replayed requests were
 * accepted, because the replay reached the instance that had not seen the
 * nonce. These tests pin the contract the shared store has to satisfy.
 */
describe('ValkeyNonceStore', () => {
  // A fake standing in for Valkey's SET NX PX, including its actual return
  // convention: 'OK' when the key was set, null when it already existed.
  const fakeValkey = (now: () => number) => {
    const keys = new Map<string, number>()
    return {
      keys,
      calls: [] as { key: string; ttlMs: number }[],
      async set(key: string, _v: string, _px: 'PX', ttlMs: number, _nx: 'NX') {
        this.calls.push({ key, ttlMs })
        const existing = keys.get(key)
        if (existing !== undefined && existing > now()) return null
        keys.set(key, now() + ttlMs)
        return 'OK' as const
      },
    }
  }

  it('accepts a nonce once and refuses it thereafter', async () => {
    const now = () => 1_000
    const client = fakeValkey(now)
    const store = new ValkeyNonceStore({ client, now })
    const expiresAt = new Date(31_000)

    expect(await store.consume('n1', expiresAt)).toBe(true)
    expect(await store.consume('n1', expiresAt)).toBe(false)
    expect(await store.consume('n1', expiresAt)).toBe(false)
  })

  it('keeps different nonces independent', async () => {
    const now = () => 1_000
    const store = new ValkeyNonceStore({ client: fakeValkey(now), now })
    expect(await store.consume('a', new Date(31_000))).toBe(true)
    expect(await store.consume('b', new Date(31_000))).toBe(true)
  })

  it('retains a nonce only as long as its signature could still verify', async () => {
    const now = () => 1_000
    const client = fakeValkey(now)
    const store = new ValkeyNonceStore({ client, now })

    await store.consume('n1', new Date(31_000))

    // 30s of remaining signature lifetime, not a fixed window: remembering a
    // nonce for longer than its signature can verify is wasted memory.
    expect(client.calls[0]?.ttlMs).toBe(30_000)
  })

  it('never asks Valkey for a non-positive TTL', async () => {
    // An already-expired signature is refused by the expiry check before it
    // reaches the store, but PX 0 is an error reply rather than a rejection,
    // so it must not be sent even on that path.
    const now = () => 50_000
    const client = fakeValkey(now)
    const store = new ValkeyNonceStore({ client, now })

    await store.consume('stale', new Date(1_000))

    expect(client.calls[0]?.ttlMs).toBeGreaterThan(0)
  })

  it('namespaces keys so the cache cannot collide with other state', async () => {
    const now = () => 1_000
    const client = fakeValkey(now)
    const store = new ValkeyNonceStore({ client, now })

    await store.consume('n1', new Date(31_000))

    expect(client.calls[0]?.key).toBe('oa:gw:nonce:n1')
  })
})
