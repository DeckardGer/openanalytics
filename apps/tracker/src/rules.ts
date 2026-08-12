import { LIMITS } from './constants.ts'
import { bearsUserInput } from './interaction.ts'
import { isValidEventName, redactText, sanitizeProperties, truncate } from './sanitize.ts'
import type { PropertyValue } from './sanitize.ts'

/**
 * The no-code rule runtime (ADR-0034, D1/D2/D8).
 *
 * This is the only module in the tracker whose cost is paid on *every click of
 * every visitor*, so its shape is dictated by that rather than by tidiness:
 *
 * - **Two delegated listeners on `document`, never per-element binding and never
 *   polling.** A rule matches by walking up from the event target with
 *   `closest()`, so the cost is bounded by DOM *depth* — the one dimension the
 *   ADR-0034 D2 grammar can state a bound for. `querySelectorAll` would make it
 *   depend on document size instead, which no selector limit can bound.
 * - **A per-click time budget.** If evaluation ever exceeds
 *   `RULE_BUDGET_MS`, rules are switched off for the rest of the pageview. A
 *   tracker that has become a performance problem on somebody's site stops being
 *   one without waiting for a deploy.
 * - **An input's value is never read.** `bearsUserInput` is imported from
 *   `interaction.ts` rather than reimplemented, so the heatmap signal and the
 *   rule runtime cannot drift into disagreeing about what a form field is.
 *
 * Rules arrive already validated: the selector grammar, the complexity bound and
 * the property allowlist are enforced server-side at save time, so nothing here
 * re-checks them. What it does do is **fail closed per rule** — a selector the
 * browser rejects disables that rule for the page and leaves the others running.
 */

/** Milliseconds of rule evaluation one browser action may cost. */
export const RULE_BUDGET_MS = 2

export type RuleTrigger = 'click' | 'submit' | 'url_pattern'

export interface RuleProperty {
  readonly key: string
  readonly source: string
  readonly argument?: string
}

export interface NoCodeRule {
  readonly rule_id: string
  readonly name: string
  readonly version: number
  readonly trigger: RuleTrigger
  readonly selector?: string
  readonly url_pattern?: string
  readonly properties?: readonly RuleProperty[]
}

export interface RuleMatch {
  /** Absent for an attribute-marked event (ADR-0037): no rule produced it. */
  readonly ruleId?: string
  readonly name: string
  readonly properties?: Record<string, PropertyValue>
}

/**
 * The no-setup marker (ADR-0037): `<button data-oa-event="signup_click">`.
 *
 * Validated by the same event-name grammar as `track()` — a value that fails is
 * dropped silently, because the customer's markup is not our trusted input even
 * though its author is our customer.
 */
const EVENT_ATTRIBUTE = 'data-oa-event'

/**
 * Properties on the marked element (ADR-0038, D1/D2):
 * `<button data-oa-event="signup_click" data-oa-prop-plan="pro">`.
 *
 * The key is whatever follows the prefix, verbatim — which the HTML parser has
 * already lowercased, so `data-oa-prop-buttonLabel` arrives as `buttonlabel`
 * and kebab-case is the spelling that survives being written down (D2). Values
 * go through `sanitizeProperties`, the same pass `track()` applies: the author's
 * markup is not trusted input, because a server-rendered template interpolating
 * an email into one of these is the obvious well-intentioned mistake.
 */
const PROPERTY_ATTRIBUTE = 'data-oa-prop-'

function attributeProperties(
  element: Element,
  redactQueryKeys: readonly string[],
): Record<string, PropertyValue> | undefined {
  let raw: Record<string, string> | undefined
  for (const name of element.getAttributeNames()) {
    if (name.indexOf(PROPERTY_ATTRIBUTE) !== 0) continue
    if (!raw) raw = {}
    raw[name.slice(PROPERTY_ATTRIBUTE.length)] = element.getAttribute(name) ?? ''
  }
  return raw && sanitizeProperties(raw, redactQueryKeys)
}

/**
 * Path-glob matching, mirroring `matchesUrlPattern` in the domain package.
 *
 * Restated rather than imported for the same reason `types.ts` restates the wire
 * shapes: the bundle carries no workspace dependency. `*` consumes one segment,
 * `**` the rest — and it is deliberately not a regular expression, because one
 * supplied by a dashboard field and run in a visitor's browser is a ReDoS
 * against our customer's own users.
 */
export function matchesPattern(pattern: string, path: string): boolean {
  const p = pattern.split('/')
  const t = path.split('/')
  let i = 0
  for (; i < p.length; i += 1) {
    if (p[i] === '**') return true
    if (i >= t.length) return false
    if (p[i] !== '*' && p[i] !== t[i]) return false
  }
  return i === t.length
}

/** Attributes a rule may read. Mirrors the server grammar; `value` is absent. */
const ATTRIBUTE_ALLOWED = /^(?:data-[a-z0-9-]+|id|class|name|type|role|aria-label|href|title|alt)$/

function elementText(element: Element): string | undefined {
  // The privacy rule, applied before the text is anything but a local variable:
  // a form field has no text branch at all, and everything else is redacted.
  if (bearsUserInput(element)) return undefined
  const raw = (element.textContent ?? '').replace(/\s+/g, ' ').trim()
  if (raw === '') return undefined
  const redacted = truncate(redactText(raw), LIMITS.elementTextMaxLength)
  return redacted === '' ? undefined : redacted
}

export interface ExtractContext {
  readonly path: string
  readonly url: string
  readonly title: string
  readonly search: URLSearchParams | null
}

/**
 * Reads one mapped property off a matched element.
 *
 * Every branch returns structure the site's own author put in their markup, or
 * page context the tracker has already sanitized. There is no branch that
 * reaches a value a person typed, and `attribute` is bounded by an allowlist
 * that cannot spell `value` — the second of the three layers ADR-0034 D8
 * requires, after the server grammar and before the contract's own schema.
 */
function extract(
  rule: RuleProperty,
  element: Element | null,
  context: ExtractContext,
): string | undefined {
  switch (rule.source) {
    case 'text':
      return element ? elementText(element) : undefined
    case 'element_tag':
      return element ? element.tagName.toLowerCase() : undefined
    case 'page_path':
      return context.path
    case 'page_url':
      return context.url
    case 'page_title':
      return context.title === '' ? undefined : context.title
    case 'attribute': {
      const name = rule.argument ?? ''
      if (!element || !ATTRIBUTE_ALLOWED.test(name)) return undefined
      const value = element.getAttribute(name)
      return value === null ? undefined : truncate(redactText(value), LIMITS.propertyValueMaxLength)
    }
    case 'url_param': {
      const value = context.search?.get(rule.argument ?? '')
      return value == null ? undefined : truncate(redactText(value), LIMITS.propertyValueMaxLength)
    }
    case 'constant':
      return rule.argument === undefined
        ? undefined
        : truncate(rule.argument, LIMITS.propertyValueMaxLength)
    default:
      // An unknown source is dropped rather than guessed at. A tracker cached in
      // a browser can be older than the server that published the rule.
      return undefined
  }
}

function propertiesFor(
  rule: NoCodeRule,
  element: Element | null,
  context: ExtractContext,
): Record<string, PropertyValue> | undefined {
  if (!rule.properties || rule.properties.length === 0) return undefined
  const out: Record<string, PropertyValue> = {}
  let any = false
  for (const property of rule.properties) {
    const value = extract(property, element, context)
    if (value !== undefined) {
      out[property.key] = value
      any = true
    }
  }
  return any ? out : undefined
}

export interface RulesDeps {
  readonly document: Pick<Document, 'addEventListener' | 'removeEventListener'> & {
    title?: string
  }
  readonly location: () => { href: string; pathname: string; search: string }
  readonly rules: () => readonly NoCodeRule[]
  /** The site's own extra redaction keys, applied to attribute properties. */
  readonly redactQueryKeys: () => readonly string[]
  readonly now: () => number
  /** Called with the match and the id correlating it to the same browser action. */
  readonly emit: (match: RuleMatch, actionId: string) => void
  /** Mints the action id. Injected so the runtime carries no uuid dependency. */
  readonly newActionId: () => string
}

export function createRules(deps: RulesDeps) {
  /**
   * The id shared by everything one browser action produces (ADR-0034, D5).
   *
   * Set when a native `click`/`submit` begins dispatching and cleared on the
   * next macrotask, so a customer's own `oa.track()` called synchronously from
   * their `onClick` handler — which is what React's synthetic events do too —
   * inherits it without anybody passing it. Without this the D-101 collapse
   * could never fire in practice: `track()` takes `actionId` as an explicit
   * option that no real caller passes.
   */
  let currentActionId: string | null = null
  /** Set once a click has blown the budget; cleared on the next pageview. */
  let disabled = false

  const contextFor = (): ExtractContext => {
    const location = deps.location()
    let search: URLSearchParams | null = null
    try {
      search = new URLSearchParams(location.search)
    } catch {
      /* a malformed query string is no query string */
    }
    return {
      path: location.pathname,
      url: location.href,
      title: deps.document.title ?? '',
      search,
    }
  }

  const runElementRules = (
    trigger: RuleTrigger,
    target: Element,
    /** A middle-click: the attribute pass only, never the rules (ADR-0038, D4). */
    attributeOnly?: boolean,
  ): void => {
    if (disabled) return

    const startedAt = deps.now()
    const matches: { rule: NoCodeRule; element: Element }[] = []

    if (!attributeOnly) {
      for (const rule of deps.rules()) {
        if (rule.trigger !== trigger || !rule.selector) continue
        let matched: Element | null = null
        try {
          matched = target.closest(rule.selector)
        } catch {
          // A selector this browser rejects — an older engine meeting a newer
          // grammar. That rule is dead for this page; the rest keep working.
          continue
        }
        if (matched) matches.push({ rule, element: matched })
      }
    }

    /**
     * The attribute pass (ADR-0037, D3/D5). The *nearest* marked ancestor is
     * the whole search — nested markers resolve to one event, and a marked
     * element whose trigger does not fit emits nothing rather than deferring
     * to an outer marker. A `<form>` marker fires on submit only: on click it
     * would count every click on every field inside the form. Everything else
     * fires on click only. And the rule wins on a shared name (D5) — a rule's
     * event is strictly richer, so the customer sees one event, not two.
     */
    let attribute: RuleMatch | null = null
    const marked = target.closest(`[${EVENT_ATTRIBUTE}]`)
    if (marked && (marked.tagName === 'FORM') === (trigger === 'submit')) {
      const value = marked.getAttribute(EVENT_ATTRIBUTE)
      if (isValidEventName(value) && !matches.some(({ rule }) => rule.name === value)) {
        // Read off the marked element alone (ADR-0038, D1): a property on an
        // ancestor would make one marker's meaning depend on markup the author
        // is not looking at, and would cost a walk to the document root.
        const properties = attributeProperties(marked, deps.redactQueryKeys())
        attribute = { name: value, ...(properties ? { properties } : {}) }
      }
    }

    // The budget is checked after the whole pass rather than inside the loop:
    // measuring per rule would cost more clock reads than the work it guards.
    if (deps.now() - startedAt > RULE_BUDGET_MS) disabled = true

    if (matches.length === 0 && attribute === null) return

    const context = contextFor()
    const actionId = currentActionId ?? deps.newActionId()
    currentActionId = actionId
    for (const { rule, element } of matches) {
      const properties = propertiesFor(rule, element, context)
      deps.emit(
        { ruleId: rule.rule_id, name: rule.name, ...(properties ? { properties } : {}) },
        actionId,
      )
    }
    if (attribute !== null) deps.emit(attribute, actionId)
  }

  const onAction =
    (trigger: RuleTrigger, auxiliary?: boolean) =>
    (event: Event): void => {
      const target = event.target
      if (!target || typeof (target as Element).tagName !== 'string') return

      // A middle-click is a click only where it opens something (ADR-0038, D4):
      // button 1 exactly — `auxclick` fires for the right button too, and a
      // context menu is not a click — and inside a link, which is the element
      // whose middle-click has an outcome at all.
      if (
        auxiliary &&
        ((event as MouseEvent).button !== 1 || !(target as Element).closest('a[href]'))
      ) {
        return
      }

      // Opened before any rule runs, so a `track()` call made from the site's own
      // handler during this same dispatch shares the id even when no rule matches.
      currentActionId = deps.newActionId()
      try {
        runElementRules(trigger, target as Element, auxiliary)
      } finally {
        // Cleared on the next macrotask: the synchronous handler chain has run by
        // then, and holding it longer would let an unrelated later `track()` join
        // an action it had nothing to do with.
        setTimeout(() => {
          currentActionId = null
        }, 0)
      }
    }

  const onClick = onAction('click')
  const onAuxClick = onAction('click', true)
  const onSubmit = onAction('submit')

  return {
    start(): void {
      // Capture phase, passive where the event allows it: a rule must observe a
      // click even when the site's own handler calls `stopPropagation()`, and it
      // must never be able to delay one.
      deps.document.addEventListener('click', onClick, { capture: true, passive: true })
      // The third listener, and the first one ADR-0037 did not already have: a
      // middle-click dispatches `auxclick`, never `click`, so a link opened in a
      // new tab was the one way of following a marked link that counted nothing.
      deps.document.addEventListener('auxclick', onAuxClick, { capture: true, passive: true })
      deps.document.addEventListener('submit', onSubmit, { capture: true })
    },

    stop(): void {
      deps.document.removeEventListener('click', onClick, { capture: true })
      deps.document.removeEventListener('auxclick', onAuxClick, { capture: true })
      deps.document.removeEventListener('submit', onSubmit, { capture: true })
    },

    /** The action id in flight, for `track()` to inherit. */
    actionId(): string | null {
      return currentActionId
    },

    /**
     * Evaluates `url_pattern` rules for the page that just became current.
     *
     * Called from the same place the pageview is emitted, so a rule and the
     * pageview it accompanies describe the same URL. The budget resets here:
     * a heavy page must not permanently disable rules for a session.
     */
    onPageView(): void {
      disabled = false
      const rules = deps.rules()
      if (rules.length === 0) return

      const context = contextFor()
      for (const rule of rules) {
        if (rule.trigger !== 'url_pattern' || !rule.url_pattern) continue
        if (!matchesPattern(rule.url_pattern, context.path)) continue
        const properties = propertiesFor(rule, null, context)
        deps.emit(
          { ruleId: rule.rule_id, name: rule.name, ...(properties ? { properties } : {}) },
          deps.newActionId(),
        )
      }
    },
  }
}

export type Rules = ReturnType<typeof createRules>
