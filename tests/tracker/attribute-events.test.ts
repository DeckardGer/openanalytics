import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, resetBrowser, settle, type Harness } from './harness.ts'

/**
 * `data-oa-event` in a real DOM (ADR-0037).
 *
 * The attribute is author-written markup, but it is not trusted input: the
 * hostile cases below — nested markers, an invalid name, a marker the trigger
 * does not fit, the same click described by a rule and a marker — are the
 * design, not edge cases. Each asserts what reaches the wire, because the wire
 * is what gets billed.
 */

const RULE = {
  rule_id: 'r_cta',
  name: 'signup_click',
  version: 1,
  trigger: 'click' as const,
  selector: 'button.cta',
}

function html(markup: string): void {
  document.body.innerHTML = markup
}

function withRules(rules: unknown[]): Harness {
  return createHarness({ config: { noCodeRules: rules as never } })
}

describe('data-oa-event in the browser', () => {
  beforeEach(() => {
    resetBrowser('/pricing')
    html('')
  })

  afterEach(() => {
    html('')
  })

  it('emits a custom_event named by the attribute, with an action_id and no rule_id', async () => {
    html('<button data-oa-event="signup_click">Sign up</button>')
    const h = createHarness()

    document.querySelector('button')?.click()
    await settle()
    h.tracker.flush()
    await settle()

    const events = h.eventsOfType('custom_event')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ name: 'signup_click' })
    expect(events[0]?.['rule_id']).toBeUndefined()
    expect(events[0]?.['properties']).toBeUndefined()
    expect(events[0]?.['action_id']).toBeTypeOf('string')

    h.stop()
  })

  it('fires from a click on a descendant, because delegation walks up', async () => {
    html('<a data-oa-event="cta_click" href="#"><span>Go</span></a>')
    const h = createHarness()

    document.querySelector('span')?.click()
    await settle()
    h.tracker.flush()
    await settle()

    expect(h.eventsOfType('custom_event')).toHaveLength(1)
    h.stop()
  })

  it('fires from a marked non-clickable ancestor, exactly once', async () => {
    // A marked wrapper div is legal: the author chose the subtree. One click
    // inside it is one event, whatever the inner element is.
    html('<div data-oa-event="hero_click"><p><em>fine print</em></p></div>')
    const h = createHarness()

    document.querySelector('em')?.click()
    await settle()
    h.tracker.flush()
    await settle()

    const events = h.eventsOfType('custom_event')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ name: 'hero_click' })

    h.stop()
  })

  it('resolves nested markers to the nearest one, one event per click', async () => {
    html(
      '<section data-oa-event="section_click">' +
        '<button data-oa-event="buy_click">Buy</button>' +
        '</section>',
    )
    const h = createHarness()

    document.querySelector('button')?.click()
    await settle()
    h.tracker.flush()
    await settle()

    const names = h.eventsOfType('custom_event').map((event) => event['name'])
    expect(names).toEqual(['buy_click'])

    h.stop()
  })

  it('drops an invalid name silently — nothing is sent at all', async () => {
    // Spaces, an email shape, and empty: all fail the event-name grammar the
    // wire enforces. The click produces no event and no error.
    html(
      '<button data-oa-event="not a name">A</button>' +
        '<button data-oa-event="user@example.com">B</button>' +
        '<button data-oa-event="">C</button>',
    )
    const h = createHarness()

    for (const button of Array.from(document.querySelectorAll('button'))) {
      ;(button as HTMLElement).click()
      await settle()
    }
    h.tracker.flush()
    await settle()

    expect(h.eventsOfType('custom_event')).toHaveLength(0)
    h.stop()
  })

  it('lets the rule win when both describe the same click under the same name', async () => {
    // The M13 rule and the attribute both say `signup_click`. One event goes
    // out, and it is the rule's — it carries rule_id (ADR-0037, D5).
    html('<button class="cta" data-oa-event="signup_click">Sign up</button>')
    const h = withRules([RULE])

    document.querySelector('button')?.click()
    await settle()
    h.tracker.flush()
    await settle()

    const events = h.eventsOfType('custom_event')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ name: 'signup_click', rule_id: 'r_cta' })

    h.stop()
  })

  it('fires both when the rule and the attribute name different events', async () => {
    html('<button class="cta" data-oa-event="upgrade_click">Sign up</button>')
    const h = withRules([RULE])

    document.querySelector('button')?.click()
    await settle()
    h.tracker.flush()
    await settle()

    const events = h.eventsOfType('custom_event')
    const names = events.map((event) => event['name']).sort()
    expect(names).toEqual(['signup_click', 'upgrade_click'])
    // Two configured descriptions of one click share one action_id.
    expect(new Set(events.map((event) => event['action_id'])).size).toBe(1)

    h.stop()
  })

  it('shares the action_id with a track() call from the site own click handler', async () => {
    html('<button data-oa-event="signup_click">Sign up</button>')
    const h = createHarness()

    document.querySelector('button')?.addEventListener('click', () => {
      h.tracker.track('signup_click')
    })

    document.querySelector('button')?.click()
    await settle()
    h.tracker.flush()
    await settle()

    const events = h.eventsOfType('custom_event')
    expect(events).toHaveLength(2)
    expect(new Set(events.map((event) => event['action_id'])).size).toBe(1)

    h.stop()
  })

  it('fires a marked form on submit, never on a click inside it', async () => {
    html(
      '<form data-oa-event="signup_submit">' +
        '<input class="field" type="text" />' +
        '<button type="button" class="inner">Not submit</button>' +
        '</form>',
    )
    const h = createHarness()

    // Clicks inside the marked form: nothing. Without the FORM carve-out these
    // would each have walked up and counted a submit that never happened.
    ;(document.querySelector('input') as HTMLElement).click()
    await settle()
    ;(document.querySelector('button.inner') as HTMLElement).click()
    await settle()
    h.tracker.flush()
    await settle()
    expect(h.eventsOfType('custom_event')).toHaveLength(0)

    document.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true }))
    await settle()
    h.tracker.flush()
    await settle()

    const events = h.eventsOfType('custom_event')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ name: 'signup_submit' })

    h.stop()
  })

  it('does not fire a marked non-form ancestor on submit', async () => {
    // The submit target is the form; the nearest marker is a div, and a div
    // fires on click only. Submit emits nothing here.
    html('<div data-oa-event="area_click"><form><button type="submit">Go</button></form></div>')
    const h = createHarness()

    document.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true }))
    await settle()
    h.tracker.flush()
    await settle()

    expect(h.eventsOfType('custom_event')).toHaveLength(0)
    h.stop()
  })

  it('never reads an input value, innerHTML or text — only the marked attributes', async () => {
    html(
      '<div data-oa-event="wrap_click">' +
        '<input value="secret@example.com" />' +
        '<b>bold secret text</b>' +
        '</div>',
    )
    const h = createHarness()

    document.querySelector('b')?.click()
    await settle()
    h.tracker.flush()
    await settle()

    const events = h.eventsOfType('custom_event')
    expect(events).toHaveLength(1)
    const wire = JSON.stringify(events[0])
    expect(wire).not.toContain('secret')
    expect(wire).not.toContain('bold')

    h.stop()
  })
})

/**
 * `data-oa-prop-*` (ADR-0038, D1/D2).
 *
 * The author's markup is not trusted input — a server-rendered template will
 * interpolate an email into one of these, and that is the case the design is
 * built for rather than the case it hopes not to meet. Every assertion below is
 * on the wire, because the wire is what is stored.
 */
describe('data-oa-prop-* in the browser', () => {
  beforeEach(() => {
    resetBrowser('/pricing')
    html('')
  })

  afterEach(() => {
    html('')
  })

  const clickAndRead = async (selector: string, h: Harness): Promise<Record<string, unknown>[]> => {
    ;(document.querySelector(selector) as HTMLElement).click()
    await settle()
    h.tracker.flush()
    await settle()
    return h.eventsOfType('custom_event')
  }

  it('carries properties from the marked element', async () => {
    html('<button data-oa-event="signup_click" data-oa-prop-section="hero">Go</button>')
    const h = createHarness()

    const events = await clickAndRead('button', h)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ name: 'signup_click', properties: { section: 'hero' } })

    h.stop()
  })

  it('takes the key verbatim after the prefix, which the HTML parser has lowercased', async () => {
    // D2, both spellings. Kebab-case survives being written down; camelCase is
    // not an error, it is a silently different key — a customer has to be able
    // to find out which one their dashboard will show.
    html(
      '<button data-oa-event="cta" data-oa-prop-button-label="Buy" data-oa-prop-buttonLabel="Sell">' +
        'Go</button>',
    )
    const h = createHarness()

    const events = await clickAndRead('button', h)
    expect(events[0]?.['properties']).toEqual({ 'button-label': 'Buy', buttonlabel: 'Sell' })

    h.stop()
  })

  it('redacts a PII value the site rendered into the markup', async () => {
    // The mistake this design exists for: a template interpolating the signed-in
    // user's address into an attribute. It leaves as `[redacted]`, and the event
    // still counts.
    html('<button data-oa-event="invite_sent" data-oa-prop-invitee="ada@example.com">Go</button>')
    const h = createHarness()

    const events = await clickAndRead('button', h)
    expect(events[0]?.['properties']).toEqual({ invitee: '[redacted]' })
    expect(JSON.stringify(events[0])).not.toContain('ada@example.com')

    h.stop()
  })

  it('drops a reserved oa_ key, a sensitive key and an over-long key, keeping the rest', async () => {
    // `oa_` is the server's own namespace (packages/clickhouse events-raw fold),
    // `session` is on the redaction list, and the key cap is 40 characters. Each
    // is dropped individually: one bad property never costs the event, and never
    // costs the properties beside it.
    const overlong = 'k'.repeat(41)
    html(
      '<button data-oa-event="checkout"' +
        ' data-oa-prop-oa_billable="1"' +
        ' data-oa-prop-session="abc"' +
        ` data-oa-prop-${overlong}="x"` +
        ' data-oa-prop-plan="pro">Go</button>',
    )
    const h = createHarness()

    const events = await clickAndRead('button', h)
    expect(events).toHaveLength(1)
    expect(events[0]?.['properties']).toEqual({ plan: 'pro' })

    h.stop()
  })

  it('applies the site own extra redaction keys, exactly as track() does', async () => {
    html('<button data-oa-event="cta" data-oa-prop-ref="r-1" data-oa-prop-plan="pro">Go</button>')
    const h = createHarness({ config: { redactQueryKeys: ['ref'] } })

    const events = await clickAndRead('button', h)
    expect(events[0]?.['properties']).toEqual({ plan: 'pro' })

    h.stop()
  })

  it('reads properties from the marked element only — never an ancestor or a descendant', async () => {
    // D1: same element, no inheritance. The wrapper's property and the inner
    // span's are both markup the author wrote, and neither is on the element
    // that carries the name.
    html(
      '<div data-oa-prop-outer="wrap">' +
        '<button data-oa-event="buy" data-oa-prop-plan="pro">' +
        '<span data-oa-prop-inner="span">Go</span>' +
        '</button></div>',
    )
    const h = createHarness()

    const events = await clickAndRead('span', h)
    expect(events[0]?.['properties']).toEqual({ plan: 'pro' })

    h.stop()
  })

  it('sends no properties key at all when a marked element carries none', async () => {
    html('<div data-oa-prop-x="1"><button data-oa-event="buy">Go</button></div>')
    const h = createHarness()

    const events = await clickAndRead('button', h)
    expect(events[0]?.['properties']).toBeUndefined()

    h.stop()
  })

  it('carries the marked form properties on submit, and nothing on a click inside it', async () => {
    html(
      '<form data-oa-event="signup_submit" data-oa-prop-plan="pro">' +
        // `type="button"`, so the click stays a click: a real submit button
        // submits the form, which is the *other* half of this test.
        '<input type="text" /><button type="button">Go</button>' +
        '</form>',
    )
    const h = createHarness()

    ;(document.querySelector('button') as HTMLElement).click()
    await settle()
    h.tracker.flush()
    await settle()
    expect(h.eventsOfType('custom_event')).toHaveLength(0)

    document.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true }))
    await settle()
    h.tracker.flush()
    await settle()

    const events = h.eventsOfType('custom_event')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ name: 'signup_submit', properties: { plan: 'pro' } })

    h.stop()
  })
})

/**
 * The middle-click (ADR-0038, D4).
 *
 * `auxclick`, button 1 exactly, and only inside a link — the element whose
 * middle-click has an outcome. The M13 rule pass does not run here at all, which
 * is asserted rather than assumed: extending a published rule's triggers moves a
 * live customer's counts.
 */
describe('middle-click on a marked element', () => {
  beforeEach(() => {
    resetBrowser('/pricing')
    html('')
  })

  afterEach(() => {
    html('')
  })

  const aux = (selector: string, button: number): void => {
    document
      .querySelector(selector)
      ?.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button }))
  }

  const flush = async (h: Harness): Promise<Record<string, unknown>[]> => {
    await settle()
    h.tracker.flush()
    await settle()
    return h.eventsOfType('custom_event')
  }

  it('emits when the middle button opens a marked link, with its properties', async () => {
    html('<a href="/signup" data-oa-event="signup" data-oa-prop-section="hero"><b>Go</b></a>')
    const h = createHarness()

    aux('b', 1)
    const events = await flush(h)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ name: 'signup', properties: { section: 'hero' } })
    expect(events[0]?.['action_id']).toBeTypeOf('string')

    h.stop()
  })

  it('emits when the marker is around the link rather than on it', async () => {
    html('<div data-oa-event="hero_click"><a href="/signup">Go</a></div>')
    const h = createHarness()

    aux('a', 1)
    expect(await flush(h)).toHaveLength(1)

    h.stop()
  })

  it('emits nothing on a marked element that is not a link', async () => {
    // A middle-click on a <div> opens nothing: on Windows it starts autoscroll,
    // on Linux it pastes the primary selection. The visitor followed no call to
    // action, so there is no click to count.
    html('<button data-oa-event="buy">Go</button>')
    const h = createHarness()

    aux('button', 1)
    expect(await flush(h)).toHaveLength(0)

    h.stop()
  })

  it('emits nothing for the right button, which auxclick also fires for', async () => {
    html('<a href="/signup" data-oa-event="signup">Go</a>')
    const h = createHarness()

    aux('a', 2)
    expect(await flush(h)).toHaveLength(0)

    h.stop()
  })

  it('leaves the marked form carve-out intact', async () => {
    html('<form data-oa-event="signup_submit"><a href="/x">Go</a></form>')
    const h = createHarness()

    aux('a', 1)
    expect(await flush(h)).toHaveLength(0)

    h.stop()
  })

  it('does not fire an M13 rule, whose trigger stays what it was', async () => {
    html('<a class="cta" href="/signup" data-oa-event="attr_signup">Go</a>')
    const h = withRules([{ ...RULE, selector: 'a.cta' }])

    aux('a', 1)
    const names = (await flush(h)).map((event) => event['name'])
    expect(names).toEqual(['attr_signup'])

    h.stop()
  })
})
