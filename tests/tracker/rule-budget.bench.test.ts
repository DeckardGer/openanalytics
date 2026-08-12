import { MAX_PUBLISHED_RULES_PER_SITE } from '@openanalytics/domain'
import { createRules, type NoCodeRule } from '../../apps/tracker/src/index.ts'
import { describe, expect, it } from 'vitest'

/**
 * ADR-0034 acceptance criterion 2: **selector abuse does not slow the tracker**.
 *
 * The measurement, and what it is worth. This runs in happy-dom, whose
 * `closest()` is a JavaScript selector engine — a real browser's is native and
 * substantially faster at the matching itself. So the number below is a
 * conservative upper bound on our own per-click cost, not a Chrome benchmark:
 * the loop, the property extraction and the budget check are exactly what ship,
 * and the one part that is slower here than in production is the part we do not
 * write.
 *
 * The worst case is built to the limits D2 actually allows, not to a
 * comfortable shape: `MAX_PUBLISHED_RULES_PER_SITE` rules, each at the maximum
 * combinator depth and close to the simple-selector ceiling, none of them
 * matching — a miss is the expensive case, because a match short-circuits the
 * ancestor walk and a miss walks it to the root.
 */

/** A 4-compound, 12-simple selector: the most expensive shape D2 permits. */
function worstCaseSelector(index: number): string {
  return (
    `div.wrap-${index}.col-${index} > ` +
    `section.panel-${index}.inner-${index} > ` +
    `ul.list-${index}.rows-${index} > ` +
    `li.item-${index}.cell-${index}[data-idx="${index}"]`
  )
}

function deepDom(depth: number): Element {
  document.body.innerHTML = ''
  let node: Element = document.body
  for (let i = 0; i < depth; i += 1) {
    const child = document.createElement('div')
    child.className = `depth-${i} filler-${i}`
    child.setAttribute('data-depth', String(i))
    node.appendChild(child)
    node = child
  }
  const leaf = document.createElement('button')
  leaf.className = 'cta target'
  node.appendChild(leaf)
  return leaf
}

describe('selector abuse does not slow the tracker', () => {
  it('bounds the worst case at the full published-rule ceiling', () => {
    const rules: NoCodeRule[] = Array.from(
      { length: MAX_PUBLISHED_RULES_PER_SITE },
      (_, i): NoCodeRule => ({
        rule_id: `r_${i}`,
        name: `evt_${i}`,
        version: 1,
        trigger: 'click',
        selector: worstCaseSelector(i),
      }),
    )

    // A 32-deep tree: deeper than the great majority of real pages, and the
    // dimension `closest()` cost is actually bounded by.
    const target = deepDom(32)

    const emitted: unknown[] = []
    const clock = 0
    const runtime = createRules({
      document,
      location: () => ({ href: 'https://shop.example.com/p', pathname: '/p', search: '' }),
      rules: () => rules,
      redactQueryKeys: () => [],
      // A clock that never advances, so the runtime's own 2 ms budget cannot
      // disarm it mid-measurement and flatter the result.
      now: () => clock,
      newActionId: () => 'a1',
      emit: (match) => emitted.push(match),
    })
    runtime.start()

    const CLICKS = 1_000
    const startedAt = performance.now()
    for (let i = 0; i < CLICKS; i += 1) {
      target.dispatchEvent(new Event('click', { bubbles: true }))
    }
    const elapsed = performance.now() - startedAt
    runtime.stop()

    const perClickMs = elapsed / CLICKS
    // Reported rather than only asserted: the number is the deliverable, and a
    // regression that stays under the ceiling is still worth seeing in CI logs.
    // `process.stdout` rather than `console`, which the lint config bans.
    const line =
      `[rule-budget] ${MAX_PUBLISHED_RULES_PER_SITE} rules x ${CLICKS} clicks over a 32-deep DOM: ` +
      `${elapsed.toFixed(1)} ms total, ${perClickMs.toFixed(3)} ms/click (happy-dom)`
    process.stdout.write(`${line}
`)

    // None of the worst-case selectors matches the target, so nothing is emitted
    // and the whole cost is the ancestor walk this test exists to bound.
    expect(emitted).toHaveLength(0)
    // Generous against a shared CI runner, and still two orders of magnitude
    // below anything a person could perceive on a click.
    expect(perClickMs).toBeLessThan(20)
  })

  it('disarms after a click that exceeds the budget, and rearms on the next pageview', () => {
    const rules: NoCodeRule[] = [
      { rule_id: 'r', name: 'e', version: 1, trigger: 'click', selector: 'button.cta' },
    ]
    const target = deepDom(4)

    const emitted: unknown[] = []
    let ticks = 0
    const runtime = createRules({
      document,
      location: () => ({ href: 'https://shop.example.com/p', pathname: '/p', search: '' }),
      rules: () => rules,
      redactQueryKeys: () => [],
      // Every reading jumps past the budget, which is what a pathological page
      // looks like from inside the runtime.
      now: () => (ticks += 100),
      newActionId: () => 'a1',
      emit: (match) => emitted.push(match),
    })
    runtime.start()

    target.dispatchEvent(new Event('click', { bubbles: true }))
    target.dispatchEvent(new Event('click', { bubbles: true }))
    target.dispatchEvent(new Event('click', { bubbles: true }))
    // The first click is reported; the runtime is off for the rest of the page.
    expect(emitted).toHaveLength(1)

    // A new pageview is a fresh budget: a heavy page must not silently disable
    // rules for the remainder of the session.
    runtime.onPageView()
    target.dispatchEvent(new Event('click', { bubbles: true }))
    expect(emitted).toHaveLength(2)

    runtime.stop()
  })
})
