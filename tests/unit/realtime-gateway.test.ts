import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import {
  errorEnvelopeSchema,
  publicRealtimeSnapshotSchema,
  realtimeControlSchema,
  realtimeSnapshotSchema,
} from '@openanalytics/contracts'
import { loadServiceEnv } from '@openanalytics/domain'
import {
  loadRealtimeVerifyKey,
  signRealtimeToken,
  type SignRealtimeTokenInput,
} from '@openanalytics/auth'
import type { PresenceSnapshot, RealtimeCache } from '@openanalytics/redis'
import { realtimeControlChannel, realtimeUpdatesChannel } from '@openanalytics/redis'
import { createServiceMetadata, createRecordingMetrics } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../../apps/realtime/src/app.ts'
import { REALTIME_METRICS } from '../../apps/realtime/src/metrics.ts'
import type { RealtimeSubscriber } from '../../apps/realtime/src/subscriber.ts'

/**
 * The M9 realtime SSE gateway (docs snapshot 02 §17, 05 D-213).
 *
 * Every case runs in-process against a real `createApp` instance with a fake
 * cache and a fake subscriber — so the auth path, the shared-snapshot fan-out and
 * the fail-closed liveness are all under test without a live Redis, which
 * Checkpoint 4 owns. Timers are real but tiny: the epoch check and cache window
 * are configured to one second via env overrides.
 */

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const VERIFY_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const SIGNING_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const VERIFY_KEY = loadRealtimeVerifyKey(VERIFY_PEM)

const OTHER_SIGNING_PEM = generateKeyPairSync('ed25519')
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString()

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function presenceOf(active: number): PresenceSnapshot {
  return {
    activeVisitors: active,
    truncated: false,
    pages: [{ path: '/', visitors: active }],
    countries: [{ country: 'US', visitors: active }],
    devices: [{ deviceType: 'desktop', visitors: active }],
    browsers: [{ browser: 'chrome', visitors: active }],
    operatingSystems: [{ os: 'windows', visitors: active }],
    cities: [{ city: 'New York', visitors: active }],
    events: [],
    present: [],
  }
}

/** In-memory Pub/Sub, delivering only to subscribed channels. */
class FakeSubscriber implements RealtimeSubscriber {
  readonly channels = new Set<string>()
  private readonly listeners: ((channel: string, message: string) => void)[] = []
  closed = false

  subscribe(channel: string): Promise<void> {
    this.channels.add(channel)
    return Promise.resolve()
  }
  unsubscribe(channel: string): Promise<void> {
    this.channels.delete(channel)
    return Promise.resolve()
  }
  onMessage(listener: (channel: string, message: string) => void): void {
    this.listeners.push(listener)
  }
  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
  publish(channel: string, message: string): void {
    if (!this.channels.has(channel)) return
    for (const listener of this.listeners) listener(channel, message)
  }
}

/** Fake realtime cache keyed by site; only the two methods the gateway uses. */
class FakeCache {
  readonly epochs = new Map<string, number>()
  readonly presenceBySite = new Map<string, PresenceSnapshot>()
  readonly snapshotCalls: { siteId: string }[] = []
  epochThrows = false
  snapshotFailsRemaining = 0

  setEpoch(siteId: string, subject: string, epoch: number): void {
    this.epochs.set(`${siteId}:${subject}`, epoch)
  }

  getEpoch(input: { siteId: string; subject: string }): Promise<number | null> {
    if (this.epochThrows) return Promise.reject(new Error('realtime cache unreachable'))
    return Promise.resolve(this.epochs.get(`${input.siteId}:${input.subject}`) ?? null)
  }

  readPresenceSnapshot(input: {
    siteId: string
    at: Date
    maxVisitors: number
  }): Promise<PresenceSnapshot> {
    this.snapshotCalls.push({ siteId: input.siteId })
    if (this.snapshotFailsRemaining > 0) {
      this.snapshotFailsRemaining -= 1
      return Promise.reject(new Error('presence scan failed'))
    }
    return Promise.resolve(this.presenceBySite.get(input.siteId) ?? presenceOf(0))
  }
}

interface SseEvent {
  event?: string | undefined
  id?: string | undefined
  data?: string | undefined
  comment?: boolean | undefined
}

function parseFrame(raw: string): SseEvent | null {
  const lines = raw.split('\n')
  const data: string[] = []
  let event: string | undefined
  let id: string | undefined
  let isComment = false
  for (const line of lines) {
    if (line.startsWith(':')) {
      isComment = true
      continue
    }
    const idx = line.indexOf(':')
    const field = idx < 0 ? line : line.slice(0, idx)
    let value = idx < 0 ? '' : line.slice(idx + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'id') id = value
    else if (field === 'data') data.push(value)
  }
  if (data.length === 0 && event === undefined && id === undefined) {
    return isComment ? { comment: true } : null
  }
  return { event, id, data: data.join('\n') }
}

/** Reads an SSE body, buffering parsed frames for assertions. */
class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private buffer = ''
  private readonly frames: SseEvent[] = []
  private cursor = 0
  private done = false

  constructor(body: ReadableStream<Uint8Array>) {
    this.reader = body.getReader()
    void this.pump()
  }

  private async pump(): Promise<void> {
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await this.reader.read()
        if (done) break
        this.buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = this.buffer.indexOf('\n\n')) >= 0) {
          const raw = this.buffer.slice(0, idx)
          this.buffer = this.buffer.slice(idx + 2)
          const frame = parseFrame(raw)
          if (frame) this.frames.push(frame)
        }
      }
    } catch {
      // Stream cancelled/aborted: pump ends.
    } finally {
      this.done = true
    }
  }

  /** Next frame matching `pred`, or throws on timeout. */
  async nextMatching(pred: (e: SseEvent) => boolean, timeoutMs = 4000): Promise<SseEvent> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      while (this.cursor < this.frames.length) {
        const frame = this.frames[this.cursor++]!
        if (pred(frame)) return frame
      }
      if (this.done && this.cursor >= this.frames.length) break
      await sleep(15)
    }
    throw new Error('SSE frame did not arrive before the timeout')
  }

  /** Resolves true when no matching frame arrives inside the window. */
  async expectNone(pred: (e: SseEvent) => boolean, windowMs = 800): Promise<boolean> {
    try {
      await this.nextMatching(pred, windowMs)
      return false
    } catch {
      return true
    }
  }

  cancel(): Promise<void> {
    return this.reader.cancel().catch(() => undefined)
  }
}

const isSnapshot = (e: SseEvent): boolean => e.event === 'snapshot'
const isControl = (e: SseEvent): boolean => e.event === 'control'

function mkToken(overrides: Partial<SignRealtimeTokenInput> = {}): string {
  return signRealtimeToken({
    privateKeyPem: SIGNING_PEM,
    siteId: 'site_a',
    subject: 'user_1',
    scope: 'private',
    epoch: 3,
    siteEpoch: 0,
    issuedAt: new Date(),
    ttlSeconds: 60,
    jti: randomUUID(),
    ...overrides,
  })
}

/**
 * A token as the api minted them before ADR-0030: no `site_epoch` claim at all.
 * Hand-signed, because `signRealtimeToken` now always writes the claim — which
 * is the point, and also why the compatibility case needs its own signer.
 */
function legacyToken(overrides: { epoch?: number; subject?: string } = {}): string {
  const iat = Math.floor(Date.now() / 1000)
  const claims = {
    v: 1,
    aud: 'realtime',
    site_id: 'site_a',
    subject: overrides.subject ?? 'user_1',
    scope: 'private',
    epoch: overrides.epoch ?? 3,
    iat,
    exp: iat + 60,
    jti: randomUUID(),
  }
  const bytes = Buffer.from(JSON.stringify(claims), 'utf8')
  const signature = sign(null, bytes, createPrivateKey(SIGNING_PEM))
  return ['OA1-RT1', bytes.toString('base64url'), signature.toString('base64url')].join('.')
}

interface Harness {
  fetch: (input: Request) => Response | Promise<Response>
  cache: FakeCache
  subscriber: FakeSubscriber
  metrics: ReturnType<typeof createRecordingMetrics>
  captured: ReturnType<typeof createCapturedLogger>
}

const openReaders: SseReader[] = []

function build(overrides: Record<string, string | undefined> = {}): Harness {
  const captured = createCapturedLogger()
  const metrics = createRecordingMetrics()
  const cache = new FakeCache()
  const subscriber = new FakeSubscriber()
  const env = loadServiceEnv(
    'realtime',
    testEnv({
      REALTIME_EPOCH_CHECK_SECONDS: '1',
      REALTIME_SNAPSHOT_CACHE_SECONDS: '1',
      ...overrides,
    }),
  )
  const { app } = createApp({
    service: createServiceMetadata({
      name: 'realtime',
      version: '1.0.0-test',
      environment: 'test',
    }),
    logger: captured.logger,
    env,
    cache: cache as unknown as RealtimeCache,
    subscriber,
    verifyKey: VERIFY_KEY,
    metrics,
  })
  return { fetch: app.fetch, cache, subscriber, metrics, captured }
}

async function connect(
  h: Harness,
  init: { token?: string; query?: string; lastEventId?: string } = {},
): Promise<{ res: Response; reader: SseReader | null }> {
  const headers: Record<string, string> = {}
  if (init.token !== undefined) headers['authorization'] = `Bearer ${init.token}`
  if (init.lastEventId !== undefined) headers['Last-Event-ID'] = init.lastEventId
  const url = `http://realtime.test/v1/realtime/stream${init.query ?? ''}`
  const res = await h.fetch(new Request(url, { headers }))
  if (res.status === 200 && res.body !== null) {
    const reader = new SseReader(res.body)
    openReaders.push(reader)
    return { res, reader }
  }
  return { res, reader: null }
}

afterEach(async () => {
  await Promise.all(openReaders.splice(0).map((reader) => reader.cancel()))
})

describe('realtime stream — connect-time authorization (D-213, fail-closed)', () => {
  it('rejects a missing Authorization header as 401', async () => {
    const h = build()
    const { res } = await connect(h, {})
    expect(res.status).toBe(401)
    const body = errorEnvelopeSchema.parse(await res.json())
    expect(body.error.code).toBe('UNAUTHENTICATED')
    expect(body.error.details['reason']).toBe('missing_bearer')
  })

  it('maps each token defect to a distinct 401 reason', async () => {
    const h = build()
    h.cache.setEpoch('site_a', 'user_1', 3)

    const cases: { token: string; reason: string }[] = [
      { token: 'not-a-token', reason: 'malformed' },
      { token: mkToken({ privateKeyPem: OTHER_SIGNING_PEM }), reason: 'bad_signature' },
      { token: mkToken({ ttlSeconds: 61 }), reason: 'ttl_exceeded' },
      {
        token: mkToken({ issuedAt: new Date(Date.now() - 120_000), ttlSeconds: 30 }),
        reason: 'expired',
      },
    ]
    for (const { token, reason } of cases) {
      const { res } = await connect(h, { token })
      expect(res.status).toBe(401)
      const body = errorEnvelopeSchema.parse(await res.json())
      expect(body.error.details['reason']).toBe(reason)
    }
  })

  it('rejects a tampered payload and a tampered signature as bad_signature', async () => {
    const h = build()
    h.cache.setEpoch('site_a', 'user_1', 3)
    const token = mkToken()
    const [scheme, payload, sig] = token.split('.') as [string, string, string]

    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    claims.site_id = 'site_evil'
    const tamperedPayload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
    const payloadTampered = [scheme, tamperedPayload, sig].join('.')

    const sigBytes = Buffer.from(sig, 'base64url')
    sigBytes[0] = sigBytes[0]! ^ 0xff
    const sigTampered = [scheme, payload, sigBytes.toString('base64url')].join('.')

    for (const bad of [payloadTampered, sigTampered]) {
      const { res } = await connect(h, { token: bad })
      expect(res.status).toBe(401)
      const body = errorEnvelopeSchema.parse(await res.json())
      expect(body.error.details['reason']).toBe('bad_signature')
    }
  })

  it('rejects a wrong-audience token as wrong_audience', async () => {
    const h = build()
    h.cache.setEpoch('site_a', 'user_1', 3)
    // The signer hardcodes aud=realtime, so a wrong audience is hand-built.
    const nowSec = Math.floor(Date.now() / 1000)
    const claims = {
      v: 1,
      aud: 'analytics',
      site_id: 'site_a',
      subject: 'user_1',
      scope: 'private',
      epoch: 3,
      iat: nowSec,
      exp: nowSec + 60,
      jti: randomUUID(),
    }
    const { sign } = await import('node:crypto')
    const { createPrivateKey } = await import('node:crypto')
    const bytes = Buffer.from(JSON.stringify(claims), 'utf8')
    const signature = sign(null, bytes, createPrivateKey(SIGNING_PEM))
    const token = ['OA1-RT1', bytes.toString('base64url'), signature.toString('base64url')].join(
      '.',
    )

    const { res } = await connect(h, { token })
    expect(res.status).toBe(401)
    const body = errorEnvelopeSchema.parse(await res.json())
    expect(body.error.details['reason']).toBe('wrong_audience')
  })

  it('rejects a valid token presented in the query string, header absent (no EventSource auth)', async () => {
    const h = build()
    h.cache.setEpoch('site_a', 'user_1', 3)
    const token = mkToken()
    // A genuinely valid token — but in the query string, and with no header.
    const { res } = await connect(h, { query: `?token=${encodeURIComponent(token)}` })
    expect(res.status).toBe(401)
    const body = errorEnvelopeSchema.parse(await res.json())
    expect(body.error.details['reason']).toBe('query_token_rejected')
    // And it never reached the epoch anchor.
    expect(h.cache.snapshotCalls).toHaveLength(0)
  })

  it('fails closed when the epoch is missing (never seeded / evicted) → auth_unreachable', async () => {
    const h = build()
    // No epoch seeded for this subject.
    const { res } = await connect(h, { token: mkToken() })
    expect(res.status).toBe(401)
    const body = errorEnvelopeSchema.parse(await res.json())
    expect(body.error.details['reason']).toBe('auth_unreachable')
  })

  it('fails closed when the epoch read throws → auth_unreachable (never fail-open)', async () => {
    const h = build()
    h.cache.setEpoch('site_a', 'user_1', 3)
    h.cache.epochThrows = true
    const { res } = await connect(h, { token: mkToken() })
    expect(res.status).toBe(401)
    const body = errorEnvelopeSchema.parse(await res.json())
    expect(body.error.details['reason']).toBe('auth_unreachable')
  })

  it('rejects a token whose epoch no longer matches → revoked', async () => {
    const h = build()
    h.cache.setEpoch('site_a', 'user_1', 4) // current is 4; token snapshotted 3
    const { res } = await connect(h, { token: mkToken({ epoch: 3 }) })
    expect(res.status).toBe(401)
    const body = errorEnvelopeSchema.parse(await res.json())
    expect(body.error.details['reason']).toBe('revoked')
  })

  it('rejects a token whose SITE epoch is behind → revoked (ADR-0030 D5)', async () => {
    // The block/deletion cut: the subject epoch is untouched and still matches,
    // and the connection is refused anyway because the whole site was closed.
    const h = build()
    h.cache.setEpoch('site_a', 'user_1', 3)
    h.cache.setEpoch('site_a', 'site', 2)
    const { res } = await connect(h, { token: mkToken({ epoch: 3, siteEpoch: 1 }) })
    expect(res.status).toBe(401)
    const body = errorEnvelopeSchema.parse(await res.json())
    expect(body.error.details['reason']).toBe('revoked')
  })

  it('admits a connection when the site epoch key is absent, reading it as 0', async () => {
    // Deliberately NOT fail-closed, unlike the subject key. The site key is only
    // created by a mint or a bump, so absent means "never bumped" — epoch 0 —
    // and failing closed would refuse every stream for every site that has had
    // no lifecycle event since the deploy. The subject key above is what still
    // fails closed on a wiped cache.
    const h = build()
    h.cache.setEpoch('site_a', 'user_1', 3)
    h.cache.presenceBySite.set('site_a', presenceOf(1))
    const { res, reader } = await connect(h, { token: mkToken({ epoch: 3, siteEpoch: 0 }) })
    expect(res.status).toBe(200)
    expect(await reader!.nextMatching(isSnapshot)).toBeDefined()
  })

  it('admits a legacy token (site_epoch absent) while the site has never been bumped', async () => {
    // A token minted before ADR-0030 shipped carries no `site_epoch`; the codec
    // reads it as 0. It keeps working until the first site-level bump, which is
    // the correct failure direction.
    const h = build()
    h.cache.setEpoch('site_a', 'user_1', 3)
    h.cache.setEpoch('site_a', 'site', 0)
    h.cache.presenceBySite.set('site_a', presenceOf(1))
    const { res } = await connect(h, { token: legacyToken({ epoch: 3 }) })
    expect(res.status).toBe(200)
  })

  it('rejects that same legacy token once the site epoch has been bumped', async () => {
    const h = build()
    h.cache.setEpoch('site_a', 'user_1', 3)
    h.cache.setEpoch('site_a', 'site', 1)
    const { res } = await connect(h, { token: legacyToken({ epoch: 3 }) })
    expect(res.status).toBe(401)
    expect(errorEnvelopeSchema.parse(await res.json()).error.details['reason']).toBe('revoked')
  })
})

describe('realtime stream — connect and snapshot payloads', () => {
  it('sends an immediate private snapshot with an id, parsing as realtimeSnapshotSchema', async () => {
    const h = build()
    h.cache.setEpoch('site_a', 'user_1', 3)
    h.cache.presenceBySite.set('site_a', presenceOf(7))

    const { res, reader } = await connect(h, { token: mkToken() })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const frame = await reader!.nextMatching(isSnapshot)
    expect(frame.id).toBeDefined()
    expect(Number(frame.id)).toBeGreaterThan(0)
    const payload = realtimeSnapshotSchema.parse(JSON.parse(frame.data!))
    expect(payload.active_visitors).toBe(7)
    expect(payload.pages.length).toBeGreaterThan(0)
  })

  it('serves a public token the narrow public snapshot — no breakdown of any kind', async () => {
    const h = build()
    h.cache.setEpoch('site_a', 'public', 1)
    h.cache.presenceBySite.set('site_a', presenceOf(9))

    const token = mkToken({ subject: 'public', scope: 'public', epoch: 1 })
    const { reader } = await connect(h, { token })
    const frame = await reader!.nextMatching(isSnapshot)
    const parsed = JSON.parse(frame.data!)
    expect(publicRealtimeSnapshotSchema.parse(parsed).active_visitors).toBe(9)
    for (const field of [
      'pages',
      'countries',
      'devices',
      'browsers',
      'operating_systems',
      'cities',
    ]) {
      expect(parsed).not.toHaveProperty(field)
    }
  })

  it("serves data only from the token's site (a wrong-site token is structurally impossible)", async () => {
    const h = build()
    h.cache.setEpoch('site_a', 'user_1', 3)
    h.cache.presenceBySite.set('site_a', presenceOf(3))
    h.cache.presenceBySite.set('site_b', presenceOf(999))

    const { reader } = await connect(h, { token: mkToken({ siteId: 'site_a' }) })
    const frame = await reader!.nextMatching(isSnapshot)
    expect(realtimeSnapshotSchema.parse(JSON.parse(frame.data!)).active_visitors).toBe(3)
    // Every scan targeted site_a; site_b's data was never reachable.
    expect(h.cache.snapshotCalls.every((call) => call.siteId === 'site_a')).toBe(true)
  })
})

describe('realtime stream — shared compute and fan-out (§17: never one scan per client)', () => {
  it('computes the snapshot once for two concurrent clients within the cache window', async () => {
    const h = build()
    h.cache.setEpoch('site_a', 'user_1', 3)
    h.cache.presenceBySite.set('site_a', presenceOf(5))

    const [a, b] = await Promise.all([
      connect(h, { token: mkToken() }),
      connect(h, { token: mkToken() }),
    ])
    await a.reader!.nextMatching(isSnapshot)
    await b.reader!.nextMatching(isSnapshot)

    expect(h.cache.snapshotCalls).toHaveLength(1)
  })

  it('fans a single recompute out to every client with a higher id', async () => {
    const h = build()
    h.cache.setEpoch('site_a', 'user_1', 3)
    h.cache.presenceBySite.set('site_a', presenceOf(5))

    const a = await connect(h, { token: mkToken() })
    const b = await connect(h, { token: mkToken() })
    const firstA = await a.reader!.nextMatching(isSnapshot)
    await b.reader!.nextMatching(isSnapshot)
    const baseId = Number(firstA.id)

    // A visitor changes; a single update triggers one recompute, two sends.
    h.cache.presenceBySite.set('site_a', presenceOf(11))
    h.subscriber.publish(realtimeUpdatesChannel('site_a'), JSON.stringify({ t: Date.now() }))

    const nextA = await a.reader!.nextMatching((e) => isSnapshot(e) && Number(e.id) > baseId)
    const nextB = await b.reader!.nextMatching((e) => isSnapshot(e) && Number(e.id) > baseId)
    expect(realtimeSnapshotSchema.parse(JSON.parse(nextA.data!)).active_visitors).toBe(11)
    expect(realtimeSnapshotSchema.parse(JSON.parse(nextB.data!)).active_visitors).toBe(11)
  })
})

describe('realtime stream — control-channel revocation', () => {
  it('closes exactly the matching subject and leaves the other client open', async () => {
    const h = build()
    h.cache.setEpoch('site_a', 'user_a', 3)
    h.cache.setEpoch('site_a', 'user_b', 3)
    h.cache.presenceBySite.set('site_a', presenceOf(2))

    const a = await connect(h, { token: mkToken({ subject: 'user_a', epoch: 3 }) })
    const b = await connect(h, { token: mkToken({ subject: 'user_b', epoch: 3 }) })
    await a.reader!.nextMatching(isSnapshot)
    await b.reader!.nextMatching(isSnapshot)

    // Revoke user_a: the control message names the new epoch.
    h.subscriber.publish(
      realtimeControlChannel('site_a'),
      JSON.stringify({ subject: 'user_a', epoch: 4 }),
    )

    const control = await a.reader!.nextMatching(isControl)
    const parsed = realtimeControlSchema.parse(JSON.parse(control.data!))
    expect(parsed.action).toBe('disconnect')
    expect(parsed.reason).toBe('access_revoked')

    // user_b stays: it still receives a fresh snapshot after an update.
    h.cache.presenceBySite.set('site_a', presenceOf(6))
    h.subscriber.publish(realtimeUpdatesChannel('site_a'), JSON.stringify({ t: Date.now() }))
    const bSnap = await b.reader!.nextMatching(
      (e) => isSnapshot(e) && JSON.parse(e.data!).active_visitors === 6,
    )
    expect(bSnap).toBeDefined()
    // And user_b never saw a control disconnect.
    expect(await b.reader!.expectNone(isControl, 200)).toBe(true)
  })
})

describe('realtime stream — the site-level control subject (ADR-0030 D5)', () => {
  it('closes every client on the site, whatever their own subject', async () => {
    // The gap M10 closes: `onControl` matched subjects exactly, so nothing could
    // cut *all* of a site's streams — which is precisely what a billing block
    // and a deletion start have to do.
    const h = build()
    h.cache.setEpoch('site_a', 'user_a', 3)
    h.cache.setEpoch('site_a', 'user_b', 3)
    h.cache.setEpoch('site_a', 'site', 0)
    h.cache.presenceBySite.set('site_a', presenceOf(2))

    const a = await connect(h, { token: mkToken({ subject: 'user_a', epoch: 3, siteEpoch: 0 }) })
    const b = await connect(h, { token: mkToken({ subject: 'user_b', epoch: 3, siteEpoch: 0 }) })
    await a.reader!.nextMatching(isSnapshot)
    await b.reader!.nextMatching(isSnapshot)

    h.subscriber.publish(
      realtimeControlChannel('site_a'),
      JSON.stringify({ subject: 'site', epoch: 1 }),
    )

    for (const client of [a, b]) {
      const control = await client.reader!.nextMatching(isControl)
      const parsed = realtimeControlSchema.parse(JSON.parse(control.data!))
      expect(parsed.action).toBe('disconnect')
      // The existing vocabulary, deliberately: the client's behaviour is
      // identical — stop, re-mint, learn why from the API.
      expect(parsed.reason).toBe('access_revoked')
    }
  })

  it('leaves a client whose snapshotted site epoch is already current', async () => {
    const h = build()
    h.cache.setEpoch('site_a', 'user_a', 3)
    h.cache.setEpoch('site_a', 'site', 5)
    h.cache.presenceBySite.set('site_a', presenceOf(1))

    const a = await connect(h, { token: mkToken({ subject: 'user_a', epoch: 3, siteEpoch: 5 }) })
    await a.reader!.nextMatching(isSnapshot)

    // A replayed control message for a bump this client already reflects.
    h.subscriber.publish(
      realtimeControlChannel('site_a'),
      JSON.stringify({ subject: 'site', epoch: 5 }),
    )
    expect(await a.reader!.expectNone(isControl, 200)).toBe(true)
  })

  it('closes on the periodic tick when the control message was missed', async () => {
    // The ≤15s guarantee applied to the site epoch: a dropped publish must not
    // leave a blocked site streaming.
    const h = build()
    h.cache.setEpoch('site_a', 'user_1', 3)
    h.cache.setEpoch('site_a', 'site', 0)
    h.cache.presenceBySite.set('site_a', presenceOf(1))

    const { reader } = await connect(h, { token: mkToken({ epoch: 3, siteEpoch: 0 }) })
    await reader!.nextMatching(isSnapshot)

    h.cache.setEpoch('site_a', 'site', 1)
    const control = await reader!.nextMatching(isControl, 3000)
    expect(realtimeControlSchema.parse(JSON.parse(control.data!)).reason).toBe('access_revoked')
  })
})

describe('realtime stream — liveness of authorization (the 15-second guarantee)', () => {
  it('closes with access_revoked when the epoch advances between checks', async () => {
    const h = build()
    h.cache.setEpoch('site_a', 'user_1', 3)
    h.cache.presenceBySite.set('site_a', presenceOf(1))

    const { reader } = await connect(h, { token: mkToken({ epoch: 3 }) })
    await reader!.nextMatching(isSnapshot)

    // A member removal bumps the epoch; the next 1s check must catch it.
    h.cache.setEpoch('site_a', 'user_1', 4)
    const control = await reader!.nextMatching(isControl, 3000)
    expect(realtimeControlSchema.parse(JSON.parse(control.data!)).reason).toBe('access_revoked')
  })

  it('closes fail-closed with auth_unreachable when the epoch read throws', async () => {
    const h = build()
    h.cache.setEpoch('site_a', 'user_1', 3)
    h.cache.presenceBySite.set('site_a', presenceOf(1))

    const { reader } = await connect(h, { token: mkToken() })
    await reader!.nextMatching(isSnapshot)

    h.cache.epochThrows = true
    const control = await reader!.nextMatching(isControl, 3000)
    expect(realtimeControlSchema.parse(JSON.parse(control.data!)).reason).toBe('auth_unreachable')
    expect(h.metrics.countOf(REALTIME_METRICS.epochCheckFailed)).toBeGreaterThan(0)
  })
})

describe('realtime stream — degraded then recovered (auth alive, data failing)', () => {
  it('emits degraded once on a failed recompute and recovered on the next success', async () => {
    const h = build()
    h.cache.setEpoch('site_a', 'user_1', 3)
    h.cache.presenceBySite.set('site_a', presenceOf(4))

    const { reader } = await connect(h, { token: mkToken() })
    await reader!.nextMatching(isSnapshot)

    // The next recompute throws once; epoch checks keep passing.
    h.cache.snapshotFailsRemaining = 1
    h.subscriber.publish(realtimeUpdatesChannel('site_a'), JSON.stringify({ t: Date.now() }))
    const degraded = await reader!.nextMatching(isControl, 3000)
    expect(realtimeControlSchema.parse(JSON.parse(degraded.data!)).reason).toBe(
      'snapshot_unavailable',
    )

    // A later successful recompute recovers and delivers the snapshot again.
    h.cache.presenceBySite.set('site_a', presenceOf(8))
    h.subscriber.publish(realtimeUpdatesChannel('site_a'), JSON.stringify({ t: Date.now() }))
    const recovered = await reader!.nextMatching(
      (e) => isControl(e) && JSON.parse(e.data!).action === 'recovered',
      3000,
    )
    expect(realtimeControlSchema.parse(JSON.parse(recovered.data!)).reason).toBe('ok')
    const snap = await reader!.nextMatching(
      (e) => isSnapshot(e) && JSON.parse(e.data!).active_visitors === 8,
      3000,
    )
    expect(snap).toBeDefined()
  })
})

describe('realtime stream — Last-Event-ID bounded replay', () => {
  it('always answers a subscribe with a snapshot, whatever the Last-Event-ID says', async () => {
    const h = build()
    h.cache.setEpoch('site_a', 'user_1', 3)
    h.cache.presenceBySite.set('site_a', presenceOf(4))

    // A hub-keeper holds the hub (and its computed sequence) alive.
    const keeper = await connect(h, { token: mkToken() })
    const first = await keeper.reader!.nextMatching(isSnapshot)
    const currentId = Number(first.id)

    // **Inverted deliberately by ADR-0035 D5.** This used to assert silence for
    // a client at or beyond the current sequence — "nothing to replay". It is
    // still true that there is nothing to replay, and it was never true that
    // silence communicated it: a subscriber receiving nothing cannot tell "you
    // are current" from "this stream is broken". The id still does the work it
    // always did — no recompute is forced for a caught-up client — but the
    // snapshot it already holds is re-sent, at the same sequence, because a
    // formatted copy of the cache is free and it re-anchors the client's own
    // staleness clock (REALTIME_SNAPSHOT_MAX_AGE_SECONDS).
    const caughtUp = await connect(h, { token: mkToken(), lastEventId: String(currentId) })
    const replayed = await caughtUp.reader!.nextMatching(isSnapshot)
    expect(Number(replayed.id)).toBe(currentId)

    // Absent Last-Event-ID → immediate snapshot.
    const fresh = await connect(h, { token: mkToken() })
    expect(await fresh.reader!.nextMatching(isSnapshot)).toBeDefined()

    // A stale (older) id → immediate snapshot too.
    const stale = await connect(h, { token: mkToken(), lastEventId: String(currentId - 100) })
    expect(await stale.reader!.nextMatching(isSnapshot)).toBeDefined()
  })
})

describe('realtime stream — unmounted when a dependency is absent', () => {
  it('does not mount the stream without a verify key, and logs stream_routes_unmounted', async () => {
    const captured = createCapturedLogger()
    const env = loadServiceEnv('realtime', testEnv({}))
    const { app } = createApp({
      service: createServiceMetadata({ name: 'realtime', version: 't', environment: 'test' }),
      logger: captured.logger,
      env,
      // No cache, subscriber or verifyKey.
    })
    const res = await app.fetch(new Request('http://realtime.test/v1/realtime/stream'))
    expect(res.status).toBe(404)
    expect(captured.find('stream_routes_unmounted')).toHaveLength(1)
  })
})
