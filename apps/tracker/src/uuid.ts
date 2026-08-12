/**
 * UUIDv7 generation.
 *
 * Docs snapshot 02 §7.1: every historical event carries a client-generated
 * UUIDv7 `event_id`, minted **before** the first send attempt. That ordering is
 * the whole point — if the id were created per attempt, a retry after a lost
 * response would look like a new event and be stored twice. v7 also keeps the
 * time prefix, so queue and ClickHouse keys stay roughly ordered.
 *
 * Layout (RFC 9562): 48-bit big-endian milliseconds, 4-bit version, 12 bits of
 * counter, 2-bit variant, 62 bits of randomness.
 */

const HEX: string[] = []
for (let index = 0; index < 256; index += 1) HEX.push(index.toString(16).padStart(2, '0'))

export interface UuidV7Source {
  /** Wall clock in milliseconds. */
  now(): number
  /** Fills the given array with random bytes. */
  randomBytes(into: Uint8Array): Uint8Array
}

function defaultRandomBytes(into: Uint8Array): Uint8Array {
  const cryptoRef = (globalThis as { crypto?: Crypto }).crypto
  if (cryptoRef && typeof cryptoRef.getRandomValues === 'function') {
    cryptoRef.getRandomValues(into)
    return into
  }
  // Older browsers without WebCrypto still need a well-formed id. Collisions
  // matter less than format here: dedup is `(site_id,event_id)` scoped and the
  // millisecond prefix plus the counter already separates same-tab events.
  for (let index = 0; index < into.length; index += 1) {
    into[index] = Math.floor(Math.random() * 256)
  }
  return into
}

export function createUuidV7(source: Partial<UuidV7Source> = {}): () => string {
  const now = source.now ?? (() => Date.now())
  const randomBytes = source.randomBytes ?? defaultRandomBytes

  let lastMillisecond = -1
  let counter = 0

  return function uuidV7(): string {
    const millisecond = now()

    if (millisecond === lastMillisecond) {
      // Same millisecond: advance the counter so ids stay strictly ordered
      // within a burst instead of relying on random tie-breaks.
      counter = (counter + 1) & 0xfff
    } else {
      lastMillisecond = millisecond
      counter = 0
    }

    const bytes = new Uint8Array(16)
    const time = Math.max(0, Math.floor(millisecond))

    bytes[0] = Math.floor(time / 2 ** 40) & 0xff
    bytes[1] = Math.floor(time / 2 ** 32) & 0xff
    bytes[2] = Math.floor(time / 2 ** 24) & 0xff
    bytes[3] = Math.floor(time / 2 ** 16) & 0xff
    bytes[4] = Math.floor(time / 2 ** 8) & 0xff
    bytes[5] = time & 0xff

    const random = randomBytes(new Uint8Array(10))
    for (let index = 0; index < 10; index += 1) bytes[6 + index] = random[index] ?? 0

    // Version 7 in the high nibble of byte 6, counter in the remaining 12 bits.
    bytes[6] = 0x70 | ((counter >> 8) & 0x0f)
    bytes[7] = counter & 0xff
    // RFC 4122 variant bits.
    bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f)

    const hex = (index: number): string => HEX[bytes[index] ?? 0] ?? '00'

    return (
      `${hex(0)}${hex(1)}${hex(2)}${hex(3)}-${hex(4)}${hex(5)}-${hex(6)}${hex(7)}-` +
      `${hex(8)}${hex(9)}-${hex(10)}${hex(11)}${hex(12)}${hex(13)}${hex(14)}${hex(15)}`
    )
  }
}

/** Process-wide generator used by the tracker runtime. */
export const uuidV7 = createUuidV7()
