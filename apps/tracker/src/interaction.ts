import {
  INTERACTION_MAX_PER_PAGE,
  INTERACTION_THROTTLE_MS,
  LIMITS,
  VIEWPORT_BREAKPOINTS,
} from './constants.ts'
import { redactQueryKeyValues, redactText, truncate } from './sanitize.ts'
import type { InteractionPayload, ViewportClass } from './types.ts'

/**
 * Heatmap click signal (F-314, D-101; docs snapshot 02 §8, §11).
 *
 * A passive, high-volume signal that never bills. Three rules hold regardless of
 * configuration, and they are the reason this is a separate module rather than
 * three lines in a click handler:
 *
 * 1. **An input's value is never captured.** Not truncated, not hashed — not
 *    read. For a form field there is no text branch at all, only coordinates.
 * 2. **Element text passes through redaction** before it is anything but a local
 *    variable — the built-in PII patterns and the site's own `redact_query_keys`
 *    (ADR-0057 D7), on the text and the selector alike.
 * 3. **Volume is bounded twice**: a throttle between clicks and a per-pageview
 *    ceiling, before any sampling the site configures.
 */

export interface InteractionDeps {
  readonly document: Pick<Document, 'addEventListener' | 'removeEventListener'>
  readonly window: { innerWidth?: number; innerHeight?: number }
  readonly now: () => number
  readonly random: () => number
  readonly sampling: () => number
  readonly redactQueryKeys: () => readonly string[]
  readonly emit: (payload: InteractionPayload) => void
}

export function viewportClass(width: number): ViewportClass {
  if (width <= VIEWPORT_BREAKPOINTS.mobile) return 'mobile'
  if (width <= VIEWPORT_BREAKPOINTS.tablet) return 'tablet'
  if (width <= VIEWPORT_BREAKPOINTS.desktop) return 'desktop'
  return 'wide'
}

const VALUE_BEARING_TAGS = ['input', 'textarea', 'select', 'option'] as const

/**
 * Whether this element holds something a person typed.
 *
 * Exported because the no-code rule runtime (`rules.ts`) must apply exactly the
 * same test: two copies of "what counts as a form field" would eventually
 * disagree, and the direction that disagreement fails in is a captured input
 * value. One definition, two callers.
 */
export function bearsUserInput(element: Element): boolean {
  const tag = element.tagName.toLowerCase()
  if ((VALUE_BEARING_TAGS as readonly string[]).indexOf(tag) !== -1) return true
  return element.getAttribute('contenteditable') !== null
}

/**
 * A short, stable-ish CSS path: enough to locate the element, not to profile it.
 *
 * Never returns an empty string, and that is a correctness requirement rather
 * than tidiness: the contract declares `interaction.selector` as
 * `min(1)` (`packages/contracts/src/events.ts`), a batch is validated
 * atomically (docs snapshot 02 §7.3), and the tracker treats a `400` as final.
 * So one unselectable click would not merely lose its own event — it would take
 * the whole batch with it, page views included, silently. That is exactly what
 * a real browser proved on 2026-07-25: a click on the page background produced
 * an empty selector, because the walk below stops at `body`/`html` without
 * pushing them.
 *
 * The walk stopping there is right — `body>` as a prefix on every selector
 * locates nothing — but *ending* there with nothing is not. A click on the page
 * background is a real click a heatmap wants, so it is reported with the
 * clicked element's own tag as its selector.
 */
export function selectorFor(element: Element, maxDepth = 4): string {
  const parts: string[] = []
  let current: Element | null = element
  let depth = 0

  while (current && depth < maxDepth) {
    const tag = current.tagName.toLowerCase()
    if (tag === 'html' || tag === 'body') break

    const id = current.getAttribute('id')
    if (id !== null && id !== '') {
      parts.unshift(`${tag}#${id}`)
      break
    }

    const className = current.getAttribute('class')
    const classes = (className ?? '')
      .split(/\s+/)
      .filter((entry) => entry !== '')
      .slice(0, 2)

    parts.unshift(classes.length > 0 ? `${tag}.${classes.join('.')}` : tag)
    current = current.parentElement
    depth += 1
  }

  // Ids and class names are author-controlled and occasionally carry an email or
  // an account number; the selector is redacted like any other stored text.
  const selector = truncate(redactText(parts.join('>')), LIMITS.selectorMaxLength)
  if (selector !== '') return selector

  // Nothing survived: the click landed on `body`/`html`, or redaction consumed
  // the whole path. Fall back to the clicked element's own tag, and to `body`
  // for the empty-tag case a non-HTML element could produce, so the return is
  // non-empty by construction rather than by assumption.
  const tag = element.tagName.toLowerCase()
  return tag === '' ? 'body' : tag
}

export function createInteractions(deps: InteractionDeps) {
  let lastReportedAt = 0
  let reportedOnThisPage = 0

  const onClick = (event: Event): void => {
    const pointer = event as MouseEvent
    const target = pointer.target

    if (!target || typeof (target as Element).tagName !== 'string') return
    if (reportedOnThisPage >= INTERACTION_MAX_PER_PAGE) return

    const at = deps.now()
    if (at - lastReportedAt < INTERACTION_THROTTLE_MS) return

    const sampling = deps.sampling()
    if (sampling <= 0) return
    if (sampling < 1 && deps.random() >= sampling) return

    const element = target as Element
    const width = deps.window.innerWidth ?? 0
    const height = deps.window.innerHeight ?? 0
    if (width <= 0 || height <= 0) return

    const clamp = (value: number): number => Math.min(100, Math.max(0, value))
    const round = (value: number): number => Math.round(value * 100) / 100

    // The site's configured keys join the built-in redaction patterns here, so
    // a `?token=` quoted in a link's visible text is blurred the same way it
    // would be on `page.url` (ADR-0057 D7).
    const extraKeys = deps.redactQueryKeys()

    let text: string | undefined
    if (!bearsUserInput(element)) {
      const raw = (element.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (raw !== '') {
        const redacted = truncate(
          redactText(redactQueryKeyValues(raw, extraKeys)),
          LIMITS.elementTextMaxLength,
        )
        if (redacted !== '') text = redacted
      }
    }

    lastReportedAt = at
    reportedOnThisPage += 1

    deps.emit({
      x_percent: round(clamp((pointer.clientX / width) * 100)),
      y_percent: round(clamp((pointer.clientY / height) * 100)),
      viewport_class: viewportClass(width),
      viewport_width: Math.round(width),
      // Key-value redaction substitutes rather than removes, so the non-empty
      // guarantee `selectorFor` provides survives it; re-truncated because the
      // substitution can lengthen the string past the contract limit.
      selector: truncate(
        redactQueryKeyValues(selectorFor(element), extraKeys),
        LIMITS.selectorMaxLength,
      ),
      ...(text === undefined ? {} : { text }),
    })
  }

  return {
    start(): void {
      deps.document.addEventListener('click', onClick, { capture: true, passive: true })
    },
    stop(): void {
      deps.document.removeEventListener('click', onClick, { capture: true })
    },
    /** The ceiling is per pageview, so an SPA route change resets it. */
    onRouteChange(): void {
      reportedOnThisPage = 0
    },
  }
}

export type Interactions = ReturnType<typeof createInteractions>
