import { describe, expect, it } from 'vitest'
import {
  PublicDashboardConfigError,
  coarsenPublicGeography,
  loadPublicDashboardConfig,
  type GeographyRow,
} from '@openanalytics/domain'

/**
 * Public-dashboard city-privacy coarsening (docs snapshot 02 §20; plan Milestone
 * 7 item 8) and the G-008 gate discipline (AGENTS.md: a gated value is not an
 * invented default).
 */

const ROWS: GeographyRow[] = [
  { country: 'US', city: 'New York', views: 500, visitors: 300 },
  { country: 'US', city: 'Springfield', views: 20, visitors: 4 },
  { country: 'US', city: 'Rivertown', views: 10, visitors: 2 },
  { country: 'DE', city: 'Berlin', views: 200, visitors: 120 },
  { country: 'DE', city: '', views: 5, visitors: 1 },
]

describe('coarsenPublicGeography — G-008 fail-closed', () => {
  it('suppresses every city when the threshold is unset (defensive lost-config branch)', () => {
    const out = coarsenPublicGeography(ROWS, undefined)
    // No row keeps a city label; each country folds into one suppressed bucket.
    expect(out.every((r) => r.city === null && r.city_suppressed)).toBe(true)
    const us = out.find((r) => r.country === 'US')
    expect(us).toEqual({
      country: 'US',
      city: null,
      views: 530,
      visitors: 306,
      city_suppressed: true,
    })
  })

  it('names only cities at or above the set threshold, folding the rest', () => {
    const out = coarsenPublicGeography(ROWS, 100)
    const named = out.filter((r) => !r.city_suppressed)
    expect(named.map((r) => r.city).sort()).toEqual(['Berlin', 'New York'])

    // The two small US cities collapse into a single suppressed US bucket.
    const usOther = out.find((r) => r.country === 'US' && r.city_suppressed)
    expect(usOther).toEqual({
      country: 'US',
      city: null,
      views: 30,
      visitors: 6,
      city_suppressed: true,
    })
  })

  it('never leaks a below-threshold city even with a non-empty name', () => {
    const out = coarsenPublicGeography(ROWS, 100)
    expect(out.some((r) => r.city === 'Springfield')).toBe(false)
    expect(out.some((r) => r.city === 'Rivertown')).toBe(false)
  })

  it('is ordered deterministically by views then country/city', () => {
    const out = coarsenPublicGeography(ROWS, 100)
    const views = out.map((r) => r.views)
    expect(views).toEqual([...views].sort((a, b) => b - a))
  })
})

describe('public dashboard config', () => {
  it('defaults the city threshold to 1 — every city is named (ADR-0017, G-008 closed)', () => {
    const config = loadPublicDashboardConfig({})
    expect(config.PUBLIC_CITY_MIN_VISITORS).toBe(1)
    expect(config.PUBLIC_READ_RATE_LIMIT_PER_MINUTE).toBe(60)
  })

  it('accepts an operator-raised threshold', () => {
    const config = loadPublicDashboardConfig({ PUBLIC_CITY_MIN_VISITORS: '50' })
    expect(config.PUBLIC_CITY_MIN_VISITORS).toBe(50)
  })

  it('rejects a non-positive threshold', () => {
    expect(() => loadPublicDashboardConfig({ PUBLIC_CITY_MIN_VISITORS: '0' })).toThrow(
      PublicDashboardConfigError,
    )
  })
})
