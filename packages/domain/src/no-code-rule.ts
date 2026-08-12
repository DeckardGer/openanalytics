import { z } from 'zod'

/**
 * No-code rule validation: the grammar, the bounds and the template (ADR-0034,
 * D1/D2/D7/D8; docs snapshot 02 §12).
 *
 * Pure and total. Nothing here reads a clock, a database or a DOM, so the API,
 * the publication path and the tests all get the same answer to "is this rule
 * safe to put in a browser".
 *
 * The module exists because of where its output ends up. A rule saved here is
 * served to every visitor of a customer's site and evaluated on every click, in
 * code we cannot hot-fix once it is cached in someone's browser. So the
 * validation is deliberately *server-side and up front*: a selector that would
 * be slow, ambiguous or privacy-violating is refused while its author is looking
 * at the dashboard, rather than discovered as a slow page a week later.
 *
 * Two rules shape everything below:
 *
 * 1. **Allowlist, never denylist.** A selector feature we have not thought about
 *    is refused. A denylist is a claim to have enumerated everything dangerous
 *    in CSS, which stops being true the next time CSS grows.
 * 2. **An input's value is never readable.** Not by a selector, not by a
 *    property mapping, not at any bound. See `RULE_PROPERTY_SOURCES`.
 */

// --- Triggers (D1) -----------------------------------------------------------

/**
 * The v1 trigger set.
 *
 * Snapshot 02 §12 lists six; three ship. The three here are the ones that need
 * no new browser observer: `click` and `submit` are delegated listeners on
 * `document`, and `url_pattern` rides the pageview the tracker already emits.
 * `element_visible` and `scroll_threshold` are ADR-0034 follow-ups, and
 * `modal_open` never becomes a trigger of its own — it is a dashboard preset
 * over `element_visible`, because no browser event means "a modal opened".
 */
export const NO_CODE_TRIGGERS = ['click', 'submit', 'url_pattern'] as const
export type NoCodeTrigger = (typeof NO_CODE_TRIGGERS)[number]

/** Triggers that locate an element, and therefore carry a selector. */
const SELECTOR_TRIGGERS: ReadonlySet<NoCodeTrigger> = new Set<NoCodeTrigger>(['click', 'submit'])

export function triggerUsesSelector(trigger: NoCodeTrigger): boolean {
  return SELECTOR_TRIGGERS.has(trigger)
}

// --- Bounds (D2) -------------------------------------------------------------

/**
 * Published rules per site.
 *
 * Flat across every plan, closed as the ADR-0034 gate on 2026-08-01: a cap that
 * differed by plan would put this milestone into the billed-limits surface for a
 * number that exists to bound a browser's per-click work, not to price anything.
 *
 * Enforced here rather than as a database constraint, so making it plan-derived
 * later is a change to this constant's callers and not a migration.
 */
export const MAX_PUBLISHED_RULES_PER_SITE = 50

/** Combinator depth. Matches the depth `selectorFor()` in the tracker generates. */
export const SELECTOR_MAX_COMPOUNDS = 4

/** Total simple selectors, across every compound. The real complexity bound. */
export const SELECTOR_MAX_SIMPLE = 12

/** Mirrors `EVENT_LIMITS.selectorMaxLength`; restated so this module stays pure. */
export const SELECTOR_MAX_LENGTH = 256

/** Property mappings per rule. Well under the contract's 32 per event, leaving
 * room for the properties a customer's own `track()` call adds to the same one. */
export const MAX_RULE_PROPERTIES = 8

/** Display template, in characters. */
export const DISPLAY_TEMPLATE_MAX_LENGTH = 200

/** Placeholders in one display template. */
export const DISPLAY_TEMPLATE_MAX_PLACEHOLDERS = 8

/** A URL pattern, in characters. */
export const URL_PATTERN_MAX_LENGTH = 512

/**
 * Attributes a selector may test and a property may read.
 *
 * `value` is absent and that is the point: it is how a text input's contents
 * would be reached. `data-*` is open because it is the one namespace a site
 * author controls entirely and the one they use to mark their own elements.
 *
 * Note what else is absent — every `on*` handler attribute. They are not a
 * script-execution risk here (an attribute selector only compares strings), but
 * their contents are code, and code is not a property value.
 */
const ATTRIBUTE_NAME_PATTERN =
  /^(?:data-[a-z0-9-]+|id|class|name|type|role|aria-label|href|title|alt)$/u

export function isAllowedAttributeName(name: string): boolean {
  return ATTRIBUTE_NAME_PATTERN.test(name)
}

// --- Selector grammar (D2) ---------------------------------------------------

export type SelectorRejection =
  | 'empty'
  | 'too_long'
  | 'unsupported_character'
  | 'unsupported_combinator'
  | 'unsupported_pseudo'
  | 'universal_selector'
  | 'selector_list'
  | 'attribute_not_allowed'
  | 'malformed'
  | 'too_deep'
  | 'too_complex'

export type SelectorCheck =
  | { readonly ok: true; readonly compounds: number; readonly simple: number }
  | { readonly ok: false; readonly reason: SelectorRejection }

function fail(reason: SelectorRejection): SelectorCheck {
  return { ok: false, reason }
}

const isIdentStart = (ch: string): boolean => /[a-zA-Z_-]/u.test(ch)
const isIdentChar = (ch: string): boolean => /[a-zA-Z0-9_-]/u.test(ch)
const isTagStart = (ch: string): boolean => /[a-zA-Z]/u.test(ch)
const isTagChar = (ch: string): boolean => /[a-zA-Z0-9-]/u.test(ch)

/**
 * Parses a rule selector against the ADR-0034 D2 grammar.
 *
 * ```
 * selector   := compound ( combinator compound )*
 * combinator := whitespace | '>'
 * compound   := simple+
 * simple     := tag | '.' ident | '#' ident | '[' attr ( '=' string )? ']'
 * ```
 *
 * Everything outside that is refused, and the refusals carry the reasoning:
 *
 * - **`:has()`** — the only selector whose cost is not bounded by the ancestor
 *   chain, because it descends. There is no number we could state for it
 *   against an arbitrary DOM, and this runs on every click of every visitor.
 * - **`*`** — makes every complexity bound below meaningless.
 * - **`+` and `~`** — sibling scans, so cost follows fan-out rather than depth,
 *   and depth is the only dimension `closest()` bounds.
 * - **`,`** — a selector list is N selectors wearing one selector's budget.
 * - **every other pseudo-class**, `:nth-child()` included. It is cheap in
 *   itself; refusing it is what keeps this an allowlist.
 *
 * Escapes (`\3a`, `\.`) are refused wholesale rather than decoded. A rule
 * selector is typed by a human into a dashboard field, so an escape is far more
 * likely an attempt to smuggle a banned character past this parser than it is a
 * real class name — and a decoder here would be a second, subtly different
 * implementation of CSS's.
 *
 * Total: returns a rejection for every input, including hostile ones. It never
 * throws.
 */
export function checkSelector(raw: unknown): SelectorCheck {
  if (typeof raw !== 'string') return fail('malformed')

  const selector = raw.trim()
  if (selector === '') return fail('empty')
  if (selector.length > SELECTOR_MAX_LENGTH) return fail('too_long')

  let compounds = 0
  let simple = 0
  let index = 0
  // Tracks whether the current compound has at least one simple selector, so
  // `div >` and `> div` and `div  ` are all malformed rather than silently fine.
  let compoundHasSimple = false

  const skipSpace = (): boolean => {
    let skipped = false
    while (index < selector.length && /[ \t\n\r\f]/u.test(selector[index] as string)) {
      index += 1
      skipped = true
    }
    return skipped
  }

  const readIdent = (
    test: (ch: string) => boolean,
    testStart: (ch: string) => boolean,
  ): boolean => {
    const first = selector[index]
    if (first === undefined || !testStart(first)) return false
    index += 1
    while (index < selector.length && test(selector[index] as string)) index += 1
    return true
  }

  while (index < selector.length) {
    const ch = selector[index] as string

    // --- Explicit refusals, named so the author gets a useful message --------
    if (ch === '*') return fail('universal_selector')
    if (ch === ',') return fail('selector_list')
    if (ch === '+' || ch === '~') return fail('unsupported_combinator')
    if (ch === ':') return fail('unsupported_pseudo')
    if (ch === '\\') return fail('unsupported_character')
    if (ch === '(' || ch === ')') return fail('malformed')

    // --- Combinators --------------------------------------------------------
    if (/[ \t\n\r\f]/u.test(ch) || ch === '>') {
      const sawSpace = skipSpace()
      let child = false
      if (selector[index] === '>') {
        child = true
        index += 1
        skipSpace()
      }
      // A combinator with nothing before it, or nothing after it, is malformed.
      if (!compoundHasSimple) return fail('malformed')
      if (index >= selector.length) return fail('malformed')
      // `a > > b` and `a >> b`.
      if (selector[index] === '>') return fail('malformed')
      if (!sawSpace && !child) return fail('malformed')

      compoundHasSimple = false
      continue
    }

    // --- Simple selectors ---------------------------------------------------
    if (!compoundHasSimple) {
      compounds += 1
      if (compounds > SELECTOR_MAX_COMPOUNDS) return fail('too_deep')
    }

    if (ch === '.' || ch === '#') {
      index += 1
      if (!readIdent(isIdentChar, isIdentStart)) return fail('malformed')
    } else if (ch === '[') {
      index += 1
      const nameStart = index
      if (!readIdent(isIdentChar, isIdentStart)) return fail('malformed')
      const name = selector.slice(nameStart, index)
      if (!isAllowedAttributeName(name)) return fail('attribute_not_allowed')

      if (selector[index] === '=') {
        index += 1
        const quote = selector[index]
        // Unquoted attribute values are refused: quoting is what makes the end
        // of the value unambiguous without a second escaping rule.
        if (quote !== '"' && quote !== "'") return fail('malformed')
        index += 1
        const valueStart = index
        while (index < selector.length && selector[index] !== quote) {
          // A backslash inside the value would need the escape decoder this
          // grammar deliberately does not have.
          if (selector[index] === '\\') return fail('unsupported_character')
          index += 1
        }
        if (index >= selector.length) return fail('malformed')
        if (index - valueStart > 128) return fail('too_long')
        index += 1
      } else if (
        selector[index] === '~' ||
        selector[index] === '^' ||
        selector[index] === '$' ||
        selector[index] === '*' ||
        selector[index] === '|'
      ) {
        // Substring and prefix matchers (`[href^="/x"]`) are a follow-up, not a
        // refusal on principle. They are absent because exact equality is what
        // the dashboard offers in v1, and an operator this parser accepts but no
        // UI can produce is an untested path.
        return fail('unsupported_character')
      }

      if (selector[index] !== ']') return fail('malformed')
      index += 1
    } else if (isTagStart(ch)) {
      if (!readIdent(isTagChar, isTagStart)) return fail('malformed')
    } else {
      return fail('unsupported_character')
    }

    compoundHasSimple = true
    simple += 1
    if (simple > SELECTOR_MAX_SIMPLE) return fail('too_complex')
  }

  if (!compoundHasSimple) return fail('malformed')
  return { ok: true, compounds, simple }
}

export function isValidSelector(raw: unknown): boolean {
  return checkSelector(raw).ok
}

// --- URL patterns (D1) -------------------------------------------------------

export type UrlPatternRejection =
  'empty' | 'too_long' | 'must_start_with_slash' | 'unsupported_character' | 'traversal'

export type UrlPatternCheck =
  { readonly ok: true } | { readonly ok: false; readonly reason: UrlPatternRejection }

/**
 * A path glob, deliberately not a regular expression.
 *
 * `*` matches within one path segment, `**` matches across segments, and
 * nothing else is special. A client-supplied regular expression evaluated in a
 * visitor's browser is a ReDoS against our customer's own users, with no bound
 * we could state — and the patterns people actually write (`/checkout/*`) are
 * globs anyway.
 *
 * Matching is against the sanitized `page.path`, so a pattern never sees a
 * query string or a fragment; `?` and `#` are refused rather than silently
 * never matching.
 */
export function checkUrlPattern(raw: unknown): UrlPatternCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'empty' }
  const pattern = raw.trim()
  if (pattern === '') return { ok: false, reason: 'empty' }
  if (pattern.length > URL_PATTERN_MAX_LENGTH) return { ok: false, reason: 'too_long' }
  if (!pattern.startsWith('/')) return { ok: false, reason: 'must_start_with_slash' }
  if (pattern.includes('..')) return { ok: false, reason: 'traversal' }
  if (!/^[a-zA-Z0-9\-._~/*%]+$/u.test(pattern))
    return { ok: false, reason: 'unsupported_character' }
  return { ok: true }
}

/**
 * The matcher the tracker mirrors, kept here so the dashboard's "does this
 * match?" preview and the browser cannot disagree.
 *
 * Segment-wise rather than regexp-based: `*` consumes one segment, `**`
 * consumes the rest. Total, and linear in the number of segments.
 */
export function matchesUrlPattern(pattern: string, path: string): boolean {
  const patternParts = pattern.split('/')
  const pathParts = path.split('/')

  let p = 0
  let t = 0
  while (p < patternParts.length) {
    const part = patternParts[p] as string
    if (part === '**') return true
    if (t >= pathParts.length) return false
    if (part !== '*' && part !== pathParts[t]) return false
    p += 1
    t += 1
  }
  return t === pathParts.length
}

// --- Property mapping (D8) ---------------------------------------------------

/**
 * What a rule may read.
 *
 * The list is the privacy boundary, so it is worth reading as a whole: every
 * entry is either page context the tracker has already sanitized, or *structure*
 * the site's own author put in their markup. None of it is what a person typed.
 *
 * `attribute:` is bounded by `ATTRIBUTE_NAME_PATTERN`, which has no `value`, so
 * `attribute:value` cannot be spelled here at all. That is the first of the
 * three layers ADR-0034 D8 requires; the tracker's `bearsUserInput()` is the
 * second and `eventPropertiesSchema` is the third. Three, because one of them
 * ships inside other people's pages and cannot be hot-fixed.
 */
export const RULE_PROPERTY_SOURCES = [
  'text',
  'element_tag',
  'page_path',
  'page_url',
  'page_title',
  'attribute',
  'url_param',
  'constant',
] as const
export type RulePropertySource = (typeof RULE_PROPERTY_SOURCES)[number]

/** Sources that need an argument (`attribute:data-sku`, `url_param:plan`). */
const PARAMETERIZED_SOURCES: ReadonlySet<RulePropertySource> = new Set<RulePropertySource>([
  'attribute',
  'url_param',
  'constant',
])

export const rulePropertyKeySchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-zA-Z_][a-zA-Z0-9_.-]*$/u, 'property key must start with a letter or underscore')
  .refine((key) => !key.toLowerCase().startsWith('oa_'), 'property keys may not use the oa_ prefix')

/**
 * One extraction. `source` names where the value comes from; `argument` is the
 * attribute name, query key or literal it needs.
 *
 * `superRefine` rather than a union, so the error names the field the dashboard
 * should highlight.
 */
export const rulePropertySchema = z
  .strictObject({
    key: rulePropertyKeySchema,
    source: z.enum(RULE_PROPERTY_SOURCES),
    argument: z.string().max(256).optional(),
  })
  .superRefine((mapping, ctx) => {
    const needsArgument = PARAMETERIZED_SOURCES.has(mapping.source)
    if (needsArgument && (mapping.argument === undefined || mapping.argument === '')) {
      ctx.addIssue({
        code: 'custom',
        path: ['argument'],
        message: `source ${mapping.source} requires an argument`,
      })
      return
    }
    if (!needsArgument && mapping.argument !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['argument'],
        message: `source ${mapping.source} takes no argument`,
      })
      return
    }
    if (mapping.source === 'attribute' && !isAllowedAttributeName(mapping.argument as string)) {
      ctx.addIssue({
        code: 'custom',
        path: ['argument'],
        // Named explicitly: "value" is the argument someone reaches for first,
        // and "not in the allowlist" would read as an oversight rather than the
        // rule it is.
        message:
          'attribute is not readable by a rule; an input value is never readable at any layer',
      })
    }
    if (
      mapping.source === 'url_param' &&
      !/^[a-zA-Z0-9_.-]{1,64}$/u.test(mapping.argument as string)
    ) {
      ctx.addIssue({ code: 'custom', path: ['argument'], message: 'invalid query key' })
    }
  })

export type RuleProperty = z.infer<typeof rulePropertySchema>

const rulePropertiesSchema = z
  .array(rulePropertySchema)
  .max(MAX_RULE_PROPERTIES)
  .refine(
    (properties) => new Set(properties.map((p) => p.key)).size === properties.length,
    'property keys must be unique within a rule',
  )

// --- Display template (D7) ---------------------------------------------------

const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*\}\}/gu

/** The property keys a template interpolates, in order, deduplicated. */
export function templatePlaceholders(template: string): string[] {
  const found = new Set<string>()
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) found.add(match[1] as string)
  return [...found]
}

export type TemplateRejection =
  | 'too_long'
  | 'markup_not_allowed'
  | 'too_many_placeholders'
  | 'malformed_placeholder'
  | 'undeclared_property'

export type TemplateCheck =
  | { readonly ok: true; readonly placeholders: readonly string[] }
  | { readonly ok: false; readonly reason: TemplateRejection; readonly detail?: string }

/**
 * Validates a display template against the properties its version declares.
 *
 * The template renders to **plain text** in the read API (ADR-0034, D7), never
 * to HTML, so `<` and `>` are refused outright rather than escaped at render
 * time. Refusing here means there is no escaping step to forget later, and no
 * template in the database that would become an injection the day someone
 * renders one into markup.
 *
 * A placeholder naming a property the version does not declare is refused at
 * save time, because the alternative is an em dash discovered in production by
 * a customer reading their own journey.
 */
export function checkDisplayTemplate(raw: unknown, declaredKeys: readonly string[]): TemplateCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'malformed_placeholder' }
  if (raw.length > DISPLAY_TEMPLATE_MAX_LENGTH) return { ok: false, reason: 'too_long' }
  if (raw.includes('<') || raw.includes('>')) return { ok: false, reason: 'markup_not_allowed' }

  const placeholders = templatePlaceholders(raw)
  if (placeholders.length > DISPLAY_TEMPLATE_MAX_PLACEHOLDERS) {
    return { ok: false, reason: 'too_many_placeholders' }
  }

  // A `{{` the placeholder pattern did not consume is a typo the author wants
  // to know about now — `{{ button label }}`, or an unclosed brace — not a
  // literal brace they meant to leave in the sentence.
  const opens = (raw.match(/\{\{/gu) ?? []).length
  const consumed = [...raw.matchAll(PLACEHOLDER_PATTERN)].length
  if (opens !== consumed) return { ok: false, reason: 'malformed_placeholder' }

  const declared = new Set(declaredKeys)
  for (const placeholder of placeholders) {
    if (!declared.has(placeholder)) {
      return { ok: false, reason: 'undeclared_property', detail: placeholder }
    }
  }

  return { ok: true, placeholders }
}

/** What a missing property renders as (D7). Not empty: a sentence with a hole
 * in it reads as a bug, where an em dash reads as "we did not capture this". */
export const TEMPLATE_MISSING_VALUE = '—'

/**
 * Renders a canonical event to its human sentence.
 *
 * Server-side, in the read API. Total: an unknown property renders as
 * `TEMPLATE_MISSING_VALUE` rather than throwing, and `complete` tells the caller
 * whether every placeholder was filled so the dashboard can choose to show the
 * raw event instead.
 */
export function renderDisplayTemplate(
  template: string,
  properties: Readonly<Record<string, string | number | boolean | null>>,
): { readonly text: string; readonly complete: boolean } {
  let complete = true
  const text = template.replace(PLACEHOLDER_PATTERN, (_match, key: string) => {
    const value = properties[key]
    if (value === undefined || value === null || value === '') {
      complete = false
      return TEMPLATE_MISSING_VALUE
    }
    return String(value)
  })
  return { text, complete }
}

// --- Rules and definitions ---------------------------------------------------

export const EVENT_DEFINITION_STATUSES = ['active', 'archived'] as const
export type EventDefinitionStatus = (typeof EVENT_DEFINITION_STATUSES)[number]

/** Mirrors `eventNameSchema` in the contract; restated to keep this module pure. */
export const eventNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/u, 'event name must start with a letter')

/**
 * One rule, as it is stored and as it is published to the tracker.
 *
 * `selector` and `url_pattern` are conditional on the trigger, checked below
 * rather than by a discriminated union so that a request carrying the wrong one
 * gets "this trigger takes a selector" instead of "no union member matched".
 */
export const noCodeRuleSchema = z
  .strictObject({
    /** Stable across versions: a rule edited in v2 keeps the id it had in v1,
     * so `rule_id` on an ingested event stays resolvable across a publish. */
    rule_id: z.uuid(),
    trigger: z.enum(NO_CODE_TRIGGERS),
    selector: z.string().max(SELECTOR_MAX_LENGTH).optional(),
    url_pattern: z.string().max(URL_PATTERN_MAX_LENGTH).optional(),
    properties: rulePropertiesSchema.default([]),
  })
  .superRefine((rule, ctx) => {
    if (triggerUsesSelector(rule.trigger)) {
      if (rule.url_pattern !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['url_pattern'],
          message: `trigger ${rule.trigger} takes a selector, not a url_pattern`,
        })
      }
      const check = checkSelector(rule.selector)
      if (!check.ok) {
        ctx.addIssue({ code: 'custom', path: ['selector'], message: `selector: ${check.reason}` })
      }
      return
    }

    if (rule.selector !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['selector'],
        message: `trigger ${rule.trigger} takes a url_pattern, not a selector`,
      })
    }
    const check = checkUrlPattern(rule.url_pattern)
    if (!check.ok) {
      ctx.addIssue({
        code: 'custom',
        path: ['url_pattern'],
        message: `url_pattern: ${check.reason}`,
      })
    }
  })

export type NoCodeRule = z.infer<typeof noCodeRuleSchema>

const rulesSchema = z
  .array(noCodeRuleSchema)
  .max(MAX_PUBLISHED_RULES_PER_SITE)
  .refine(
    (rules) => new Set(rules.map((rule) => rule.rule_id)).size === rules.length,
    'rule ids must be unique within a version',
  )

/**
 * The versioned content of a definition — everything that can change.
 *
 * The definition row holds only what must stay stable (`site_id`, `event_name`);
 * everything here is copied forward into a new immutable version on every save,
 * which is what makes rollback a publish rather than an edit (ADR-0034, D3).
 */
const eventDefinitionContentShape = {
  display_name: z.string().trim().min(1).max(200),
  description: z.string().max(1000).nullable().default(null),
  category: z.string().trim().max(64).nullable().default(null),
  /** The property allowlist. A rule may only map to a key declared here, and
   * an ingested property this does not declare is dropped (D8). */
  property_schema: z
    .array(
      z.strictObject({
        key: rulePropertyKeySchema,
        type: z.enum(['string', 'number', 'boolean']).default('string'),
      }),
    )
    .max(32)
    .default([]),
  display_template: z.string().max(DISPLAY_TEMPLATE_MAX_LENGTH).nullable().default(null),
  rules: rulesSchema.default([]),
} as const

/**
 * The cross-field checks, shared by every schema that carries content.
 *
 * Extracted rather than written twice: `createEventDefinitionRequestSchema`
 * carries the same content plus `event_name`, and two copies of "a rule may only
 * map to a declared property" is exactly how one of them stops being true.
 */
function refineContent(
  content: {
    readonly property_schema: readonly { readonly key: string }[]
    readonly rules: readonly { readonly properties: readonly { readonly key: string }[] }[]
    readonly display_template: string | null
  },
  ctx: z.RefinementCtx,
): void {
  const declared = content.property_schema.map((entry) => entry.key)
  const declaredSet = new Set(declared)

  if (declaredSet.size !== declared.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['property_schema'],
      message: 'property keys must be unique',
    })
  }

  content.rules.forEach((rule, index) => {
    rule.properties.forEach((mapping, propertyIndex) => {
      if (!declaredSet.has(mapping.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['rules', index, 'properties', propertyIndex, 'key'],
          message: `property ${mapping.key} is not declared in property_schema`,
        })
      }
    })
  })

  if (content.display_template !== null) {
    const check = checkDisplayTemplate(content.display_template, declared)
    if (!check.ok) {
      ctx.addIssue({
        code: 'custom',
        path: ['display_template'],
        message:
          check.reason === 'undeclared_property'
            ? `display_template refers to undeclared property ${check.detail}`
            : `display_template: ${check.reason}`,
      })
    }
  }
}

export const eventDefinitionContentSchema = z
  .strictObject(eventDefinitionContentShape)
  .superRefine(refineContent)

export type EventDefinitionContent = z.infer<typeof eventDefinitionContentSchema>

/** Creating a definition: the stable half plus a first version's content. */
export const createEventDefinitionRequestSchema = z
  .strictObject({ event_name: eventNameSchema, ...eventDefinitionContentShape })
  .superRefine(refineContent)

/**
 * Saving a new version. The whole content is restated rather than patched:
 * a version is immutable and complete by definition, and a partial update would
 * make "what did v3 contain" a question you answer by replaying v1 and v2.
 */
export const createEventDefinitionVersionRequestSchema = eventDefinitionContentSchema

/**
 * Publishing. `expected_published_version` is the optimistic-concurrency token
 * (D3): two admins publishing different drafts get a defined winner and a 409,
 * rather than a silent last-write-wins. `null` states "nothing is published
 * yet", which is a claim that can be wrong and therefore worth checking.
 */
export const publishEventDefinitionRequestSchema = z.strictObject({
  version: z.number().int().min(1),
  expected_published_version: z.number().int().min(1).nullable(),
})

export type PublishEventDefinitionRequest = z.infer<typeof publishEventDefinitionRequestSchema>
