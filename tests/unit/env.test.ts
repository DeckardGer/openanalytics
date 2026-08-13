import { execFileSync } from 'node:child_process'
import { createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SIGNATURE_HEADERS,
  canonicalSigningString,
  loadVerifyKey,
  sha256Hex,
  signRequest,
  signedPathOf,
  verifySignature,
} from '@openanalytics/auth'
import {
  EnvValidationError,
  POLICY_SCOPE,
  describeEnvSurface,
  forbiddenKeysFor,
  loadServiceEnv,
} from '@openanalytics/domain'
import { testEnv } from '@openanalytics/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

describe('service environment', () => {
  it('loads a valid environment and merges policy defaults', () => {
    const env = loadServiceEnv('api', testEnv())

    expect(env.NODE_ENV).toBe('test')
    expect(env.PORT).toBe(3000)
    // Policy defaults come along, so a service never reads a bare number.
    expect(env.EVENT_MAX_LATENESS_HOURS).toBe(24)
  })

  it('fails clearly on a malformed value', () => {
    expect(() => loadServiceEnv('api', testEnv({ PORT: 'not-a-port' }))).toThrow(EnvValidationError)
  })

  it('refuses to start the collector with a ClickHouse credential', () => {
    // Docs snapshot 02 §5 and §7.1. The collector never writes to ClickHouse;
    // being handed the credential means the deployment is wrong, and starting
    // anyway would hide that until someone used it.
    expect(() =>
      loadServiceEnv('collector', testEnv({ CLICKHOUSE_URL: 'https://clickhouse.internal:8443' })),
    ).toThrow(/least-privilege secret boundary/)
  })

  it('starts the collector with its own anonymous-identity secret', () => {
    // D-102: the collector is the one service that holds this key on the INGEST
    // side — it derives the identity before the raw IP is discarded. The key sat
    // on the collector's own forbidden list from M4 until the first real
    // deployment EX_CONFIG'd on it (2026-07-24); this pins the fix.
    const env = loadServiceEnv(
      'collector',
      testEnv({ ANONYMOUS_IDENTITY_SECRET: 'a'.repeat(32), ANONYMOUS_IDENTITY_KEY_VERSION: '1' }),
    )
    expect(env.ANONYMOUS_IDENTITY_SECRET).toBe('a'.repeat(32))
    // ...while the three services with no use for it still refuse it.
    for (const service of ['api', 'query-gateway', 'realtime'] as const) {
      expect(() =>
        loadServiceEnv(service, testEnv({ ANONYMOUS_IDENTITY_SECRET: 'a'.repeat(32) })),
      ).toThrow(/least-privilege secret boundary/)
    }
  })

  it('accepts the identity secret on the worker, read-only, since M12 CP3', () => {
    // ADR-0033 D6 amendment. `external_user_hash` on the revenue fact has to be
    // the `identify()` derivation byte for byte or the CP4 join matches nothing
    // while looking exactly like a value that should — and the derivation runs
    // over provider-side identifiers that only the worker ever holds.
    //
    // The rule the forbidden entry enforced still holds in full: the worker sees
    // no raw IP and the analytics schema has no IP column, so holding the key
    // here buys nobody the ability to re-derive an anonymous id. The collector
    // remains the only writer of event identity.
    const env = loadServiceEnv(
      'worker',
      testEnv({ ANONYMOUS_IDENTITY_SECRET: 'a'.repeat(32), ANONYMOUS_IDENTITY_KEY_VERSION: '2' }),
    )
    expect(env.ANONYMOUS_IDENTITY_SECRET).toBe('a'.repeat(32))
    expect(env.ANONYMOUS_IDENTITY_KEY_VERSION).toBe(2)
    // Optional, like every other credential in that schema: without it the
    // projection loop does not start and the worker boots anyway.
    expect(loadServiceEnv('worker', testEnv({})).ANONYMOUS_IDENTITY_SECRET).toBeUndefined()
    expect(forbiddenKeysFor('worker')).not.toContain('ANONYMOUS_IDENTITY_SECRET')
  })

  it('refuses to start the API with a direct ClickHouse URL', () => {
    // Docs snapshot 05, D-208: Vercel reaches analytics only via the signed
    // gateway. A direct credential here quietly restores the forbidden topology.
    expect(() =>
      loadServiceEnv('api', testEnv({ CLICKHOUSE_URL: 'https://clickhouse.internal:8443' })),
    ).toThrow(EnvValidationError)
  })

  it('refuses to give the query gateway the private signing key', () => {
    // Verify-only. Holding the private key would let the gateway forge the
    // requests it exists to authenticate.
    expect(() =>
      loadServiceEnv('query-gateway', testEnv({ QUERY_SIGNING_PRIVATE_KEY: 'x'.repeat(32) })),
    ).toThrow(EnvValidationError)
  })

  it('refuses to give the API the email provider credential', () => {
    // Docs snapshot 02 §5, G-007: the API enqueues email to the outbox; only the
    // worker delivers it and holds RESEND_API_KEY. Handing it to the API means
    // email could bypass the outbox.
    expect(() => loadServiceEnv('api', testEnv({ RESEND_API_KEY: 're_'.padEnd(32, 'x') }))).toThrow(
      /least-privilege secret boundary/,
    )
  })

  it('refuses to give the worker an OAuth client secret', () => {
    // The OAuth login flow runs in the API, not the worker.
    expect(() =>
      loadServiceEnv('worker', testEnv({ GITHUB_CLIENT_SECRET: 'x'.repeat(32) })),
    ).toThrow(/least-privilege secret boundary/)
  })

  it('accepts the API holding OAuth client credentials', () => {
    expect(() =>
      loadServiceEnv(
        'api',
        testEnv({ GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'x'.repeat(32) }),
      ),
    ).not.toThrow()
  })

  it('takes the frontend origin separately from the auth base URL', () => {
    // Two different hosts in production: AUTH_BASE_URL is Better Auth's own base
    // (the api), APP_BASE_URL is the frontend every human-facing link points at.
    // Optional, so a deployment that has not set it keeps the old behaviour.
    const env = loadServiceEnv(
      'api',
      testEnv({
        AUTH_BASE_URL: 'https://api.example.com',
        APP_BASE_URL: 'https://app.example.com',
      }),
    )
    expect(env.APP_BASE_URL).toBe('https://app.example.com')
    expect(env.AUTH_BASE_URL).toBe('https://api.example.com')
    expect(loadServiceEnv('api', testEnv()).APP_BASE_URL).toBeUndefined()
    // A URL, not a credential: it is on no service's forbidden list.
    expect(forbiddenKeysFor('api')).not.toContain('APP_BASE_URL')
  })

  it('rejects an APP_BASE_URL that is not a URL', () => {
    expect(() => loadServiceEnv('api', testEnv({ APP_BASE_URL: 'app.example.com' }))).toThrow()
  })

  it('gives the bucket credential to the worker and the api, and to nobody else', () => {
    // ADR-0032, D1. The worker moves the bytes and the api mints the signed
    // URLs, so both need the key pair; the collector, the query gateway and the
    // realtime gateway have no path to object storage at all, and a credential
    // for customer import archives on the public intake service would be one
    // reachable from the internet-facing surface.
    const block = {
      OBJECT_STORAGE_ENDPOINT: 'https://hel1.objectstorage.example',
      OBJECT_STORAGE_REGION: 'hel1',
      OBJECT_STORAGE_BUCKET: 'getopen-oa-prod',
      OBJECT_STORAGE_ACCESS_KEY_ID: 'AKIA-test',
      OBJECT_STORAGE_SECRET_ACCESS_KEY: 'x'.repeat(32),
    }

    for (const service of ['api', 'worker'] as const) {
      const env = loadServiceEnv(service, testEnv(block))
      expect(env.OBJECT_STORAGE_BUCKET).toBe('getopen-oa-prod')
      expect(env.OBJECT_STORAGE_REGION).toBe('hel1')
    }

    for (const service of ['collector', 'query-gateway', 'realtime'] as const) {
      expect(() =>
        loadServiceEnv(service, testEnv({ OBJECT_STORAGE_SECRET_ACCESS_KEY: 'x'.repeat(32) })),
      ).toThrow(/least-privilege secret boundary/)
      expect(() =>
        loadServiceEnv(service, testEnv({ OBJECT_STORAGE_ACCESS_KEY_ID: 'AKIA-test' })),
      ).toThrow(/least-privilege secret boundary/)
    }
  })

  it('starts the worker and the api with no object storage configured at all', () => {
    // Optional-until-used: without the block the import surface is simply not
    // mounted and the purge phase waits, rather than a service refusing to boot
    // over a feature this deployment has not enabled.
    for (const service of ['api', 'worker'] as const) {
      const env = loadServiceEnv(service, testEnv())
      expect(env.OBJECT_STORAGE_ENDPOINT).toBeUndefined()
      expect(env.OBJECT_STORAGE_BUCKET).toBeUndefined()
    }
  })

  it('gives the credential keyring to the api and the worker, and to nobody else', () => {
    // ADR-0033, D3. The api encrypts a customer's provider secret on connect and
    // the worker decrypts it to sync; nothing else has a reason to hold the key
    // that unlocks every customer's payment-provider credential. The collector
    // in particular is the internet-facing intake service, which is the same
    // reasoning that keeps STRIPE_SECRET_KEY off it.
    const keyring = JSON.stringify({ active: 'k1', keys: { k1: 'A'.repeat(43) + '=' } })

    for (const service of ['api', 'worker'] as const) {
      const env = loadServiceEnv(service, testEnv({ OA_CREDENTIAL_KEYRING: keyring }))
      expect(env.OA_CREDENTIAL_KEYRING).toBe(keyring)
    }

    for (const service of ['collector', 'query-gateway', 'realtime'] as const) {
      expect(forbiddenKeysFor(service)).toContain('OA_CREDENTIAL_KEYRING')
      expect(() => loadServiceEnv(service, testEnv({ OA_CREDENTIAL_KEYRING: keyring }))).toThrow(
        /least-privilege secret boundary/,
      )
    }
  })

  it('starts the api and the worker with no credential keyring at all', () => {
    // Optional-until-used, and fail-closed with it: without the ring the revenue
    // connection routes are simply not mounted (one warn log), rather than a
    // service refusing to boot over a feature this deployment has not enabled.
    for (const service of ['api', 'worker'] as const) {
      expect(loadServiceEnv(service, testEnv()).OA_CREDENTIAL_KEYRING).toBeUndefined()
    }
  })

  it('gives the assistant’s provider key to the api and to nobody else', () => {
    // ADR-0046 D6. The api is the one service that talks to the model, and this
    // is the first third-party credential we hold whose leak is a *bill* rather
    // than a data exposure — the Consequences section says so in as many words.
    // The collector in particular runs closest to untrusted input and has the
    // least business holding a spend-capable credential.
    const env = loadServiceEnv('api', testEnv({ OPENAI_API_KEY: 'sk-proj-test' }))
    expect(env.OPENAI_API_KEY).toBe('sk-proj-test')

    for (const service of ['collector', 'worker', 'query-gateway', 'realtime'] as const) {
      expect(forbiddenKeysFor(service)).toContain('OPENAI_API_KEY')
      expect(() => loadServiceEnv(service, testEnv({ OPENAI_API_KEY: 'sk-proj-test' }))).toThrow(
        /least-privilege secret boundary/,
      )
    }
  })

  it('starts the api with no assistant provider configured at all', () => {
    // D6's optional-until-used, and D2's reason for it: the routes mount on
    // every deployment and report that the provider is unconfigured, rather
    // than being absent — an unmounted `/v1` path answers 401, which a browser
    // would render as "you are signed out".
    expect(loadServiceEnv('api', testEnv()).OPENAI_API_KEY).toBeUndefined()
  })

  it('ignores an empty forbidden variable', () => {
    // Orchestrators commonly inject an empty string for an unset variable;
    // that is absence, not a violation.
    expect(() => loadServiceEnv('collector', testEnv({ CLICKHOUSE_URL: '' }))).not.toThrow()
  })

  it('declares a forbidden-key list for every service', () => {
    for (const service of ['api', 'collector', 'worker', 'query-gateway', 'realtime'] as const) {
      expect(forbiddenKeysFor(service).length).toBeGreaterThan(0)
    }
  })

  it('gives the worker an SMTP block and keeps the relay password off every other service', () => {
    // The self-hostable transport. It lands on the same side of the same
    // boundary as RESEND_API_KEY: the worker delivers mail, so the worker is
    // the only service that may hold the credential.
    const env = loadServiceEnv(
      'worker',
      testEnv({
        SMTP_HOST: 'mail.example',
        SMTP_PORT: '465',
        SMTP_SECURE: 'true',
        SMTP_USER: 'relay',
        SMTP_PASS: 'relay-secret',
        SMTP_FROM: 'relay@mail.example',
      }),
    )
    expect(env.SMTP_HOST).toBe('mail.example')
    expect(env.SMTP_PORT).toBe(465)
    expect(env.SMTP_SECURE).toBe(true)

    for (const service of ['api', 'collector', 'query-gateway', 'realtime'] as const) {
      expect(() => loadServiceEnv(service, testEnv({ SMTP_PASS: 'relay-secret' }))).toThrow(
        /least-privilege secret boundary/,
      )
    }
  })

  it("reads SMTP_SECURE as the two literals rather than through JavaScript's truthiness", () => {
    // `z.coerce.boolean()` would make the string 'false' mean true, which is
    // the one spelling an operator is most likely to reach for.
    expect(loadServiceEnv('worker', testEnv({ SMTP_SECURE: 'false' })).SMTP_SECURE).toBe(false)
    expect(loadServiceEnv('worker', testEnv()).SMTP_SECURE).toBeUndefined()
    expect(() => loadServiceEnv('worker', testEnv({ SMTP_SECURE: 'yes' }))).toThrow(
      EnvValidationError,
    )
  })

  it('requires email verification unless a deployment says otherwise', () => {
    // Cloud never sets it, so the default is what production runs.
    expect(loadServiceEnv('api', testEnv()).AUTH_EMAIL_VERIFICATION).toBe('required')
    expect(
      loadServiceEnv('api', testEnv({ AUTH_EMAIL_VERIFICATION: 'optional' }))
        .AUTH_EMAIL_VERIFICATION,
    ).toBe('optional')
  })

  it('describes the whole environment surface, with the boundary each key sits on', () => {
    // The inventory `scripts/generate-env-example.mjs` reads. What matters is
    // that it is derived rather than restated: a variable added to a service
    // schema appears here without anyone remembering to add it.
    const surface = describeEnvSurface()
    const byName = new Map(surface.map((entry) => [entry.name, entry]))

    expect(byName.get('SMTP_PASS')).toMatchObject({
      scopes: ['worker'],
      required: false,
      forbiddenFor: ['api', 'collector', 'query-gateway', 'realtime'],
    })
    // Declared by every service's base schema, and carrying its default.
    expect(byName.get('PORT')?.defaultValue).toBe('3000')
    // The cross-service policy block is in there too, under its own scope.
    expect(byName.get('EVENT_MAX_LATENESS_HOURS')?.scopes).toEqual([POLICY_SCOPE])
    // Nothing is silently dropped: a name that exists on two services keeps both.
    expect(byName.get('DATABASE_URL')?.scopes).toEqual(['api', 'collector', 'worker'])
  })

  it('collects every problem into one error', () => {
    try {
      loadServiceEnv(
        'collector',
        testEnv({ PORT: 'nope', CLICKHOUSE_URL: 'https://x.invalid', AUTH_SECRET: 'y'.repeat(32) }),
      )
      expect.unreachable('expected EnvValidationError')
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError)
      const issues = (error as EnvValidationError).issues
      expect(issues.length).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('file-backed environment variables', () => {
  // The self-host marketplaces (Coolify, Openship and the template catalogues
  // shaped like them) can generate a random string into a variable and nothing
  // else, so a keypair whose halves must match across two services has to reach
  // the services as files written by a one-shot step in the stack.
  let dir: string
  let privatePem: string
  let publicPem: string
  let privatePath: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'oa-env-file-'))
    // A real Ed25519 pair, in the PEM shape `openssl genpkey -algorithm ed25519`
    // writes — trailing newline included, because that is what the generator
    // produces and therefore what the loader has to cope with.
    const pair = generateKeyPairSync('ed25519')
    privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    privatePath = join(dir, 'query.private.pem')
    writeFileSync(privatePath, privatePem)
    writeFileSync(join(dir, 'query.public.pem'), publicPem)
    writeFileSync(join(dir, 'empty.pem'), '   \n')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses to start the gateway with the private half handed over as a FILE', () => {
    // THE test. The forbidden-key check reads variable NAMES, so a `_FILE`
    // variable resolved after that check would carry the minting key straight
    // past the boundary it exists to hold — and the gateway would come up green
    // able to sign the envelopes it is only supposed to verify. Resolution
    // therefore happens BEFORE the check, and this pins that ordering.
    expect(() =>
      loadServiceEnv('query-gateway', testEnv({ QUERY_SIGNING_PRIVATE_KEY_FILE: privatePath })),
    ).toThrow(/least-privilege secret boundary/)
  })

  it('reads a value from the file the path names, without its trailing newline', () => {
    const env = loadServiceEnv('api', testEnv({ QUERY_SIGNING_PRIVATE_KEY_FILE: privatePath }))

    expect(env.QUERY_SIGNING_PRIVATE_KEY).toBe(privatePem.trim())
    expect(env.QUERY_SIGNING_PRIVATE_KEY?.endsWith('\n')).toBe(false)
    // Still a usable key after the trim, not just a matching string. Parsed
    // rather than pattern-matched: it is the stronger check, and it keeps a
    // key-shaped literal out of the tree — the pattern this replaced tripped
    // the public mirror's leak scan, which is a pre-merge gate there.
    expect(() => createPrivateKey(env.QUERY_SIGNING_PRIVATE_KEY as string)).not.toThrow()
  })

  it('refuses a variable given as both a value and a file', () => {
    // Silently preferring one would mean a deployment running on a key nobody
    // in the room could name.
    expect(() =>
      loadServiceEnv(
        'api',
        testEnv({
          QUERY_SIGNING_PRIVATE_KEY: privatePem,
          QUERY_SIGNING_PRIVATE_KEY_FILE: privatePath,
        }),
      ),
    ).toThrow(/not both/)
  })

  it('refuses to start when the file is missing, and names the path but never a value', () => {
    const missing = join(dir, 'absent.pem')
    try {
      loadServiceEnv('api', testEnv({ QUERY_SIGNING_PRIVATE_KEY_FILE: missing }))
      expect.unreachable('expected EnvValidationError')
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError)
      const message = (error as EnvValidationError).message
      expect(message).toContain(missing)
      expect(message).not.toContain(privatePem.slice(0, 64))
    }
  })

  it('refuses to start when the file is empty', () => {
    // A path is an assertion that the value matters. An absent variable may mean
    // "this feature is off" (the optional-until-used rule); a path pointing at
    // nothing is a broken deployment, and the gateway would otherwise mount no
    // query route at all while every health check stayed green.
    expect(() =>
      loadServiceEnv('api', testEnv({ QUERY_SIGNING_PRIVATE_KEY_FILE: join(dir, 'empty.pem') })),
    ).toThrow(/is empty/)
  })

  it('leaves a _FILE variable alone when no schema declares its base name', () => {
    // `SSL_CERT_FILE` is OpenSSL's, set on plenty of hosts. Refusing to boot
    // over somebody else's convention would be a self-inflicted outage.
    expect(() =>
      loadServiceEnv('api', testEnv({ SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt' })),
    ).not.toThrow()
  })

  it('resolves the verify half the same way, on the service that holds it', () => {
    const env = loadServiceEnv(
      'query-gateway',
      testEnv({ QUERY_SIGNING_PUBLIC_KEY_FILE: join(dir, 'query.public.pem') }),
    )

    expect(env.QUERY_SIGNING_PUBLIC_KEY).toBe(publicPem.trim())
  })

  it('carries a pair openssl wrote all the way to a signature the gateway accepts', () => {
    // The end of the chain, run rather than reasoned about. `openssl genpkey`
    // is what the keygen one-shot in `docker-compose.keys.yml` runs and what
    // `generate-secrets.sh` has always run, so these are the exact bytes a
    // self-hosted install ends up with — including the trailing newline that
    // the loader has to strip without disturbing anything else. A string that
    // merely *looks* like a PEM after trimming would pass every other test in
    // this block; only signing with it proves the key survived.
    const keys = mkdtempSync(join(tmpdir(), 'oa-env-openssl-'))
    try {
      const priv = join(keys, 'query.private.pem')
      const pub = join(keys, 'query.public.pem')
      execFileSync('openssl', ['genpkey', '-algorithm', 'ed25519', '-out', priv])
      execFileSync('openssl', ['pkey', '-in', priv, '-pubout', '-out', pub])

      const api = loadServiceEnv('api', testEnv({ QUERY_SIGNING_PRIVATE_KEY_FILE: priv }))
      const gateway = loadServiceEnv(
        'query-gateway',
        testEnv({ QUERY_SIGNING_PUBLIC_KEY_FILE: pub }),
      )

      const url = 'https://gateway.internal/v1/query'
      const body = '{"q":1}'
      const issuedAt = new Date('2026-08-14T00:00:00.000Z')
      const headers = signRequest({
        privateKeyPem: api.QUERY_SIGNING_PRIVATE_KEY as string,
        keyId: 'k1',
        audience: 'query-gateway:test',
        method: 'POST',
        url,
        body,
        nonce: 'n-1',
        issuedAt,
        lifetimeMs: 60_000,
      })

      const canonical = canonicalSigningString({
        keyId: 'k1',
        audience: 'query-gateway:test',
        method: 'POST',
        path: signedPathOf(url),
        issuedAt: headers[SIGNATURE_HEADERS.issuedAt] as string,
        expiresAt: headers[SIGNATURE_HEADERS.expiresAt] as string,
        nonce: 'n-1',
        bodySha256: sha256Hex(body),
      })

      expect(
        verifySignature({
          verifyKey: loadVerifyKey(gateway.QUERY_SIGNING_PUBLIC_KEY as string),
          canonical,
          signatureBase64: headers[SIGNATURE_HEADERS.signature] as string,
        }),
      ).toBe(true)
    } finally {
      rmSync(keys, { recursive: true, force: true })
    }
  })
})
