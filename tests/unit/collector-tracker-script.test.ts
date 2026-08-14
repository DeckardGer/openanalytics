import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { loadPolicy } from '@openanalytics/domain'
import { createLogger, createServiceMetadata } from '@openanalytics/observability'
import { describe, expect, it } from 'vitest'
import { createApp, readTrackerScript } from '../../apps/collector/src/index.ts'

/**
 * `GET /oa.js` from the collector.
 *
 * **The failure this pins shipped.** From v0.3.0 to v0.3.2 a Coolify install
 * served `404` for the tracker: the `tracker-build` image is the shared
 * Dockerfile's `build` stage, that stage did not carry `scripts/`, and
 * `pnpm run tracker:build` is `node scripts/build-tracker.mjs`. With no command
 * of its own the container inherited a bare `node`, read EOF from a closed
 * stdin, exited 0 and wrote nothing — a one-shot reporting success while the
 * shared volume stayed empty. Nothing would have served the file either: the
 * collector mounted no static route, and the platform variants have no Caddy.
 * Meanwhile the dashboard hands every new site
 * `<script src="${COLLECTOR_BASE_URL}/oa.js">`.
 *
 * Two halves, two guards. The build half is
 * `tests/unit/selfhost-release-wiring.test.ts`, which asserts the Dockerfile
 * copies `scripts/` and that the source is in the build context. This file is
 * the serving half.
 *
 * The bundle is written here rather than read from `apps/tracker/bundle`, which
 * exists only after `pnpm run tracker:build` and would make this pass or fail
 * on whether somebody had run it.
 */

const POLICY = loadPolicy({})

const SERVICE = createServiceMetadata({
  name: 'collector',
  version: '0.0.0',
  commit: 'test',
  environment: 'test',
})

/** Silent: what is under test is headers and bytes, not the request log. */
const LOGGER = createLogger({ service: SERVICE, sink: () => undefined })

function appWithScript(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'oa-tracker-'))
  const file = join(dir, 'oa.js')
  writeFileSync(file, body)
  const script = readTrackerScript(pathToFileURL(file))
  expect(script).toBeDefined()

  return createApp({
    env: { ...POLICY, PORT: 0 } as never,
    logger: LOGGER,
    service: SERVICE,
    trackerScript: script!,
  })
}

// Long enough that gzip is smaller than the input, which a one-line file is not.
const BUNDLE = `(()=>{const s="${'x'.repeat(400)}";console.log(s)})();\n`

describe('the collector serves the tracker bundle', () => {
  it('answers /oa.js with the bytes and the headers Caddy would send', async () => {
    const app = appWithScript(BUNDLE)
    const res = await app.request('http://c.example.com/oa.js', {
      headers: { 'Accept-Encoding': 'identity' },
    })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe(BUNDLE)
    expect(res.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600')
    expect(res.headers.get('Vary')).toBe('Accept-Encoding')
    expect(res.headers.get('ETag')).toMatch(/^"oa-[\w-]{16}"$/u)
    // From `publicIngestCors`, not from the route: a site owner who adds
    // `crossorigin` gets real errors instead of "Script error.".
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  it('serves the precompressed copy to a client that accepts gzip', async () => {
    const app = appWithScript(BUNDLE)
    const res = await app.request('http://c.example.com/oa.js', {
      headers: { 'Accept-Encoding': 'gzip, deflate, br' },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Encoding')).toBe('gzip')

    // Decoded by hand: `res.text()` would hand back whatever the runtime chose
    // to do about the encoding, which is not what is under test.
    const raw = Buffer.from(await res.arrayBuffer())
    expect(gunzipSync(raw).toString('utf8')).toBe(BUNDLE)
    expect(raw.byteLength).toBeLessThan(Buffer.byteLength(BUNDLE))
  })

  it('gives the two encodings different tags, so a shared cache cannot mix them', async () => {
    const app = appWithScript(BUNDLE)
    const plain = await app.request('http://c.example.com/oa.js', {
      headers: { 'Accept-Encoding': 'identity' },
    })
    const gzip = await app.request('http://c.example.com/oa.js', {
      headers: { 'Accept-Encoding': 'gzip' },
    })

    expect(plain.headers.get('ETag')).not.toBe(gzip.headers.get('ETag'))
  })

  it('revalidates to a bodyless 304', async () => {
    const app = appWithScript(BUNDLE)
    const first = await app.request('http://c.example.com/oa.js', {
      headers: { 'Accept-Encoding': 'identity' },
    })
    const etag = first.headers.get('ETag')
    expect(etag).not.toBeNull()

    const second = await app.request('http://c.example.com/oa.js', {
      headers: { 'Accept-Encoding': 'identity', 'If-None-Match': etag! },
    })

    expect(second.status).toBe(304)
    expect(await second.text()).toBe('')
    // Still says how long the answer is good for, or the next visit revalidates
    // whatever the tag said.
    expect(second.headers.get('Cache-Control')).toBe('public, max-age=3600')
  })

  it('changes the tag when the bundle changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oa-tracker-'))
    const file = join(dir, 'oa.js')

    writeFileSync(file, 'console.log(1)\n')
    const before = readTrackerScript(pathToFileURL(file))
    writeFileSync(file, 'console.log(2)\n')
    const after = readTrackerScript(pathToFileURL(file))

    expect(before?.etag).toBeDefined()
    expect(after?.etag).not.toBe(before?.etag)
  })
})

describe('a collector with no bundle', () => {
  it('reads nothing from a path that names no file', () => {
    const missing = pathToFileURL(join(tmpdir(), 'oa-tracker-nothing-here', 'oa.js'))
    expect(readTrackerScript(missing)).toBeUndefined()
  })

  it('treats an empty file as no bundle rather than as an empty script', () => {
    // An empty 200 is the worst answer available: every visitor's browser would
    // cache "the tracker is nothing" for an hour.
    const dir = mkdtempSync(join(tmpdir(), 'oa-tracker-'))
    const file = join(dir, 'oa.js')
    writeFileSync(file, '')
    expect(readTrackerScript(pathToFileURL(file))).toBeUndefined()
  })

  it('does not mount the route, so the miss is a 404 an operator can see', async () => {
    const app = createApp({
      env: { ...POLICY, PORT: 0 } as never,
      logger: LOGGER,
      service: SERVICE,
    })

    const res = await app.request('http://c.example.com/oa.js')
    expect(res.status).toBe(404)
  })
})
