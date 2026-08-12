import { HEARTBEAT_INTERVAL_SECONDS, LIMITS, TRACKER_SDK, TRACKER_VERSION } from './constants.ts'
import { createEngagement } from './engagement.ts'
import { createHeartbeat } from './heartbeat.ts'
import { createInteractions } from './interaction.ts'
import { DEFAULT_PRIVACY_POLICY, createPrivacyGate, type PrivacyPolicy } from './privacy.ts'
import { createRules, type NoCodeRule } from './rules.ts'
import {
  isValidEventName,
  sanitizeProperties,
  sanitizeReferrer,
  sanitizeUrl,
  truncate,
} from './sanitize.ts'
import { createRetryQueue, createSessionTracker, safeStorage } from './storage.ts'
import { createTransport } from './transport.ts'
import type {
  EngagementPayload,
  InteractionPayload,
  TrackerContext,
  TrackerEvent,
  TrackerEventType,
  TrackerPage,
  WebVitalPayload,
} from './types.ts'
import { uuidV7 } from './uuid.ts'
import { createWebVitals, type ObserverHost } from './vitals.ts'

/**
 * The tracker runtime.
 *
 * Wiring only: every rule lives in the module that owns it. What this file is
 * responsible for is the order things happen in —
 *
 * - the `event_id` is minted here, before the event reaches the transport, so a
 *   retry carries the same id (docs snapshot 02 §7.1);
 * - every signal passes the privacy gate before it becomes an event;
 * - an SPA route change ends the previous route's engagement, resets the
 *   interaction ceiling and starts a new pageview — but not a new session
 *   (§10);
 * - the way out (`pagehide`, first `hidden`) reports vitals, collects final
 *   engagement and flushes with `sendBeacon`.
 */

export interface TrackerRuntimeConfig {
  readonly redactQueryKeys: readonly string[]
  readonly interactionSampling: number
  readonly heartbeatIntervalSeconds: number
  /** Published (or previewed) no-code rules the runtime evaluates (ADR-0034). */
  readonly noCodeRules: readonly NoCodeRule[]
  readonly features: {
    readonly web_vitals: boolean
    readonly engagement: boolean
    readonly interactions: boolean
    readonly heartbeat: boolean
  }
}

/**
 * A partial configuration update. `features` is patchable field by field, so a
 * site (or the config endpoint) can turn one signal off without restating the
 * rest.
 */
export type TrackerConfigPatch = Partial<Omit<TrackerRuntimeConfig, 'features'>> & {
  readonly features?: Partial<TrackerRuntimeConfig['features']>
}

export const DEFAULT_RUNTIME_CONFIG: TrackerRuntimeConfig = {
  redactQueryKeys: [],
  interactionSampling: 1,
  heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
  noCodeRules: [],
  features: { web_vitals: true, engagement: true, interactions: true, heartbeat: true },
}

export interface TrackerOptions {
  readonly trackingKey: string
  readonly collectorUrl: string
  /** Defaults to the ambient window; injected in tests. */
  readonly window?: Window & typeof globalThis
  readonly testMode?: boolean
  readonly debug?: boolean
  readonly privacyPolicy?: Partial<PrivacyPolicy>
  readonly config?: TrackerConfigPatch
  readonly now?: () => number
  readonly random?: () => number
  readonly schedule?: (task: () => void, delayMs: number) => void
  readonly setIntervalImpl?: (task: () => void, ms: number) => unknown
  readonly clearIntervalImpl?: (handle: unknown) => void
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
  readonly beaconImpl?: (url: string, body: string) => boolean
  /**
   * Called after each SPA route change, once the pageview has been emitted.
   *
   * It exists for one caller: the config revalidation ADR-0034 D4 requires.
   * Configuration is fetched once, at `start()`, so a long-lived single-page app
   * tab would never revalidate at any TTL — the five-minute cache would expire
   * and nothing would ever ask again. A route change is the one moment a SPA
   * reliably offers, and the tracker is already there for the pageview.
   *
   * The callback decides whether that costs a request; `loadTrackerConfig`
   * returns from cache without touching the network inside the TTL.
   */
  readonly onRouteChange?: () => void
}

export interface Tracker {
  /** `oa.track("signup_started", { plan: "growth" })` */
  track(name: string, properties?: Record<string, unknown>, options?: { actionId?: string }): void
  /** `oa.identify("customer-internal-id")` — hashed site-scoped by the server. */
  identify(externalUserId: string): void
  /** `oa.conversion("purchase", { order_id, value, currency })` */
  conversion(name: string, properties?: Record<string, unknown>): void
  /** Manual pageview, for frameworks that route in ways history patching misses. */
  pageview(): void
  consent(state: 'granted' | 'denied' | 'unknown'): void
  applyConfig(config: TrackerConfigPatch): void
  flush(): void
  stop(): void
  readonly version: string
}

export function createTracker(options: TrackerOptions): Tracker {
  const win = options.window ?? (globalThis as unknown as Window & typeof globalThis)
  const doc = win.document
  const now = options.now ?? (() => Date.now())
  const random = options.random ?? (() => Math.random())

  let config: TrackerRuntimeConfig = {
    ...DEFAULT_RUNTIME_CONFIG,
    ...options.config,
    features: { ...DEFAULT_RUNTIME_CONFIG.features, ...options.config?.features },
  }

  const localStore = safeStorage(win.localStorage ?? null)
  const sessionStore = safeStorage(win.sessionStorage ?? null)
  const queue = createRetryQueue(localStore)
  const session = createSessionTracker(sessionStore, uuidV7)
  const privacy = createPrivacyGate(win, localStore, {
    ...DEFAULT_PRIVACY_POLICY,
    ...options.privacyPolicy,
  })

  const context: TrackerContext = {
    sdk: TRACKER_SDK,
    sdk_version: TRACKER_VERSION,
    ...(options.testMode === true ? { test_mode: true } : {}),
  }

  const transport = createTransport({
    collectorUrl: options.collectorUrl,
    trackingKey: options.trackingKey,
    context,
    queue,
    now,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.beaconImpl ? { beaconImpl: options.beaconImpl } : {}),
    ...(options.schedule ? { schedule: options.schedule } : {}),
    ...(options.debug === true
      ? {
          onError: (reason: string) => {
            win.console?.debug?.('[oa]', reason)
          },
        }
      : {}),
  })

  const currentPage = (): TrackerPage | undefined => {
    const url = sanitizeUrl(win.location?.href ?? '', config.redactQueryKeys)
    if (url === '') return undefined
    const title = doc?.title ?? ''
    return title === '' ? { url } : { url, title: truncate(title, LIMITS.pageTitleMaxLength) }
  }

  let lastPageUrl = ''

  const emit = (
    type: TrackerEventType,
    extras: Partial<TrackerEvent> = {},
    options_: { immediate?: boolean } = {},
  ): void => {
    if (!privacy.mayCollect()) return

    const page = extras.page ?? currentPage()
    const event: TrackerEvent = {
      // Minted before the first attempt: a retry after a lost response must
      // carry the same id or the collector cannot deduplicate it (§7.1).
      event_id: uuidV7(),
      type,
      occurred_at: new Date(now()).toISOString(),
      client_session_id: session.current(now()),
      ...(page ? { page } : {}),
      ...extras,
    }

    transport.enqueue(event, options_)
  }

  const emitPageview = (referrer: string): void => {
    const page = currentPage()
    if (!page) return
    lastPageUrl = page.url

    emit(
      'page_view',
      { page, ...(referrer === '' ? {} : { referrer }) },
      // Docs snapshot 02 §7.3: the critical pageview leaves at the first
      // opportunity instead of waiting for a batching window.
      { immediate: true },
    )

    // After the pageview, so a `url_pattern` rule and the pageview it
    // accompanies describe the same URL in the same order every time.
    rules.onPageView()
  }

  const engagement = createEngagement({ document: doc, window: win, now })
  const vitals = createWebVitals({
    host: win as unknown as ObserverHost,
    emit: (payload: WebVitalPayload) => emit('web_vital', { web_vital: payload }),
  })
  const interactions = createInteractions({
    document: doc,
    window: win,
    now,
    random,
    sampling: () => config.interactionSampling,
    redactQueryKeys: () => config.redactQueryKeys,
    emit: (payload: InteractionPayload) => emit('interaction', { interaction: payload }),
  })
  /**
   * The no-code rule runtime (ADR-0034).
   *
   * Deliberately NOT gated on `features.interactions` and deliberately not
   * sampled. `interaction_sampling` throttles a passive, high-volume heatmap
   * signal that never bills; a rule produces a semantic, billable event, and
   * sampling one of those would make a customer's usage — and their conversion
   * counts — a dice roll.
   */
  const rules = createRules({
    document: doc,
    location: () => ({
      href: win.location?.href ?? '',
      pathname: win.location?.pathname ?? '',
      search: win.location?.search ?? '',
    }),
    rules: () => config.noCodeRules,
    redactQueryKeys: () => config.redactQueryKeys,
    // `performance.now()` in production -- monotonic and sub-millisecond, which
    // a 2 ms budget needs -- but an explicitly injected clock always wins, so
    // the budget is assertable in a test rather than only in theory.
    now: options.now ?? (win.performance?.now ? () => win.performance.now() : now),
    newActionId: uuidV7,
    emit: (match, actionId) => {
      emit('custom_event', {
        name: match.name,
        // Absent for an attribute-marked event (ADR-0037): there is no rule,
        // and the server classifies the event `client_sdk` by that absence.
        ...(match.ruleId ? { rule_id: match.ruleId } : {}),
        action_id: actionId,
        ...(match.properties ? { properties: match.properties } : {}),
      })
    },
  })

  const heartbeat = createHeartbeat({
    document: doc,
    intervalSeconds: () => config.heartbeatIntervalSeconds,
    send: () => {
      if (!privacy.mayCollect()) return
      const page = currentPage()
      transport.sendHeartbeat({
        context,
        client_session_id: session.current(now()),
        ...(page ? { page } : {}),
      })
    },
    ...(options.setIntervalImpl ? { setIntervalImpl: options.setIntervalImpl } : {}),
    ...(options.clearIntervalImpl ? { clearIntervalImpl: options.clearIntervalImpl } : {}),
  })

  const collectEngagement = (): void => {
    if (!config.features.engagement) return
    const payload: EngagementPayload | null = engagement.collect()
    if (payload) emit('engagement', { engagement: payload })
  }

  const onRouteChange = (): void => {
    const page = currentPage()
    if (!page || page.url === lastPageUrl) return

    // Duration belongs to the route it was spent on, so the previous route's
    // engagement closes before the new pageview opens.
    collectEngagement()
    interactions.onRouteChange()

    const previous = lastPageUrl
    emitPageview(previous)

    // After the pageview, never before it: a revalidation that arrived first
    // could apply a new rule set to a route the visitor has already left.
    options.onRouteChange?.()
  }

  const patchedHistory: {
    pushState?: History['pushState']
    replaceState?: History['replaceState']
  } = {}

  const patchHistory = (): void => {
    const history = win.history
    if (!history) return

    patchedHistory.pushState = history.pushState
    patchedHistory.replaceState = history.replaceState

    const wrap = (original: History['pushState']): History['pushState'] =>
      function patched(this: History, ...args: Parameters<History['pushState']>) {
        const result = original.apply(this, args)
        onRouteChange()
        return result
      }

    history.pushState = wrap(history.pushState.bind(history))
    history.replaceState = wrap(history.replaceState.bind(history))
  }

  const restoreHistory = (): void => {
    const history = win.history
    if (!history) return
    if (patchedHistory.pushState) history.pushState = patchedHistory.pushState
    if (patchedHistory.replaceState) history.replaceState = patchedHistory.replaceState
  }

  const onPopState = (): void => onRouteChange()

  const onVisibility = (): void => {
    if (doc?.visibilityState === 'hidden') {
      leave()
      return
    }
    // Back on the site: say so now rather than at the next interval, so the
    // realtime board shows them again within a second instead of up to 15
    // (ADR-0035, D10). Still no ping while hidden, at any cadence — `ping`
    // re-checks visibility itself, so an event on the wrong edge sends nothing.
    heartbeat.ping()
  }

  /**
   * KNOWN DEFECT, parked with a reason rather than fixed (ADR-0035, D10).
   *
   * `left` is a one-way latch, so the **first** `hidden` ends the visit for data
   * purposes. On Chrome and Safari a window *occlusion* — another window simply
   * covering the tab — fires `visibilitychange`, so a visitor who alt-tabs at
   * second 10 and then reads for twenty minutes reports **ten seconds of
   * engagement and never reports again**.
   *
   * It is not fixed here because fixing it increases engagement-event volume,
   * and that worsens the separate, already-open "more visitors than pageviews in
   * a bucket" symptom — a metric-definition question. Decide the two together or
   * the fix for one will be read as the cause of the other.
   *
   * Presence is unaffected: `heartbeat.ping()` above is not gated on this latch,
   * so the occluded-then-returning visitor is still on the realtime board.
   */
  let left = false
  const leave = (): void => {
    if (left) return
    left = true

    if (config.features.web_vitals) vitals.report()
    collectEngagement()
    transport.flush({ beacon: true })
  }

  const onPageHide = (): void => leave()

  const start = (): void => {
    if (config.features.engagement) engagement.start()
    if (config.features.web_vitals) vitals.start()
    if (config.features.interactions) interactions.start()
    rules.start()

    patchHistory()
    win.addEventListener('popstate', onPopState)
    win.addEventListener('pagehide', onPageHide)
    doc?.addEventListener('visibilitychange', onVisibility)

    emitPageview(sanitizeReferrer(doc?.referrer ?? '', config.redactQueryKeys))

    if (config.features.heartbeat) heartbeat.start()

    // Anything stranded by a previous page load goes out with this one.
    transport.flush()
  }

  start()

  return {
    track(name, properties, trackOptions) {
      if (!isValidEventName(name)) return
      const sanitized = sanitizeProperties(properties, config.redactQueryKeys)
      // An explicit id wins; otherwise the call inherits whatever browser action
      // is dispatching right now (ADR-0034, D5). That inheritance is what makes
      // the D-101 collapse reachable at all: a site's own `onClick` handler
      // calls `track()` synchronously inside the click, and no real caller has
      // ever passed `actionId` by hand.
      const actionId = trackOptions?.actionId ?? rules.actionId()
      emit('custom_event', {
        name,
        ...(sanitized ? { properties: sanitized } : {}),
        ...(actionId ? { action_id: truncate(actionId, LIMITS.actionIdMaxLength) } : {}),
      })
    },

    identify(externalUserId) {
      if (typeof externalUserId !== 'string' || externalUserId === '') return
      emit('identify', {
        external_user_id: truncate(externalUserId, LIMITS.externalUserIdMaxLength),
      })
    },

    conversion(name, properties) {
      if (!isValidEventName(name)) return
      const sanitized = sanitizeProperties(properties, config.redactQueryKeys)
      emit('conversion', { name, ...(sanitized ? { properties: sanitized } : {}) })
    },

    pageview() {
      onRouteChange()
    },

    consent(state) {
      privacy.setConsent(state)
    },

    applyConfig(next) {
      const previousInterval = config.heartbeatIntervalSeconds
      config = {
        ...config,
        ...next,
        features: { ...config.features, ...next.features },
      }
      if (config.features.heartbeat && config.heartbeatIntervalSeconds !== previousInterval) {
        heartbeat.restart()
      }
      if (!config.features.heartbeat) heartbeat.stop()
    },

    flush() {
      transport.flush()
    },

    stop() {
      engagement.stop()
      vitals.stop()
      interactions.stop()
      rules.stop()
      heartbeat.stop()
      restoreHistory()
      win.removeEventListener('popstate', onPopState)
      win.removeEventListener('pagehide', onPageHide)
      doc?.removeEventListener('visibilitychange', onVisibility)
    },

    version: TRACKER_VERSION,
  }
}
