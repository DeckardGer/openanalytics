import {
  REALTIME_ACCESS_REVOKED_TOPIC,
  REALTIME_SITE_SUBJECT,
  parseRealtimeAccessRevokedPayload,
} from '@openanalytics/domain'
import { REALTIME_SITE_EPOCH_SUBJECT } from '@openanalytics/redis'
import type { Database } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import type { RealtimeCache } from '@openanalytics/redis'
import { createCapturedLogger } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The worker's durable realtime-revocation drain (D-213). It replays the epoch
 * bump the api enqueued in-transaction until the realtime cache acks. A malformed
 * payload is marked failed with a clear reason rather than crashing the batch; a
 * cache error is a per-row failure that requeues, not a lost batch.
 */

const claimed = { rows: [] as { id: string; payload: unknown }[] }
const claimDueOutbox = vi.fn(
  async (_db: unknown, _params: { topic: string; limit: number }) => claimed.rows,
)
const markOutboxDelivered = vi.fn(async (_db: unknown, _id: string) => {})
const markOutboxFailed = vi.fn(async (_db: unknown, _id: string, _reason: string) => {})

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    claimDueOutbox: (db: unknown, params: { topic: string; limit: number }) =>
      claimDueOutbox(db, params),
    markOutboxDelivered: (db: unknown, id: string) => markOutboxDelivered(db, id),
    markOutboxFailed: (db: unknown, id: string, reason: string) => markOutboxFailed(db, id, reason),
  }
})

const { processRealtimeRevocationOutbox } =
  await import('../../apps/worker/src/realtime-revocation-drain.ts')

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const USER = 'removed-9'

interface BumpRecorder {
  calls: { siteId: string; subject: string }[]
  throws: boolean
}

function fakeCache(rec: BumpRecorder): RealtimeCache {
  return {
    bumpEpochAndPublishDisconnect: async (input: { siteId: string; subject: string }) => {
      rec.calls.push(input)
      if (rec.throws) throw new Error('redis down')
      return 1
    },
  } as unknown as RealtimeCache
}

const db = {} as Database

beforeEach(() => {
  claimed.rows = []
  claimDueOutbox.mockClear()
  markOutboxDelivered.mockClear()
  markOutboxFailed.mockClear()
})

describe('realtime revocation drain', () => {
  it('claims the right topic', async () => {
    const rec: BumpRecorder = { calls: [], throws: false }
    const { logger } = createCapturedLogger()
    await processRealtimeRevocationOutbox({ db, cache: fakeCache(rec), logger })
    expect(claimDueOutbox).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ topic: REALTIME_ACCESS_REVOKED_TOPIC }),
    )
  })

  it('bumps the subject and marks delivered on a valid row', async () => {
    claimed.rows = [
      { id: 'row-1', payload: { site_id: SITE, user_id: USER, reason: 'member_removed' } },
    ]
    const rec: BumpRecorder = { calls: [], throws: false }
    const { logger } = createCapturedLogger()
    const result = await processRealtimeRevocationOutbox({ db, cache: fakeCache(rec), logger })

    expect(rec.calls).toEqual([{ siteId: SITE, subject: USER }])
    expect(markOutboxDelivered).toHaveBeenCalledWith(db, 'row-1')
    expect(markOutboxFailed).not.toHaveBeenCalled()
    expect(result).toEqual({ claimed: 1, delivered: 1, failed: 0 })
  })

  it('marks failed (not delivered) on a cache error, so the row requeues', async () => {
    claimed.rows = [
      { id: 'row-2', payload: { site_id: SITE, user_id: USER, reason: 'owner_removed' } },
    ]
    const rec: BumpRecorder = { calls: [], throws: true }
    const { logger } = createCapturedLogger()
    const result = await processRealtimeRevocationOutbox({ db, cache: fakeCache(rec), logger })

    expect(rec.calls).toHaveLength(1)
    expect(markOutboxDelivered).not.toHaveBeenCalled()
    expect(markOutboxFailed).toHaveBeenCalledWith(db, 'row-2', expect.any(String))
    expect(result).toEqual({ claimed: 1, delivered: 0, failed: 1 })
  })

  it('passes the reserved site subject straight through for a site_deleted row', async () => {
    // The deletion-start transaction's durable epoch bump (ADR-0030, D4): the
    // subject is the reserved `site`, not a user, so the drain's bump cuts every
    // stream on the site. The drain needs no branch for it — `user_id` is the
    // subject field, whatever kind of subject it names.
    claimed.rows = [
      {
        id: 'row-5',
        payload: { site_id: SITE, user_id: REALTIME_SITE_SUBJECT, reason: 'site_deleted' },
      },
    ]
    const rec: BumpRecorder = { calls: [], throws: false }
    const { logger } = createCapturedLogger()
    const result = await processRealtimeRevocationOutbox({ db, cache: fakeCache(rec), logger })

    expect(rec.calls).toEqual([{ siteId: SITE, subject: 'site' }])
    expect(markOutboxDelivered).toHaveBeenCalledWith(db, 'row-5')
    expect(result).toEqual({ claimed: 1, delivered: 1, failed: 0 })
  })

  it('marks a malformed payload failed with a clear reason, never crashing', async () => {
    claimed.rows = [
      { id: 'row-3', payload: { site_id: SITE } }, // missing user_id + reason
      { id: 'row-4', payload: { site_id: SITE, user_id: USER, reason: 'not_a_reason' } },
    ]
    const rec: BumpRecorder = { calls: [], throws: false }
    const { logger } = createCapturedLogger()
    const result = await processRealtimeRevocationOutbox({ db, cache: fakeCache(rec), logger })

    // Neither malformed row reached the cache.
    expect(rec.calls).toHaveLength(0)
    expect(markOutboxFailed).toHaveBeenCalledWith(db, 'row-3', 'invalid_payload')
    expect(markOutboxFailed).toHaveBeenCalledWith(db, 'row-4', 'invalid_payload')
    expect(result).toEqual({ claimed: 2, delivered: 0, failed: 2 })
  })
})

describe('realtime access-revoked payload schema', () => {
  it('accepts site_deleted carrying the reserved site subject', () => {
    const payload = parseRealtimeAccessRevokedPayload({
      site_id: SITE,
      user_id: REALTIME_SITE_SUBJECT,
      reason: 'site_deleted',
    })
    expect(payload.user_id).toBe('site')
    expect(payload.reason).toBe('site_deleted')
  })

  it('still refuses a reason outside the enum and an extra field', () => {
    expect(() =>
      parseRealtimeAccessRevokedPayload({ site_id: SITE, user_id: USER, reason: 'site_removed' }),
    ).toThrow(/malformed/iu)
    // strictObject: a payload carrying something the drain would ignore is a
    // producer bug, and failing the row is how it becomes visible.
    expect(() =>
      parseRealtimeAccessRevokedPayload({
        site_id: SITE,
        user_id: USER,
        reason: 'member_removed',
        extra: 1,
      }),
    ).toThrow(/malformed/iu)
  })

  it('pins the domain subject literal to the redis key builder’s', () => {
    // The two packages share no import on purpose (postgres writes this payload
    // and must not gain an ioredis dependency); this is what keeps the mirror
    // honest, exactly as PRESENCE_TOP_N is pinned to its contracts twin.
    expect(REALTIME_SITE_SUBJECT).toBe(REALTIME_SITE_EPOCH_SUBJECT)
  })
})
