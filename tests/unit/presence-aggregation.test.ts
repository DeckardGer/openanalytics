import {
  MAX_HEARTBEAT_INTERVAL_SECONDS,
  MIN_HEARTBEAT_INTERVAL_SECONDS,
  PRESENCE_WINDOW_HEARTBEAT_RATIO,
} from '@openanalytics/contracts'
import {
  BUMP_EPOCH_SCRIPT,
  InvalidKeyComponentError,
  PRESENCE_FEED_MAX,
  PRESENCE_PAGE_HISTORY_MAX,
  PRESENCE_PRESENT_MAX,
  PRESENCE_TOP_N,
  REALTIME_FEED_WINDOW_MS,
  TOUCH_VISITOR_SCRIPT,
  VISITOR_PRESENCE_WINDOW_MS,
  aggregatePresenceSnapshot,
  realtimeControlChannel,
  realtimeEpochKey,
  realtimeFeedKey,
  realtimeUpdatesChannel,
  visitorMetaKey,
  visitorPagesKey,
} from '@openanalytics/redis'
import { describe, expect, it } from 'vitest'

/**
 * Presence-model v2 (docs snapshot 02 §17).
 *
 * The aggregation is pure so its ordering, tie-break and "no metadata counts
 * toward active only" rule are testable without Redis. The key builders carry the
 * same charset guard as the rest of the realtime store: a visitor or subject id
 * that could smuggle a separator would let one key address another's.
 */

describe('presence snapshot aggregation', () => {
  const meta = (fields: Record<string, string>) => fields

  it('counts pages, countries and devices independently, top-N by count', () => {
    const snapshot = aggregatePresenceSnapshot({
      activeVisitors: 5,
      truncated: false,
      entries: [
        meta({ path: '/', country: 'US', device_type: 'desktop', last_seen_ms: '1' }),
        meta({ path: '/', country: 'US', device_type: 'mobile', last_seen_ms: '2' }),
        meta({ path: '/pricing', country: 'DE', device_type: 'desktop', last_seen_ms: '3' }),
        meta({ path: '/', country: 'US', device_type: 'desktop', last_seen_ms: '4' }),
        meta({ path: '/pricing', country: 'US', device_type: 'mobile', last_seen_ms: '5' }),
      ],
    })

    expect(snapshot.activeVisitors).toBe(5)
    expect(snapshot.truncated).toBe(false)
    expect(snapshot.pages).toEqual([
      { path: '/', visitors: 3 },
      { path: '/pricing', visitors: 2 },
    ])
    expect(snapshot.countries).toEqual([
      { country: 'US', visitors: 4 },
      { country: 'DE', visitors: 1 },
    ])
    expect(snapshot.devices).toEqual([
      { deviceType: 'desktop', visitors: 3 },
      { deviceType: 'mobile', visitors: 2 },
    ])
  })

  it('counts a visitor with no metadata toward active only', () => {
    const snapshot = aggregatePresenceSnapshot({
      activeVisitors: 3,
      truncated: false,
      entries: [
        // Only a last_seen_ms: a heartbeat with no page/geo/device.
        meta({ last_seen_ms: '1' }),
        // No metadata hash at all.
        null,
        meta({ path: '/', country: 'US', device_type: 'desktop', last_seen_ms: '2' }),
      ],
    })

    expect(snapshot.activeVisitors).toBe(3)
    expect(snapshot.pages).toEqual([{ path: '/', visitors: 1 }])
    expect(snapshot.countries).toEqual([{ country: 'US', visitors: 1 }])
    expect(snapshot.devices).toEqual([{ deviceType: 'desktop', visitors: 1 }])
  })

  it('breaks a count tie by key ascending, for determinism', () => {
    const snapshot = aggregatePresenceSnapshot({
      activeVisitors: 2,
      truncated: false,
      entries: [meta({ path: '/b' }), meta({ path: '/a' })],
    })
    expect(snapshot.pages).toEqual([
      { path: '/a', visitors: 1 },
      { path: '/b', visitors: 1 },
    ])
  })

  it('counts browser, OS and city independently, under the same top-N rule (ADR-0024)', () => {
    const snapshot = aggregatePresenceSnapshot({
      activeVisitors: 3,
      truncated: false,
      entries: [
        meta({ browser: 'chrome', os: 'windows', city: 'Baku', last_seen_ms: '1' }),
        meta({ browser: 'chrome', os: 'macos', city: 'Baku', last_seen_ms: '2' }),
        // A visitor with geo but no UA class contributes to the city bucket only.
        meta({ city: 'Berlin', last_seen_ms: '3' }),
      ],
    })

    expect(snapshot.browsers).toEqual([{ browser: 'chrome', visitors: 2 }])
    expect(snapshot.operatingSystems).toEqual([
      { os: 'macos', visitors: 1 },
      { os: 'windows', visitors: 1 },
    ])
    expect(snapshot.cities).toEqual([
      { city: 'Baku', visitors: 2 },
      { city: 'Berlin', visitors: 1 },
    ])
  })

  it('caps every open-vocabulary breakdown at the documented top-N', () => {
    const wide = Array.from({ length: PRESENCE_TOP_N + 5 }, (_, i) => {
      const n = String(i).padStart(3, '0')
      return meta({ browser: `b${n}`, os: `o${n}`, city: `c${n}` })
    })
    const snapshot = aggregatePresenceSnapshot({
      activeVisitors: wide.length,
      truncated: false,
      entries: wide,
    })
    expect(snapshot.browsers).toHaveLength(PRESENCE_TOP_N)
    expect(snapshot.operatingSystems).toHaveLength(PRESENCE_TOP_N)
    expect(snapshot.cities).toHaveLength(PRESENCE_TOP_N)
  })

  it('names present visitors newest first, bounded, without a city (ADR-0035 D3)', () => {
    const snapshot = aggregatePresenceSnapshot({
      activeVisitors: 3,
      truncated: false,
      entries: [],
      present: [
        {
          visitorId: 'v1',
          meta: meta({
            last_seen_ms: '1700000200000',
            path: '/pricing',
            country: 'US',
            device_type: 'desktop',
            browser: 'chrome',
            os: 'windows',
            // The store holds one; the row must not.
            city: 'New York',
          }),
        },
        // Present on heartbeats alone, with nothing but liveness recorded. This
        // is the row that could not exist before — the anonymous `+1`.
        { visitorId: 'v2', meta: meta({ last_seen_ms: '1700000100000' }) },
      ],
    })

    expect(snapshot.present).toEqual([
      {
        visitorId: 'v1',
        lastSeenMs: 1_700_000_200_000,
        path: '/pricing',
        country: 'US',
        deviceType: 'desktop',
        browser: 'chrome',
        os: 'windows',
      },
      {
        visitorId: 'v2',
        lastSeenMs: 1_700_000_100_000,
        path: null,
        country: null,
        deviceType: null,
        browser: null,
        os: null,
      },
    ])
    expect(snapshot.present.every((row) => !('city' in row))).toBe(true)
  })

  it('re-applies the present bound on read and drops a visitor with no metadata', () => {
    const snapshot = aggregatePresenceSnapshot({
      activeVisitors: 500,
      truncated: false,
      entries: [],
      present: [
        // No HASH: countable, not nameable. A blank row carrying an id and no
        // last-seen would be a worse answer than being counted and unnamed.
        { visitorId: 'ghost', meta: null },
        // A HASH with an unusable clock is the same case.
        { visitorId: 'broken', meta: meta({ last_seen_ms: 'soon' }) },
        ...Array.from({ length: PRESENCE_PRESENT_MAX + 5 }, (_, index) => ({
          visitorId: `v${index}`,
          meta: meta({ last_seen_ms: String(1_700_000_000_000 - index) }),
        })),
      ],
    })

    expect(snapshot.present).toHaveLength(PRESENCE_PRESENT_MAX)
    expect(snapshot.present[0]?.visitorId).toBe('v0')
    // The count is authoritative and deliberately larger than the named list.
    expect(snapshot.activeVisitors).toBe(500)
  })

  it('is empty rather than absent when the caller has no present list', () => {
    const snapshot = aggregatePresenceSnapshot({
      activeVisitors: 0,
      truncated: false,
      entries: [],
    })
    expect(snapshot.present).toEqual([])
  })

  it('caps pages and countries at the documented top-N', () => {
    const entries = Array.from({ length: PRESENCE_TOP_N + 5 }, (_, i) =>
      meta({ path: `/p${String(i).padStart(3, '0')}`, country: 'US' }),
    )
    const snapshot = aggregatePresenceSnapshot({
      activeVisitors: entries.length,
      truncated: true,
      entries,
    })
    expect(snapshot.pages).toHaveLength(PRESENCE_TOP_N)
    expect(snapshot.truncated).toBe(true)
  })
})

describe('rolling page-view feed (ADR-0024)', () => {
  const entry = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      eventId: 'evt-1',
      occurredAtMs: 1_700_000_000_000,
      visitorId: 'ab12',
      path: '/pricing',
      country: 'AZ',
      deviceType: 'desktop',
      browser: 'chrome',
      os: 'windows',
      referrer: 'google.com',
      ...overrides,
    })

  it('decodes entries in stored order, newest first', () => {
    const snapshot = aggregatePresenceSnapshot({
      activeVisitors: 2,
      truncated: false,
      entries: [],
      feed: [entry({ eventId: 'evt-2', path: '/' }), entry()],
    })

    expect(snapshot.events.map((e) => e.eventId)).toEqual(['evt-2', 'evt-1'])
    expect(snapshot.events[1]).toEqual({
      eventId: 'evt-1',
      occurredAtMs: 1_700_000_000_000,
      visitorId: 'ab12',
      path: '/pricing',
      country: 'AZ',
      deviceType: 'desktop',
      browser: 'chrome',
      os: 'windows',
      referrer: 'google.com',
    })
  })

  it('reports an absent optional as null rather than an empty string', () => {
    const snapshot = aggregatePresenceSnapshot({
      activeVisitors: 1,
      truncated: false,
      entries: [],
      feed: [entry({ country: null, deviceType: '', browser: undefined, referrer: null })],
    })

    const event = snapshot.events[0]
    expect(event?.country).toBeNull()
    expect(event?.deviceType).toBeNull()
    expect(event?.browser).toBeNull()
    expect(event?.referrer).toBeNull()
    // The required fields still came through.
    expect(event?.path).toBe('/pricing')
  })

  it('drops an entry that does not decode, keeping the rest of the feed', () => {
    const snapshot = aggregatePresenceSnapshot({
      activeVisitors: 1,
      truncated: false,
      feed: [
        'not json at all',
        entry({ eventId: 'good' }),
        // Structurally valid JSON, but missing a required field.
        JSON.stringify({ eventId: 'evt-x', path: '/' }),
      ],
      entries: [],
    })

    expect(snapshot.events.map((e) => e.eventId)).toEqual(['good'])
  })

  it('re-applies the bound on read, not only on the write-side trim', () => {
    const snapshot = aggregatePresenceSnapshot({
      activeVisitors: 1,
      truncated: false,
      entries: [],
      feed: Array.from({ length: PRESENCE_FEED_MAX + 10 }, (_, i) => entry({ eventId: `e${i}` })),
    })

    expect(snapshot.events).toHaveLength(PRESENCE_FEED_MAX)
  })

  it('has an empty feed when the caller supplies none', () => {
    expect(
      aggregatePresenceSnapshot({ activeVisitors: 0, truncated: false, entries: [] }).events,
    ).toEqual([])
  })
})

describe('presence-model v2 key naming', () => {
  it('keys metadata and page history by (site, visitor)', () => {
    expect(visitorMetaKey('site-1', 'abcdef01')).toBe('rt_meta:site-1:abcdef01')
    expect(visitorPagesKey('site-1', 'abcdef01')).toBe('rt_pages:site-1:abcdef01')
  })

  it('names the update and control channels and the epoch key', () => {
    expect(realtimeUpdatesChannel('site-1')).toBe('rt_updates:site-1')
    expect(realtimeControlChannel('site-1')).toBe('rt_control:site-1')
    expect(realtimeEpochKey('site-1', 'user-1')).toBe('rt_epoch:site-1:user-1')
    // The public subject is a literal, and a valid key component.
    expect(realtimeEpochKey('site-1', 'public')).toBe('rt_epoch:site-1:public')
  })

  it('keys the rolling feed per site, not per visitor', () => {
    expect(realtimeFeedKey('site-1')).toBe('rt_feed:site-1')
  })

  it('refuses an id that could address another key', () => {
    expect(() => realtimeFeedKey('site:1')).toThrow(InvalidKeyComponentError)
    expect(() => visitorMetaKey('site-1', 'evil:id')).toThrow(InvalidKeyComponentError)
    expect(() => visitorPagesKey('site:1', 'v')).toThrow(InvalidKeyComponentError)
    expect(() => realtimeEpochKey('site-1', 'user:1')).toThrow(InvalidKeyComponentError)
    expect(() => realtimeUpdatesChannel('')).toThrow(InvalidKeyComponentError)
  })
})

describe('presence Lua scripts', () => {
  it('touches atomically: trims, TTLs, bounds the page list and publishes', () => {
    expect(TOUCH_VISITOR_SCRIPT).toContain("redis.call('ZADD', presence, score, visitor)")
    expect(TOUCH_VISITOR_SCRIPT).toContain("redis.call('ZREMRANGEBYSCORE'")
    expect(TOUCH_VISITOR_SCRIPT).toContain("redis.call('PEXPIRE', presence, window_ms)")
    expect(TOUCH_VISITOR_SCRIPT).toContain("redis.call('LTRIM', pages, 0, page_max - 1)")
    expect(TOUCH_VISITOR_SCRIPT).toContain("redis.call('PUBLISH', channel, publish_payload)")
    // The page list only grows when the newest path differs from its head.
    expect(TOUCH_VISITOR_SCRIPT).toContain('if head ~= page_path then')
  })

  it('bumps the epoch and publishes the disconnect in one script', () => {
    expect(BUMP_EPOCH_SCRIPT).toContain("redis.call('INCR', KEYS[1])")
    expect(BUMP_EPOCH_SCRIPT).toContain("redis.call('PUBLISH', KEYS[2]")
    expect(BUMP_EPOCH_SCRIPT).toContain('"epoch":')
  })

  it('retains a bounded page history', () => {
    expect(PRESENCE_PAGE_HISTORY_MAX).toBe(10)
  })

  it('writes the feed inside the same script, bounded and expiring (ADR-0024)', () => {
    expect(TOUCH_VISITOR_SCRIPT).toContain("redis.call('LPUSH', feed, feed_entry)")
    expect(TOUCH_VISITOR_SCRIPT).toContain("redis.call('LTRIM', feed, 0, feed_max - 1)")
    expect(TOUCH_VISITOR_SCRIPT).toContain("redis.call('PEXPIRE', feed, feed_window_ms)")
    // Guarded, so a heartbeat touch updates presence and writes no feed entry.
    expect(TOUCH_VISITOR_SCRIPT).toContain('if has_feed then')
    expect(PRESENCE_FEED_MAX).toBe(50)
  })

  it('outlives the presence window, because it answers a different question', () => {
    expect(REALTIME_FEED_WINDOW_MS).toBeGreaterThan(VISITOR_PRESENCE_WINDOW_MS)
  })

  it('holds three heartbeat intervals, so two lost beats do not drop a visitor (ADR-0035 D8)', () => {
    // The window and the interval ceiling live in packages that share no import
    // — the same mirroring PRESENCE_FEED_MAX and REALTIME_FEED_MAX_EVENTS use —
    // so the relation is pinned here or nowhere. Before this, the ceiling was
    // the *whole* window: an interval of 300 s against a 300 s window means
    // every visitor's presence expires exactly as their next beat arrives.
    expect(MAX_HEARTBEAT_INTERVAL_SECONDS * PRESENCE_WINDOW_HEARTBEAT_RATIO * 1000).toBe(
      VISITOR_PRESENCE_WINDOW_MS,
    )
    // Two would mean one dropped ping drops a present visitor off the board.
    expect(PRESENCE_WINDOW_HEARTBEAT_RATIO).toBeGreaterThanOrEqual(3)
    expect(MIN_HEARTBEAT_INTERVAL_SECONDS).toBeLessThan(MAX_HEARTBEAT_INTERVAL_SECONDS)
  })

  it('holds a visitor present for five minutes, the promise the word makes (ADR-0035 D1)', () => {
    // Not a tuning parameter. It is the window the store trims by and the board
    // says "Online" about, and the two are the same window only because this
    // value is the same value. 60 s was the shortest in the category and made a
    // visitor reading one page for two minutes disappear from their own board.
    expect(VISITOR_PRESENCE_WINDOW_MS).toBe(5 * 60_000)
  })
})
