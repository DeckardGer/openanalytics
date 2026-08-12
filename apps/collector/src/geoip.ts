import { readFileSync } from 'node:fs'
import { Reader, type CityResponse } from 'mmdb-lib'
import { normalizeCountry } from './client-identity.ts'

/**
 * Local MMDB geo lookup (ADR-0015 addendum).
 *
 * On Vercel/Fly the platform injected country/city headers; on our own host
 * nobody does, so the collector resolves geo itself from a local
 * GeoLite2/DB-IP City database. The lookup runs in-process — the address
 * never leaves the machine, which is the only acceptable shape for a
 * privacy-first product — and the database file is a deploy artifact, never
 * committed: it is licensed per-account and refreshed monthly on the host.
 *
 * The reader is db-vendor-agnostic (`.mmdb` format), so a self-hosting fork
 * can point `GEOIP_DB_PATH` at MaxMind or DB-IP alike.
 */

export interface GeoHint {
  readonly country: string | null
  readonly city: string | null
}

export type GeoLookup = (address: string) => GeoHint | null

/** The two fields we read from a City-schema record; everything else ignored. */
interface GeoRecordLike {
  readonly country?: { readonly iso_code?: string }
  readonly city?: { readonly names?: { readonly en?: string } }
}

/** Pure mapping, split out so it is testable without a database file. */
export function geoHintFromRecord(record: GeoRecordLike | null | undefined): GeoHint | null {
  if (!record) return null
  const country = normalizeCountry(record.country?.iso_code)
  const city = record.city?.names?.en?.trim().slice(0, 64) || null
  if (country === null && city === null) return null
  return { country, city }
}

/**
 * Loads the database eagerly and fails startup loudly if the configured path
 * is unreadable — a configured-but-missing database is a deployment mistake,
 * not a degradation to hide (the same rule as every other env failure).
 */
export function createGeoLookupFromFile(path: string): GeoLookup {
  const reader = new Reader<CityResponse>(readFileSync(path))
  return (address: string): GeoHint | null => {
    try {
      return geoHintFromRecord(reader.get(address))
    } catch {
      // An unparseable address is the caller's degradation, never a crash.
      return null
    }
  }
}
