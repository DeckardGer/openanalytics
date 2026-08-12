import { SENSITIVE_ACTION_MAX_SESSION_AGE_SECONDS, isRecentReauth } from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * Re-authentication recency, the gate every destructive verb shares (D-010).
 *
 * `decideSuccessorSiteState` was here until the open-core split; a cutover's
 * effect on the site depends on the successor's subscription, so it moved to
 * `tests/unit/cloud/ownership.test.ts`.
 */

describe('isRecentReauth', () => {
  const now = new Date('2026-07-22T12:00:00.000Z')

  it('accepts a session created within the window', () => {
    const created = new Date(now.getTime() - 60_000)
    expect(isRecentReauth(created, now)).toBe(true)
  })

  it('rejects a session older than the window', () => {
    const created = new Date(now.getTime() - (SENSITIVE_ACTION_MAX_SESSION_AGE_SECONDS + 1) * 1000)
    expect(isRecentReauth(created, now)).toBe(false)
  })

  it('rejects a session timestamp in the future (clock skew)', () => {
    expect(isRecentReauth(new Date(now.getTime() + 10_000), now)).toBe(false)
  })
})
