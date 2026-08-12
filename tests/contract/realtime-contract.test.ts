import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  publicDashboardSettingsFixture,
  publicRealtimeSnapshotFixture,
  publicRealtimeSnapshotSchema,
  REALTIME_FEED_MAX_EVENTS,
  REALTIME_PRESENT_MAX_VISITORS,
  realtimeControlFixture,
  realtimeControlSchema,
  realtimeSnapshotFixture,
  realtimeSnapshotSchema,
  realtimeStreamEventSchema,
  realtimeTokenResponseFixture,
  realtimeTokenResponseSchema,
} from '@openanalytics/contracts'
import type { PresenceSnapshot } from '@openanalytics/redis'
import { describe, expect, it } from 'vitest'
import {
  controlMessage,
  toPrivateSnapshot,
  toPublicSnapshot,
} from '../../apps/realtime/src/snapshot.ts'

const SPEC_PATH = fileURLToPath(
  new URL('../../packages/contracts/openapi/openapi.yaml', import.meta.url),
)

/**
 * The M9 realtime surface (docs snapshot 02 §17, 05 D-213).
 *
 * The zod schemas and the OpenAPI document are two encodings of one contract;
 * this asserts they agree, that the fixtures are valid against the schemas (and,
 * by their generated-type annotations, against the spec), and that the two
 * D-213 separations — public payload distinct from private, token never in the
 * query string — are actually documented.
 */

describe('realtime token response contract', () => {
  it('accepts a well-formed token response', () => {
    expect(realtimeTokenResponseSchema.safeParse(realtimeTokenResponseFixture).success).toBe(true)
  })

  it('bounds the epoch-check cadence at the D-213 ceiling', () => {
    expect(
      realtimeTokenResponseSchema.safeParse({
        ...realtimeTokenResponseFixture,
        epoch_check_seconds: 16,
      }).success,
    ).toBe(false)
  })

  it('rejects an unknown field rather than ignoring it', () => {
    expect(
      realtimeTokenResponseSchema.safeParse({ ...realtimeTokenResponseFixture, scope: 'private' })
        .success,
    ).toBe(false)
  })
})

describe('realtime snapshot contract', () => {
  it('accepts the private and public fixtures', () => {
    expect(realtimeSnapshotSchema.safeParse(realtimeSnapshotFixture).success).toBe(true)
    expect(publicRealtimeSnapshotSchema.safeParse(publicRealtimeSnapshotFixture).success).toBe(true)
  })

  it('carries cities as their own private breakdown, not smuggled into countries', () => {
    // ADR-0024 admits a city to the private snapshot — as a `cities` array. A
    // country row is still exactly `{country, visitors}`.
    const withCity = {
      ...realtimeSnapshotFixture,
      countries: [{ country: 'US', city: 'New York', visitors: 5 }],
    }
    expect(realtimeSnapshotSchema.safeParse(withCity).success).toBe(false)
    expect(
      realtimeSnapshotSchema.safeParse({
        ...realtimeSnapshotFixture,
        cities: [{ city: 'New York', visitors: 5 }],
      }).success,
    ).toBe(true)
  })

  it('bounds every open-vocabulary breakdown at ten items', () => {
    const rows = <T>(build: (i: number) => T) => Array.from({ length: 11 }, (_, i) => build(i))
    const over: Record<string, unknown>[] = [
      { pages: rows((i) => ({ path: `/p${i}`, visitors: 1 })) },
      { countries: rows(() => ({ country: 'US', visitors: 1 })) },
      { browsers: rows((i) => ({ browser: `b${i}`, visitors: 1 })) },
      { operating_systems: rows((i) => ({ os: `o${i}`, visitors: 1 })) },
      { cities: rows((i) => ({ city: `c${i}`, visitors: 1 })) },
    ]
    for (const patch of over) {
      expect(
        realtimeSnapshotSchema.safeParse({ ...realtimeSnapshotFixture, ...patch }).success,
      ).toBe(false)
    }
  })

  it('keeps the public snapshot to its narrow allowlist (D-213)', () => {
    // The public payload must not be able to carry any private breakdown — the
    // three ADR-0024 additions included, and ADR-0035's `present`, which is the
    // one addition that names individual people and therefore the one whose
    // absence here matters most.
    for (const patch of [
      { pages: [{ path: '/', visitors: 1 }] },
      { browsers: [{ browser: 'chrome', visitors: 1 }] },
      { operating_systems: [{ os: 'windows', visitors: 1 }] },
      { cities: [{ city: 'New York', visitors: 1 }] },
      {
        present: [
          {
            visitor: 'ab12cd34',
            last_seen_at: '2026-07-24T11:59:58.000Z',
            path: '/',
            country: 'US',
            device_type: 'desktop',
            browser: 'chrome',
            os: 'windows',
          },
        ],
      },
    ]) {
      expect(
        publicRealtimeSnapshotSchema.safeParse({ ...publicRealtimeSnapshotFixture, ...patch })
          .success,
      ).toBe(false)
    }
  })

  it('accepts a two-letter country or the literal unknown, nothing else', () => {
    const withCountry = (country: string) => ({
      ...realtimeSnapshotFixture,
      countries: [{ country, visitors: 1 }],
    })
    expect(realtimeSnapshotSchema.safeParse(withCountry('US')).success).toBe(true)
    expect(realtimeSnapshotSchema.safeParse(withCountry('unknown')).success).toBe(true)
    expect(realtimeSnapshotSchema.safeParse(withCountry('USA')).success).toBe(false)
  })
})

describe('realtime control contract', () => {
  it('accepts the control fixture and discriminates the stream union', () => {
    expect(realtimeControlSchema.safeParse(realtimeControlFixture).success).toBe(true)
    expect(realtimeStreamEventSchema.safeParse(realtimeControlFixture).success).toBe(true)
    expect(realtimeStreamEventSchema.safeParse(realtimeSnapshotFixture).success).toBe(true)
  })

  it('covers revocation and fail-closed in the disconnect reasons', () => {
    for (const reason of ['access_revoked', 'auth_unreachable', 'token_expired_reconnect']) {
      expect(
        realtimeControlSchema.safeParse({ type: 'control', action: 'disconnect', reason }).success,
      ).toBe(true)
    }
    expect(
      realtimeControlSchema.safeParse({ type: 'control', action: 'disconnect', reason: 'because' })
        .success,
    ).toBe(false)
  })
})

describe('OpenAPI documents the realtime surface', () => {
  it('documents the three endpoints and the realtimeBearer scheme', async () => {
    const spec = await readFile(SPEC_PATH, 'utf8')
    expect(spec).toContain('/v1/sites/{site_id}/realtime/token:')
    expect(spec).toContain('/v1/public/{share_slug}/realtime/token:')
    expect(spec).toContain('/v1/realtime/stream:')
    expect(spec).toContain('operationId: issueRealtimeToken')
    expect(spec).toContain('operationId: issuePublicRealtimeToken')
    expect(spec).toContain('operationId: streamRealtime')
    expect(spec).toContain('realtimeBearer:')
  })

  it('documents the SSE payload schemas', async () => {
    const spec = await readFile(SPEC_PATH, 'utf8')
    expect(spec).toContain('RealtimeTokenResponse:')
    expect(spec).toContain('RealtimeSnapshot:')
    expect(spec).toContain('PublicRealtimeSnapshot:')
    expect(spec).toContain('RealtimeControl:')
    expect(spec).toContain('text/event-stream:')
  })

  it('documents that the stream refuses a query-string token (D-213)', async () => {
    const spec = await readFile(SPEC_PATH, 'utf8')
    // The stream binds the site from the token, never a query parameter.
    expect(spec).toMatch(/never from a query parameter/)
    expect(spec).toMatch(/query-string token is not accepted/)
  })

  it('documents the token endpoints returning RealtimeTokenResponse with the gated codes', async () => {
    const spec = await readFile(SPEC_PATH, 'utf8')
    // The private endpoint is suspension- and membership-gated (403/404); the
    // public one is opt-in and rate-limited (404/429). Both answer
    // RealtimeTokenResponse. It was a 402 until the open-core split: the product
    // contract has no payment status, and a suspended site is a `403
    // SITE_SUSPENDED` carried by the same response as `FORBIDDEN`.
    const privateBlock = spec.slice(
      spec.indexOf('/v1/sites/{site_id}/realtime/token:'),
      spec.indexOf('/v1/public/{share_slug}/realtime/token:'),
    )
    expect(privateBlock).toMatch(/RealtimeTokenResponse/)
    expect(privateBlock).toMatch(/ForbiddenOrSuspended/)
    expect(privateBlock).toMatch(/SiteNotFound/)

    const publicBlock = spec.slice(
      spec.indexOf('/v1/public/{share_slug}/realtime/token:'),
      spec.indexOf('/v1/realtime/stream:'),
    )
    expect(publicBlock).toMatch(/RealtimeTokenResponse/)
    expect(publicBlock).toMatch(/ShareNotFound/)
    expect(publicBlock).toMatch(/RateLimited/)
  })
})

describe('gateway-emitted wire shapes satisfy the schemas exactly', () => {
  const presence: PresenceSnapshot = {
    activeVisitors: 42,
    truncated: false,
    pages: [{ path: '/', visitors: 20 }],
    countries: [
      { country: 'US', visitors: 15 },
      { country: 'unknown', visitors: 3 },
    ],
    devices: [
      { deviceType: 'desktop', visitors: 30 },
      { deviceType: 'mobile', visitors: 12 },
    ],
    browsers: [{ browser: 'chrome', visitors: 25 }],
    operatingSystems: [{ os: 'windows', visitors: 18 }],
    cities: [{ city: 'New York', visitors: 9 }],
    events: [
      {
        eventId: 'evt-1',
        occurredAtMs: Date.parse('2026-07-24T11:59:58.000Z'),
        visitorId: 'ab12cd34',
        path: '/pricing',
        country: 'US',
        deviceType: 'desktop',
        browser: 'chrome',
        os: 'windows',
        referrer: 'news.ycombinator.com',
      },
      {
        eventId: 'evt-2',
        occurredAtMs: Date.parse('2026-07-24T11:59:50.000Z'),
        visitorId: 'ef56ab78',
        path: '/',
        country: null,
        deviceType: null,
        browser: null,
        os: null,
        referrer: null,
      },
    ],
    present: [
      {
        visitorId: 'ab12cd34',
        lastSeenMs: Date.parse('2026-07-24T11:59:58.000Z'),
        path: '/pricing',
        country: 'US',
        deviceType: 'desktop',
        browser: 'chrome',
        os: 'windows',
      },
      {
        // Present on heartbeats alone: no page recorded, no labels resolved.
        visitorId: 'ef56ab78',
        lastSeenMs: Date.parse('2026-07-24T11:59:50.000Z'),
        path: null,
        country: null,
        deviceType: null,
        browser: null,
        os: null,
      },
    ],
  }
  const generatedAt = new Date('2026-07-24T12:00:00.000Z')

  it('formats a private snapshot that parses as realtimeSnapshotSchema', () => {
    const parsed = realtimeSnapshotSchema.safeParse(toPrivateSnapshot(presence, generatedAt))
    expect(parsed.success).toBe(true)
  })

  it('formats a private snapshot carrying the ADR-0024 breakdowns', () => {
    const payload = toPrivateSnapshot(presence, generatedAt)
    expect(payload.browsers).toEqual([{ browser: 'chrome', visitors: 25 }])
    expect(payload.operating_systems).toEqual([{ os: 'windows', visitors: 18 }])
    expect(payload.cities).toEqual([{ city: 'New York', visitors: 9 }])
  })

  it('formats the feed newest-first, with instants and nulls the schema accepts', () => {
    const payload = toPrivateSnapshot(presence, generatedAt)
    expect(realtimeSnapshotSchema.safeParse(payload).success).toBe(true)
    expect(payload.events[0]).toEqual({
      event_id: 'evt-1',
      occurred_at: '2026-07-24T11:59:58.000Z',
      visitor: 'ab12cd34',
      path: '/pricing',
      country: 'US',
      device_type: 'desktop',
      browser: 'chrome',
      os: 'windows',
      referrer: 'news.ycombinator.com',
    })
    // An unrecorded device stays null — a different statement from `unknown`,
    // which means "recorded, and unrecognised".
    expect(payload.events[1]?.device_type).toBeNull()
  })

  it('coerces an out-of-vocabulary feed device without dropping the event', () => {
    const odd: PresenceSnapshot = {
      ...presence,
      events: [{ ...presence.events[0]!, deviceType: 'smartwatch' }],
    }
    const payload = toPrivateSnapshot(odd, generatedAt)
    expect(payload.events[0]?.device_type).toBe('unknown')
    expect(realtimeSnapshotSchema.safeParse(payload).success).toBe(true)
  })

  it('bounds the feed on the wire at the documented maximum', () => {
    const one = realtimeSnapshotFixture.events[0]!
    expect(
      realtimeSnapshotSchema.safeParse({
        ...realtimeSnapshotFixture,
        events: Array.from({ length: REALTIME_FEED_MAX_EVENTS + 1 }, () => one),
      }).success,
    ).toBe(false)
  })

  it('formats a public snapshot that parses and carries only the allowlist (D-213)', () => {
    const payload = toPublicSnapshot(presence, generatedAt)
    expect(publicRealtimeSnapshotSchema.safeParse(payload).success).toBe(true)
    // Deliberately no private breakdown leaked into the public shape — a city
    // present in the presence source above reaches the private payload only, and
    // so does `present`, which the same source carries two rows of. The formatter
    // is a separate function over a separate type, so this key set is what makes
    // that structural rather than a promise (D-213, ADR-0035).
    expect(Object.keys(payload).sort()).toEqual(['active_visitors', 'generated_at', 'type'])
  })

  it('names present visitors on the private payload, and never their city (ADR-0035)', () => {
    const payload = toPrivateSnapshot(presence, generatedAt)

    expect(realtimeSnapshotSchema.safeParse(payload).success).toBe(true)
    expect(payload.present).toHaveLength(2)
    expect(payload.present[0]).toEqual({
      visitor: 'ab12cd34',
      last_seen_at: '2026-07-24T11:59:58.000Z',
      path: '/pricing',
      country: 'US',
      device_type: 'desktop',
      browser: 'chrome',
      os: 'windows',
    })
    // A heartbeat-only visitor is nameable with every label null — which is the
    // whole point: before `present` this person was an anonymous +1.
    expect(payload.present[1]?.path).toBeNull()

    // The presence store holds a city and the row does not carry one. A city
    // histogram over the active set names nobody; a per-visitor city beside that
    // visitor's own path, browser and OS is a different disclosure (D3).
    expect(payload.cities).toEqual([{ city: 'New York', visitors: 9 }])
    for (const row of payload.present) {
      expect(Object.keys(row).sort()).toEqual([
        'browser',
        'country',
        'device_type',
        'last_seen_at',
        'os',
        'path',
        'visitor',
      ])
    }
  })

  it('bounds the present list on the wire at the documented maximum', () => {
    const one = realtimeSnapshotFixture.present[0]!
    expect(
      realtimeSnapshotSchema.safeParse({
        ...realtimeSnapshotFixture,
        present: Array.from({ length: REALTIME_PRESENT_MAX_VISITORS + 1 }, () => one),
      }).success,
    ).toBe(false)
  })

  it('coerces an out-of-vocabulary device to the unknown bucket the schema allows', () => {
    const odd: PresenceSnapshot = {
      ...presence,
      devices: [{ deviceType: 'smartwatch', visitors: 1 }],
    }
    const parsed = realtimeSnapshotSchema.safeParse(toPrivateSnapshot(odd, generatedAt))
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.devices[0]?.device_type).toBe('unknown')
  })

  it('formats every control transition to a valid RealtimeControl', () => {
    expect(
      realtimeControlSchema.safeParse(controlMessage('disconnect', 'access_revoked')).success,
    ).toBe(true)
    expect(
      realtimeControlSchema.safeParse(controlMessage('disconnect', 'auth_unreachable')).success,
    ).toBe(true)
    expect(
      realtimeControlSchema.safeParse(controlMessage('degraded', 'snapshot_unavailable')).success,
    ).toBe(true)
    expect(realtimeControlSchema.safeParse(controlMessage('recovered', 'ok')).success).toBe(true)
  })
})

describe('public dashboard realtime opt-in (M9)', () => {
  it('carries share_realtime in the settings fixture', () => {
    expect(publicDashboardSettingsFixture.share_realtime).toBe(false)
  })

  it('documents share_realtime on the settings schemas as an opt-in surface', async () => {
    const spec = await readFile(SPEC_PATH, 'utf8')
    expect(spec).toMatch(
      /required: \[enabled, share_slug, share_overview, share_geography, share_realtime\]/,
    )
    // The update request also accepts the flag (default false).
    const updateBlock = spec.slice(spec.indexOf('UpdatePublicDashboardRequest:'))
    expect(updateBlock).toMatch(/share_realtime/)
  })
})
