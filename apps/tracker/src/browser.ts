import { loadTrackerConfig } from './config.ts'
import { resolveIgnore, showIgnoreNotice } from './ignore.ts'
import { installTracker, optionsFromScript } from './install.ts'
import { memoryStorage, safeStorage } from './storage.ts'

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

  const script =
    doc.currentScript ??
    doc.querySelector('script[data-key]') ??
    doc.querySelector('script[src*="oa.js"]')

  const options = optionsFromScript(script, win.location?.origin ?? '')
  const strict = options.storage === 'none'

  // ADR-0057 F6: an excluded browser installs nothing and sends nothing.
  // Checked before the snippet is *validated* — so `#oa-ignore` still works on a
  // page whose tag has no key — but after its attributes are read, because one
  // of them decides whether this line may touch storage at all.
  //
  // **Strict mode has no exclusion flag, and cannot have one** (ADR-0064, D5).
  // The flag is localStorage: setting it is storage on the visitor's device and
  // reading it is access to it, which are the two halves of the thing strict
  // mode promises not to do. A site that turns strict mode on gives up
  // `#oa-ignore` in the same act — including any flag one of its operators had
  // already set — and the alternative would be a mode whose central claim is
  // false in a way nobody could see. `safeStorage`'s own write probe is part of
  // this: it is why the store is not built at all here rather than built and
  // left unused.
  const localStore = strict ? memoryStorage() : safeStorage(win.localStorage ?? null)
  if (!strict) {
    const ignore = resolveIgnore(localStore, win.location?.hash ?? '')
    if (ignore.changed) showIgnoreNotice(doc, ignore.changed)
    if (ignore.ignored) return
  }

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

  const configDeps = {
    collectorUrl: options.collectorUrl,
    trackingKey: options.trackingKey,
    // The config cache is the fourth thing that writes to the device, and the
    // one `createTracker` cannot reach — it lives out here, beside the loader.
    // In strict mode `localStore` is already the memory one, so the promise is
    // not quietly broken by a five-minute cache entry.
    storage: localStore,
    now: () => Date.now(),
    ...fetchDeps,
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
    // ADR-0034 D4: a single-page app fetches configuration once and would never
    // revalidate at any TTL. A route change is the one moment a SPA reliably
    // offers to ask again.
    onRouteChange: () => syncConfig(),
  })

  syncConfig()
}

boot()
