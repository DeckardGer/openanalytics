import {
  CAPABILITIES,
  capabilitiesForRole,
  isCapability,
  isSiteRole,
  roleHasCapability,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

describe('capability matrix', () => {
  it('gives the owner every site capability', () => {
    // Every one, with no exception to carve out: `billing:self_manage` was the
    // exception until the open-core split, and it left with the bill
    // (`tests/unit/cloud/authz.test.ts`).
    const owner = capabilitiesForRole('owner')
    for (const capability of CAPABILITIES) {
      expect(owner, capability).toContain(capability)
    }
  })

  it('keeps sensitive and destructive capabilities away from admin', () => {
    // The legacy defect: an admin could reach customer revenue data
    // (docs snapshot 01 §10.3). Revenue PII, raw export and deletion are
    // owner-only.
    expect(roleHasCapability('admin', 'team:manage')).toBe(true)
    expect(roleHasCapability('admin', 'credentials:manage')).toBe(true)
    expect(roleHasCapability('admin', 'revenue:read')).toBe(false)
    expect(roleHasCapability('admin', 'export:raw')).toBe(false)
    expect(roleHasCapability('admin', 'site:delete')).toBe(false)
  })

  it('grants a viewer no management capability', () => {
    expect(capabilitiesForRole('viewer')).toEqual([])
  })

  it('lets only owner-only operations pass for the owner and not admin/viewer', () => {
    for (const ownerOnly of ['revenue:read', 'export:raw', 'site:delete'] as const) {
      expect(roleHasCapability('owner', ownerOnly)).toBe(true)
      expect(roleHasCapability('admin', ownerOnly)).toBe(false)
      expect(roleHasCapability('viewer', ownerOnly)).toBe(false)
    }
  })
})

describe('vocabulary guards', () => {
  it('recognizes valid roles and capabilities and rejects others', () => {
    expect(isSiteRole('owner')).toBe(true)
    expect(isSiteRole('superuser')).toBe(false)
    expect(isCapability('site:delete')).toBe(true)
    expect(isCapability('site:nuke')).toBe(false)
  })
})
