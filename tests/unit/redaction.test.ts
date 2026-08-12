import { REDACTED, isSensitiveKey, redact, scrubSecrets } from '@openanalytics/observability'
import { createCapturedLogger } from '@openanalytics/testkit'
import { describe, expect, it } from 'vitest'

/**
 * Docs snapshot 02 §26: credentials, auth tokens, raw email/IP and arbitrary
 * event properties never reach logs. A missed redaction is not recoverable — the
 * value is already in log storage by the time anyone notices.
 */
describe('log redaction', () => {
  it('drops sensitive keys at any depth', () => {
    const result = redact({
      safe: 'keep',
      password: 'hunter2',
      nested: { api_key: 'sk_live_x', authorization: 'Bearer y', deeper: { email: 'a@b.c' } },
    }) as Record<string, unknown>

    expect(result['safe']).toBe('keep')
    expect(result['password']).toBe(REDACTED)

    const nested = result['nested'] as Record<string, unknown>
    expect(nested['api_key']).toBe(REDACTED)
    expect(nested['authorization']).toBe(REDACTED)
    expect((nested['deeper'] as Record<string, unknown>)['email']).toBe(REDACTED)
  })

  it('drops arbitrary event properties wholesale', () => {
    // The collector accepts customer-defined properties; their contents are
    // unknowable, so the whole object is dropped rather than sampled.
    const result = redact({ properties: { anything: 'at all' } }) as Record<string, unknown>
    expect(result['properties']).toBe(REDACTED)
  })

  it('recognises IP fields', () => {
    expect(isSensitiveKey('ip')).toBe(true)
    expect(isSensitiveKey('ip_address')).toBe(true)
    expect(isSensitiveKey('x-forwarded-for')).toBe(true)
    expect(isSensitiveKey('site_id')).toBe(false)
  })

  it('truncates long strings instead of writing whole payloads', () => {
    const result = redact({ blob: 'x'.repeat(5_000) }) as Record<string, unknown>
    expect(String(result['blob']).length).toBeLessThan(700)
    expect(String(result['blob'])).toContain('more chars')
  })

  it('collapses deep structures rather than recursing without bound', () => {
    let deep: unknown = 'bottom'
    for (let i = 0; i < 20; i += 1) deep = { next: deep }

    // Must terminate and not throw on a hostile shape.
    expect(() => redact(deep)).not.toThrow()
    expect(JSON.stringify(redact(deep))).toContain('max depth')
  })

  it('survives a circular structure', () => {
    const circular: Record<string, unknown> = { name: 'root' }
    circular['self'] = circular
    expect(() => redact(circular)).not.toThrow()
  })

  it('recognises the write-only tracking key', () => {
    // Docs snapshot 01 §3.2: it is not read auth, but a leaked one forges
    // ingest. Logs correlate on `site_id` instead.
    expect(isSensitiveKey('tracking_key')).toBe(true)
    expect(isSensitiveKey('trackingKey')).toBe(true)
  })
})

/**
 * Key-name redaction cannot see a credential embedded in free-form text. A
 * driver's connection error is exactly that: the value is not a field, it is a
 * sentence, and it carries the password of the datastore that failed.
 */
describe('secret scrubbing in free-form strings', () => {
  it('removes URL userinfo but keeps the host', () => {
    const scrubbed = scrubSecrets('connect ECONNREFUSED redis://default:hunter2@10.0.0.4:6379')

    expect(scrubbed).not.toContain('hunter2')
    expect(scrubbed).not.toContain('default')
    expect(scrubbed).toContain('10.0.0.4:6379')
  })

  it('removes provider tokens by prefix', () => {
    expect(
      scrubSecrets(`stripe rejected ${['sk_live', '51QaBcDeFgHiJkLmNoP'].join('_')}`),
    ).not.toContain('51QaBcDeFg')
    expect(scrubSecrets('signature check used whsec_9fA2bC3dE4fG5hI6')).not.toContain('9fA2bC3dE4')
    expect(scrubSecrets('resend said re_AbCdEfGhIjKlMnOp failed')).not.toContain('AbCdEfGhIj')
  })

  it('removes bearer tokens and JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1XzEifQ.c2lnbmF0dXJl'
    expect(scrubSecrets(`Authorization: Bearer ${jwt}`)).not.toContain('eyJhbGci')
    expect(scrubSecrets(`token ${jwt} expired`)).toContain(REDACTED)
  })

  it('leaves ordinary text intact', () => {
    const text = 'GET https://example.com/pricing?utm_source=google returned 404'
    expect(scrubSecrets(text)).toBe(text)
    // `re_` is a common prefix; only long token-shaped runs are scrubbed.
    expect(scrubSecrets('re_run scheduled')).toBe('re_run scheduled')
  })

  it('scrubs key-bearing query parameters in URL-shaped text (ADR-0008 addendum)', () => {
    // The tracker config GET carries the write-only tracking key as `?key=`.
    const logged = scrubSecrets('GET /v1/tracker/config?key=oa_pub_AbCdEf123456 304')
    expect(logged).not.toContain('AbCdEf123456')
    expect(logged).toContain(`?key=${REDACTED}`)
    // Named variants and mid-query position.
    expect(scrubSecrets('url https://x.test/a?a=1&tracking_key=k123456789&b=2')).not.toContain(
      'k123456789',
    )
    expect(scrubSecrets('retrying https://x.test/cfg?api_key=zz9988776655')).not.toContain(
      'zz9988776655',
    )
    // A parameter merely ending in the letters "key" without a separator, and
    // ordinary parameters, stay intact.
    expect(scrubSecrets('https://x.test/?donkey=gray&keyboard=qwerty')).toBe(
      'https://x.test/?donkey=gray&keyboard=qwerty',
    )
  })

  it('scrubs an error message and stack, not just fields', () => {
    // The finding this closes: `redact` truncated error text without scanning
    // it, so a credential URL inside a thrown error reached log storage.
    const error = new Error('AggregateError: redis://user:s3cr3tPassw0rd@queue.internal:6379 down')
    error.stack = `Error: redis://user:s3cr3tPassw0rd@queue.internal:6379\n    at connect`

    const result = redact(error) as Record<string, unknown>

    expect(String(result['message'])).not.toContain('s3cr3tPassw0rd')
    expect(String(result['stack'])).not.toContain('s3cr3tPassw0rd')
    expect(String(result['message'])).toContain('queue.internal')
  })

  it('scrubs before truncating, so no secret survives as a prefix', () => {
    // Joined at runtime: a literal of this shape trips GitHub push protection
    // on the public export (ADR-0060) — the fixture is synthetic either way.
    const secret = ['sk_live', '51QaBcDeFgHiJkLmNoPqRsTuV'].join('_')
    const long = `${secret} ${'x'.repeat(2_000)}`

    const result = redact({ note: long }) as Record<string, unknown>
    expect(String(result['note'])).not.toContain('sk_live_51')
    expect(String(result['note'])).toContain('more chars')
  })
})

describe('structured logger', () => {
  it('stamps every line with service identity', () => {
    const captured = createCapturedLogger()
    captured.logger.info('something_happened', { site_id: 'site_1' })

    const line = captured.lines[0]
    expect(line).toBeDefined()
    expect(line?.['service']).toBe('test')
    expect(line?.['version']).toBe('0.0.0-test')
    expect(line?.['level']).toBe('info')
    expect(line?.['msg']).toBe('something_happened')
  })

  it('redacts fields passed by a caller', () => {
    const captured = createCapturedLogger()
    captured.logger.error('provider_call_failed', { token: 'secret-value', code: 'INTERNAL_ERROR' })

    const line = captured.lines[0]
    expect(line?.['token']).toBe(REDACTED)
    // The error code is what alerting keys on, so it must survive.
    expect(line?.['code']).toBe('INTERNAL_ERROR')
  })

  it('does not let a caller overwrite reserved fields', () => {
    // Otherwise a field named `service` would break every alert query.
    const captured = createCapturedLogger()
    captured.logger.info('x', { service: 'spoofed', level: 'debug' })

    expect(captured.lines[0]?.['service']).toBe('test')
    expect(captured.lines[0]?.['level']).toBe('info')
  })

  it('respects the level threshold', () => {
    const captured = createCapturedLogger({ level: 'warn' })
    captured.logger.debug('ignored')
    captured.logger.info('ignored')
    captured.logger.warn('kept')

    expect(captured.lines).toHaveLength(1)
    expect(captured.lines[0]?.['msg']).toBe('kept')
  })

  it('merges child bindings into every line', () => {
    const captured = createCapturedLogger()
    captured.logger.child({ job_type: 'ingest_batch' }).info('claimed')

    expect(captured.lines[0]?.['job_type']).toBe('ingest_batch')
  })
})
