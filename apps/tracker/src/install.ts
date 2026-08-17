import { createTracker, type Tracker, type TrackerOptions } from './core.ts'
import type { PrivacyPolicy } from './privacy.ts'

/**
 * Namespace installation and the queue-stub drain.
 *
 * Docs snapshot 02 §11: never overwrite an existing global unannounced. A site
 * may already have something at `window.oa` — another vendor, its own helper, or
 * our own snippet stub — and clobbering it silently breaks a page the tracker was
 * only supposed to observe.
 *
 * Three cases, decided in `installTracker`:
 *
 * 1. Nothing there → install.
 * 2. Our snippet stub (`function` with a `q` array of queued calls) → drain the
 *    queue into the real tracker and replace it. This is what makes
 *    `oa("track", …)` work before the script has loaded.
 * 3. A foreign object → do not touch it. The tracker installs under
 *    `window.openanalytics` instead and reports the conflict, so the site keeps
 *    working and the operator can see why.
 */

const BRAND = '__oa__'

type QueuedCall = readonly [method: string, ...args: unknown[]]

interface StubFunction {
  (...args: unknown[]): void
  q?: QueuedCall[]
}

export type InstallOutcome = 'installed' | 'drained_stub' | 'namespace_conflict'

export interface InstallResult {
  readonly tracker: Tracker
  readonly namespace: 'oa' | 'openanalytics'
  readonly outcome: InstallOutcome
}

function isOurStub(candidate: unknown): candidate is StubFunction {
  return typeof candidate === 'function' && Array.isArray((candidate as StubFunction).q)
}

function isForeign(candidate: unknown): boolean {
  if (candidate === undefined || candidate === null) return false
  if (isOurStub(candidate)) return false
  return (candidate as Record<string, unknown>)[BRAND] !== true
}

function applyQueued(tracker: Tracker, queued: readonly QueuedCall[]): void {
  for (const call of queued) {
    const [method, ...args] = call as [string, ...unknown[]]
    const target = (tracker as unknown as Record<string, unknown>)[method]
    if (typeof target !== 'function') continue
    try {
      ;(target as (...callArgs: unknown[]) => void).apply(tracker, args)
    } catch {
      // One bad queued call must not stop the rest of the page's analytics.
    }
  }
}

export function installTracker(
  win: Window & typeof globalThis,
  options: TrackerOptions,
): InstallResult {
  const existing = (win as unknown as Record<string, unknown>)['oa']
  const conflict = isForeign(existing)

  const tracker = createTracker({ ...options, window: win })
  Object.defineProperty(tracker, BRAND, { value: true, enumerable: false })

  if (isOurStub(existing)) {
    applyQueued(tracker, existing.q ?? [])
    ;(win as unknown as Record<string, unknown>)['oa'] = tracker
    return { tracker, namespace: 'oa', outcome: 'drained_stub' }
  }

  if (conflict) {
    ;(win as unknown as Record<string, unknown>)['openanalytics'] = tracker
    win.console?.warn?.(
      '[oa] window.oa already belongs to another script; Open Analytics installed as window.openanalytics',
    )
    return { tracker, namespace: 'openanalytics', outcome: 'namespace_conflict' }
  }

  ;(win as unknown as Record<string, unknown>)['oa'] = tracker
  return { tracker, namespace: 'oa', outcome: 'installed' }
}

/**
 * Read init options from the `<script>` tag that loaded the tracker:
 *
 * ```html
 * <script async src="https://collect.example.com/oa.js"
 *         data-key="oa_pub_live_…"
 *         data-collector="https://collect.example.com"></script>
 * ```
 *
 * `data-storage="none"` puts the tracker in strict mode (ADR-0064): memory-only,
 * nothing written to the visitor's device.
 *
 * The privacy attributes let a site state its own policy: `data-respect-gpc`,
 * `data-respect-dnt` and `data-require-consent` (G-008, closed by ADR-0057). Any
 * value other than `'false'` or `'0'` reads as true; a missing attribute falls
 * through to the default.
 */
export function optionsFromScript(
  script: Element | null,
  fallbackOrigin: string,
): Pick<TrackerOptions, 'trackingKey' | 'collectorUrl' | 'debug' | 'storage'> & {
  privacyPolicy: Partial<PrivacyPolicy>
} {
  const attribute = (name: string): string | null => script?.getAttribute(name) ?? null
  const flag = (name: string): boolean | undefined => {
    const value = attribute(name)
    if (value === null) return undefined
    return value !== 'false' && value !== '0'
  }

  const privacyPolicy: { respectGpc?: boolean; respectDnt?: boolean; requireConsent?: boolean } = {}
  const gpc = flag('data-respect-gpc')
  const dnt = flag('data-respect-dnt')
  const consent = flag('data-require-consent')
  if (gpc !== undefined) privacyPolicy.respectGpc = gpc
  if (dnt !== undefined) privacyPolicy.respectDnt = dnt
  if (consent !== undefined) privacyPolicy.requireConsent = consent

  const debug = flag('data-debug')
  // `data-test-mode` is intentionally not read: the attribute is retired
  // (ADR-0068) and a snippet still carrying it gets ordinary, visible traffic.
  // `data-storage="none"` and nothing else. Read as an exact value rather than
  // through `flag()`, because the other attributes are booleans whose default is
  // the interesting half — this one names a mode, and a typo must fall back to
  // the ordinary behaviour rather than to an unintended strictness.
  const storage = attribute('data-storage') === 'none' ? ('none' as const) : undefined

  return {
    trackingKey: attribute('data-key') ?? '',
    collectorUrl: attribute('data-collector') ?? fallbackOrigin,
    ...(debug === undefined ? {} : { debug }),
    ...(storage === undefined ? {} : { storage }),
    privacyPolicy,
  }
}
