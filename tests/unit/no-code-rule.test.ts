import { describe, expect, it } from 'vitest'
import {
  MAX_PUBLISHED_RULES_PER_SITE,
  SELECTOR_MAX_LENGTH,
  checkDisplayTemplate,
  checkSelector,
  checkUrlPattern,
  createEventDefinitionRequestSchema,
  eventDefinitionContentSchema,
  matchesUrlPattern,
  noCodeRuleSchema,
  renderDisplayTemplate,
  rulePropertySchema,
  templatePlaceholders,
} from '@openanalytics/domain'

/**
 * ADR-0034 D2/D7/D8 — the validation that stands between a dashboard field and
 * every visitor's browser.
 *
 * The hostile cases are the point of this file. A selector that reaches a
 * browser cannot be recalled, so each refusal below is asserted by *reason*
 * rather than by "it threw something": a `:has()` that started failing as
 * `malformed` instead of `unsupported_pseudo` would still pass a truthiness
 * check while meaning we had stopped recognising it.
 */

describe('checkSelector — the accepted grammar', () => {
  it.each([
    ['a tag', 'button'],
    ['a class', '.cta'],
    ['an id', '#buy'],
    ['a compound', 'button.cta.primary'],
    ['a descendant combinator', 'nav a'],
    ['a child combinator', 'form > button'],
    ['a child combinator without spaces', 'form>button'],
    ['the maximum depth', 'a b c d'],
    ['an attribute presence test', '[data-role]'],
    ['an attribute equality test', '[data-role="submit"]'],
    ['single quotes', "[data-role='submit']"],
    ['a hyphenated data attribute', '[data-checkout-step="2"]'],
    ['aria-label', '[aria-label="Close"]'],
    ['a tag with an attribute', 'a[href]'],
    ['a realistic rule', 'section.pricing > button.cta[data-plan="growth"]'],
  ])('accepts %s', (_label, selector) => {
    expect(checkSelector(selector)).toMatchObject({ ok: true })
  })

  it('reports the complexity it measured, which is what the bounds are about', () => {
    expect(checkSelector('div.a.b > span#c')).toEqual({ ok: true, compounds: 2, simple: 5 })
  })

  it('trims before measuring, so a pasted selector is not rejected for whitespace', () => {
    expect(checkSelector('  button.cta  ')).toMatchObject({ ok: true })
  })
})

describe('checkSelector — hostile and malformed input', () => {
  it.each([
    // The one selector whose cost is not bounded by the ancestor chain.
    [':has() is refused', 'div:has(a[href])', 'unsupported_pseudo'],
    ['a bare pseudo-class is refused', 'a:hover', 'unsupported_pseudo'],
    ['nth-child is refused, allowlist not denylist', 'li:nth-child(2)', 'unsupported_pseudo'],
    ['a pseudo-element is refused', 'p::before', 'unsupported_pseudo'],
    ['the universal selector is refused', '*', 'universal_selector'],
    ['a universal inside a compound is refused', 'div > *', 'universal_selector'],
    ['a selector list is refused', 'a,button', 'selector_list'],
    ['the adjacent sibling combinator is refused', 'h1 + p', 'unsupported_combinator'],
    ['the general sibling combinator is refused', 'h1 ~ p', 'unsupported_combinator'],
    ['a CSS escape is refused rather than decoded', 'div.a\\3a b', 'unsupported_character'],
    ['a backslash anywhere is refused', '.a\\.b', 'unsupported_character'],
    ['an attribute substring matcher is refused', '[href^="/pricing"]', 'unsupported_character'],
    ['an attribute contains matcher is refused', '[href*="pricing"]', 'unsupported_character'],
  ])('%s', (_label, selector, reason) => {
    expect(checkSelector(selector)).toEqual({ ok: false, reason })
  })

  it('refuses an input value attribute, and every other name outside the allowlist', () => {
    for (const selector of ['[value]', '[value="secret"]', 'input[value]', '[onclick]']) {
      expect(checkSelector(selector)).toEqual({ ok: false, reason: 'attribute_not_allowed' })
    }
  })

  it.each([
    ['an empty selector', '', 'empty'],
    ['whitespace only', '   ', 'empty'],
    ['a leading combinator', '> div', 'malformed'],
    ['a trailing combinator', 'div >', 'malformed'],
    ['a doubled combinator', 'a >> b', 'malformed'],
    ['a doubled combinator with spaces', 'a > > b', 'malformed'],
    ['an unterminated attribute', '[data-role', 'malformed'],
    ['an unterminated attribute value', '[data-role="submit', 'malformed'],
    ['an unquoted attribute value', '[data-role=submit]', 'malformed'],
    ['an empty class', 'div.', 'malformed'],
    ['an empty id', 'div#', 'malformed'],
    ['a class starting with a digit', '.1col', 'malformed'],
    ['a stray paren', 'div)', 'malformed'],
  ])('refuses %s', (_label, selector, reason) => {
    expect(checkSelector(selector)).toEqual({ ok: false, reason })
  })

  it('bounds depth and total complexity separately', () => {
    expect(checkSelector('a b c d e')).toEqual({ ok: false, reason: 'too_deep' })
    expect(checkSelector('div.a.b.c.d.e.f.g.h.i.j.k.l.m')).toEqual({
      ok: false,
      reason: 'too_complex',
    })
  })

  it('bounds length before it parses, so a megabyte of selector is cheap to refuse', () => {
    expect(checkSelector(`.${'a'.repeat(SELECTOR_MAX_LENGTH)}`)).toEqual({
      ok: false,
      reason: 'too_long',
    })
  })

  it('is total: every non-string and every control character gets a reason, never a throw', () => {
    for (const value of [undefined, null, 42, {}, [], Symbol('x')]) {
      expect(checkSelector(value)).toEqual({ ok: false, reason: 'malformed' })
    }
    expect(checkSelector('div\0span')).toEqual({ ok: false, reason: 'unsupported_character' })
    expect(checkSelector('div<span>')).toEqual({ ok: false, reason: 'unsupported_character' })
  })

  it('refuses a selector engineered to look like a nested query', () => {
    // Each of these is a real shape someone reaches for; none is representable.
    expect(checkSelector('div:has(:has(:has(a)))').ok).toBe(false)
    expect(checkSelector('*:not([data-x])').ok).toBe(false)
    expect(checkSelector('a[href]:not(.x), b[href]:not(.y)').ok).toBe(false)
  })
})

describe('checkUrlPattern', () => {
  it.each(['/pricing', '/blog/*', '/checkout/**', '/', '/a/b/c'])('accepts %s', (pattern) => {
    expect(checkUrlPattern(pattern)).toEqual({ ok: true })
  })

  it.each([
    ['', 'empty'],
    ['pricing', 'must_start_with_slash'],
    ['/a/../b', 'traversal'],
    ['/pricing?plan=growth', 'unsupported_character'],
    ['/pricing#top', 'unsupported_character'],
    ['/(a+)+$', 'unsupported_character'],
  ])('refuses %s', (pattern, reason) => {
    expect(checkUrlPattern(pattern)).toEqual({ ok: false, reason })
  })

  it('matches segment-wise, so * does not cross a slash', () => {
    expect(matchesUrlPattern('/blog/*', '/blog/hello')).toBe(true)
    expect(matchesUrlPattern('/blog/*', '/blog/2026/hello')).toBe(false)
    expect(matchesUrlPattern('/blog/**', '/blog/2026/hello')).toBe(true)
    expect(matchesUrlPattern('/pricing', '/pricing')).toBe(true)
    expect(matchesUrlPattern('/pricing', '/pricing/enterprise')).toBe(false)
    expect(matchesUrlPattern('/blog/*', '/blog')).toBe(false)
  })
})

describe('rulePropertySchema — an input value is never readable', () => {
  it('refuses attribute:value in the words a dashboard can show', () => {
    const result = rulePropertySchema.safeParse({
      key: 'typed',
      source: 'attribute',
      argument: 'value',
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toMatch(/never readable/u)
  })

  it('accepts structure the site author controls', () => {
    for (const argument of ['data-sku', 'aria-label', 'href', 'id']) {
      expect(
        rulePropertySchema.safeParse({ key: 'k', source: 'attribute', argument }).success,
      ).toBe(true)
    }
  })

  it('requires an argument exactly where one is meaningful', () => {
    expect(rulePropertySchema.safeParse({ key: 'k', source: 'attribute' }).success).toBe(false)
    expect(rulePropertySchema.safeParse({ key: 'k', source: 'text' }).success).toBe(true)
    expect(rulePropertySchema.safeParse({ key: 'k', source: 'text', argument: 'x' }).success).toBe(
      false,
    )
  })

  it('refuses the reserved oa_ prefix and malformed keys', () => {
    expect(rulePropertySchema.safeParse({ key: 'oa_billable', source: 'text' }).success).toBe(false)
    expect(rulePropertySchema.safeParse({ key: '1st', source: 'text' }).success).toBe(false)
  })
})

describe('checkDisplayTemplate', () => {
  const declared = ['button_label', 'page_path']

  it('accepts a sentence with declared placeholders', () => {
    expect(checkDisplayTemplate('Clicked “{{button_label}}” on {{page_path}}', declared)).toEqual({
      ok: true,
      placeholders: ['button_label', 'page_path'],
    })
  })

  it('refuses markup outright rather than escaping it at render time', () => {
    expect(checkDisplayTemplate('<b>{{button_label}}</b>', declared)).toEqual({
      ok: false,
      reason: 'markup_not_allowed',
    })
    expect(checkDisplayTemplate('<img src=x onerror=alert(1)>', declared)).toEqual({
      ok: false,
      reason: 'markup_not_allowed',
    })
  })

  it('refuses a placeholder the version does not declare, and names it', () => {
    expect(checkDisplayTemplate('Clicked {{secret}}', declared)).toEqual({
      ok: false,
      reason: 'undeclared_property',
      detail: 'secret',
    })
  })

  it('refuses a malformed placeholder rather than rendering it literally', () => {
    expect(checkDisplayTemplate('Clicked {{button label}}', declared)).toEqual({
      ok: false,
      reason: 'malformed_placeholder',
    })
    expect(checkDisplayTemplate('Clicked {{button_label', declared)).toEqual({
      ok: false,
      reason: 'malformed_placeholder',
    })
  })

  it('bounds length and placeholder count', () => {
    expect(checkDisplayTemplate('x'.repeat(201), declared).ok).toBe(false)
    const many = Array.from({ length: 9 }, (_, i) => `{{p${i}}}`).join(' ')
    expect(
      checkDisplayTemplate(
        many,
        Array.from({ length: 9 }, (_, i) => `p${i}`),
      ),
    ).toEqual({
      ok: false,
      reason: 'too_many_placeholders',
    })
  })

  it('deduplicates placeholders when counting', () => {
    expect(templatePlaceholders('{{a}} and {{a}}')).toEqual(['a'])
  })
})

describe('renderDisplayTemplate', () => {
  it('interpolates and reports completeness', () => {
    expect(
      renderDisplayTemplate('Clicked “{{button_label}}” on {{page_path}}', {
        button_label: 'Start trial',
        page_path: '/pricing',
      }),
    ).toEqual({ text: 'Clicked “Start trial” on /pricing', complete: true })
  })

  it('renders a missing property as an em dash and says the sentence is incomplete', () => {
    expect(renderDisplayTemplate('Clicked {{button_label}}', {})).toEqual({
      text: 'Clicked —',
      complete: false,
    })
    expect(renderDisplayTemplate('Clicked {{button_label}}', { button_label: '' })).toEqual({
      text: 'Clicked —',
      complete: false,
    })
  })

  it('never throws on a property whose type is not a string', () => {
    expect(renderDisplayTemplate('{{n}}/{{b}}', { n: 3, b: false })).toEqual({
      text: '3/false',
      complete: true,
    })
  })
})

describe('noCodeRuleSchema', () => {
  const id = '0192f7a0-0000-7000-8000-000000000001'

  it('pairs a selector with a selector trigger and a pattern with url_pattern', () => {
    expect(
      noCodeRuleSchema.safeParse({ rule_id: id, trigger: 'click', selector: 'button.cta' }).success,
    ).toBe(true)
    expect(
      noCodeRuleSchema.safeParse({ rule_id: id, trigger: 'url_pattern', url_pattern: '/thanks' })
        .success,
    ).toBe(true)
  })

  it('refuses the wrong locator for the trigger, in words that name the trigger', () => {
    const wrong = noCodeRuleSchema.safeParse({
      rule_id: id,
      trigger: 'click',
      url_pattern: '/thanks',
    })
    expect(wrong.success).toBe(false)
    expect(JSON.stringify(wrong.error?.issues)).toMatch(/takes a selector/u)
  })

  it('carries the selector rejection reason out to the caller', () => {
    const result = noCodeRuleSchema.safeParse({
      rule_id: id,
      trigger: 'click',
      selector: 'div:has(a)',
    })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toMatch(/unsupported_pseudo/u)
  })
})

describe('eventDefinitionContentSchema', () => {
  const base = {
    display_name: 'Pricing CTA clicked',
    property_schema: [{ key: 'button_label' }],
  }

  it('refuses a rule mapping to a property the definition does not declare', () => {
    const result = eventDefinitionContentSchema.safeParse({
      ...base,
      rules: [
        {
          rule_id: '0192f7a0-0000-7000-8000-000000000001',
          trigger: 'click',
          selector: 'button.cta',
          properties: [{ key: 'undeclared', source: 'text' }],
        },
      ],
    })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toMatch(/not declared in property_schema/u)
  })

  it('refuses a template referring to an undeclared property', () => {
    const result = eventDefinitionContentSchema.safeParse({
      ...base,
      display_template: 'Clicked {{nope}}',
    })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toMatch(/undeclared property nope/u)
  })

  it('accepts a whole realistic definition and applies its defaults', () => {
    const result = eventDefinitionContentSchema.safeParse({
      ...base,
      display_template: 'Clicked “{{button_label}}”',
      rules: [
        {
          rule_id: '0192f7a0-0000-7000-8000-000000000001',
          trigger: 'click',
          selector: 'section.pricing > button.cta',
          properties: [{ key: 'button_label', source: 'text' }],
        },
      ],
    })
    expect(result.success).toBe(true)
    expect(result.data?.description).toBeNull()
    expect(result.data?.category).toBeNull()
    expect(result.data?.property_schema[0]?.type).toBe('string')
  })

  it('caps a version at the flat published-rule limit', () => {
    const rules = Array.from({ length: MAX_PUBLISHED_RULES_PER_SITE + 1 }, (_, i) => ({
      rule_id: `0192f7a0-0000-7000-8000-${String(i).padStart(12, '0')}`,
      trigger: 'click' as const,
      selector: 'button.cta',
    }))
    expect(eventDefinitionContentSchema.safeParse({ ...base, rules }).success).toBe(false)
  })

  it('refuses duplicate rule ids within one version', () => {
    const rule = {
      rule_id: '0192f7a0-0000-7000-8000-000000000001',
      trigger: 'click' as const,
      selector: 'button.cta',
    }
    expect(eventDefinitionContentSchema.safeParse({ ...base, rules: [rule, rule] }).success).toBe(
      false,
    )
  })

  it('shares its cross-field checks with the create-definition request', () => {
    const result = createEventDefinitionRequestSchema.safeParse({
      event_name: 'pricing_cta_clicked',
      ...base,
      display_template: 'Clicked {{nope}}',
    })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toMatch(/undeclared property nope/u)
  })

  it('refuses an event name the contract would refuse', () => {
    expect(
      createEventDefinitionRequestSchema.safeParse({ event_name: '1bad', ...base }).success,
    ).toBe(false)
  })
})
