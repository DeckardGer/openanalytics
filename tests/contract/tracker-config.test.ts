import {
  errorEnvelopeSchema,
  trackerConfigSchema,
  type TrackerConfig,
  type components,
} from '@openanalytics/contracts'
import { loadServiceEnv, MAX_PUBLISHED_RULES_PER_SITE } from '@openanalytics/domain'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { describe, expect, it } from 'vitest'
import { createApp, type TrackerConfigRecord } from '../../apps/collector/src/index.ts'

/**
 * `GET /v1/tracker/config` (docs snapshot 02 §11; plan 04 Milestone 4 item 8).
 *
 * The store is a fake here: resolving a tracking key to a site is Milestone 5's
 * work. What Milestone 4 owns is the endpoint's contract — validation, the
 * `ETag`/`config_version` caching semantics, and the guarantee that a public,
 * cacheable response carries no credential.
 */

const CONFIG: TrackerConfigRecord = {
  siteId: 'site_1',
  config: {
    config_version: 7,
    site_timezone: 'Asia/Baku',
    allowed_domains: ['shop.example.com'],
    redact_query_keys: ['order_ref'],
    interaction_sampling: 0.5,
    heartbeat_interval_seconds: 15,
    features: { web_vitals: true, engagement: true, interactions: true, heartbeat: true },
    attributed_revenue: false,
    no_code_rules: [
      {
        rule_id: 'r_1',
        name: 'cta_clicked',
        version: 1,
        trigger: 'click',
        selector: 'button.cta',
        properties: [{ key: 'button_label', source: 'text' }],
      },
    ],
  },
}

function buildApp(store?: { find(key: string): Promise<TrackerConfigRecord | null> }) {
  const captured = createCapturedLogger()
  const app = createApp({
    service: createServiceMetadata({ name: 'collector', version: '1.0.0', environment: 'test' }),
    logger: captured.logger,
    env: loadServiceEnv('collector', testEnv()),
    ...(store ? { trackerConfigStore: store } : {}),
  })
  return { app, captured }
}

const workingStore = {
  find: (key: string) => Promise.resolve(key === 'oa_pub_live_abcdef123456' ? CONFIG : null),
}

describe('tracker config endpoint', () => {
  it('serves a configuration matching the contract', async () => {
    const { app } = buildApp(workingStore)
    const response = await app.request('/v1/tracker/config?key=oa_pub_live_abcdef123456')

    expect(response.status).toBe(200)
    const body = trackerConfigSchema.parse(await response.json())
    expect(body.config_version).toBe(7)
    expect(body.site_timezone).toBe('Asia/Baku')
  })

  it('carries an ETag derived from the config version, and a cache policy', async () => {
    const { app } = buildApp(workingStore)
    const response = await app.request('/v1/tracker/config?key=oa_pub_live_abcdef123456')

    expect(response.headers.get('etag')).toBe('"oa-site_1-7"')
    expect(response.headers.get('cache-control')).toContain('max-age=')
  })

  it('answers 304 with no body when the caller already has that version', async () => {
    const { app } = buildApp(workingStore)
    const response = await app.request('/v1/tracker/config?key=oa_pub_live_abcdef123456', {
      headers: { 'If-None-Match': '"oa-site_1-7"' },
    })

    expect(response.status).toBe(304)
    expect(await response.text()).toBe('')
  })

  it('invalidates the cache when a dashboard change bumps the version', async () => {
    // The version is the invalidation mechanism (docs snapshot 02 §11): a stale
    // `If-None-Match` must miss, not match.
    const bumped = { ...CONFIG, config: { ...CONFIG.config, config_version: 8 } }
    const { app } = buildApp({ find: () => Promise.resolve(bumped) })

    const response = await app.request('/v1/tracker/config?key=oa_pub_live_abcdef123456', {
      headers: { 'If-None-Match': '"oa-site_1-7"' },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('etag')).toBe('"oa-site_1-8"')
  })

  it('never returns a credential in a publicly cacheable response', async () => {
    // The tracking key stays write-only: it is an input here and appears nowhere
    // in the output (docs snapshot 01 §3.2).
    const { app } = buildApp(workingStore)
    const response = await app.request('/v1/tracker/config?key=oa_pub_live_abcdef123456')

    const raw = await response.text()
    expect(raw).not.toContain('oa_pub_live_abcdef123456')
    expect(raw.toLowerCase()).not.toContain('tracking_key')
    expect(raw.toLowerCase()).not.toContain('secret')
  })

  it('rejects a missing or malformed key with the canonical envelope', async () => {
    const { app } = buildApp(workingStore)

    const missing = await app.request('/v1/tracker/config')
    expect(missing.status).toBe(400)
    expect(errorEnvelopeSchema.parse(await missing.json()).error.code).toBe('VALIDATION_FAILED')

    const short = await app.request('/v1/tracker/config?key=abc')
    expect(short.status).toBe(400)
  })

  it('distinguishes an unknown site from an unconfigured deployment', async () => {
    const { app } = buildApp(workingStore)
    const unknown = await app.request('/v1/tracker/config?key=oa_pub_live_zzzzzzzzzzzz')
    expect(unknown.status).toBe(404)
    expect(errorEnvelopeSchema.parse(await unknown.json()).error.code).toBe('SITE_NOT_FOUND')

    // No store wired yet (before Milestone 5): that is a server state, and
    // answering 404 would tell the tracker to give up on a site that exists.
    const { app: bare } = buildApp()
    const unconfigured = await bare.request('/v1/tracker/config?key=oa_pub_live_abcdef123456')
    expect(unconfigured.status).toBe(503)
    expect(errorEnvelopeSchema.parse(await unconfigured.json()).error.code).toBe(
      'SERVICE_UNAVAILABLE',
    )
  })

  it('is documented in the OpenAPI contract with the same caching semantics', async () => {
    const spec = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        new URL('../../packages/contracts/openapi/openapi.yaml', import.meta.url),
        'utf8',
      ),
    )

    const section = spec.slice(spec.indexOf('  /v1/tracker/config:'), spec.indexOf('components:'))
    expect(section).toContain('ETag')
    expect(section).toContain("'304'")
    expect(section).toContain('If-None-Match')
  })
})

/**
 * The retired preview branch (ADR-0068).
 *
 * The rule-preview mechanism is gone; a stale dashboard URL still carrying
 * `?preview=` must get the published configuration like any other request.
 */
describe('tracker config ignores a stale preview parameter', () => {
  it('serves the published set with ordinary caching headers', async () => {
    const { app } = buildApp(workingStore)
    const response = await app.request(
      '/v1/tracker/config?key=oa_pub_live_abcdef123456&preview=some-stale-token',
    )

    expect(response.status).toBe(200)
    const body = trackerConfigSchema.parse(await response.json())
    expect(body.no_code_rules.map((rule) => rule.rule_id)).toEqual(['r_1'])
    expect(response.headers.get('etag')).toBe('"oa-site_1-7"')
  })
})

/**
 * The two copies of this endpoint's contract, pinned against each other.
 *
 * There are two: the OpenAPI document (from which the frontend's client is
 * generated) and `trackerConfigSchema` (which the collector serves and every
 * test above validates against). Nothing compared them, and on 2026-08-05 the
 * audit found they had disagreed since M13 — the document still described M4's
 * guessed `{rule_id, name, selector, event: click|submit|view}` at
 * `maxItems: 200`, a shape the server had stopped sending two months earlier
 * (ADR-0034 D2, whose "the contract's maximum drops from 200 to 50" never
 * shipped).
 *
 * `contracts:check` cannot catch that class: it regenerates the client from the
 * document and compares, so a wrong document and a client faithfully generated
 * from it are green together. What was missing is an assertion that the
 * document describes the schema the server actually serves. These are it.
 */
/**
 * Both sides normalized to one spelling of "may be absent".
 *
 * The one difference between these two generators that is *not* drift: under
 * `exactOptionalPropertyTypes`, zod infers `selector?: string | undefined`
 * while `openapi-typescript` emits `selector?: string`. Comparing them raw
 * leaves a permanently red assertion, and an assertion everyone learns to
 * ignore is worse than none.
 *
 * So `undefined` is stripped from every property's value type, recursively.
 * The mapped type is homomorphic, so the `?` modifier survives untouched — an
 * optional field stays optional, a required one stays required, and a flip
 * between them is caught in one direction or the other. Field names, nesting,
 * primitive types and enum members are not touched at all.
 *
 * The first attempt at this *added* `| undefined` instead of removing it, which
 * silently disabled the whole check — all three drift probes below passed. The
 * probes are why that was caught, and they are why they are recorded in the
 * ADR: a pinning assertion nobody has watched fail is not known to pin anything.
 */
type SameShape<T> = T extends readonly (infer U)[]
  ? SameShape<U>[]
  : T extends object
    ? { [K in keyof T]: Exclude<SameShape<T[K]>, undefined> }
    : T

/** `true` only when `A` is assignable to `B`; anything else collapses to `false`. */
type Assignable<A, B> = A extends B ? true : false

describe('the OpenAPI document and the runtime schema describe the same config', () => {
  it('the two types are mutually assignable', () => {
    type Spec = SameShape<components['schemas']['TrackerConfig']>
    type Served = SameShape<TrackerConfig>

    // A pure *type* assertion. Both directions are needed: one alone permits
    // the other side to grow a field nobody serves. If the document and the zod
    // schema drift in any field name, optionality or enum member, one of these
    // becomes `false` and the tuple stops typechecking — so the failure lands
    // in `tsc -p tests/tsconfig.json`, which `pnpm run verify` runs.
    const bothDirections: [Assignable<Spec, Served>, Assignable<Served, Spec>] = [true, true]
    expect(bothDirections).toEqual([true, true])

    // And the served value parses, so the agreement is not only structural: a
    // value the generated client would accept is one the collector would serve.
    expect(trackerConfigSchema.parse(CONFIG.config)).toEqual(CONFIG.config)
  })

  it('the published rule cap is the one the server enforces', async () => {
    const { readFile } = await import('node:fs/promises')
    const spec = await readFile('packages/contracts/openapi/openapi.yaml', 'utf8')
    const block = spec.slice(
      spec.indexOf('        no_code_rules:'),
      spec.indexOf('    PersistedEvent:'),
    )

    // The number a client reads out of the contract and the number a publish is
    // refused against are the same number, and it is the domain's. Matched with
    // the trailing newline so a future `maxItems: 500` cannot satisfy it.
    expect(block).toContain(`\n          maxItems: ${MAX_PUBLISHED_RULES_PER_SITE}\n`)
    expect(MAX_PUBLISHED_RULES_PER_SITE).toBe(50)

    // The M4 shape is gone rather than merely joined. `view` was never a
    // trigger and `event` was never a field the server sent.
    expect(block).not.toMatch(/^\s+event:/m)
    expect(block).not.toContain('submit, view')
    expect(block).toMatch(/enum: \[click, submit, url_pattern\]/)
  })
})
