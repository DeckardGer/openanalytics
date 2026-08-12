import {
  BUMP_EPOCH_SCRIPT,
  INCREMENT_WINDOWS_SCRIPT,
  InvalidKeyComponentError,
  REALTIME_EPOCH_TTL_MS,
  REALTIME_SITE_EPOCH_SUBJECT,
  QueueConnectionError,
  RATE_LIMIT_WINDOW_TTL_SECONDS,
  botCounterKey,
  buildConnectionOptions,
  dailyBillableKey,
  dailyCeilingKey,
  minuteBucketOf,
  rateLimitIdentityKey,
  rateLimitIpKey,
  rateLimitSiteKey,
  realtimeEpochKey,
  usageCounterKey,
  visitorPresenceKey,
} from '@openanalytics/redis'
import { describe, expect, it } from 'vitest'

/**
 * Realtime-cache key naming and the counter script (docs snapshot 05, D-205,
 * G-005, D-103).
 *
 * The failures these guard against are all silent. A window key without a TTL is
 * a counter that never resets, which throttles a site forever. A usage counter
 * keyed differently from the one the worker reconciles is a limit check reading
 * a number nobody writes. And a bot counter keyed by the matched user agent is
 * unbounded cardinality plus visitor data in a store with no redaction.
 */

describe('realtime cache key naming', () => {
  const at = new Date('2026-07-23T12:34:56.789Z')

  it('buckets rate limits by the minute', () => {
    expect(minuteBucketOf(at)).toBe('2026-07-23T12:34')
    expect(rateLimitIpKey('site-1', 'iphash', '2026-07-23T12:34')).toBe(
      'rl_ip:site-1:iphash:2026-07-23T12:34',
    )
    expect(rateLimitIdentityKey('site-1', 'anon', '2026-07-23T12:34')).toBe(
      'rl_id:site-1:anon:2026-07-23T12:34',
    )
    expect(rateLimitSiteKey('site-1', '2026-07-23T12:34')).toBe('rl_site:site-1:2026-07-23T12:34')
  })

  it('keeps a window key alive one minute past its window', () => {
    // Expiring exactly on the minute would let a caller reset their own counter
    // by timing requests at :59 — and a request arriving at the boundary still
    // has to read the bucket it is leaving.
    expect(RATE_LIMIT_WINDOW_TTL_SECONDS).toBe(120)
  })

  it('separates the daily ceiling from the daily billable count', () => {
    // G-005's ceiling counts every accepted event; the rapid-burn notice counts
    // billable ones against a monthly limit. One counter could not answer both.
    expect(dailyCeilingKey('site-1', '2026-07-23')).toBe('site_day_events:site-1:2026-07-23')
    expect(dailyBillableKey('site-1', '2026-07-23')).toBe('site_day_billable:site-1:2026-07-23')
  })

  it('keys the usage counter the way usage_windows is keyed', () => {
    // (user_id, starts_at) is the unique constraint in migration 0011. The
    // collector cannot mint the window's row id without writing to Postgres, so
    // the natural key is what lets the worker reconcile onto the same counter
    // the collector was reading.
    expect(usageCounterKey('user-1', new Date('2026-07-01T00:00:00.000Z'))).toBe(
      'usage_window:user-1:2026-07-01T00:00:00.000Z',
    )
  })

  it('names the bot counter by rule, never by user agent', () => {
    expect(botCounterKey('site-1', '2026-07-23', 'googlebot')).toBe(
      'sec_bot:site-1:2026-07-23:googlebot',
    )
    // A raw user agent could not be a key component even if someone tried.
    expect(() => botCounterKey('site-1', '2026-07-23', 'Mozilla/5.0 (compatible)')).toThrow(
      InvalidKeyComponentError,
    )
  })

  it('refuses an identifier that could address another site key', () => {
    expect(() => rateLimitSiteKey('site:1', '2026-07-23T12:34')).toThrow(InvalidKeyComponentError)
    expect(() => visitorPresenceKey('')).toThrow(InvalidKeyComponentError)
  })
})

describe('counter script', () => {
  it('sets a TTL when the key is created', () => {
    // Without this every counter is a total rather than a window, and a site
    // that once hit its daily ceiling never ingests again.
    expect(INCREMENT_WINDOWS_SCRIPT).toContain("redis.call('INCRBY', KEYS[i], increment)")
    expect(INCREMENT_WINDOWS_SCRIPT).toContain("redis.call('EXPIRE', KEYS[i], ttl_seconds)")
  })

  it('repairs a key that lost its expiry rather than leaving it immortal', () => {
    expect(INCREMENT_WINDOWS_SCRIPT).toContain("redis.call('TTL', KEYS[i]) < 0")
  })

  it('does not extend a window that is already running', () => {
    // The TTL is set on creation only. Refreshing it on every increment would
    // make a busy site's window slide forward forever and never reset.
    expect(INCREMENT_WINDOWS_SCRIPT).toContain('if value == increment or')
  })
})

describe('access epochs (D-213, ADR-0030 D5)', () => {
  it('reserves the subject `site` for the site-level epoch', () => {
    // The per-subject epoch cuts one member's streams. `site` is the one that
    // cuts every stream on a site, which is what a block and a deletion start
    // need. It cannot collide with a real subject: those are user UUIDs or the
    // literal `public`.
    expect(REALTIME_SITE_EPOCH_SUBJECT).toBe('site')
    expect(realtimeEpochKey('site-1', REALTIME_SITE_EPOCH_SUBJECT)).toBe('rt_epoch:site-1:site')
  })

  it('bumps and expires the epoch key in one script', () => {
    // The keys were immortal before this — one integer per (site, subject)
    // forever, including for members removed long ago. The PEXPIRE is inside the
    // script rather than a second round trip: a bump that created the key and
    // then failed to set its TTL would leave exactly the immortal key the TTL
    // exists to stop.
    expect(BUMP_EPOCH_SCRIPT).toContain("redis.call('INCR', KEYS[1])")
    expect(BUMP_EPOCH_SCRIPT).toContain("redis.call('PEXPIRE', KEYS[1], ARGV[2])")
    // Expiry is fail-closed by construction: a missing epoch reads as
    // `auth_unreachable` at the gateway and the next mint re-seeds it.
    expect(REALTIME_EPOCH_TTL_MS).toBe(30 * 86_400_000)
  })

  it('publishes the new epoch with its subject, so a gateway can match it', () => {
    expect(BUMP_EPOCH_SCRIPT).toContain('"subject":"')
    expect(BUMP_EPOCH_SCRIPT).toContain('"epoch":')
  })
})

describe('realtime-cache connection (D-206)', () => {
  it('requires TLS and AUTH, like the queue hop', () => {
    // The state is losable; the credential protecting it is not. Both hops leave
    // Vercel for the public internet (D-208).
    expect(() =>
      buildConnectionOptions({ mode: 'realtime-cache', url: 'redis://cache.example.com:6379' }),
    ).toThrow(QueueConnectionError)

    expect(() =>
      buildConnectionOptions({ mode: 'realtime-cache', url: 'rediss://cache.example.com:6379' }),
    ).toThrow(QueueConnectionError)

    const options = buildConnectionOptions({
      mode: 'realtime-cache',
      url: 'rediss://default:secret@cache.example.com:6379',
    })
    expect(options.tls).toEqual({ servername: 'cache.example.com' })
  })
})
