import { geoHintFromRecord, readClientIdentity } from '../../apps/collector/src/index.ts'
import { describe, expect, it } from 'vitest'

/** The test root deliberately has no hono dependency; derive the type instead. */
type Context = Parameters<typeof readClientIdentity>[0]

/**
 * Local MMDB geo lookup (ADR-0015 addendum).
 *
 * On our own host nobody injects geo headers, so the collector resolves
 * country/city itself. What is pinned here: the record mapping never invents
 * a country, platform headers still win when a platform provides them, the
 * lookup fills only what is missing, and no address means no lookup at all.
 */

const OPTIONS = { secret: 's'.repeat(32), keyVersion: 1, utcDate: '2026-07-24' }

function fakeContext(headers: Record<string, string>): Context {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return { req: { header: (name: string) => lower[name.toLowerCase()] } } as unknown as Context
}

describe('geoHintFromRecord', () => {
  it('maps a City-schema record to a normalized hint', () => {
    expect(
      geoHintFromRecord({ country: { iso_code: 'fi' }, city: { names: { en: 'Helsinki' } } }),
    ).toEqual({ country: 'FI', city: 'Helsinki' })
  })

  it('never invents a country from a placeholder or junk code', () => {
    expect(geoHintFromRecord({ country: { iso_code: 'XX' } })).toBeNull()
    expect(geoHintFromRecord({ country: { iso_code: 'ZZZ' } })).toBeNull()
    expect(geoHintFromRecord({})).toBeNull()
    expect(geoHintFromRecord(null)).toBeNull()
  })

  it('keeps a city even when the country is unusable', () => {
    expect(
      geoHintFromRecord({ country: { iso_code: 'T1' }, city: { names: { en: 'Espoo' } } }),
    ).toEqual({ country: null, city: 'Espoo' })
  })
})

describe('readClientIdentity with a geo lookup', () => {
  it('fills country and city from the lookup when no platform header provides them', () => {
    const identity = readClientIdentity(
      fakeContext({ 'x-real-ip': '203.0.113.10' }),
      OPTIONS,
      () => ({ country: 'FI', city: 'Helsinki' }),
    )
    expect(identity.country).toBe('FI')
    expect(identity.city).toBe('Helsinki')
    expect(identity.degraded).toBe(false)
  })

  it('lets a platform header win over the local database', () => {
    const identity = readClientIdentity(
      fakeContext({ 'x-real-ip': '203.0.113.10', 'cf-ipcountry': 'DE' }),
      OPTIONS,
      () => ({ country: 'FI', city: 'Helsinki' }),
    )
    // Country came from the platform; the lookup still fills the missing city.
    expect(identity.country).toBe('DE')
    expect(identity.city).toBe('Helsinki')
  })

  it('never calls the lookup without an address, and degrades honestly', () => {
    let called = 0
    const identity = readClientIdentity(fakeContext({}), OPTIONS, () => {
      called += 1
      return { country: 'FI', city: null }
    })
    expect(called).toBe(0)
    expect(identity.country).toBeNull()
    expect(identity.degraded).toBe(true)
  })

  it('treats a null lookup result as plain absence', () => {
    const identity = readClientIdentity(
      fakeContext({ 'x-real-ip': '10.0.0.9' }),
      OPTIONS,
      () => null,
    )
    expect(identity.country).toBeNull()
    expect(identity.city).toBeNull()
    expect(identity.degraded).toBe(false)
  })
})
