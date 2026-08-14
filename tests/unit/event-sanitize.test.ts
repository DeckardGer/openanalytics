import { EVENT_LIMITS } from '@openanalytics/contracts'
import {
  OPAQUE_ID_MAX_LENGTH,
  PII_REDACTED,
  attributionFrom,
  containsSensitiveText,
  isOpaqueIdPropertyKey,
  OPAQUE_ID_PROPERTY_KEYS,
  redactSensitiveText,
  sanitizeElementText,
  sanitizeInteraction,
  sanitizeProperties,
  sanitizeUrl,
  stripLinkingHints,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * Docs snapshot 02 §11 and §25. The tracker strips fragments and sensitive query
 * keys before sending; the server applies the same rules again, because the rule
 * that holds is the one on this side of the network.
 */
describe('URL sanitization', () => {
  it('drops the fragment', () => {
    // Password-reset and magic-link flows routinely put the token in the hash,
    // and the hash is client state no analytics report needs.
    const sanitized = sanitizeUrl('https://example.com/reset#access_token=abc123def456')

    expect(sanitized?.url).toBe('https://example.com/reset')
    expect(sanitized?.url).not.toContain('abc123def456')
  })

  it('drops sensitive query keys but keeps attribution', () => {
    const sanitized = sanitizeUrl(
      'https://example.com/checkout?utm_source=google&utm_campaign=summer&token=s3cr3t&email=a@b.co&plan=growth',
    )

    expect(sanitized?.query['utm_source']).toBe('google')
    expect(sanitized?.query['plan']).toBe('growth')
    expect(sanitized?.query['token']).toBeUndefined()
    expect(sanitized?.query['email']).toBeUndefined()
    expect(sanitized?.url).not.toContain('s3cr3t')
    expect(sanitized?.droppedQueryKeys).toEqual(expect.arrayContaining(['token', 'email']))
  })

  it('drops compound sensitive names, not just exact matches', () => {
    const sanitized = sanitizeUrl(
      'https://example.com/?user_email=a@b.co&csrfToken=x&reset-password=y&page=2',
    )

    expect(Object.keys(sanitized?.query ?? {})).toEqual(['page'])
  })

  it('honours per-site redaction rules from tracker config', () => {
    const sanitized = sanitizeUrl('https://example.com/?order=A100&internal_ref=x', {
      redactQueryKeys: ['order'],
    })

    expect(sanitized?.query['order']).toBeUndefined()
    expect(sanitized?.query['internal_ref']).toBe('x')
  })

  it('redacts a PII value even under an innocuous key', () => {
    const sanitized = sanitizeUrl('https://example.com/?q=someone%40example.com')
    expect(sanitized?.query['q']).toBe(PII_REDACTED)
  })

  it('removes credentials embedded in the URL', () => {
    const sanitized = sanitizeUrl('https://user:hunter2@example.com/dashboard')

    expect(sanitized?.url).not.toContain('hunter2')
    expect(sanitized?.url).not.toContain('user:')
    expect(sanitized?.host).toBe('example.com')
  })

  it('rejects anything that is not a parseable http(s) URL', () => {
    // A value we cannot parse is a validation failure, not something to store
    // verbatim and hope.
    expect(sanitizeUrl('not a url')).toBeNull()
    expect(sanitizeUrl('javascript:alert(1)')).toBeNull()
    expect(sanitizeUrl('file:///etc/passwd')).toBeNull()
  })

  // A referrer is resolved rather than merely sanitized — it has the site's own
  // hosts to answer for as well — so it lives in `referrer.test.ts` (ADR-0028).

  it('derives attribution from the sanitized URL only', () => {
    // A client cannot state `source` at all (contract), so a forged campaign has
    // nowhere to enter: attribution is read back out of the URL the server
    // cleaned.
    const attribution = attributionFrom(
      sanitizeUrl(
        'https://example.com/?utm_source=google&utm_medium=cpc&utm_campaign=summer&utm_term=web%20analytics',
      ),
    )

    expect(attribution).toEqual({
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'summer',
      utm_content: null,
      utm_term: 'web analytics',
    })
    expect(attributionFrom(null).utm_source).toBeNull()
  })
})

describe('PII redaction in stored values', () => {
  it('redacts emails, long digit runs and provider tokens', () => {
    expect(redactSensitiveText('write to a.person+tag@example.co.uk please')).toContain(
      PII_REDACTED,
    )
    expect(redactSensitiveText('call +994 50 123 45 67')).toContain(PII_REDACTED)
    expect(redactSensitiveText(`key ${['sk_live', '51QaBcDeFgHiJkLmNoP'].join('_')}`)).toContain(
      PII_REDACTED,
    )
    expect(redactSensitiveText('4111 1111 1111 1111')).toContain(PII_REDACTED)
  })

  it('redacts an opaque token even without a recognisable prefix', () => {
    expect(redactSensitiveText('a1B2c3D4e5F6g7H8i9J0k1L2m3N4')).toBe(PII_REDACTED)
  })

  it('leaves ordinary analytics values alone', () => {
    // A false positive costs one blurred dimension value; the bar is still that
    // ordinary values survive.
    for (const value of ['growth', 'Pricing page', 'checkout_step_2', 'AZ', '2026-07-20']) {
      expect(redactSensitiveText(value)).toBe(value)
      expect(containsSensitiveText(value)).toBe(false)
    }
  })
})

describe('property sanitization', () => {
  it('drops keys that name a secret and redacts values that look like one', () => {
    const { properties, dropped } = sanitizeProperties({
      plan: 'growth',
      api_key: ['sk_live', '51QaBcDeFgHiJkLmNoP'].join('_'),
      contact: 'someone@example.com',
      seats: 12,
      active: true,
      note: null,
    })

    expect(properties['plan']).toBe('growth')
    expect(properties['seats']).toBe(12)
    expect(properties['active']).toBe(true)
    expect(properties['note']).toBeNull()
    expect(properties['api_key']).toBeUndefined()
    expect(properties['contact']).toBe(PII_REDACTED)
    expect(dropped).toContain('api_key')
  })

  it('drops the reserved oa_ prefix', () => {
    const { properties, dropped } = sanitizeProperties({ oa_billable: true, ok: 1 })

    expect(properties['oa_billable']).toBeUndefined()
    expect(dropped).toContain('oa_billable')
  })

  it('drops structures that have no analytics column instead of stringifying them', () => {
    const { properties, dropped } = sanitizeProperties({
      nested: { a: 1 },
      list: [1, 2],
      broken: Number.NaN,
      fine: 'yes',
    })

    expect(Object.keys(properties)).toEqual(['fine'])
    expect(dropped).toEqual(expect.arrayContaining(['nested', 'list', 'broken']))
  })

  it('truncates long values and caps the key count', () => {
    const many = Object.fromEntries(
      Array.from({ length: EVENT_LIMITS.maxPropertiesPerEvent + 5 }, (_, i) => [`k${i}`, i]),
    )
    const { properties, dropped } = sanitizeProperties({
      ...many,
      long: 'x'.repeat(EVENT_LIMITS.propertyValueMaxLength + 100),
    })

    expect(Object.keys(properties)).toHaveLength(EVENT_LIMITS.maxPropertiesPerEvent)
    expect(dropped).toHaveLength(6)
    expect(properties['long']).toBeUndefined()
  })

  it('is deterministic for the same input', () => {
    const input = { plan: 'growth', contact: 'someone@example.com', seats: 3 }
    expect(JSON.stringify(sanitizeProperties(input))).toBe(
      JSON.stringify(sanitizeProperties(input)),
    )
  })
})

describe('the `order_id` exemption (M12 CP7 defect 1)', () => {
  /**
   * Real Stripe ids, at their real lengths. The synthetic short ids every other
   * fixture in this repository used are exactly the ones the generic
   * opaque-token rule ignores, which is why CI never saw this and production
   * did: 7/7 real charges attributed `none` while a 15-character synthetic id
   * matched `exact` in 62 seconds.
   */
  const STRIPE_IDS = [
    'pi_3RtZ8kQ2mNvXpL4aB7cD9eF0', // 27
    'ch_3RtZ8kQ2mNvXpL4aB7cD9eF0', // 27
    'cs_test_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6', // 38
    'cs_live_b8Kd2Qm4Xp7Rt1Nv5Zw9Hc3Jf6Ls0Yb', // 38
  ] as const

  it('every one of these WOULD be destroyed under any other key', () => {
    // The control. Without it the test below could pass because the values are
    // innocuous rather than because the exemption works.
    for (const id of STRIPE_IDS) {
      expect(id.length, id).toBeGreaterThanOrEqual(24)
      const { properties } = sanitizeProperties({ purchase_ref: id })
      expect(properties['purchase_ref'], id).toBe('[redacted]')
    }
  })

  it('survives intact under `order_id`', () => {
    for (const id of STRIPE_IDS) {
      const { properties } = sanitizeProperties({ order_id: id })
      expect(properties['order_id'], id).toBe(id)
    }
  })

  it('is the one key, matched case-insensitively and never by substring', () => {
    const id = STRIPE_IDS[0]
    expect(sanitizeProperties({ Order_Id: id }).properties['Order_Id']).toBe(id)
    // A fuzzy match would quietly widen an exemption that is meant to name one
    // documented property.
    for (const key of ['internal_order_id', 'order_id_2', 'orderid', 'order']) {
      expect(sanitizeProperties({ [key]: id }).properties[key], key).toBe('[redacted]')
    }
  })

  it('STILL redacts a value that is a known secret by shape', () => {
    // The whole point of exempting the generic rule rather than the key: what is
    // lifted is "long and mixed-case", not "this key is safe".
    // The Stripe-shaped ones are joined at runtime: literals of this shape trip
    // GitHub push protection on the public export (ADR-0060) — synthetic either way.
    for (const secret of [
      ['sk_test', '51QkR2fJk9Xa1bCdEfGhIjKlMnOpQrStUvWxYz'].join('_'),
      ['sk_live', '51QkR2fJk9Xa1bCdEfGhIjKlMnOpQrStUvWxYz'].join('_'),
      ['rk_live', '51QkR2fJk9Xa1bCdEfGhIjKlMnOpQrStUvWxYz'].join('_'),
      'whsec_9Xa1bCdEfGhIjKlMnOpQrStUvWxYz012345',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
    ]) {
      expect(sanitizeProperties({ order_id: secret }).properties['order_id'], secret).toBe(
        '[redacted]',
      )
    }
  })

  it('STILL redacts an email under `order_id`', () => {
    const { properties } = sanitizeProperties({ order_id: 'buyer@example.com' })
    expect(properties['order_id']).toBe('[redacted]')
  })

  it('STILL redacts a long digit run under `order_id`', () => {
    // A card number pasted into the wrong box is the reason this rule outlives
    // the exemption.
    const { properties } = sanitizeProperties({ order_id: '4242424242424242' })
    expect(properties['order_id']).toBe('[redacted]')
  })

  it('stops exempting past the length cap', () => {
    // The exemption must not be a hole somebody can post a document through.
    // One leading digit so the value is mixed-alphabet (what the generic rule
    // looks for), and no run of nine to trip the digit rule.
    const atCap = `pi_7${'aB'.repeat(OPAQUE_ID_MAX_LENGTH)}`.slice(0, OPAQUE_ID_MAX_LENGTH)
    expect(atCap).toHaveLength(OPAQUE_ID_MAX_LENGTH)
    expect(sanitizeProperties({ order_id: atCap }).properties['order_id']).toBe(atCap)

    const overCap = `${atCap}X`
    expect(overCap.length).toBeGreaterThan(OPAQUE_ID_MAX_LENGTH)
    expect(sanitizeProperties({ order_id: overCap }).properties['order_id']).toBe('[redacted]')
  })

  it('still redacts a digit run inside an order id, and that is the accepted trade', () => {
    // `redactDigitRuns` survives the exemption because a card number pasted into
    // this box is a real mistake and a permanent incident. The cost is that a
    // provider id containing nine or more consecutive digits is partially
    // redacted and will not match — for a base62 Stripe id that is a few in a
    // million, and the failure is a missed attribution rather than a wrong
    // number. Pinned so the trade is a decision rather than a surprise.
    const withRun = 'pi_3Rt1234567890Zk9Xa1bCdEf'
    expect(sanitizeProperties({ order_id: withRun }).properties['order_id']).not.toBe(withRun)
  })

  it('leaves every other key behaving exactly as before', () => {
    // The regression guard. One key changed; nothing else may have.
    const { properties, dropped } = sanitizeProperties({
      plan: 'pro',
      seats: 12,
      api_token: 'abc',
      order_id: STRIPE_IDS[0],
      note: 'Order pi_3RtZ8kQ2mNvXpL4aB7cD9eF0 confirmed',
    })
    expect(properties['plan']).toBe('pro')
    expect(properties['seats']).toBe(12)
    expect(dropped).toContain('api_token')
    expect(properties['order_id']).toBe(STRIPE_IDS[0])
    // A free-text value that happens to contain an id is untouched by the
    // exemption: it has a space, so the generic rule never applied to it anyway.
    expect(properties['note']).toBe('Order pi_3RtZ8kQ2mNvXpL4aB7cD9eF0 confirmed')
  })

  it('exposes the key predicate so the matcher and the collector agree', () => {
    expect(isOpaqueIdPropertyKey('order_id')).toBe(true)
    expect(isOpaqueIdPropertyKey(' ORDER_ID ')).toBe(true)
    expect(isOpaqueIdPropertyKey('order')).toBe(false)
  })
})

describe('the linking hint, server-side (ADR-0064 D4a)', () => {
  const bag = { order_id: 'cs_test_a1B2c3', plan: 'growth', seats: 3 }

  it('removes the hint for a site that has not turned attributed revenue on', () => {
    const out = stripLinkingHints(bag, false)

    expect(out.properties).toEqual({ plan: 'growth', seats: 3 })
    expect(out.dropped).toEqual(['order_id'])
    // The input is not mutated: the caller's sanitized map is still whole, and
    // two callers sharing one map cannot strip it for each other.
    expect(bag.order_id).toBe('cs_test_a1B2c3')
  })

  it('passes the hint through for a site that did — the positive control', () => {
    const out = stripLinkingHints(bag, true)

    expect(out.properties).toEqual(bag)
    expect(out.dropped).toEqual([])
  })

  it('matches the key case-insensitively, as the tracker does', () => {
    expect(stripLinkingHints({ Order_Id: 'pi_1', ' ORDER_ID ': 'pi_2' }, false).dropped).toEqual([
      'Order_Id',
      ' ORDER_ID ',
    ])
    // Nothing is inferred from a substring: the exemption names one key.
    expect(stripLinkingHints({ internal_order_id: 'x' }, false).dropped).toEqual([])
  })

  it('leaves an event with an empty bag rather than dropping the event', () => {
    // The conversion is a measurement signal and stays one; the server envelope
    // already spells "no properties" as `{}`, so a stripped event is
    // indistinguishable from one that never carried a hint.
    expect(stripLinkingHints({ order_id: 'pi_1' }, false).properties).toEqual({})
  })

  it('returns the same map when there is nothing to remove', () => {
    const ordinary = { plan: 'growth' }
    expect(stripLinkingHints(ordinary, false).properties).toBe(ordinary)
  })

  it('reads the one list the opaque-id exemption already keeps', () => {
    // One list, two rules: a key is exempt from opaque-token redaction because
    // it carries a provider id, which is exactly what makes it a linking hint.
    for (const key of OPAQUE_ID_PROPERTY_KEYS) {
      expect(isOpaqueIdPropertyKey(key)).toBe(true)
      expect(stripLinkingHints({ [key]: 'pi_1' }, false).dropped).toEqual([key])
    }
  })
})

describe('the widened secret shapes (M12 CP7)', () => {
  it('redacts a Stripe restricted key wherever it appears', () => {
    // `rk_` is the exact secret the M12 connect form asks a customer to paste,
    // and therefore the exact one that ends up in the wrong box.
    // Joined at runtime for the same push-protection reason as above.
    expect(redactSensitiveText(['rk_live', '51QkR2fJk9Xa1bCdEfGhIjKlMnOpQrStUv'].join('_'))).toBe(
      '[redacted]',
    )
    expect(
      redactSensitiveText(`key is ${['rk_test', '51QkR2fJk9Xa1bCdEfGhIjKlMnOpQ'].join('_')} here`),
    ).toContain('[redacted]')
  })

  it('redacts a Bearer header, which carries a space and so escapes the token rule', () => {
    expect(redactSensitiveText('Bearer abcdefghijklmnopqrstuvwxyz012345')).toBe('[redacted]')
    expect(redactSensitiveText('authorization: bearer abcdefghijklmnop')).toContain('[redacted]')
  })
})

describe('heatmap element text', () => {
  it('collapses whitespace, redacts PII and truncates', () => {
    expect(sanitizeElementText('  Buy   now  ')).toBe('Buy now')
    expect(sanitizeElementText('Email someone@example.com')).toContain(PII_REDACTED)
    expect(sanitizeElementText('t'.repeat(500))).toHaveLength(EVENT_LIMITS.elementTextMaxLength)
  })
})

describe('the whole interaction payload, server-side (ADR-0057 D6)', () => {
  const payload = (overrides: Partial<{ selector: string; text: string }> = {}) => ({
    x_percent: 50,
    y_percent: 50,
    viewport_class: 'desktop',
    viewport_width: 1280,
    selector: 'section#pricing>button.cta',
    ...overrides,
  })

  it('redacts text and selector without trusting the tracker did', () => {
    const out = sanitizeInteraction(
      payload({ selector: 'a.contact-sales@example.com', text: 'Write to sales@example.com' }),
    )
    expect(out.selector).toContain(PII_REDACTED)
    expect((out as { text?: string }).text).toContain(PII_REDACTED)
    expect(JSON.stringify(out)).not.toContain('example.com')
  })

  it('leaves an ordinary utility-class selector alone', () => {
    // The generic opaque-token rule is skipped for selectors: a dot-joined
    // Tailwind chain is long, spaceless and mixed-alphabet — the exact shape
    // the rule matches — and blanket-redacting it would blind every heatmap on
    // a utility-class site. The explicit rules still run (previous test).
    const selector = 'div.px-4.py-2.text-sm.font-medium'
    expect(redactSensitiveText(selector)).toBe(PII_REDACTED) // the shape does trip the generic rule
    expect(sanitizeInteraction(payload({ selector })).selector).toBe(selector)
  })

  it('drops text that sanitizes to nothing rather than storing an empty string', () => {
    const out = sanitizeInteraction(payload({ text: '   ' }))
    expect('text' in out).toBe(false)
  })

  it('keeps a validated selector non-empty and inside the contract limit', () => {
    const out = sanitizeInteraction(payload({ selector: 'x'.repeat(500) }))
    expect(out.selector.length).toBe(EVENT_LIMITS.selectorMaxLength)
    expect(sanitizeInteraction(payload()).selector.length).toBeGreaterThan(0)
  })
})
