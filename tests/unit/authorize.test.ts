import { AuthorizationError, authorizeCapability, canAct } from '@openanalytics/auth'
import { describe, expect, it } from 'vitest'

describe('authorizeCapability', () => {
  it('allows an owner an owner-only operation', () => {
    expect(() => authorizeCapability({ role: 'owner', capability: 'site:delete' })).not.toThrow()
  })

  it('refuses an admin or viewer an owner-only operation', () => {
    // The acceptance criterion: viewer/admin cannot perform owner-only ops.
    for (const role of ['admin', 'viewer'] as const) {
      for (const capability of ['site:delete', 'revenue:read', 'export:raw'] as const) {
        expect(() => authorizeCapability({ role, capability })).toThrow(AuthorizationError)
      }
    }
  })

  it('refuses a viewer a management capability', () => {
    expect(() => authorizeCapability({ role: 'viewer', capability: 'team:manage' })).toThrow(
      AuthorizationError,
    )
  })

  it('reports the role and capability on the error', () => {
    try {
      authorizeCapability({ role: 'viewer', capability: 'site:delete' })
      expect.unreachable('expected AuthorizationError')
    } catch (error) {
      expect(error).toBeInstanceOf(AuthorizationError)
      expect((error as AuthorizationError).role).toBe('viewer')
      expect((error as AuthorizationError).capability).toBe('site:delete')
    }
  })

  it('canAct mirrors the matrix without throwing', () => {
    expect(canAct('admin', 'team:manage')).toBe(true)
    expect(canAct('admin', 'site:delete')).toBe(false)
  })
})
