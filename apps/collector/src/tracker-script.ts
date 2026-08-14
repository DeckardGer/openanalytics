import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { Hono } from 'hono'

/**
 * `oa.js` itself, served by the collector.
 *
 * **This is a second server for one file, and the reason is that the first one
 * is not always there.** On the stock compose Caddy serves `/oa.js` from the
 * shared `tracker` volume and never forwards it here, and `Caddyfile:82-90` says
 * why: a static file has no business travelling through a Node request pipeline
 * with its logging and metrics. That argument holds wherever Caddy is in front,
 * and it decides nothing where it is not.
 *
 * The one-click platforms are where it is not. Coolify and Openship terminate at
 * their own proxy, which routes a hostname to a container and serves no files of
 * its own, so on those installs the snippet the dashboard hands out —
 * `<script src="${COLLECTOR_BASE_URL}/oa.js">` — answered `404` from v0.3.0
 * until this existed. The dashboard worked, the api worked, ingest worked, and
 * the one file a customer actually pastes could not load.
 *
 * So the bundle is baked into the image beside the service that already answers
 * on that hostname, and read once at boot. The headers below are the ones
 * `Caddyfile:93-114` sets, for the same reasons, so the two paths answer alike.
 */

/** Where the build stage leaves the bundle, relative to this module. `src` and
 *  `dist` sit at the same depth, so one path is right in both. */
const BUNDLE_URL = new URL('../../tracker/bundle/oa.js', import.meta.url)

/**
 * One hour, then revalidate. Copied from `Caddyfile:98` with its reasoning: the
 * filename is stable and never versioned, so a longer cache would make every fix
 * require every site owner to edit their snippet, and this hour is also the
 * ceiling on how long a broken tracker survives after you have fixed it.
 */
export const TRACKER_SCRIPT_CACHE_CONTROL = 'public, max-age=3600'

/** What Caddy's mime table answers for `.js`, so which of the two paths served
 *  the bytes cannot change how a browser treats them. */
export const TRACKER_SCRIPT_CONTENT_TYPE = 'text/javascript; charset=utf-8'

export interface TrackerScript {
  /** `ArrayBuffer` rather than `Buffer`, because that is what Hono's `c.body`
   *  takes, and because a `Buffer` is a view into a shared pool: handing one out
   *  hands out a window onto whatever else that pool holds. */
  readonly body: ArrayBuffer
  /** Compressed once here rather than per request: the build enforces a GZIPPED
   *  size budget, so these are the bytes that budget measured. */
  readonly gzipped: ArrayBuffer
  /** Strong tag over the uncompressed bytes. */
  readonly etag: string
  /** A different representation needs a different tag (RFC 9110 §8.8.3). With
   *  `Vary: Accept-Encoding` it is also what stops a shared cache handing gzip
   *  to a client that asked for none. */
  readonly etagGzip: string
}

/**
 * Read and precompress the bundle, or `undefined` when it is not there.
 *
 * Absent is a real state rather than a fault: the contract tests build a bare
 * app, and a developer running the collector before `pnpm run tracker:build` has
 * nothing to serve. The published images are the case that must never be missing
 * one, and `infra/docker/node-app.Dockerfile` asserts that at build time instead
 * of leaving it to be discovered here.
 */
export function readTrackerScript(source: URL = BUNDLE_URL): TrackerScript | undefined {
  let raw: Buffer
  try {
    raw = readFileSync(source)
  } catch {
    return undefined
  }
  if (raw.byteLength === 0) return undefined

  const digest = createHash('sha256').update(raw).digest('base64url').slice(0, 16)
  return {
    body: detach(raw),
    gzipped: detach(gzipSync(raw, { level: 9 })),
    etag: `"oa-${digest}"`,
    etagGzip: `"oa-${digest}-gz"`,
  }
}

/** A `Buffer`'s own bytes, copied out of whatever pool it is a view into. */
function detach(view: Buffer): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
}

/**
 * `GET /oa.js`, mounted at the root because that is the URL in every snippet the
 * dashboard prints and in every doc page. Not under `/v1`: this is a file a
 * customer pastes, not part of the versioned ingest contract.
 *
 * `Access-Control-Allow-Origin` is not set here — `publicIngestCors` already
 * puts `*` on every response from this service. A classic `<script src>` is not
 * a CORS request and needs none of it, but a site owner who adds `crossorigin`
 * gets real messages in `window.onerror` instead of "Script error.".
 */
export function createTrackerScriptRoutes(script: TrackerScript) {
  const routes = new Hono()

  routes.get('/oa.js', (c) => {
    const acceptsGzip = (c.req.header('Accept-Encoding') ?? '').toLowerCase().includes('gzip')
    const etag = acceptsGzip ? script.etagGzip : script.etag

    c.header('Content-Type', TRACKER_SCRIPT_CONTENT_TYPE)
    c.header('Cache-Control', TRACKER_SCRIPT_CACHE_CONTROL)
    c.header('ETag', etag)
    c.header('Vary', 'Accept-Encoding')

    if (c.req.header('If-None-Match') === etag) return c.body(null, 304)

    if (acceptsGzip) {
      c.header('Content-Encoding', 'gzip')
      return c.body(script.gzipped)
    }
    return c.body(script.body)
  })

  return routes
}
