import { loadTrackerConfig } from './config.ts'
import { resolveIgnore, showIgnoreNotice } from './ignore.ts'
import { installTracker, optionsFromScript } from './install.ts'
import { safeStorage } from './storage.ts'

/**
 * Bundle entry point.
 *
 * The only file that touches ambient globals. It reads its options from the
 * `<script>` tag, installs the tracker (without stealing a namespace it does not
 * own) and then, asynchronously, folds in the site's cached configuration.
 *
 * Configuration arrives after the first pageview on purpose: a pageview that
 * waited for a config round-trip would be lost on every fast bounce, which is
 * exactly the visit an analytics product must not miss.
 *
 * This file is also where the tracker gets its *transport*. `createTracker`
 * takes `fetchImpl`/`beaconImpl` as injected capabilities — that is what makes
 * the runtime testable — and `optionsFromScript` cannot supply them: it reads
 * `data-` attributes, and a DOM attribute is not a function. So they are
 * feature-detected off the real `window` here, at the one call site that is
 * allowed to know what a browser is. Without them `createTransport` has neither
 * implementation, every batch takes its `no_transport` requeue branch and
 * `sendBeacon` falls through to the same place: the tracker installs, collects,
 * queues — and never sends a byte (ADR-0019 open item 1).
 *
 * `beaconImpl` is handed a *string*, never a `Blob`. A string body makes the
 * browser stamp the beacon `text/plain;charset=UTF-8`, which is exactly
 * `INGEST_CONTENT_TYPE` and exactly what keeps the POST a CORS *simple* request
 * with no preflight (transport.ts). A `Blob` would let us set any type — and any
 * type we set that is not one of the three safelisted ones costs a preflight on
 * every batch, on a request the page is unloading out from under.
 *
 * Both detections are independent on purpose: a browser without `sendBeacon`
 * still delivers through `fetch` (the transport falls back), and a browser
 * without `fetch` still delivers the unload flush through `sendBeacon`.
 */

function boot(): void {
  const win = globalThis as unknown as Window & typeof globalThis
  const doc = win.document
  if (!doc) return

  // ADR-0057 F6: an excluded browser installs nothing and sends nothing.
  // Checked before anything else — before the snippet is even validated — so
  // `#oa-ignore` works on a page whose tag is otherwise broken.
  const localStore = safeStorage(win.localStorage ?? null)
  const ignore = resolveIgnore(localStore, win.location?.hash ?? '')
  if (ignore.changed) showIgnoreNotice(doc, ignore.changed)
  if (ignore.ignored) return

  const script =
    doc.currentScript ??
    doc.querySelector('script[data-key]') ??
    doc.querySelector('script[src*="oa.js"]')

  const options = optionsFromScript(script, win.location?.origin ?? '')
  if (options.trackingKey === '' || options.collectorUrl === '') {
    win.console?.warn?.('[oa] missing data-key or data-collector; tracker not started')
    return
  }

  // One detection, used by both the tracker's transport and the config fetch.
  // The previous asymmetry — a `fetchImpl` for the config, none for the tracker —
  // is what left production with no transport at all.
  const fetchDeps =
    typeof win.fetch === 'function'
      ? { fetchImpl: (url: string, init: RequestInit) => win.fetch(url, init) }
      : {}
  const beaconDeps =
    typeof win.navigator?.sendBeacon === 'function'
      ? { beaconImpl: (url: string, payload: string) => win.navigator.sendBeacon(url, payload) }
      : {}

  // A rule preview (ADR-0034, D6). Read from the page's own URL, which is where
  // the dashboard put it. Its presence also makes the whole page's traffic
  // `test_mode`: preview events are non-billable and are excluded from every
  // production read, which is what lets a preview run against a real site.
  let previewToken = ''
  try {
    previewToken = new URLSearchParams(win.location?.search ?? '').get('oa_preview') ?? ''
  } catch {
    /* a malformed query string is no preview */
  }

  const configDeps = {
    collectorUrl: options.collectorUrl,
    trackingKey: options.trackingKey,
    storage: localStore,
    now: () => Date.now(),
    ...fetchDeps,
    ...(previewToken === '' ? {} : { previewToken }),
  }

  /**
   * Loads configuration and hands it to the tracker.
   *
   * `pending` is the whole of the concurrency story: the TTL check lives inside
   * `loadTrackerConfig`, so a route change inside the window costs nothing, but
   * two route changes in the same tick just after it expires would otherwise
   * open two requests for one answer.
   */
  let pending = false
  const syncConfig = (): void => {
    if (pending) return
    pending = true
    void loadTrackerConfig(configDeps)
      .then((config) => {
        if (config) tracker.applyConfig(config)
      })
      .finally(() => {
        pending = false
      })
  }

  const { tracker } = installTracker(win, {
    ...options,
    ...fetchDeps,
    ...beaconDeps,
    ...(previewToken === '' ? {} : { testMode: true }),
    // ADR-0034 D4: a single-page app fetches configuration once and would never
    // revalidate at any TTL. Not wired during a preview — that path bypasses the
    // cache by design, so every route change would be an unconditional request
    // for a draft rule set nobody asked for again.
    ...(previewToken === '' ? { onRouteChange: () => syncConfig() } : {}),
  })

  syncConfig()
}

boot()
