import { RULE_BUDGET_MS, matchesPattern } from '../../apps/tracker/src/index.ts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, resetBrowser, settle, type Harness } from './harness.ts'

/**
 * The no-code rule runtime in a real DOM (ADR-0034, D1/D2/D5/D8).
 *
 * Three properties are worth a browser rather than a unit test, because none of
 * them is observable without real event dispatch:
 *
 * 1. **`action_id` correlation.** A site's own `onClick` handler calls
 *    `oa.track()` synchronously inside the click, and it must come out sharing
 *    an id with the rule's event. This is what makes D-101's collapse reachable
 *    at all, and it cannot be asserted without dispatching a real click.
 * 2. **An input's value is never captured**, even when a rule asks for the text
 *    of an element that contains one.
 * 3. **The per-click budget** actually disarms the runtime.
 */

const RULE = {
  rule_id: 'r_cta',
  name: 'pricing_cta_clicked',
  version: 1,
  trigger: 'click' as const,
  selector: 'section.pricing > button.cta',
  properties: [
    { key: 'button_label', source: 'text' },
    { key: 'page_path', source: 'page_path' },
  ],
}

function html(markup: string): void {
  document.body.innerHTML = markup
}

/** A harness whose config already carries rules, as a config fetch would. */
function withRules(rules: unknown[], overrides: Record<string, unknown> = {}): Harness {
  return createHarness({
    config: { noCodeRules: rules as never, ...overrides },
  })
}

describe('no-code rules in the browser', () => {
  beforeEach(() => {
    resetBrowser('/pricing')
    html('')
  })

  afterEach(() => {
    html('')
  })

  it('produces a canonical event when a click matches, carrying rule_id', async () => {
    html('<section class="pricing"><button class="cta">Start trial</button></section>')
    const h = withRules([RULE])

    document.querySelector('button')?.click()
    await settle()
    h.tracker.flush()
    await settle()

    const events = h.eventsOfType('custom_event')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      name: 'pricing_cta_clicked',
      rule_id: 'r_cta',
      properties: { button_label: 'Start trial', page_path: '/pricing' },
    })
    expect(events[0]?.['action_id']).toBeTypeOf('string')

    h.stop()
  })

  it('gives the rule event and the site own track() call one shared action_id', async () => {
    html('<section class="pricing"><button class="cta">Start trial</button></section>')
    const h = withRules([RULE])

    // Exactly what a customer writes: a handler on their own button that calls
    // the tracker synchronously. Nobody passes an action id by hand.
    document.querySelector('button')?.addEventListener('click', () => {
      h.tracker.track('pricing_cta_clicked')
    })

    document.querySelector('button')?.click()
    await settle()
    h.tracker.flush()
    await settle()

    const events = h.eventsOfType('custom_event')
    expect(events).toHaveLength(2)
    const ids = new Set(events.map((event) => event['action_id']))
    // One id across both, which is what lets the server bill the pair once.
    expect(ids.size).toBe(1)
    expect([...ids][0]).toBeTypeOf('string')
    // And exactly one of them is the rule's.
    expect(events.filter((event) => event['rule_id'] === 'r_cta')).toHaveLength(1)

    h.stop()
  })

  it('does not leak the action id to a track() call made later', async () => {
    html('<section class="pricing"><button class="cta">Start trial</button></section>')
    const h = withRules([RULE])

    document.querySelector('button')?.click()
    await settle()
    // A macrotask later: an unrelated call must not join that action.
    h.tracker.track('newsletter_signup')
    h.tracker.flush()
    await settle()

    const events = h.eventsOfType('custom_event')
    const later = events.find((event) => event['name'] === 'newsletter_signup')
    expect(later?.['action_id']).toBeUndefined()

    h.stop()
  })

  it('matches through a descendant, because a click lands on the inner node', async () => {
    html('<section class="pricing"><button class="cta"><span>Start trial</span></button></section>')
    const h = withRules([RULE])

    // The event target is the span; `closest()` is what finds the button.
    document.querySelector('span')?.click()
    await settle()
    h.tracker.flush()
    await settle()

    expect(h.eventsOfType('custom_event')).toHaveLength(1)
    h.stop()
  })

  it('ignores a click that matches nothing', async () => {
    html('<section class="pricing"><button class="other">No</button></section>')
    const h = withRules([RULE])

    document.querySelector('button')?.click()
    await settle()
    h.tracker.flush()
    await settle()

    expect(h.eventsOfType('custom_event')).toHaveLength(0)
    h.stop()
  })

  it('never captures what a person typed, even asked for directly', async () => {
    html('<form class="signup"><input class="field" value="secret@example.com" /></form>')
    const h = withRules([
      {
        rule_id: 'r_input',
        name: 'field_clicked',
        version: 1,
        trigger: 'click',
        selector: 'input.field',
        properties: [
          { key: 'typed', source: 'text' },
          // `value` is refused server-side, but the runtime must not depend on
          // that: an attribute outside the allowlist is dropped here too.
          { key: 'attr', source: 'attribute', argument: 'value' },
        ],
      },
    ])

    document.querySelector('input')?.click()
    await settle()
    h.tracker.flush()
    await settle()

    const events = h.eventsOfType('custom_event')
    expect(events).toHaveLength(1)
    // The event fires -- the click is real -- but it carries no value at all.
    expect(events[0]?.['properties']).toBeUndefined()
    expect(JSON.stringify(events[0])).not.toContain('secret@example.com')

    h.stop()
  })

  it('redacts an email that a site put in its own button text', async () => {
    html('<section class="pricing"><button class="cta">Email us at a@b.com</button></section>')
    const h = withRules([RULE])

    document.querySelector('button')?.click()
    await settle()
    h.tracker.flush()
    await settle()

    const properties = h.eventsOfType('custom_event')[0]?.['properties'] as Record<string, string>
    expect(properties['button_label']).not.toContain('a@b.com')
    expect(properties['button_label']).toContain('[redacted]')

    h.stop()
  })

  it('fires a submit rule on the form, not on the button inside it', async () => {
    html('<form class="signup"><button type="submit">Go</button></form>')
    const h = withRules([
      {
        rule_id: 'r_submit',
        name: 'signup_submitted',
        version: 1,
        trigger: 'submit',
        selector: 'form.signup',
      },
    ])

    document.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true }))
    await settle()
    h.tracker.flush()
    await settle()

    const events = h.eventsOfType('custom_event')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ name: 'signup_submitted', rule_id: 'r_submit' })

    h.stop()
  })

  it('does not fire a click rule on a submit, or the reverse', async () => {
    html('<form class="signup"><button class="cta">Go</button></form>')
    const h = withRules([
      { rule_id: 'r_c', name: 'a_click', version: 1, trigger: 'click', selector: 'form.signup' },
      { rule_id: 'r_s', name: 'a_submit', version: 1, trigger: 'submit', selector: 'form.signup' },
    ])

    document.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true }))
    await settle()
    h.tracker.flush()
    await settle()

    const names = h.eventsOfType('custom_event').map((event) => event['name'])
    expect(names).toEqual(['a_submit'])

    h.stop()
  })

  it('survives a selector the browser rejects, and keeps the other rules running', async () => {
    html('<section class="pricing"><button class="cta">Start trial</button></section>')

    // `closest` is patched rather than relying on a genuinely invalid selector:
    // happy-dom's parser is more forgiving than a real engine's, so a string
    // that throws in Chrome is silently accepted here. What is under test is our
    // own guard — one rule's throw must not take the others down — so the throw
    // is injected directly instead of hoping the environment produces one.
    const original = Element.prototype.closest
    Element.prototype.closest = function patched(this: Element, selector: string) {
      if (selector === 'BOOM') throw new SyntaxError('unsupported selector')
      return original.call(this, selector)
    } as typeof original

    try {
      const h = withRules([
        { rule_id: 'r_bad', name: 'bad', version: 1, trigger: 'click', selector: 'BOOM' },
        RULE,
      ])

      document.querySelector('button')?.click()
      await settle()
      h.tracker.flush()
      await settle()

      const names = h.eventsOfType('custom_event').map((event) => event['name'])
      expect(names).toEqual(['pricing_cta_clicked'])

      h.stop()
    } finally {
      Element.prototype.closest = original
    }
  })

  it('is not sampled away by interaction_sampling, because it is billable', async () => {
    html('<section class="pricing"><button class="cta">Start trial</button></section>')
    // Sampling zero silences the heatmap signal entirely; a semantic event must
    // still fire, or a customer usage figure would become a dice roll.
    const h = withRules([RULE], { interactionSampling: 0 })

    document.querySelector('button')?.click()
    await settle()
    h.tracker.flush()
    await settle()

    expect(h.eventsOfType('custom_event')).toHaveLength(1)
    expect(h.eventsOfType('interaction')).toHaveLength(0)

    h.stop()
  })

  it('fires a url_pattern rule on the pageview, and on an SPA route change', async () => {
    const h = withRules([
      {
        rule_id: 'r_url',
        name: 'checkout_reached',
        version: 1,
        trigger: 'url_pattern',
        url_pattern: '/checkout/*',
      },
    ])

    // The initial pageview was /pricing, which does not match.
    h.tracker.flush()
    await settle()
    expect(h.eventsOfType('custom_event')).toHaveLength(0)

    window.history.pushState(null, '', '/checkout/success')
    await settle()
    h.tracker.flush()
    await settle()

    const events = h.eventsOfType('custom_event')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ name: 'checkout_reached', rule_id: 'r_url' })

    h.stop()
  })

  it('disarms itself when one click blows the evaluation budget', async () => {
    html('<section class="pricing"><button class="cta">Start trial</button></section>')

    // A clock that jumps past the budget on every read, which is what a
    // pathological page would look like from inside the runtime.
    let ticks = 0
    const h = createHarness({
      config: { noCodeRules: [RULE] as never },
      now: () => {
        ticks += 1
        return ticks * (RULE_BUDGET_MS + 10)
      },
    })

    document.querySelector('button')?.click()
    await settle()
    document.querySelector('button')?.click()
    await settle()
    h.tracker.flush()
    await settle()

    // The first click is reported; after it the runtime is off for this page.
    expect(h.eventsOfType('custom_event')).toHaveLength(1)

    h.stop()
  })
})

describe('matchesPattern', () => {
  it('consumes one segment for * and the rest for **', () => {
    expect(matchesPattern('/blog/*', '/blog/hello')).toBe(true)
    expect(matchesPattern('/blog/*', '/blog/2026/hello')).toBe(false)
    expect(matchesPattern('/blog/**', '/blog/2026/hello')).toBe(true)
    expect(matchesPattern('/pricing', '/pricing')).toBe(true)
    expect(matchesPattern('/pricing', '/pricing/pro')).toBe(false)
    expect(matchesPattern('/blog/*', '/blog')).toBe(false)
  })

  it('agrees with the server matcher on the cases the dashboard previews', () => {
    // The same table as `tests/unit/no-code-rule.test.ts`. Two implementations
    // exist because the bundle carries no workspace dependency; this is what
    // keeps them one behaviour.
    expect(matchesPattern('/checkout/**', '/checkout/a/b/c')).toBe(true)
    expect(matchesPattern('/', '/')).toBe(true)
    expect(matchesPattern('/a/b/c', '/a/b/c')).toBe(true)
  })
})
